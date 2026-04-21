// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for LLM compaction context engine layer.
 *
 * Verifies trigger threshold, cooldown, quality validation, three-level
 * fallback, session persistence, and model override fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget, CompactionLayerDeps } from "./types.js";
import { createLlmCompactionLayer, validateCompactionSummary } from "./llm-compaction.js";
import { COMPACTION_REQUIRED_SECTIONS, OVERSIZED_MESSAGE_CHARS_THRESHOLD } from "./constants.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock generateSummary from SDK
// ---------------------------------------------------------------------------

const mockGenerateSummary = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  generateSummary: (...args: unknown[]) => mockGenerateSummary(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Budget where 85% threshold would be ~108,800 tokens (128K * 0.85). */
const BUDGET: TokenBudget = {
  windowTokens: 128_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 6_400,
  contextRotBufferTokens: 32_000,
  availableHistoryTokens: 76_408,
};

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function createMockDeps(overrides?: {
  overrideModel?: CompactionLayerDeps["overrideModel"];
}): { deps: CompactionLayerDeps; logger: ReturnType<typeof createMockLogger>; mockSm: { fileEntries: unknown[]; _rewriteFile: ReturnType<typeof vi.fn> } } {
  const logger = createMockLogger();
  const mockSm = {
    fileEntries: [] as unknown[],
    _rewriteFile: vi.fn(),
  };
  const deps: CompactionLayerDeps = {
    logger: logger as unknown as CompactionLayerDeps["logger"],
    getSessionManager: () => mockSm,
    getModel: () => ({
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      contextWindow: 128_000,
      reasoning: true,
    }),
    getApiKey: vi.fn().mockResolvedValue("test-api-key"),
    overrideModel: overrides?.overrideModel,
  };
  return { deps, logger, mockSm };
}

/** Build a valid summary with all 9 required sections. */
function buildValidSummary(): string {
  return `## Identifiers
- Agent: test-agent, Channel: discord, Thread: #general

## Primary Request and Intent
- User wants to implement structured compaction with semantic sections

## Decisions
- Decided to use TypeScript for type safety

## Files and Code
- File: src/context-engine/llm-compaction.ts:63
- \`buildComisCompactionInstructions()\` — returns structured prompt

## Errors and Resolutions
- (none)

## User Messages
- "Please update the compaction sections to be more semantic"

## Constraints
- Must be backwards compatible with existing compaction format

## Active Work
- Implementing the semantic section upgrade

## Next Steps
- Complete implementation
- Write tests
- Verify section count`;
}

/** Build an incomplete summary missing several of the 9 sections. */
function buildIncompleteSummary(): string {
  return `## Identifiers
- Agent: test-agent

## Decisions
- Decided to use TypeScript

## Constraints
- Must be backwards compatible`;
}

/**
 * Build a message array that will exceed the 85% threshold.
 * 128K window * 85% = 108,800 tokens = 435,200 chars (at 4 chars/token).
 * We need messages totaling > 435K chars.
 */
function buildLargeConversation(charTarget = 500_000): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const charsPerMessage = 10_000;
  const count = Math.ceil(charTarget / charsPerMessage);
  for (let i = 0; i < count; i++) {
    messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(charsPerMessage / 3)));
    messages.push(makeAssistantMsg("A" + i + ": " + "y".repeat(charsPerMessage / 3)));
    messages.push(makeToolResult(`tc_${i}`, "bash", "z".repeat(charsPerMessage / 3)));
  }
  return messages;
}

/** Build a small conversation that stays below 85% threshold. */
function buildSmallConversation(): AgentMessage[] {
  return [
    makeUserMsg("Hello"),
    makeAssistantMsg("Hi there"),
    makeUserMsg("How are you?"),
    makeAssistantMsg("I'm doing well."),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLlmCompactionLayer", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  // -------------------------------------------------------------------------
  // 1. Below threshold -- no compaction
  // -------------------------------------------------------------------------

  it("returns messages unchanged when below 85% of windowTokens", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    expect(result).toBe(messages); // Same reference = no changes
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Within cooldown -- no compaction
  // -------------------------------------------------------------------------

  it("skips compaction when within cooldown window even if above threshold", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // First call: triggers compaction (turnsSinceLastCompaction starts at Infinity)
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    await layer.apply(largeMessages, BUDGET);

    // Reset mock for next calls
    mockGenerateSummary.mockReset();

    // Calls 2-5: within cooldown (turns 1-4), should NOT trigger
    for (let i = 0; i < 4; i++) {
      const result = await layer.apply(largeMessages, BUDGET);
      // Returns original messages because within cooldown
      expect(result).toBe(largeMessages);
    }

    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Level 1 success
  // -------------------------------------------------------------------------

  it("compacts with Level 1 when generateSummary returns valid summary", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Result should start with compaction summary
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(largeMessages.length);
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
    const firstContent = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
    expect(firstContent).toContain("<summary>");
    expect(firstContent).toContain("## Identifiers");

    // generateSummary called once (Level 1 success on first attempt)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

    // Info log emitted
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 1, attempts: 1 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 4. Level 1 retry then success
  // -------------------------------------------------------------------------

  it("retries Level 1 when first attempt returns incomplete summary", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // First attempt: incomplete summary
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    // Second attempt: valid summary
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Should succeed on second attempt
    expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Level 1 exhausted, Level 2 success
  // -------------------------------------------------------------------------

  it("falls to Level 2 after 3 failed Level 1 attempts", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // 3 failed Level 1 attempts (missing sections)
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    // Level 2: succeeds
    mockGenerateSummary.mockResolvedValueOnce("Level 2 summary without sections");

    const result = await layer.apply(largeMessages, BUDGET);

    // 3 Level 1 attempts + 1 Level 2 = 4 calls
    expect(mockGenerateSummary).toHaveBeenCalledTimes(4);
    expect(result[0]).toBeDefined();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 2 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 6. All levels exhausted, Level 3 fallback
  // -------------------------------------------------------------------------

  it("falls to Level 3 count-only note when all LLM calls fail", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // All attempts throw
    mockGenerateSummary.mockRejectedValue(new Error("LLM unavailable"));

    const result = await layer.apply(largeMessages, BUDGET);

    // Level 3: count-only note
    const firstContent = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
    expect(firstContent).toContain("[Context compacted:");
    expect(firstContent).toContain("messages summarized");
    expect(firstContent).toContain("No LLM summary available");

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 3 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 7. Session persistence
  // -------------------------------------------------------------------------

  it("persists compaction to SessionManager via fileEntries and _rewriteFile", async () => {
    const { deps, mockSm } = createMockDeps();

    // Populate fileEntries with message entries
    mockSm.fileEntries = [
      { type: "message", message: { role: "user", content: "Q1" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
      { type: "message", message: { role: "user", content: "Q2" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } },
    ];

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // _rewriteFile should have been called
    expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

    // fileEntries should start with the compaction summary entry
    const firstEntry = mockSm.fileEntries[0] as { type: string; message: { compactionSummary: boolean; content: Array<{ text: string }> } };
    expect(firstEntry.type).toBe("message");
    expect(firstEntry.message.compactionSummary).toBe(true);
    expect(firstEntry.message.content[0].text).toContain("<summary>");
  });

  // -------------------------------------------------------------------------
  // 8. Model override fallback
  // -------------------------------------------------------------------------

  it("falls back to session model when override model apiKey throws", async () => {
    const { deps, logger } = createMockDeps({
      overrideModel: {
        model: { id: "cheap-model", provider: "groq" },
        getApiKey: vi.fn().mockRejectedValue(new Error("No API key for groq")),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Should still succeed using session model
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);

    // WARN log about override failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Compaction model override failed; falling back to session model",
      }),
      "Compaction model override resolution failed",
    );

    // getApiKey on the main deps should have been called as fallback
    expect(deps.getApiKey).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. Cooldown resets after compaction
  // -------------------------------------------------------------------------

  it("resets cooldown after successful compaction, re-triggers after cooldown expires", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 3 }, deps);
    const largeMessages = buildLargeConversation();

    // First compaction
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    await layer.apply(largeMessages, BUDGET);

    // Turns 1-2: within cooldown (cooldown=3)
    const result1 = await layer.apply(largeMessages, BUDGET);
    expect(result1).toBe(largeMessages);
    const result2 = await layer.apply(largeMessages, BUDGET);
    expect(result2).toBe(largeMessages);

    // Turn 3: cooldown expired, should trigger again
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    const result3 = await layer.apply(largeMessages, BUDGET);
    expect(result3).not.toBe(largeMessages);
    expect((result3[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. WARN-level log on compaction trigger
  // -------------------------------------------------------------------------

  it("emits WARN-level log (not DEBUG) when compaction triggers with errorKind and hint", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // WARN must be called with the compaction trigger message
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokens: expect.any(Number),
        thresholdTokens: expect.any(Number),
        windowTokens: 128_000,
        messageCount: largeMessages.length,
        errorKind: "resource",
        hint: expect.stringMatching(/compaction/i),
      }),
      "LLM compaction triggered: context exceeds 85% threshold",
    );

    // DEBUG must NOT have been called with the trigger message
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const triggerDebugCalls = debugCalls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("LLM compaction triggered"),
    );
    expect(triggerDebugCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Layer name
  // -------------------------------------------------------------------------

  it("has name 'llm-compaction'", () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    expect(layer.name).toBe("llm-compaction");
  });

  // -------------------------------------------------------------------------
  // Error safety net
  // -------------------------------------------------------------------------

  it("returns unmodified messages if getApiKey throws (safety net)", async () => {
    const { deps, logger } = createMockDeps();
    (deps.getApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("No key"));
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    const result = await layer.apply(largeMessages, BUDGET);

    // Safety net returns original messages
    expect(result).toBe(largeMessages);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "LLM compaction failed; returning unmodified context",
      }),
      "LLM compaction layer error",
    );
  });

  // -------------------------------------------------------------------------
  // R-07: Repeated compaction safety
  // -------------------------------------------------------------------------

  describe("R-07: repeated compaction safety", () => {
    it("Level 1 compaction across 3 cycles preserves message content", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // --- Cycle 1 ---
      const cycle1Summary = buildValidSummary();
      mockGenerateSummary.mockResolvedValueOnce(cycle1Summary);
      const cycle1Messages = buildLargeConversation();
      const cycle1Result = await layer.apply(cycle1Messages, BUDGET);

      // Cycle 1 assertions
      expect((cycle1Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      const cycle1Content = (cycle1Result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      expect(cycle1Content).toContain("<summary>");
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // --- Cycle 2 ---
      mockGenerateSummary.mockClear();
      const cycle2Summary = buildValidSummary().replace("test-agent", "test-agent-cycle2");
      mockGenerateSummary.mockResolvedValueOnce(cycle2Summary);

      // Build cycle 2 messages: cycle 1 summary + new large content
      const cycle2NewMessages = buildLargeConversation();
      const messagesForCycle2 = [cycle1Result[0], ...cycle2NewMessages];
      const cycle2Result = await layer.apply(messagesForCycle2, BUDGET);

      // Cycle 2 assertions
      expect((cycle2Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // Verify generateSummary received cycle 1 summary in its currentMessages argument
      const cycle2CallMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
      const cycle1SummaryInInput = cycle2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("test-agent"));
        },
      );
      expect(cycle1SummaryInInput).toBe(true);

      // --- Cycle 3 ---
      mockGenerateSummary.mockClear();
      const cycle3Summary = buildValidSummary().replace("test-agent", "test-agent-cycle3");
      mockGenerateSummary.mockResolvedValueOnce(cycle3Summary);

      // Build cycle 3 messages: cycle 2 summary + new large content
      const cycle3NewMessages = buildLargeConversation();
      const messagesForCycle3 = [cycle2Result[0], ...cycle3NewMessages];
      const cycle3Result = await layer.apply(messagesForCycle3, BUDGET);

      // Cycle 3 assertions
      expect((cycle3Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // Verify generateSummary received cycle 2 summary in its currentMessages argument
      const cycle3CallMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
      const cycle2SummaryInInput = cycle3CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("test-agent-cycle2"));
        },
      );
      expect(cycle2SummaryInInput).toBe(true);
    });

    it("Level 2 fallback across 3 cycles preserves prior summaries", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // Helper to mock one Level 2 cycle: 3 L1 failures + 1 L2 success
      function mockLevel2Cycle(summaryText: string): void {
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(summaryText);
      }

      // --- Cycle 1 (Level 2 path) ---
      mockLevel2Cycle("Cycle 1 L2 summary: user discussed API design");
      const cycle1Messages = buildLargeConversation();
      const cycle1Result = await layer.apply(cycle1Messages, BUDGET);

      expect(cycle1Result[0]).toBeDefined();
      expect((cycle1Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4); // 3 L1 fails + 1 L2 success

      // --- Cycle 2 (Level 2 path) ---
      mockGenerateSummary.mockClear();
      mockLevel2Cycle("Cycle 2 L2 summary: user discussed testing strategy");
      const cycle2NewMessages = buildLargeConversation();
      const messagesForCycle2 = [cycle1Result[0], ...cycle2NewMessages];
      const cycle2Result = await layer.apply(messagesForCycle2, BUDGET);

      expect((cycle2Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4);

      // Verify: the Level 2 call (4th call) received cycle 1 summary in its filtered messages
      const cycle2L2CallMessages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];
      const cycle1SummaryInL2Input = cycle2L2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Cycle 1 L2 summary"));
        },
      );
      expect(cycle1SummaryInL2Input).toBe(true);

      // --- Cycle 3 (Level 2 path) ---
      mockGenerateSummary.mockClear();
      mockLevel2Cycle("Cycle 3 L2 summary: user discussed deployment");
      const cycle3NewMessages = buildLargeConversation();
      const messagesForCycle3 = [cycle2Result[0], ...cycle3NewMessages];
      const cycle3Result = await layer.apply(messagesForCycle3, BUDGET);

      expect((cycle3Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4);

      // Verify: the Level 2 call (4th call) received cycle 2 summary
      const cycle3L2CallMessages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];
      const cycle2SummaryInL2Input = cycle3L2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Cycle 2 L2 summary"));
        },
      );
      expect(cycle2SummaryInL2Input).toBe(true);
    });

    it("Level 2 filtering does not drop compaction summary messages (< 50K chars)", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // Step 1: Create a compaction summary message (~2K chars, well below 50K)
      const priorSummaryContent = "Prior compaction summary: " + "x".repeat(2000);
      const priorSummary: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: `<summary>\n${priorSummaryContent}\n</summary>` }],
        compactionSummary: true,
      } as unknown as AgentMessage;

      // Step 2: Create oversized messages (each >50K chars to trigger Level 2 filtering)
      const oversizedContent = "z".repeat(OVERSIZED_MESSAGE_CHARS_THRESHOLD + 10_000);
      const oversized1 = makeUserMsg(oversizedContent);
      const oversized2 = makeAssistantMsg(oversizedContent);

      // Step 3: Create normal-sized messages
      const normalMessages = buildLargeConversation(400_000);

      // Step 4: Build message array with prior summary + oversized + normal
      const allMessages = [priorSummary, oversized1, oversized2, ...normalMessages];

      // Step 5: Mock Level 2 path (3 L1 failures + 1 L2 success)
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce("Level 2 summary after filtering");

      const result = await layer.apply(allMessages, BUDGET);
      expect(result[0]).toBeDefined();

      // Step 6: Inspect the 4th call (Level 2) -- the filtered message set
      const level2Messages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];

      // The compaction summary (~2K chars) should be INCLUDED
      const summaryPresent = level2Messages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Prior compaction summary"));
        },
      );
      expect(summaryPresent).toBe(true);

      // Oversized messages (>50K chars) should be EXCLUDED
      const oversizedPresent = level2Messages.some(
        (m) => {
          const content = (m as unknown as { content: string | Array<{ text: string }> }).content;
          if (typeof content === "string") return content.length > OVERSIZED_MESSAGE_CHARS_THRESHOLD;
          if (Array.isArray(content)) return content.some((c) => c.text?.length > OVERSIZED_MESSAGE_CHARS_THRESHOLD);
          return false;
        },
      );
      expect(oversizedPresent).toBe(false);

      // Normal-sized messages should be INCLUDED
      expect(level2Messages.length).toBeGreaterThan(1); // at least summary + some normal messages
    });
  });
});

// ---------------------------------------------------------------------------
// discoveredTools metadata in compaction
// ---------------------------------------------------------------------------

describe("discoveredTools metadata in compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("compaction summary message includes discoveredTools from deps", async () => {
    const { deps } = createMockDeps();
    deps.getDiscoveredTools = () => ["tool_a", "tool_b"];
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Summary message should carry discoveredTools metadata
    const summaryMsg = result[0] as unknown as { compactionSummary: boolean; discoveredTools: string[] };
    expect(summaryMsg.compactionSummary).toBe(true);
    expect(summaryMsg.discoveredTools).toEqual(["tool_a", "tool_b"]);
  });

  it("compaction summary includes empty discoveredTools when getter returns empty", async () => {
    const { deps } = createMockDeps();
    deps.getDiscoveredTools = () => [];
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    const summaryMsg = result[0] as unknown as { discoveredTools: string[] };
    expect(summaryMsg.discoveredTools).toEqual([]);
  });

  it("compaction summary includes empty discoveredTools when getter undefined", async () => {
    const { deps } = createMockDeps();
    // getDiscoveredTools is not set (undefined by default in createMockDeps)
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    const summaryMsg = result[0] as unknown as { discoveredTools: string[] };
    expect(summaryMsg.discoveredTools).toEqual([]);
  });

  it("persistCompaction writes discoveredTools to compaction entry", async () => {
    const { deps, mockSm } = createMockDeps();
    deps.getDiscoveredTools = () => ["mcp_search", "mcp_analyze"];

    // Populate fileEntries with message entries
    mockSm.fileEntries = [
      { type: "message", message: { role: "user", content: "Q1" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
    ];

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // Inspect the persisted compaction entry in fileEntries
    const compactionEntry = mockSm.fileEntries[0] as {
      type: string;
      message: { compactionSummary: boolean; discoveredTools: string[]; content: Array<{ text: string }> };
    };
    expect(compactionEntry.type).toBe("message");
    expect(compactionEntry.message.compactionSummary).toBe(true);
    expect(compactionEntry.message.discoveredTools).toEqual(["mcp_search", "mcp_analyze"]);
    expect(compactionEntry.message.content[0].text).toContain("<summary>");
  });
});

// ---------------------------------------------------------------------------
// Resolver-integrated compaction model (overrideModel contract)
// ---------------------------------------------------------------------------
// These tests verify the downstream consumption contract that pi-executor's
// resolver-based getCompactionDeps relies on. The overrideModel is now
// populated by resolveOperationModel in pi-executor, rather than
// ad-hoc string parsing. These tests verify:
// 1. overrideModel.model is used for generateSummary when present
// 2. Fallback to getModel() when overrideModel is absent
// 3. overrideModel.getApiKey is used instead of primary getApiKey

describe("resolver-integrated compaction model selection", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("uses override model from resolver for compaction generateSummary call", async () => {
    const overrideModelObj = {
      id: "gemini-2.0-flash",
      provider: "google",
      contextWindow: 1_000_000,
      reasoning: false,
    };
    const { deps } = createMockDeps({
      overrideModel: {
        model: overrideModelObj,
        getApiKey: vi.fn().mockResolvedValue("google-api-key"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // generateSummary should have been called with the override model (2nd arg)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toBe(overrideModelObj);

    // API key should be from the override, not the primary
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("google-api-key");
  });

  it("falls through to session model when no overrideModel is provided (agent_primary source)", async () => {
    const { deps } = createMockDeps(); // No overrideModel
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // generateSummary should have been called with getModel() result (2nd arg)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toEqual({
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      contextWindow: 128_000,
      reasoning: true,
    });

    // API key should be from primary getApiKey
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("test-api-key");
  });

  it("override model API key uses resolved provider (not agent primary)", async () => {
    const googleOverrideKey = "google-resolved-provider-key";
    const { deps } = createMockDeps({
      overrideModel: {
        model: { id: "gemini-2.5-flash", provider: "google" },
        getApiKey: vi.fn().mockResolvedValue(googleOverrideKey),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // API key passed to generateSummary must be the override provider's key
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe(googleOverrideKey);

    // Primary getApiKey should NOT have been called
    expect(deps.getApiKey).not.toHaveBeenCalled();
  });

  it("overrideModel takes highest priority for compaction", async () => {
    // This test verifies the contract: when pi-executor passes overrideModel
    // (resolved via operationModels chain), that model is used for compaction,
    // not the session model.
    const subAgentCompactionModel = {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      contextWindow: 200_000,
      reasoning: false,
    };
    const { deps } = createMockDeps({
      overrideModel: {
        model: subAgentCompactionModel,
        getApiKey: vi.fn().mockResolvedValue("sub-agent-key"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // The sub-agent compaction model should be passed to generateSummary
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toBe(subAgentCompactionModel);
    expect(modelArg.id).toBe("claude-haiku-4-5-20251001");
    expect(modelArg.provider).toBe("anthropic");

    // Sub-agent's API key used
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("sub-agent-key");
  });
});

// ---------------------------------------------------------------------------
// validateCompactionSummary
// ---------------------------------------------------------------------------

describe("validateCompactionSummary", () => {
  it("returns valid=true for summary with all 9 required sections", () => {
    const result = validateCompactionSummary(buildValidSummary());
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it("returns valid=false with missing sections listed", () => {
    const result = validateCompactionSummary(buildIncompleteSummary());
    expect(result.valid).toBe(false);
    // Should be missing 6 sections (has Identifiers, Decisions, Constraints)
    expect(result.missingSections).toContain("Primary Request and Intent");
    expect(result.missingSections).toContain("Files and Code");
    expect(result.missingSections).toContain("Errors and Resolutions");
    expect(result.missingSections).toContain("User Messages");
    expect(result.missingSections).toContain("Active Work");
    expect(result.missingSections).toContain("Next Steps");
  });

  it("matches section headings case-insensitively", () => {
    let summary = "";
    for (const section of COMPACTION_REQUIRED_SECTIONS) {
      summary += `## ${section.toUpperCase()}\n- content\n\n`;
    }
    const result = validateCompactionSummary(summary);
    expect(result.valid).toBe(true);
  });

  it("returns all 9 sections as missing for empty string", () => {
    const result = validateCompactionSummary("");
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Anchor-based estimation in compaction
// ---------------------------------------------------------------------------

describe("anchor-based estimation in compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("compaction uses anchor for threshold check when getTokenAnchor returns non-null", async () => {
    const { deps, logger } = createMockDeps();
    // Provide an anchor saying we have 120,000 input tokens (above 85% of 128K = 108,800)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000,
      messageCount: 20,
      timestamp: Date.now(),
    });

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    // Use a moderate-size conversation that would NOT trigger char-based compaction
    // but has enough messages (and large enough middle) for three-zone to proceed.
    // Tail budget = 76_408 * 4 = 305,632 chars. Each message ~50K chars. Tail fits ~6 messages.
    // 10 messages total - 0 head (no prefixAnchorTurns) - 6 tail = 4 middle (>= 3 minimum).
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(50_000)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(50_000)));
    }

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // With the anchor reporting 120K tokens, compaction should trigger even though
    // the actual char-based estimate is below threshold
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokens: expect.any(Number),
        hint: expect.stringMatching(/compaction/i),
      }),
      "LLM compaction triggered: context exceeds 85% threshold",
    );
    expect(mockGenerateSummary).toHaveBeenCalled();
  });

  it("compaction falls back to char-based when getTokenAnchor returns null", async () => {
    const { deps } = createMockDeps();
    deps.getTokenAnchor = () => null;

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    // Small conversation with null anchor: char-based estimate is below threshold
    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("compaction falls back to char-based when getTokenAnchor is not provided", async () => {
    const { deps } = createMockDeps();
    // getTokenAnchor is undefined by default in createMockDeps

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    // No anchor, small conversation: char-based below threshold
    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Three-zone middle-out compaction
// ---------------------------------------------------------------------------

describe("three-zone middle-out compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  /**
   * Build a large conversation of user+assistant pairs.
   * Each message has ~charsPerMsg chars, producing `pairCount` pairs
   * (2 * pairCount messages total).
   *
   * Head budget = availableHistoryTokens * 4 = 76,408 * 4 = 305,632 chars.
   * Compaction trigger = 128K * 85% * 4 = 435,200 chars.
   * Use small head messages (~10K each, 4 * 10K = 40K < 305K budget)
   * and large middle/tail messages (~200K each) to exceed trigger threshold.
   */
  function buildThreeZoneConversation(pairCount: number, headCharsPerMsg = 10_000, bodyCharsPerMsg = 200_000): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < pairCount; i++) {
      const chars = i < 2 ? headCharsPerMsg : bodyCharsPerMsg;
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(chars)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(chars)));
    }
    return messages;
  }

  // -------------------------------------------------------------------------
  // Test 1: Head preservation and middle-only summarization
  // -------------------------------------------------------------------------

  it("preserves head messages and summarizes only middle zone", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // 5 user+assistant pairs = 10 messages.
    // Head (first 2 pairs): ~10K chars each = ~40K (fits 305K budget).
    // Body (pairs 3-5): ~200K chars each = ~1.2M total. Well above 435K trigger.
    const messages = buildThreeZoneConversation(5);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head = first 2 user-turn cycles = messages[0..3] (user0, assistant0, user1, assistant1)
    // These must be the SAME object references (not copies)
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toBe(messages[2]);
    expect(result[3]).toBe(messages[3]);

    // Position 4 is the compaction summary
    const summaryMsg = result[4] as unknown as { compactionSummary: boolean; content: Array<{ text: string }> };
    expect(summaryMsg.compactionSummary).toBe(true);
    expect(summaryMsg.content[0].text).toContain("<summary>");

    // generateSummary must NOT have received head or tail messages
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    // Head messages (0-3) should NOT be in the summarized set
    expect(summarizedMessages).not.toContain(messages[0]);
    expect(summarizedMessages).not.toContain(messages[1]);
    expect(summarizedMessages).not.toContain(messages[2]);
    expect(summarizedMessages).not.toContain(messages[3]);

    // Result ends with tail messages (last messages fitting budget)
    const lastResult = result[result.length - 1];
    expect(lastResult).toBe(messages[messages.length - 1]);
  });

  // -------------------------------------------------------------------------
  // Test 2: prefixAnchorTurns=0 backward compatibility
  // -------------------------------------------------------------------------

  it("prefixAnchorTurns=0 uses tail-only behavior (backward compatible)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 0 },
      deps,
    );
    const messages = buildThreeZoneConversation(5);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // With prefixAnchorTurns=0, head is empty, so generateSummary receives the full middle
    // (all messages except tail)
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    // The summarized set should contain some of the initial messages (no head preserved)
    expect(summarizedMessages).toContain(messages[0]);

    // Result[0] is the compaction summary (no preserved head)
    const firstMsg = result[0] as unknown as { compactionSummary: boolean };
    expect(firstMsg.compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Head exceeds budget falls back to tail-only
  // -------------------------------------------------------------------------

  it("falls back to tail-only when head exceeds budget", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Budget chars = availableHistoryTokens * 4 = 76_408 * 4 = 305,632
    // Head = first 2 user turns (4 messages). At 100K chars each = 400K, exceeds 305K budget.
    // Use large head messages to trigger the fallback.
    const messages = buildThreeZoneConversation(5, 100_000, 200_000);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head exceeded budget, so it falls back to tail-only
    // Result[0] should be the compaction summary (no preserved head)
    const firstMsg = result[0] as unknown as { compactionSummary: boolean };
    expect(firstMsg.compactionSummary).toBe(true);

    // WARN log about falling back
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Head exceeds budget; falling back to tail-only compaction",
      }),
      "Cache-preserving compaction fallback to tail-only",
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: Middle too small, skip compaction
  // -------------------------------------------------------------------------

  it("skips compaction when middle zone is too small", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Use anchor to force threshold exceeded (small messages wouldn't trigger char-based)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000, // above 85% of 128K = 108,800
      messageCount: 6,
      timestamp: Date.now(),
    });
    // 3 user+assistant pairs = 6 messages. Head = 4 (2 user turns).
    // Budget is large enough for all remaining 2 messages as tail.
    // So middle = 6 - 4 (head) - 2 (tail) = 0, which is below MIN_MIDDLE_MESSAGES_FOR_COMPACTION (3).
    const messages: AgentMessage[] = [
      makeUserMsg("Q0: " + "x".repeat(1_000)),
      makeAssistantMsg("A0: " + "y".repeat(1_000)),
      makeUserMsg("Q1: " + "x".repeat(1_000)),
      makeAssistantMsg("A1: " + "y".repeat(1_000)),
      makeUserMsg("Q2: " + "x".repeat(1_000)),
      makeAssistantMsg("A2: " + "y".repeat(1_000)),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Middle too small, so compaction is skipped
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  // -------------------------------------------------------------------------
  // Test 5: Pair safety extends head boundary
  // -------------------------------------------------------------------------

  it("extends head boundary for pair safety (tool_use/tool_result)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 1 },
      deps,
    );

    // user0, assistantWithToolUse0, toolResult0, user1, assistant1, ...more
    const assistantWithToolUse: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check..." + "z".repeat(50_000) },
        { type: "tool_use", id: "tc1", name: "web_search", input: { query: "test" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "tool_use",
      timestamp: Date.now(),
    } as AgentMessage;

    const messages: AgentMessage[] = [
      makeUserMsg("Q0: " + "x".repeat(50_000)),              // index 0 — head (1st user turn)
      assistantWithToolUse,                                    // index 1 — extended by pair safety
      makeToolResult("tc1", "web_search", "z".repeat(50_000)), // index 2 — extended by pair safety
      makeUserMsg("Q1: " + "x".repeat(100_000)),              // index 3 — middle
      makeAssistantMsg("A1: " + "y".repeat(100_000)),         // index 4 — middle
      makeUserMsg("Q2: " + "x".repeat(100_000)),              // index 5 — middle
      makeAssistantMsg("A2: " + "y".repeat(100_000)),         // index 6 — middle/tail
      makeUserMsg("Q3: " + "x".repeat(100_000)),              // index 7 — tail
      makeAssistantMsg("A3: " + "y".repeat(100_000)),         // index 8 — tail
    ];

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head should include user0, assistantWithToolUse, toolResult0 (3 messages via pair safety)
    expect(result[0]).toBe(messages[0]);   // user0
    expect(result[1]).toBe(messages[1]);   // assistantWithToolUse
    expect(result[2]).toBe(messages[2]);   // toolResult0

    // generateSummary should NOT include head messages
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(summarizedMessages).not.toContain(messages[0]);
    expect(summarizedMessages).not.toContain(messages[1]);
    expect(summarizedMessages).not.toContain(messages[2]);
  });

  // -------------------------------------------------------------------------
  // Test 6: persistCompaction preserves head entries
  // -------------------------------------------------------------------------

  it("persistCompaction preserves head entries and removes only middle", async () => {
    const { deps, mockSm } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );

    // 5 user+assistant pairs = 10 messages (small head, large body)
    const messages = buildThreeZoneConversation(5);

    // Pre-populate fileEntries matching the messages
    mockSm.fileEntries = messages.map((m) => ({ type: "message", message: m }));

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(messages, BUDGET);

    // Verify _rewriteFile was called
    expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

    // Head entries (first 4 message entries) should still be present
    const msgEntries = (mockSm.fileEntries as Array<{ type: string; message: unknown }>).filter(
      (e) => e.type === "message",
    );
    // First 4 should be original head messages
    expect(msgEntries[0].message).toBe(messages[0]);
    expect(msgEntries[1].message).toBe(messages[1]);
    expect(msgEntries[2].message).toBe(messages[2]);
    expect(msgEntries[3].message).toBe(messages[3]);

    // Next entry should be the compaction summary
    const summaryEntry = msgEntries[4] as { message: { compactionSummary: boolean; content: Array<{ text: string }> } };
    expect(summaryEntry.message.compactionSummary).toBe(true);
    expect(summaryEntry.message.content[0].text).toContain("<summary>");

    // Tail entries should be preserved (last messages from the array)
    const lastEntry = msgEntries[msgEntries.length - 1] as { message: AgentMessage };
    expect(lastEntry.message).toBe(messages[messages.length - 1]);

    // Total entries should be less than original 10 (middle removed, summary added)
    expect(msgEntries.length).toBeLessThan(10);
  });

  // -------------------------------------------------------------------------
  // Test 7: Empty middle returns unchanged
  // -------------------------------------------------------------------------

  it("empty middle with all messages fitting in head+tail returns unchanged", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Use anchor to force threshold exceeded (small messages wouldn't trigger char-based)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000,
      messageCount: 4,
      timestamp: Date.now(),
    });
    // 2 user+assistant pairs = 4 messages with small content
    // Head covers all 4 (2 user turns). Tail also covers them.
    // Middle = 0 messages.
    const messages: AgentMessage[] = [
      makeUserMsg("Q0: short question"),
      makeAssistantMsg("A0: short answer"),
      makeUserMsg("Q1: another question"),
      makeAssistantMsg("A1: another answer"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Middle is 0 (< MIN_MIDDLE_MESSAGES_FOR_COMPACTION), so no compaction
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });
});
