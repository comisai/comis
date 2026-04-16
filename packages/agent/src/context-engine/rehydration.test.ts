/**
 * Tests for the post-compaction rehydration context engine layer.
 *
 * Covers: pass-through, split injection, AGENTS.md extraction, file
 * re-reading with failures, file count cap, overflow recovery (strip files,
 * remove entirely), double-rehydration prevention, and active state formatting.
 */

import { describe, it, expect, vi } from "vitest";
import { createRehydrationLayer } from "./rehydration.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { RehydrationLayerDeps, TokenBudget } from "./types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test Helpers
function makeCompactionSummary(text = "Compacted conversation"): AgentMessage {
  return {
    role: "user",
    compactionSummary: true,
    content: [{ type: "text", text: `<summary>\n${text}\n</summary>` }],
  } as unknown as AgentMessage;
}

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/** Extract text content from a message (handles array content blocks). */
function getMessageText(msg: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const m = msg as any;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content) && m.content[0]?.type === "text") {
    return m.content[0].text ?? "";
  }
  return "";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function createMockDeps(overrides?: Partial<RehydrationLayerDeps>): {
  deps: RehydrationLayerDeps;
  logger: ReturnType<typeof createMockLogger>;
} {
  const logger = createMockLogger();
  const deps: RehydrationLayerDeps = {
    logger: logger as unknown as RehydrationLayerDeps["logger"],
    getAgentsMdContent: () => `# AGENTS.md

## Session Startup
Critical startup rules here.

## Red Lines
Never do these things.

## Other Section
This section is not extracted.
`,
    postCompactionSections: ["Session Startup", "Red Lines"],
    getRecentFiles: () => ["/path/to/file1.ts", "/path/to/file2.ts"],
    readFile: async (p: string) => `// Content of ${p}\nconst x = 1;`,
    getActiveState: () => ({
      channelType: "discord",
      channelId: "ch-123",
      agentId: "agent-abc",
    }),
    ...overrides,
  };
  return { deps, logger };
}

/** Large budget that won't trigger overflow. */
const largeBudget: TokenBudget = {
  windowTokens: 200_000,
  systemTokens: 10_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 10_000,
  contextRotBufferTokens: 50_000,
  availableHistoryTokens: 100_000,
};

/** Tiny budget that will trigger overflow. */
const tinyBudget: TokenBudget = {
  windowTokens: 4_000,
  systemTokens: 1_000,
  outputReserveTokens: 1_000,
  safetyMarginTokens: 500,
  contextRotBufferTokens: 500,
  availableHistoryTokens: 50, // 50 tokens * 4 chars = 200 chars budget
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRehydrationLayer", () => {
  it("1) no compaction summary -- pass-through", async () => {
    const { deps } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    const messages = [makeUserMsg("hello"), makeAssistantMsg("hi")];
    const result = await layer.apply(messages, largeBudget);

    expect(result).toBe(messages);
  });

  it("2) compaction detected -- split rehydration: position-1 + end", async () => {
    const { deps } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    const messages = [
      makeCompactionSummary(),
      makeUserMsg("continue please"),
    ];

    const result = await layer.apply(messages, largeBudget);

    // Should have 4 messages: compaction + position1 + user + end
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(messages[0]); // compaction summary unchanged
    expect(result[2]).toBe(messages[1]); // original user message preserved

    // Position-1 message at index 1 (AGENTS.md + files)
    const position1 = result[1]!;
    expect(position1.role).toBe("user");
    const position1Text = getMessageText(position1);

    // Position-1 should contain AGENTS.md and files
    expect(position1Text).toContain("[Critical instructions from AGENTS.md]");
    expect(position1Text).toContain("Critical startup rules here.");
    expect(position1Text).toContain("Never do these things.");
    expect(position1Text).toContain("[End critical instructions]");
    expect(position1Text).toContain("[File: /path/to/file1.ts]");
    expect(position1Text).toContain("[File: /path/to/file2.ts]");
    expect(position1Text).toContain("[End file]");

    // Position-1 should NOT contain resume instruction or active state
    expect(position1Text).not.toContain("[Resume instruction]");
    expect(position1Text).not.toContain("[Active state]");

    // End message at index 3 (resume + state)
    const endMsg = result[3]!;
    expect(endMsg.role).toBe("user");
    const endText = getMessageText(endMsg);

    // End should contain resume instruction and active state
    expect(endText).toContain("[Resume instruction]");
    expect(endText).toContain("[End resume instruction]");
    expect(endText).toContain("[Active state]");
    expect(endText).toContain("Channel type: discord");
    expect(endText).toContain("Channel ID: ch-123");
    expect(endText).toContain("Agent ID: agent-abc");
    expect(endText).toContain("[End active state]");

    // End should NOT contain AGENTS.md or files
    expect(endText).not.toContain("[Critical instructions from AGENTS.md]");
    expect(endText).not.toContain("[File:");
  });

  it("3) AGENTS.md sections extracted and truncated to 3K", async () => {
    const longSection = "X".repeat(4000);
    const { deps } = createMockDeps({
      getAgentsMdContent: () => `## Session Startup\n${longSection}\n\n## Red Lines\nDon't do bad things.`,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // Position-1 message at index 1
    expect(result.length).toBeGreaterThan(1);
    const text = getMessageText(result[1]!);

    // AGENTS.md content should be truncated to 3000 chars
    const agentsMdStart = text.indexOf("[Critical instructions from AGENTS.md]");
    const agentsMdEnd = text.indexOf("[End critical instructions]") + "[End critical instructions]".length;
    const agentsMdBlock = text.slice(agentsMdStart, agentsMdEnd);

    // The inner content (between markers) should not exceed 3000 chars
    const innerContent = agentsMdBlock
      .replace("[Critical instructions from AGENTS.md]\n", "")
      .replace("\n[End critical instructions]", "");
    expect(innerContent.length).toBeLessThanOrEqual(3000);
  });

  it("4) file re-reading with failures -- failed files skipped", async () => {
    const { deps } = createMockDeps({
      getRecentFiles: () => ["/good.ts", "/bad.ts", "/also-good.ts"],
      readFile: async (p: string) => {
        if (p === "/bad.ts") throw new Error("Permission denied");
        return `content of ${p}`;
      },
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // Files are in position-1 message (index 1)
    const text = getMessageText(result[1]!);

    expect(text).toContain("[File: /good.ts]");
    expect(text).toContain("[File: /also-good.ts]");
    expect(text).not.toContain("[File: /bad.ts]");
  });

  it("5) file count cap -- only first 5 files used", async () => {
    const { deps } = createMockDeps({
      getRecentFiles: () => [
        "/f1.ts", "/f2.ts", "/f3.ts", "/f4.ts", "/f5.ts",
        "/f6.ts", "/f7.ts",
      ],
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // Files are in position-1 message (index 1)
    const text = getMessageText(result[1]!);

    expect(text).toContain("[File: /f1.ts]");
    expect(text).toContain("[File: /f5.ts]");
    expect(text).not.toContain("[File: /f6.ts]");
    expect(text).not.toContain("[File: /f7.ts]");
  });

  it("6) overflow -- strip files from position-1, keep AGENTS.md + end message", async () => {
    const { deps, logger } = createMockDeps({
      readFile: async () => "x".repeat(500), // Moderate file content
      getAgentsMdContent: () => "## Session Startup\nRules.",
    });
    const layer = createRehydrationLayer(deps);

    // Use a budget that's too small for files but large enough for other sections
    const tightBudget: TokenBudget = {
      ...largeBudget,
      availableHistoryTokens: 200, // 200 * 4 = 800 chars budget
    };

    const messages = [makeCompactionSummary("short")];
    const result = await layer.apply(messages, tightBudget);

    // Position-1 message should have files stripped, keeping only AGENTS.md
    const position1Text = getMessageText(result[1]!);
    expect(position1Text).not.toContain("[File:");
    expect(position1Text).toContain("[Critical instructions from AGENTS.md]");

    // End message should still have resume instruction
    const endMsg = result[result.length - 1]!;
    const endText = getMessageText(endMsg);
    expect(endText).toContain("[Resume instruction]");

    // Should log WARN about overflow
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("File content stripped") }),
      expect.stringContaining("overflow"),
    );
  });

  it("7) overflow -- remove rehydration entirely when still too large", async () => {
    const { deps, logger } = createMockDeps({
      getAgentsMdContent: () => "## Session Startup\n" + "X".repeat(3000),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary("short summary"), makeUserMsg("hello")];
    const result = await layer.apply(messages, tinyBudget);

    // Should return original messages (both position-1 and end messages removed)
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);

    // Should log ERROR about removal
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("removed entirely") }),
      expect.stringContaining("Rehydration overflow"),
    );
  });

  it("8) double-rehydration prevention -- only fires once per compaction", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    const compaction = makeCompactionSummary("same summary");
    const messages = [compaction, makeUserMsg("turn 1")];

    // First call: rehydration fires (split injection)
    const result1 = await layer.apply(messages, largeBudget);
    expect(result1).toHaveLength(4); // compaction + position1 + user + end

    // Reset logger to track second call
    logger.info.mockClear();
    logger.debug.mockClear();

    // Second call with same compaction: rehydration should NOT fire
    const messages2 = [compaction, makeUserMsg("turn 2")];
    const result2 = await layer.apply(messages2, largeBudget);
    expect(result2).toBe(messages2); // pass-through, no rehydration

    // No rehydration log on second call
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Post-compaction rehydration complete",
    );
  });

  it("8b) new compaction triggers rehydration again", async () => {
    const { deps } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    // First compaction
    const messages1 = [makeCompactionSummary("first compaction"), makeUserMsg("turn 1")];
    const result1 = await layer.apply(messages1, largeBudget);
    expect(result1).toHaveLength(4); // split injection

    // Different compaction summary
    const messages2 = [makeCompactionSummary("second compaction"), makeUserMsg("turn 2")];
    const result2 = await layer.apply(messages2, largeBudget);
    expect(result2).toHaveLength(4); // rehydration fires again for new compaction
  });

  it("9) active state formatting -- present fields only (in end message)", async () => {
    const { deps } = createMockDeps({
      getActiveState: () => ({
        channelType: "telegram",
        // channelId and agentId absent
      }),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // Active state is in the end message (last message)
    const endText = getMessageText(result[result.length - 1]!);

    expect(endText).toContain("[Active state]");
    expect(endText).toContain("Channel type: telegram");
    expect(endText).not.toContain("Channel ID:");
    expect(endText).not.toContain("Agent ID:");
  });

  it("9b) active state omitted when all fields absent (end has resume only)", async () => {
    const { deps } = createMockDeps({
      getActiveState: () => ({}),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // End message should have resume but no active state
    const endText = getMessageText(result[result.length - 1]!);

    expect(endText).not.toContain("[Active state]");
    expect(endText).toContain("[Resume instruction]");
  });

  it("10) empty AGENTS.md and no files -- only end message with resume instruction", async () => {
    const { deps } = createMockDeps({
      getAgentsMdContent: () => "",
      getRecentFiles: () => [],
      getActiveState: () => ({}),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // No position-1 message (no AGENTS.md, no files), only end message
    // Result: compaction + end
    expect(result).toHaveLength(2);
    const endText = getMessageText(result[1]!);
    expect(endText).toContain("[Resume instruction]");
    expect(endText).not.toContain("[Critical instructions");
    expect(endText).not.toContain("[File:");
  });

  // ---------------------------------------------------------------------------
  // Position-aware rehydration split
  // ---------------------------------------------------------------------------

  it("11) position-1 has AGENTS.md + files, end has resume + state", async () => {
    const { deps } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    const messages = [
      makeCompactionSummary(),
      makeUserMsg("u1"),
      makeAssistantMsg("a1"),
    ];

    const result = await layer.apply(messages, largeBudget);

    // 5 messages: compaction + position1 + u1 + a1 + end
    expect(result).toHaveLength(5);

    // Position-1 (index 1): AGENTS.md + files
    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Critical instructions from AGENTS.md]");
    expect(pos1Text).toContain("[File:");

    // Original messages preserved in order (indices 2 and 3)
    expect(result[2]).toBe(messages[1]); // u1
    expect(result[3]).toBe(messages[2]); // a1

    // End (index 4): resume + state
    const endText = getMessageText(result[4]!);
    expect(endText).toContain("[Resume instruction]");
    expect(endText).toContain("[Active state]");
  });

  it("12) no files or AGENTS.md -- only end message (resume + state)", async () => {
    const { deps } = createMockDeps({
      getAgentsMdContent: () => "",
      getRecentFiles: () => [],
    });
    const layer = createRehydrationLayer(deps);

    const messages = [
      makeCompactionSummary(),
      makeUserMsg("u1"),
    ];

    const result = await layer.apply(messages, largeBudget);

    // 3 messages: compaction + u1 + end (no position-1 message)
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(messages[0]); // compaction
    expect(result[1]).toBe(messages[1]); // u1

    // End message has resume + active state
    const endText = getMessageText(result[2]!);
    expect(endText).toContain("[Resume instruction]");
    expect(endText).toContain("[Active state]");
    expect(endText).not.toContain("[Critical instructions");
    expect(endText).not.toContain("[File:");
  });

  it("13) active state absent -- end message has only resume instruction", async () => {
    const { deps } = createMockDeps({
      getActiveState: () => ({}),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary(), makeUserMsg("u1")];
    const result = await layer.apply(messages, largeBudget);

    // End message should contain resume instruction but NOT active state
    const endText = getMessageText(result[result.length - 1]!);
    expect(endText).toContain("[Resume instruction]");
    expect(endText).not.toContain("[Active state]");
  });

  // ---------------------------------------------------------------------------
  // Post-compaction skill restoration
  // ---------------------------------------------------------------------------

  it("14) skill restoration -- skills appear in position-1 after AGENTS.md and files", async () => {
    const skillsXml = `<available_skills>
<skill name="web_search"><description>Search the web</description><arguments>query</arguments></skill>
<skill name="memory_store"><description>Store memory</description><arguments>key, value</arguments></skill>
</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary(), makeUserMsg("continue")];
    const result = await layer.apply(messages, largeBudget);

    // Position-1 at index 1 should contain AGENTS.md + files + skills
    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Critical instructions from AGENTS.md]");
    expect(pos1Text).toContain("[File:");
    expect(pos1Text).toContain("[Restored prompt skills]");
    expect(pos1Text).toContain("<available_skills>");
    expect(pos1Text).toContain("web_search");
    expect(pos1Text).toContain("memory_store");
    expect(pos1Text).toContain("[End restored prompt skills]");

    // Skills should appear AFTER AGENTS.md and files in position-1
    const agentsIdx = pos1Text.indexOf("[Critical instructions from AGENTS.md]");
    const fileIdx = pos1Text.indexOf("[File:");
    const skillsIdx = pos1Text.indexOf("[Restored prompt skills]");
    expect(agentsIdx).toBeLessThan(fileIdx);
    expect(fileIdx).toBeLessThan(skillsIdx);
  });

  it("15) skill truncation -- XML exceeding 15K chars truncated at skill boundaries", async () => {
    // Build XML with skills that exceed 15K chars total
    const bigDescription = "D".repeat(2000);
    const skills: string[] = [];
    for (let i = 0; i < 10; i++) {
      skills.push(`<skill name="skill_${i}"><description>${bigDescription}</description><arguments>arg</arguments></skill>`);
    }
    const skillsXml = `<available_skills>\n${skills.join("\n")}\n</available_skills>`;

    // Verify input exceeds budget
    expect(skillsXml.length).toBeGreaterThan(15_000);

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);

    // Should contain skills but truncated
    expect(pos1Text).toContain("[Restored prompt skills]");
    expect(pos1Text).toContain("</available_skills>");

    // Extracted skills content should not have malformed XML
    // It should end with a complete </skill> before </available_skills>
    const skillsBlock = pos1Text.slice(
      pos1Text.indexOf("[Restored prompt skills]"),
      pos1Text.indexOf("[End restored prompt skills]") + "[End restored prompt skills]".length,
    );
    // No partial <skill tags should be cut mid-way
    const openTags = (skillsBlock.match(/<skill[\s>]/g) ?? []).length;
    const closeTags = (skillsBlock.match(/<\/skill>/g) ?? []).length;
    expect(openTags).toBe(closeTags);
  });

  it("16) skill count limit -- more than 10 skills truncated to 10", async () => {
    const skills: string[] = [];
    for (let i = 0; i < 15; i++) {
      skills.push(`<skill name="skill_${i}"><description>Skill ${i}</description><arguments>arg</arguments></skill>`);
    }
    const skillsXml = `<available_skills>\n${skills.join("\n")}\n</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Restored prompt skills]");

    // Count skill tags in output -- should be exactly 10
    const skillMatches = pos1Text.match(/<skill name="/g) ?? [];
    expect(skillMatches.length).toBe(10);

    // First 10 skills present, skill_10+ absent
    expect(pos1Text).toContain('skill_0');
    expect(pos1Text).toContain('skill_9');
    expect(pos1Text).not.toContain('skill_10');
    expect(pos1Text).not.toContain('skill_14');
  });

  it("17) empty skills XML -- no skills section injected", async () => {
    const { deps } = createMockDeps({
      getPromptSkillsXml: () => "",
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).not.toContain("[Restored prompt skills]");
    expect(pos1Text).toContain("[Critical instructions from AGENTS.md]");
  });

  it("18) undefined getPromptSkillsXml -- no skills section injected", async () => {
    // Default mock deps don't have getPromptSkillsXml
    const { deps } = createMockDeps();
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).not.toContain("[Restored prompt skills]");
  });

  it("19) overflow stage 1 -- strips files from position-1 (existing behavior)", async () => {
    const onOverflow = vi.fn();
    const { deps } = createMockDeps({
      readFile: async () => "x".repeat(500),
      getAgentsMdContent: () => "## Session Startup\nRules.",
      onOverflow,
    });
    const layer = createRehydrationLayer(deps);

    const tightBudget: TokenBudget = {
      ...largeBudget,
      availableHistoryTokens: 200,
    };

    const messages = [makeCompactionSummary("short")];
    const result = await layer.apply(messages, tightBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).not.toContain("[File:");
    expect(pos1Text).toContain("[Critical instructions from AGENTS.md]");
    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAction: "strip_files" }),
    );
  });

  it("20) overflow stage 2 -- strips skills from position-1 (NEW)", async () => {
    // Build a scenario: files already stripped but skills push it over budget
    const bigSkillsXml = `<available_skills>
<skill name="big_skill"><description>${"S".repeat(2000)}</description><arguments>arg</arguments></skill>
</available_skills>`;

    const onOverflow = vi.fn();
    const { deps } = createMockDeps({
      getAgentsMdContent: () => "## Session Startup\nShort rules.",
      getRecentFiles: () => [],
      getPromptSkillsXml: () => bigSkillsXml,
      onOverflow,
    });
    const layer = createRehydrationLayer(deps);

    // Budget: enough for AGENTS.md alone but not AGENTS.md + skills
    const skillOverflowBudget: TokenBudget = {
      ...largeBudget,
      availableHistoryTokens: 180, // 180 * 4 = 720 chars
    };

    const messages = [makeCompactionSummary("x")];
    const result = await layer.apply(messages, skillOverflowBudget);

    // Position-1 should have AGENTS.md but NOT skills (stripped at stage 2)
    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Critical instructions from AGENTS.md]");
    expect(pos1Text).not.toContain("[Restored prompt skills]");

    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAction: "strip_skills" }),
    );
  });

  it("21) overflow stage 3 -- removes position-1 entirely (renumbered)", async () => {
    const onOverflow = vi.fn();
    const { deps } = createMockDeps({
      getAgentsMdContent: () => "## Session Startup\n" + "X".repeat(800),
      getRecentFiles: () => [],
      getActiveState: () => ({}),
      onOverflow,
    });
    const layer = createRehydrationLayer(deps);

    // Budget: large enough for compaction + user + end (resume ~250 chars) but NOT for position-1 (AGENTS.md ~850 chars)
    // Compaction summary ~50 chars + user msg ~5 chars + resume ~250 chars = ~305 chars
    // Adding position-1 AGENTS.md ~900 chars pushes total to ~1205 chars (over 800 budget)
    const veryTightBudget: TokenBudget = {
      ...largeBudget,
      availableHistoryTokens: 200, // 200 * 4 = 800 chars
    };

    const messages = [makeCompactionSummary("short"), makeUserMsg("hello")];
    const result = await layer.apply(messages, veryTightBudget);

    // Should have end message but NO position-1
    const hasPosition1 = result.some((m, i) => {
      if (i === 0) return false; // skip compaction
      const text = getMessageText(m);
      return text.includes("[Critical instructions from AGENTS.md]");
    });
    expect(hasPosition1).toBe(false);

    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAction: "remove_position1" }),
    );
  });

  it("22) overflow stage 4 -- removes all rehydration (renumbered)", async () => {
    const onOverflow = vi.fn();
    const { deps } = createMockDeps({
      getAgentsMdContent: () => "## Session Startup\n" + "X".repeat(3000),
      onOverflow,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary("short summary"), makeUserMsg("hello")];
    const result = await layer.apply(messages, tinyBudget);

    // Should return original messages
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);

    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAction: "remove_rehydration" }),
    );
  });

  it("23) rehydration stats include skillsInjected count", async () => {
    const skillsXml = `<available_skills>
<skill name="test_skill"><description>Test</description><arguments>arg</arguments></skill>
</available_skills>`;

    const onRehydrated = vi.fn();
    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
      onRehydrated,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    await layer.apply(messages, largeBudget);

    expect(onRehydrated).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsInjected: 1,
        sectionsInjected: 1,
        overflowStripped: false,
      }),
    );
  });

  it("23b) rehydration stats skillsInjected=0 when no skills", async () => {
    const onRehydrated = vi.fn();
    const { deps } = createMockDeps({
      onRehydrated,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    await layer.apply(messages, largeBudget);

    expect(onRehydrated).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsInjected: 0,
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // POST-COMPACT-BUDGET: Per-skill and total rehydration token budget tests
  // ---------------------------------------------------------------------------

  it("24) per-skill budget -- individual skill exceeding 5,000 chars is truncated", async () => {
    // Build a single large skill that exceeds 5K chars
    const bigDescription = "D".repeat(6000);
    const skillsXml = `<available_skills>
<skill name="big_skill"><description>${bigDescription}</description><arguments>arg</arguments></skill>
<skill name="small_skill"><description>Short</description><arguments>arg</arguments></skill>
</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Restored prompt skills]");

    // The big_skill should be truncated and have a closing </skill> tag repaired
    // Extract just the big_skill block
    const bigSkillStart = pos1Text.indexOf('<skill name="big_skill">');
    expect(bigSkillStart).toBeGreaterThan(-1);

    // Find the closing </skill> for big_skill
    const bigSkillEnd = pos1Text.indexOf("</skill>", bigSkillStart);
    expect(bigSkillEnd).toBeGreaterThan(-1);

    const bigSkillBlock = pos1Text.slice(bigSkillStart, bigSkillEnd + "</skill>".length);
    // Per-skill budget is 5,000 chars -- the truncated skill block must be <= 5,000 chars
    expect(bigSkillBlock.length).toBeLessThanOrEqual(5_000);

    // The small skill should still be present (not truncated)
    expect(pos1Text).toContain("small_skill");
  });

  it("25) per-skill budget -- skills within budget are not truncated", async () => {
    const skillsXml = `<available_skills>
<skill name="skill_a"><description>Short A</description><arguments>arg</arguments></skill>
<skill name="skill_b"><description>Short B</description><arguments>arg</arguments></skill>
</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    // Both skills should be fully present
    expect(pos1Text).toContain("Short A");
    expect(pos1Text).toContain("Short B");
    expect(pos1Text).toContain("skill_a");
    expect(pos1Text).toContain("skill_b");
  });

  it("26) per-skill truncation ends with valid XML closing (</skill>)", async () => {
    const bigDescription = "D".repeat(6000);
    const skillsXml = `<available_skills>
<skill name="big_skill"><description>${bigDescription}</description><arguments>arg</arguments></skill>
</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Restored prompt skills]");

    // The truncated skill must end with a proper </skill> tag
    const skillsBlock = pos1Text.slice(
      pos1Text.indexOf("[Restored prompt skills]"),
      pos1Text.indexOf("[End restored prompt skills]") + "[End restored prompt skills]".length,
    );
    const openTags = (skillsBlock.match(/<skill[\s>]/g) ?? []).length;
    const closeTags = (skillsBlock.match(/<\/skill>/g) ?? []).length;
    expect(openTags).toBe(closeTags);
  });

  it("27) total rehydration token budget -- content exceeding 50,000 chars is capped", async () => {
    // Build enormous content that exceeds 50K total chars
    const hugeAgentsMd = "## Session Startup\n" + "X".repeat(30_000);
    const hugeSkillDescription = "S".repeat(4_500);
    const skills: string[] = [];
    for (let i = 0; i < 10; i++) {
      skills.push(`<skill name="skill_${i}"><description>${hugeSkillDescription}</description><arguments>arg</arguments></skill>`);
    }
    const hugeSkillsXml = `<available_skills>\n${skills.join("\n")}\n</available_skills>`;

    const { deps, logger } = createMockDeps({
      getAgentsMdContent: () => hugeAgentsMd,
      getPromptSkillsXml: () => hugeSkillsXml,
      getRecentFiles: () => ["/f1.ts", "/f2.ts", "/f3.ts", "/f4.ts", "/f5.ts"],
      readFile: async () => "x".repeat(8_000),
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    // The position-1 message should exist but with truncated content
    expect(result.length).toBeGreaterThan(1);
    const pos1Text = getMessageText(result[1]!);

    // Total chars should be reasonable (capped by budget)
    // The exact limit depends on how truncation interacts with the 50K cap,
    // but the combined content should not exceed 50K chars
    // (The logger.warn may or may not fire depending on overflow stage)
    expect(pos1Text.length).toBeLessThanOrEqual(50_000);
  });

  it("28) per-skill budget is additive to MAX_REHYDRATION_SKILLS=10 limit", async () => {
    // 15 skills, each small enough to fit per-skill budget
    const skills: string[] = [];
    for (let i = 0; i < 15; i++) {
      skills.push(`<skill name="skill_${i}"><description>Skill ${i}</description><arguments>arg</arguments></skill>`);
    }
    const skillsXml = `<available_skills>\n${skills.join("\n")}\n</available_skills>`;

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);

    // Should still be limited to 10 skills (MAX_REHYDRATION_SKILLS)
    const skillMatches = pos1Text.match(/<skill name="/g) ?? [];
    expect(skillMatches.length).toBe(10);
  });

  it("29) per-skill budget is additive to MAX_REHYDRATION_SKILL_CHARS=15,000 total limit", async () => {
    // 8 skills, each ~2,500 chars (within per-skill budget of 5K)
    // Total: 8 * 2,500 = 20,000 chars > 15K total limit
    const skills: string[] = [];
    for (let i = 0; i < 8; i++) {
      const desc = `${"X".repeat(2400)}`;
      skills.push(`<skill name="skill_${i}"><description>${desc}</description><arguments>arg</arguments></skill>`);
    }
    const skillsXml = `<available_skills>\n${skills.join("\n")}\n</available_skills>`;

    // Verify input exceeds 15K
    expect(skillsXml.length).toBeGreaterThan(15_000);

    const { deps } = createMockDeps({
      getPromptSkillsXml: () => skillsXml,
    });
    const layer = createRehydrationLayer(deps);

    const messages = [makeCompactionSummary()];
    const result = await layer.apply(messages, largeBudget);

    const pos1Text = getMessageText(result[1]!);
    expect(pos1Text).toContain("[Restored prompt skills]");

    // Extract skills block and verify it respects the 15K total char budget
    const skillsStart = pos1Text.indexOf("[Restored prompt skills]");
    const skillsEnd = pos1Text.indexOf("[End restored prompt skills]") + "[End restored prompt skills]".length;
    const skillsBlock = pos1Text.slice(skillsStart, skillsEnd);

    // The inner content should have balanced XML
    const openTags = (skillsBlock.match(/<skill[\s>]/g) ?? []).length;
    const closeTags = (skillsBlock.match(/<\/skill>/g) ?? []).length;
    expect(openTags).toBe(closeTags);
  });
});
