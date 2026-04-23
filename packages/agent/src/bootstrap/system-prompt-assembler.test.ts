// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { assembleRichSystemPrompt, assembleRichSystemPromptBlocks, SECTION_SEPARATOR, SECTIONS } from "./system-prompt-assembler.js";
import {
  buildDateTimeSection,
  buildRuntimeMetadataSection,
  buildPersonaSection,
  buildProjectContextSection,
  buildSafetySection,
  buildToolingSection,
  buildSkillsSection,
  buildSubagentContextSection,
  buildBackgroundTaskSection,
  buildMessagingSection,
  buildMemoryRecallSection,
  buildSilentRepliesSection,
  buildHeartbeatsSection,
  buildToolCallStyleSection,
  buildWorkspaceSection,
  buildSelfUpdateGatingSection,
  buildPrivilegedToolsSection,
  buildCodingFallbackSection,
  buildCompactedOutputRecoverySection,
  buildSubagentRoleSection,
  buildReactionGuidanceSection,
  buildReasoningSection,
  buildInboundMetadataSection,
  buildMediaFilesSection,
} from "./sections/index.js";
import type { BootstrapContextFile, InboundMetadata, RuntimeInfo } from "./types.js";
import type { SubagentRoleParams } from "./sections/index.js";

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt — mode tests
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt", () => {
  it("mode 'none' returns only identity lines", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "none",
      agentName: "TestBot",
    });

    expect(result).toContain(
      "You are TestBot, a personal AI assistant running inside Comis.",
    );
    expect(result).toContain("execute tools");
    // No section headings in "none" mode
    expect(result).not.toContain("##");
  });

  it("mode 'full' includes all sections when all params provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      agentName: "TestBot",
      toolNames: ["tool1", "message"],
      skillsPrompt: "skill info",
      hasMemoryTools: true,
      workspaceDir: "/tmp/ws",
      heartbeatPrompt: "check email",
      reasoningEnabled: true,
      runtimeInfo: {
        host: "myhost",
        os: "linux",
        arch: "x64",
        model: "claude-sonnet",
      },
      bootstrapFiles: [{ path: "AGENTS.md", content: "agent instructions" }],
    });

    expect(result).toContain("## Safety");
    expect(result).toContain("## Available Tools");
    expect(result).toContain("## Skills");
    expect(result).toContain("## Workspace");
    expect(result).toContain("## Runtime");
    expect(result).toContain("## Project Context");
    expect(result).toContain("---");
  });

  it("mode 'minimal' excludes safety, tool style, skills, memory, reply tags, messaging, silent, heartbeats, reasoning", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      agentName: "TestBot",
      toolNames: ["tool1", "message"],
      skillsPrompt: "skill info",
      hasMemoryTools: true,
      workspaceDir: "/tmp/ws",
      heartbeatPrompt: "check email",
      reasoningEnabled: true,
      runtimeInfo: {
        host: "myhost",
        os: "linux",
        arch: "x64",
        model: "claude-sonnet",
      },
      bootstrapFiles: [{ path: "AGENTS.md", content: "agent instructions" }],
    });

    // Excluded in minimal
    expect(result).not.toContain("## Safety");
    expect(result).not.toContain("## Tool Call Style");
    expect(result).not.toContain("## Skills");
    expect(result).not.toContain("## Memory");
    expect(result).not.toContain("## Reply Tags");
    expect(result).not.toContain("## Messaging");
    expect(result).not.toContain("## Silent Replies");
    expect(result).not.toContain("## Heartbeats");
    expect(result).not.toContain("## Extended Thinking");
    expect(result).not.toContain("## Self-Update & Configuration");
    expect(result).not.toContain("## Handling Compacted Output");
    expect(result).not.toContain("## Reactions");
    expect(result).not.toContain("## Reasoning Format");

    // Included in minimal
    expect(result).toContain("## Available Tools");
    expect(result).toContain("## Workspace");
    expect(result).toContain("## Runtime");
    expect(result).toContain("## Project Context");
  });

  it("mode 'full' defaults when promptMode omitted", () => {
    const result = assembleRichSystemPrompt({});

    // "full" mode includes Safety
    expect(result).toContain("## Safety");
  });

  it("defaults agentName to 'Comis' when not provided", () => {
    const result = assembleRichSystemPrompt({});

    expect(result).toContain("Comis");
  });

  it("additionalSections appended at end", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      additionalSections: ["## Memory\nSome memory context"],
    });

    expect(result).toContain("## Memory");
    expect(result).toContain("Some memory context");

    // Memory section should be after the last built-in section (after last ---)
    const lastSeparator = result.lastIndexOf("---");
    const memoryIndex = result.indexOf("## Memory\nSome memory context");
    expect(memoryIndex).toBeGreaterThan(lastSeparator);
  });
});

// ---------------------------------------------------------------------------
// Section builder tests
// ---------------------------------------------------------------------------

describe("buildDateTimeSection", () => {
  it("always returns date content", () => {
    const lines = buildDateTimeSection();

    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Contains ISO date pattern (YYYY-MM-DD)
    const joined = lines.join("\n");
    expect(joined).toMatch(/\d{4}-\d{2}-\d{2}/);
    // Contains timezone
    expect(joined).toMatch(/[A-Z]/);
  });
});

describe("buildRuntimeMetadataSection", () => {
  it("formats all fields with pipe separator", () => {
    const info: RuntimeInfo = {
      agentId: "bot-1",
      host: "myhost",
      os: "linux",
      arch: "x64",
      model: "claude-sonnet",
      thinkingLevel: "high",
    };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");

    expect(joined).toContain("agent=bot-1");
    expect(joined).toContain("host=myhost");
    expect(joined).toContain("os=linux (x64)");
    expect(joined).toContain("model=claude-sonnet");
    expect(joined).toContain("thinking=high");
    expect(joined).toContain(" | ");
  });

  it("omits empty fields", () => {
    const info: RuntimeInfo = { host: "myhost" };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");

    expect(joined).toContain("host=myhost");
    expect(joined).not.toContain("agent=");
    expect(joined).not.toContain("model=");
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeMetadataSection -- new fields
// ---------------------------------------------------------------------------

describe("buildRuntimeMetadataSection -- new fields", () => {
  it("renders nodeVersion as node=20.11.0", () => {
    const info: RuntimeInfo = { nodeVersion: "20.11.0" };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");
    expect(joined).toContain("node=20.11.0");
  });

  it("renders shell as shell=/bin/zsh", () => {
    const info: RuntimeInfo = { shell: "/bin/zsh" };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");
    expect(joined).toContain("shell=/bin/zsh");
  });

  it("renders defaultModel as default_model=claude-sonnet", () => {
    const info: RuntimeInfo = { defaultModel: "claude-sonnet" };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");
    expect(joined).toContain("default_model=claude-sonnet");
  });

  it("excludes channel field (relocated to dynamic preamble)", () => {
    const info: RuntimeInfo = { channel: "telegram" };
    const lines = buildRuntimeMetadataSection(info, false);
    // channel-only info produces empty result since channel is no longer rendered
    expect(lines).toEqual([]);
  });

  it("renders channelCapabilities as capabilities=reactions, threads", () => {
    const info: RuntimeInfo = { channelCapabilities: "reactions, threads" };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");
    expect(joined).toContain("capabilities=reactions, threads");
  });

  it("renders all 10 fields together with pipe separators (channel excluded)", () => {
    const info: RuntimeInfo = {
      agentId: "bot-1",
      host: "myhost",
      os: "linux",
      arch: "x64",
      model: "claude-sonnet",
      thinkingLevel: "high",
      nodeVersion: "20.11.0",
      shell: "/bin/zsh",
      defaultModel: "claude-sonnet",
      channel: "telegram",
      channelCapabilities: "reactions, threads",
    };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");

    expect(joined).toContain("agent=bot-1");
    expect(joined).toContain("host=myhost");
    expect(joined).toContain("os=linux (x64)");
    expect(joined).toContain("model=claude-sonnet");
    expect(joined).toContain("thinking=high");
    expect(joined).toContain("node=20.11.0");
    expect(joined).toContain("shell=/bin/zsh");
    expect(joined).toContain("default_model=claude-sonnet");
    // channel relocated to dynamic preamble
    expect(joined).not.toContain("channel=telegram");
    expect(joined).toContain("capabilities=reactions, threads");
    // 9 rendered parts (os+arch combined, channel excluded), so 8 pipe separators
    expect((joined.match(/ \| /g) ?? []).length).toBe(8);
  });

  it("omits new fields when undefined (existing behavior preserved)", () => {
    const info: RuntimeInfo = {
      agentId: "bot-1",
      host: "myhost",
    };
    const lines = buildRuntimeMetadataSection(info, false);
    const joined = lines.join("\n");

    expect(joined).toContain("agent=bot-1");
    expect(joined).toContain("host=myhost");
    expect(joined).not.toContain("node=");
    expect(joined).not.toContain("shell=");
    expect(joined).not.toContain("default_model=");
    expect(joined).not.toContain("channel=");
    expect(joined).not.toContain("capabilities=");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- runtime fields integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- runtime fields integration", () => {
  it("full prompt includes new runtime fields when runtimeInfo has them populated", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      agentName: "TestBot",
      runtimeInfo: {
        agentId: "test-bot",
        host: "myhost",
        os: "linux",
        arch: "x64",
        model: "claude-sonnet",
        nodeVersion: "20.11.0",
        shell: "/bin/zsh",
        defaultModel: "claude-sonnet",
        channel: "telegram",
        channelCapabilities: "reactions, threads",
      },
    });

    expect(result).toContain("## Runtime");
    expect(result).toContain("node=20.11.0");
    expect(result).toContain("shell=/bin/zsh");
    expect(result).toContain("default_model=claude-sonnet");
    // channel relocated to dynamic preamble
    expect(result).not.toContain("channel=telegram");
    expect(result).toContain("capabilities=reactions, threads");
  });

  it("full prompt omits new fields when runtimeInfo lacks them", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      runtimeInfo: {
        host: "myhost",
        os: "linux",
        model: "claude-sonnet",
      },
    });

    expect(result).toContain("## Runtime");
    expect(result).toContain("host=myhost");
    expect(result).not.toContain("node=");
    expect(result).not.toContain("shell=");
    expect(result).not.toContain("default_model=");
    expect(result).not.toContain("channel=");
    expect(result).not.toContain("capabilities=");
  });
});

describe("buildProjectContextSection", () => {
  it("wraps each file in heading", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "agent stuff" },
      { path: "TOOLS.md", content: "tool stuff" },
    ];
    const lines = buildProjectContextSection(files, false);
    const joined = lines.join("\n");

    expect(joined).toContain("### AGENTS.md");
    expect(joined).toContain("agent stuff");
    expect(joined).toContain("### TOOLS.md");
    expect(joined).toContain("tool stuff");
  });

  it("returns empty for no files", () => {
    const lines = buildProjectContextSection([], false);
    expect(lines).toEqual([]);
  });

  it("skips SOUL.md files (handled by buildPersonaSection)", () => {
    const files: BootstrapContextFile[] = [
      { path: "SOUL.md", content: "You are a pirate captain named Blackbeard." },
    ];
    const lines = buildProjectContextSection(files, false);
    expect(lines).toEqual([]);
  });

  it("does not inject persona instruction for non-SOUL.md files", () => {
    const files: BootstrapContextFile[] = [
      { path: "AGENTS.md", content: "Agent instructions here" },
    ];
    const lines = buildProjectContextSection(files, false);
    const joined = lines.join("\n");

    expect(joined).not.toContain("persona definition");
    expect(joined).not.toContain("Embody its personality");
  });

  it("skips SOUL.md case-insensitively", () => {
    const files: BootstrapContextFile[] = [
      { path: "soul.md", content: "Persona content" },
    ];
    const lines = buildProjectContextSection(files, false);
    expect(lines).toEqual([]);
  });
});

describe("buildSafetySection", () => {
  it("returns empty for minimal mode", () => {
    const lines = buildSafetySection(true);
    expect(lines).toEqual([]);
  });

  it("returns safety content for full mode", () => {
    const lines = buildSafetySection(false);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("## Safety");
  });

  it("includes constitutional principles in full mode", () => {
    const lines = buildSafetySection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("### Constitutional Principles");
    expect(joined).toContain("self-preservation, replication, resource acquisition, or power-seeking");
    expect(joined).toContain("### Operational Safety");
  });

  it("constitutional principles appear before operational safety", () => {
    const lines = buildSafetySection(false);
    const joined = lines.join("\n");
    const constitutionalIndex = joined.indexOf("### Constitutional Principles");
    const operationalIndex = joined.indexOf("### Operational Safety");
    expect(constitutionalIndex).toBeLessThan(operationalIndex);
  });

  it("includes honesty principle", () => {
    const lines = buildSafetySection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do not fabricate capabilities, knowledge, or tool results");
  });
});

describe("buildToolingSection", () => {
  it("renders tools as - name: summary format", () => {
    const lines = buildToolingSection(["read", "edit", "web_search"], false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Available Tools");
    expect(joined).toContain("- read: Read files, images, and PDFs with pagination");
    expect(joined).toContain("- edit: Batch edit files via text matching");
    expect(joined).toContain("- web_search: Search the web for information");
  });

  it("renders unknown tools without description", () => {
    const lines = buildToolingSection(["read", "my_custom_tool"], false);
    const joined = lines.join("\n");

    expect(joined).toContain("- read: Read files, images, and PDFs with pagination");
    expect(joined).toContain("- my_custom_tool");
    // Unknown tool should NOT have a colon+description
    expect(joined).not.toContain("- my_custom_tool:");
  });

  it("orders tools by TOOL_ORDER then extras alphabetically", () => {
    const lines = buildToolingSection(["web_search", "zzz_tool", "read", "aaa_tool"], false);
    const joined = lines.join("\n");

    const readIdx = joined.indexOf("- read:");
    const webIdx = joined.indexOf("- web_search:");
    const aaaIdx = joined.indexOf("- aaa_tool");
    const zzzIdx = joined.indexOf("- zzz_tool");

    // read before web_search (TOOL_ORDER)
    expect(readIdx).toBeLessThan(webIdx);
    // extras after all TOOL_ORDER entries
    expect(aaaIdx).toBeGreaterThan(webIdx);
    // extras sorted alphabetically
    expect(aaaIdx).toBeLessThan(zzzIdx);
  });

  it("merges caller-provided toolSummaries", () => {
    const lines = buildToolingSection(
      ["read", "my_mcp_tool"],
      false,
      { my_mcp_tool: "Custom MCP tool for data processing" },
    );
    const joined = lines.join("\n");

    expect(joined).toContain("- my_mcp_tool: Custom MCP tool for data processing");
  });

  it("included in minimal mode", () => {
    const lines = buildToolingSection(["read", "edit"], true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("- read:");
  });

  it("returns empty when no tools", () => {
    const lines = buildToolingSection([], false);
    expect(lines).toEqual([]);
  });

  it("includes anti-hallucination rule", () => {
    const lines = buildToolingSection(["read"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("Never guess or fabricate tool results");
  });
});

describe("buildSubagentContextSection", () => {
  it("returns context when extraSystemPrompt provided", () => {
    const lines = buildSubagentContextSection("Extra context for sub-agent");
    const joined = lines.join("\n");

    expect(joined).toContain("## Additional Context");
    expect(joined).toContain("Extra context for sub-agent");
  });

  it("returns empty when no extraSystemPrompt", () => {
    expect(buildSubagentContextSection(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSubagentRoleSection — unit tests
// ---------------------------------------------------------------------------

describe("buildSubagentRoleSection", () => {
  it("returns empty when params undefined", () => {
    expect(buildSubagentRoleSection(undefined)).toEqual([]);
  });

  it("renders structured role with all sections", () => {
    const params: SubagentRoleParams = { task: "Analyze the log files" };
    const lines = buildSubagentRoleSection(params);
    const joined = lines.join("\n");

    expect(joined).toContain("## Subagent Role");
    expect(joined).toContain("### Your Task");
    expect(joined).toContain("Analyze the log files");
    expect(joined).toContain("### Rules");
    expect(joined).toContain("### Output Format");
    expect(joined).toContain("### Anti-Patterns");
  });

  it("includes all 6 behavioral rules", () => {
    const params: SubagentRoleParams = { task: "test task" };
    const lines = buildSubagentRoleSection(params);
    const joined = lines.join("\n");

    expect(joined).toContain("Stay focused");
    expect(joined).toContain("Complete the task");
    expect(joined).toContain("No side quests");
    expect(joined).toContain("Be ephemeral");
    expect(joined).toContain("Trust push-based completion");
    expect(joined).toContain("Handle compacted output");
  });

  it("uses 'main agent' label at depth 1", () => {
    const params: SubagentRoleParams = { task: "test", depth: 1 };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).toContain("main agent");
    expect(joined).not.toContain("parent orchestrator");
  });

  it("uses 'parent orchestrator' label at depth >= 2", () => {
    const params: SubagentRoleParams = { task: "test", depth: 2 };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).toContain("parent orchestrator");
  });

  it("shows spawn guidance when depth < maxSpawnDepth", () => {
    const params: SubagentRoleParams = { task: "test", depth: 1, maxSpawnDepth: 3 };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).toContain("You CAN spawn your own sub-agents");
    expect(joined).not.toContain("leaf worker");
  });

  it("shows leaf worker when depth >= maxSpawnDepth", () => {
    const params: SubagentRoleParams = { task: "test", depth: 2, maxSpawnDepth: 2 };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).toContain("leaf worker");
    expect(joined).toContain("CANNOT spawn");
  });

  it("appends extraContext when provided", () => {
    const params: SubagentRoleParams = { task: "test", extraContext: "You have access to the database." };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).toContain("### Additional Context");
    expect(joined).toContain("You have access to the database.");
  });

  it("omits extraContext section when not provided", () => {
    const params: SubagentRoleParams = { task: "test" };
    const joined = buildSubagentRoleSection(params).join("\n");
    expect(joined).not.toContain("### Additional Context");
  });
});

// ---------------------------------------------------------------------------
// buildSelfUpdateGatingSection — unit tests
// ---------------------------------------------------------------------------

describe("buildSelfUpdateGatingSection", () => {
  it("returns empty in minimal mode", () => {
    expect(buildSelfUpdateGatingSection(["gateway"], true)).toEqual([]);
  });

  it("returns empty when no admin tools present", () => {
    expect(buildSelfUpdateGatingSection(["read", "edit"], false)).toEqual([]);
  });

  it("appears when gateway tool is present", () => {
    const lines = buildSelfUpdateGatingSection(["read", "gateway", "edit"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("## Self-Update & Configuration");
    expect(joined).toContain("ONLY allowed when the user explicitly asks");
  });

  it("includes confirmation guidance for ambiguous requests", () => {
    const lines = buildSelfUpdateGatingSection(["gateway"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("ask the user for confirmation first");
  });

  it("mentions auto-reconnect after restart", () => {
    const lines = buildSelfUpdateGatingSection(["gateway"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("automatically reconnect");
  });
});

// ---------------------------------------------------------------------------
// buildCompactedOutputRecoverySection — unit tests
// ---------------------------------------------------------------------------

describe("buildCompactedOutputRecoverySection", () => {
  it("returns empty in minimal mode", () => {
    expect(buildCompactedOutputRecoverySection(true)).toEqual([]);
  });

  it("includes section heading and markers", () => {
    const lines = buildCompactedOutputRecoverySection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("## Handling Compacted Output");
    expect(joined).toContain("[compacted]");
    expect(joined).toContain("[truncated]");
  });

  it("includes re-read strategy", () => {
    const lines = buildCompactedOutputRecoverySection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("smaller chunks");
    expect(joined).toContain("offset/limit");
    expect(joined).toContain("targeted `grep` searches");
  });

  it("warns against re-requesting full content", () => {
    const lines = buildCompactedOutputRecoverySection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do NOT request the full content again");
  });
});

// ---------------------------------------------------------------------------
// Canary token injection (relocated to dynamic preamble)
// ---------------------------------------------------------------------------

describe("canary token injection (relocated to dynamic preamble)", () => {
  it("assembler no longer injects canary token", () => {
    const result = assembleRichSystemPrompt({
      agentName: "TestAgent",
      promptMode: "full",
    });
    expect(result).not.toContain("CTKN_");
    expect(result).not.toContain("Internal verification token");
  });
});


// ---------------------------------------------------------------------------
// Unified tooling assembler integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- coding tools integration", () => {
  it("full mode renders tools as name: description format", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read", "edit", "write", "grep", "find", "ls", "web_search"],
    });

    // Unified format: `- name: summary` (TOOL_SUMMARIES)
    expect(result).toContain("- read: Read files, images, and PDFs with pagination");
    expect(result).toContain("- edit: Batch edit files via text matching");
    expect(result).toContain("- web_search: Search the web for information");
    // No separate coding tools section
    expect(result).not.toContain("## Coding Tools");
  });

  it("minimal mode still includes unified tooling section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      toolNames: ["read", "edit", "write"],
    });

    expect(result).toContain("## Available Tools");
    expect(result).toContain("- read:");
    expect(result).not.toContain("## Coding Tools");
  });
});

// ---------------------------------------------------------------------------
// buildSkillsSection -- skill selection framework
// ---------------------------------------------------------------------------

describe("buildSkillsSection -- skill selection framework", () => {
  it("includes 3-branch decision framework", () => {
    const lines = buildSkillsSection("skill listing here", false);
    const joined = lines.join("\n");

    expect(joined).toContain("exactly one skill clearly applies");
    expect(joined).toContain("multiple could apply");
    expect(joined).toContain("none clearly apply");
  });

  it("includes never-read-more-than-one constraint", () => {
    const lines = buildSkillsSection("skill listing here", false);
    const joined = lines.join("\n");
    expect(joined).toContain("Never read more than one skill up front");
  });

  it("appends skillsPrompt after the framework", () => {
    const lines = buildSkillsSection("my-skill-listing", false);
    const joined = lines.join("\n");

    const frameworkIdx = joined.indexOf("Never read more than one");
    const listingIdx = joined.indexOf("my-skill-listing");
    expect(frameworkIdx).toBeLessThan(listingIdx);
  });

  it("returns empty in minimal mode", () => {
    expect(buildSkillsSection("skills", true)).toEqual([]);
  });

  it("returns empty when no skillsPrompt", () => {
    expect(buildSkillsSection(undefined, false)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prompt skills integration
// ---------------------------------------------------------------------------

describe("prompt skills integration", () => {
  it("available_skills XML appears in full-mode system prompt under merged Skills section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      promptSkillsXml:
        '<available_skills>\n  <skill>\n    <name>greet</name>\n    <description>Greet user</description>\n    <location>/skills/greet</location>\n  </skill>\n</available_skills>',
    });

    expect(result).toContain("## Skills");
    expect(result).toContain("### Prompt Skills");
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>greet</name>");
  });

  it("active skill content appears in full-mode system prompt under merged Skills section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      activePromptSkillContent:
        '<skill name="deploy" location="/skills/deploy">\nDeploy instructions.\n</skill>',
    });

    expect(result).toContain("## Skills");
    expect(result).toContain("### Prompt Skills");
    expect(result).toContain('<skill name="deploy"');
    expect(result).toContain("Deploy instructions.");
  });

  it("minimal mode omits all prompt skill content", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      promptSkillsXml:
        '<available_skills>\n  <skill>\n    <name>greet</name>\n  </skill>\n</available_skills>',
      activePromptSkillContent:
        '<skill name="deploy">Deploy instructions.</skill>',
    });

    expect(result).not.toContain("## Skills");
    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("<skill");
  });

  it("AssemblerParams accepts promptSkillsXml and activePromptSkillContent", () => {
    const result = assembleRichSystemPrompt({
      promptSkillsXml: "xml",
      activePromptSkillContent: "content",
    });

    // TypeScript compilation is the real test -- the fields exist on AssemblerParams
    expect(result).toContain("xml");
    expect(result).toContain("content");
  });

  // canary token ordering test removed (canary relocated to dynamic preamble)
});

// ---------------------------------------------------------------------------
// buildBackgroundTaskSection — unit tests
// ---------------------------------------------------------------------------

describe("buildBackgroundTaskSection", () => {
  it("returns [] when isMinimal is true", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], true);
    expect(lines).toEqual([]);
  });

  it("returns [] when sessions_spawn tool is not in toolNames", () => {
    const lines = buildBackgroundTaskSection(["read", "memory_search"], false);
    expect(lines).toEqual([]);
  });

  it("returns background task section without channel context when omitted", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Background Tasks");
    expect(joined).toContain("announce_channel_type and announce_channel_id");
    expect(joined).not.toContain("Your current channel is");
  });

  it("includes channel context when provided", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], false, {
      channelType: "telegram",
      channelId: "chat-12345",
    });
    const joined = lines.join("\n");

    expect(joined).toContain("## Background Tasks");
    expect(joined).toContain('Your current channel is "telegram" (ID: "chat-12345")');
    expect(joined).toContain('announce_channel_type="telegram"');
    expect(joined).toContain('announce_channel_id="chat-12345"');
  });

  it("includes discord channel context", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], false, {
      channelType: "discord",
      channelId: "guild-channel-99",
    });
    const joined = lines.join("\n");

    expect(joined).toContain('announce_channel_type="discord"');
    expect(joined).toContain('announce_channel_id="guild-channel-99"');
  });

  it("includes push-based completion model", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("### Completion Model");
    expect(joined).toContain("push-based");
    expect(joined).toContain("automatically announced");
  });

  it("includes anti-poll rule", () => {
    const lines = buildBackgroundTaskSection(["sessions_spawn"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do not poll session status in a loop");
  });
});

// ---------------------------------------------------------------------------
// buildMessagingSection — unit tests
// ---------------------------------------------------------------------------

describe("buildMessagingSection", () => {
  it("returns [] when isMinimal is true", () => {
    const lines = buildMessagingSection(["message"], true);
    expect(lines).toEqual([]);
  });

  it("returns [] when message tool is not in toolNames", () => {
    const lines = buildMessagingSection(["read", "memory_search"], false);
    expect(lines).toEqual([]);
  });

  it("returns messaging section without channel context when omitted", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Messaging");
    expect(joined).toContain("Use `message` for channel interactions");
    expect(joined).not.toContain("Your current channel is");
  });

  it("includes channel context when provided", () => {
    const lines = buildMessagingSection(["message"], false, {
      channelType: "telegram",
      channelId: "chat-42",
    });
    const joined = lines.join("\n");

    expect(joined).toContain("## Messaging");
    expect(joined).toContain("Your current channel: telegram (ID: chat-42).");
  });

  it("does not reference send_message anywhere", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");

    expect(joined).not.toContain("send_message");
  });

  it("includes 3-tier routing framework", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("### Routing");
    expect(joined).toContain("Reply to the current session");
    expect(joined).toContain("Send to another session");
    expect(joined).toContain("Spawn background work");
  });

  it("includes NO_REPLY dedup rule", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("respond with ONLY: NO_REPLY");
  });

  it("includes anti-exec-for-messaging rule", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("Never use shell execution, code execution, or file tools to send messages");
  });

  it("includes System Message rewrite rule", () => {
    const lines = buildMessagingSection(["message"], false);
    const joined = lines.join("\n");
    expect(joined).toContain("rewrite it in your normal assistant voice");
  });
});

// ---------------------------------------------------------------------------
// buildSilentRepliesSection — unit tests
// ---------------------------------------------------------------------------

describe("buildSilentRepliesSection", () => {
  it("returns empty for minimal mode", () => {
    const lines = buildSilentRepliesSection(true);
    expect(lines).toEqual([]);
  });

  it("includes WRONG/RIGHT examples for NO_REPLY", () => {
    const lines = buildSilentRepliesSection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("WRONG:");
    expect(joined).toContain("RIGHT: NO_REPLY");
  });

  it("includes WRONG/RIGHT examples for HEARTBEAT_OK", () => {
    const lines = buildSilentRepliesSection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("RIGHT: HEARTBEAT_OK");
  });

  it("includes NO_REPLY dedup rule for message tool", () => {
    const lines = buildSilentRepliesSection(false);
    const joined = lines.join("\n");
    expect(joined).toContain("already sent the reply via the message tool");
  });
});

// ---------------------------------------------------------------------------
// buildHeartbeatsSection — unit tests
// ---------------------------------------------------------------------------

describe("buildHeartbeatsSection", () => {
  it("returns empty for minimal mode", () => {
    const lines = buildHeartbeatsSection("check email", true);
    expect(lines).toEqual([]);
  });

  it("returns empty when no heartbeatPrompt", () => {
    const lines = buildHeartbeatsSection(undefined, false);
    expect(lines).toEqual([]);
  });

  it("includes heartbeat prompt text", () => {
    const lines = buildHeartbeatsSection("check email", false);
    const joined = lines.join("\n");
    expect(joined).toContain("## Heartbeats");
    expect(joined).toContain("Heartbeat prompt: check email");
  });

  it("includes alert exclusion rule", () => {
    const lines = buildHeartbeatsSection("check email", false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do NOT include HEARTBEAT_OK anywhere in your response");
  });

  it("includes WRONG/RIGHT examples", () => {
    const lines = buildHeartbeatsSection("check email", false);
    const joined = lines.join("\n");
    expect(joined).toContain("WRONG:");
    expect(joined).toContain("RIGHT:");
  });
});

// ---------------------------------------------------------------------------
// buildToolCallStyleSection — unit tests
// ---------------------------------------------------------------------------

describe("buildToolCallStyleSection", () => {
  it("returns empty for minimal mode", () => {
    const lines = buildToolCallStyleSection(true, []);
    expect(lines).toEqual([]);
  });

  it("includes narration guidance", () => {
    const lines = buildToolCallStyleSection(false, []);
    const joined = lines.join("\n");
    expect(joined).toContain("do not narrate routine, low-risk tool calls");
    expect(joined).toContain("Narrate only when it helps");
  });

  it("retains operational tool call rules", () => {
    const lines = buildToolCallStyleSection(false, []);
    const joined = lines.join("\n");
    expect(joined).toContain("Prefer parallel tool calls");
    expect(joined).toContain("Do not retry the same failing call");
  });
});

// ---------------------------------------------------------------------------
// buildWorkspaceSection — unit tests
// ---------------------------------------------------------------------------

describe("buildWorkspaceSection", () => {
  it("returns empty when no workspaceDir", () => {
    const lines = buildWorkspaceSection(undefined, false);
    expect(lines).toEqual([]);
  });

  it("includes workspace path and behavioral rule", () => {
    const lines = buildWorkspaceSection("/tmp/ws", false);
    const joined = lines.join("\n");
    expect(joined).toContain("## Workspace");
    expect(joined).toContain("Your working directory: /tmp/ws");
    expect(joined).toContain("single global workspace for file operations");
  });
});

// ---------------------------------------------------------------------------
// buildMemoryRecallSection — unit tests
// ---------------------------------------------------------------------------

describe("buildMemoryRecallSection", () => {
  it("returns empty for minimal mode", () => {
    const lines = buildMemoryRecallSection(true, true);
    expect(lines).toEqual([]);
  });

  it("returns empty when no memory tools", () => {
    const lines = buildMemoryRecallSection(false, false);
    expect(lines).toEqual([]);
  });

  it("includes mandatory recall section with trigger topics", () => {
    const lines = buildMemoryRecallSection(true, false);
    const joined = lines.join("\n");
    expect(joined).toContain("### Mandatory Recall");
    expect(joined).toContain("you MUST run `memory_search` first");
    expect(joined).toContain("Prior work or past projects");
    expect(joined).toContain("Past decisions or agreements");
    expect(joined).toContain("Dates, timelines, or schedules");
    expect(joined).toContain("People, names, or contacts");
    expect(joined).toContain("User preferences or habits");
    expect(joined).toContain("Todos, action items, or commitments");
  });

  it("includes silent fallback rule", () => {
    const lines = buildMemoryRecallSection(true, false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do not mention that you searched");
  });

  it("names memory_search and memory_store tools", () => {
    const lines = buildMemoryRecallSection(true, false);
    const joined = lines.join("\n");
    expect(joined).toContain("**memory_search**");
    expect(joined).toContain("**memory_store**");
  });
});

// ---------------------------------------------------------------------------
// send_message bug regression
// ---------------------------------------------------------------------------

describe("send_message bug regression", () => {
  it("assembled prompt never contains 'send_message'", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["message", "sessions_spawn", "read"],
    });

    expect(result).not.toContain("send_message");
    expect(result).toContain("## Messaging");
    expect(result).toContain("Use `message` for channel interactions");
  });
});

// ---------------------------------------------------------------------------
// messaging assembler integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt — messaging integration", () => {
  it("includes messaging section when message is in toolNames", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["message"],
    });

    expect(result).toContain("## Messaging");
  });

  it("includes channel context in messaging section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["message"],
      channelContext: { channelType: "discord", channelId: "guild-99" },
    });

    expect(result).toContain("Your current channel: discord (ID: guild-99).");
  });

  it("omits messaging section when message is not in toolNames", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read"],
    });

    expect(result).not.toContain("## Messaging");
  });
});

// ---------------------------------------------------------------------------
// channelContext assembler integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt — channelContext integration", () => {
  it("includes channel context in background task section when sessions_spawn tool and channelContext provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["sessions_spawn"],
      channelContext: { channelType: "telegram", channelId: "chat-42" },
    });

    expect(result).toContain("## Background Tasks");
    expect(result).toContain('Your current channel is "telegram" (ID: "chat-42")');
    expect(result).toContain('announce_channel_type="telegram"');
    expect(result).toContain('announce_channel_id="chat-42"');
  });

  it("omits channel context lines when channelContext is not provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["sessions_spawn"],
    });

    expect(result).toContain("## Background Tasks");
    expect(result).not.toContain("Your current channel is");
  });

  it("minimal mode omits background task section even with channelContext", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      toolNames: ["sessions_spawn"],
      channelContext: { channelType: "telegram", channelId: "chat-42" },
    });

    expect(result).not.toContain("## Background Tasks");
    expect(result).not.toContain("Your current channel is");
  });
});

// ---------------------------------------------------------------------------
// toolSummaries assembler integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- toolSummaries integration", () => {
  it("merges toolSummaries into unified tooling section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read", "my_mcp_tool"],
      toolSummaries: { my_mcp_tool: "Custom MCP tool" },
    });

    expect(result).toContain("- read: Read files, images, and PDFs with pagination");
    expect(result).toContain("- my_mcp_tool: Custom MCP tool");
  });
});

// ---------------------------------------------------------------------------
// New section builder assembler integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- new section builder integration", () => {
  it("defers self-update gating when gateway is in toolNames", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read", "gateway"],
    });
    // Self-Update section is deferred to JIT injection
    expect(result).not.toContain("## Self-Update & Configuration");
    // Config/Secret integrity remains always-present
    expect(result).toContain("Config File Integrity");
    expect(result).toContain("Secret File Integrity");
  });

  it("excludes self-update gating when no admin tools", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read", "edit"],
    });
    expect(result).not.toContain("## Self-Update & Configuration");
  });

  it("includes compacted output recovery in full mode", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
    });
    expect(result).toContain("## Handling Compacted Output");
  });

  it("excludes compacted output recovery in minimal mode", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
    });
    expect(result).not.toContain("## Handling Compacted Output");
  });

  it("uses structured subagentRole when provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      subagentRole: { task: "Analyze the logs", depth: 1 },
    });
    expect(result).toContain("## Subagent Role");
    expect(result).toContain("Analyze the logs");
    expect(result).not.toContain("## Additional Context");
  });

  it("falls back to extraSystemPrompt when subagentRole not provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      extraSystemPrompt: "Legacy context",
    });
    expect(result).toContain("## Additional Context");
    expect(result).toContain("Legacy context");
    expect(result).not.toContain("## Subagent Role");
  });

  it("SOUL.md appears as standalone Persona section before Safety in assembled prompt", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      bootstrapFiles: [
        { path: "SOUL.md", content: "Be a helpful pirate" },
        { path: "AGENTS.md", content: "Agent instructions" },
      ],
    });
    expect(result).toContain("## Persona");
    expect(result).toContain("persona definition");
    expect(result).toContain("Be a helpful pirate");
    // Persona appears before Safety
    const personaIdx = result.indexOf("## Persona");
    const safetyIdx = result.indexOf("## Safety");
    expect(personaIdx).toBeLessThan(safetyIdx);
    // No separate "## Prompt Skills" heading (merged into Skills)
    expect(result).not.toMatch(/^## Prompt Skills$/m);
  });
});

// ---------------------------------------------------------------------------
// buildReactionGuidanceSection -- unit tests
// ---------------------------------------------------------------------------

describe("buildReactionGuidanceSection", () => {
  it("returns [] when isMinimal is true", () => {
    expect(buildReactionGuidanceSection("minimal", "telegram", true)).toEqual([]);
  });

  it("returns [] when reactionLevel is undefined", () => {
    expect(buildReactionGuidanceSection(undefined, "telegram", false)).toEqual([]);
  });

  it("renders minimal mode with frequency guideline", () => {
    const lines = buildReactionGuidanceSection("minimal", "telegram", false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Reactions");
    expect(joined).toContain("minimal mode");
    expect(joined).toContain("at most 1 reaction per 5-10 exchanges");
    expect(joined).toContain("telegram");
  });

  it("renders extensive mode with liberal guideline", () => {
    const lines = buildReactionGuidanceSection("extensive", "discord", false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Reactions");
    expect(joined).toContain("extensive mode");
    expect(joined).toContain("react whenever it feels natural");
    expect(joined).toContain("discord");
  });

  it("uses fallback label when channelType is undefined", () => {
    const lines = buildReactionGuidanceSection("minimal", undefined, false);
    const joined = lines.join("\n");

    expect(joined).toContain("this channel");
  });
});

// ---------------------------------------------------------------------------
// buildReasoningSection -- reasoningTagHint
// ---------------------------------------------------------------------------

describe("buildReasoningSection -- reasoningTagHint", () => {
  it("returns <think>/<final> format when reasoningTagHint is true", () => {
    const lines = buildReasoningSection(false, false, true);
    const joined = lines.join("\n");

    expect(joined).toContain("## Reasoning Format");
    expect(joined).toContain("<think>");
    expect(joined).toContain("<final>");
    expect(joined).not.toContain("Extended Thinking");
  });

  it("reasoningTagHint takes precedence over reasoningEnabled", () => {
    const lines = buildReasoningSection(true, false, true);
    const joined = lines.join("\n");

    expect(joined).toContain("## Reasoning Format");
    expect(joined).not.toContain("Extended Thinking");
  });

  it("falls back to Extended Thinking when reasoningTagHint is false", () => {
    const lines = buildReasoningSection(true, false, false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Extended Thinking");
    expect(joined).not.toContain("Reasoning Format");
  });

  it("returns [] when both false", () => {
    const lines = buildReasoningSection(false, false, false);
    expect(lines).toEqual([]);
  });

  it("returns [] in minimal mode even with reasoningTagHint true", () => {
    const lines = buildReasoningSection(true, true, true);
    expect(lines).toEqual([]);
  });

  it("backward compat: 2-arg call still works", () => {
    const lines = buildReasoningSection(true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("Extended Thinking");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- reaction guidance integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- reaction guidance integration", () => {
  it("includes reaction section when reactionLevel provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      reactionLevel: "minimal",
    });

    expect(result).toContain("## Reactions");
  });

  it("excludes reaction section when reactionLevel undefined", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
    });

    expect(result).not.toContain("## Reactions");
  });

  it("minimal mode excludes reaction section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      reactionLevel: "extensive",
    });

    expect(result).not.toContain("## Reactions");
  });

  it("reaction section uses channelType from channelContext", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      reactionLevel: "minimal",
      channelContext: { channelType: "telegram", channelId: "chat-42" },
    });

    expect(result).toContain("telegram");
    expect(result).toContain("## Reactions");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- reasoningTagHint integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- reasoningTagHint integration", () => {
  it("renders <think>/<final> when reasoningTagHint is true", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      reasoningTagHint: true,
      reasoningEnabled: false,
    });

    expect(result).toContain("## Reasoning Format");
    expect(result).toContain("<think>");
  });

  it("renders Extended Thinking when reasoningTagHint is false and reasoningEnabled is true", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      reasoningTagHint: false,
      reasoningEnabled: true,
    });

    expect(result).toContain("## Extended Thinking");
  });

  it("minimal mode excludes reasoning tag format", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      reasoningTagHint: true,
    });

    expect(result).not.toContain("## Reasoning Format");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- outbound media integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- outbound media integration", () => {
  it("includes Media Sharing section when outboundMediaEnabled is true", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      outboundMediaEnabled: true,
    });

    expect(result).toContain("## Media Sharing");
    expect(result).toContain("MEDIA:");
    expect(result).toContain("direct link");
  });

  it("excludes Media Sharing section when outboundMediaEnabled is false", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      outboundMediaEnabled: false,
    });

    expect(result).not.toContain("## Media Sharing");
  });

  it("excludes Media Sharing section when outboundMediaEnabled is undefined", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
    });

    expect(result).not.toContain("## Media Sharing");
  });

  it("excludes Media Sharing section in minimal mode even when enabled", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      outboundMediaEnabled: true,
    });

    expect(result).not.toContain("## Media Sharing");
  });

  it("section mentions direct link and URL format", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      outboundMediaEnabled: true,
    });

    expect(result).toContain("direct link to the image or file");
    expect(result).toContain("MEDIA: <url>");
    expect(result).toContain("JPEG, PNG, GIF, WebP");
  });
});

// ---------------------------------------------------------------------------
// buildInboundMetadataSection -- unit tests
// ---------------------------------------------------------------------------

describe("buildInboundMetadataSection", () => {
  it("returns [] when meta is undefined", () => {
    expect(buildInboundMetadataSection(undefined, false)).toEqual([]);
  });

  it("renders JSON block with all 6 fields", () => {
    const meta: InboundMetadata = {
      messageId: "msg-123",
      senderId: "user-456",
      chatId: "chat-789",
      channel: "telegram",
      chatType: "group",
      flags: { isGroup: true },
    };
    const lines = buildInboundMetadataSection(meta, false);
    const joined = lines.join("\n");

    expect(joined).toContain('"message_id": "msg-123"');
    expect(joined).toContain('"sender_id": "user-456"');
    expect(joined).toContain('"chat_id": "chat-789"');
    expect(joined).toContain('"channel": "telegram"');
    expect(joined).toContain('"chat_type": "group"');
    expect(joined).toContain('"isGroup": true');
  });

  it("omits flags key when flags object is empty", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "discord",
      chatType: "dm",
      flags: {},
    };
    const lines = buildInboundMetadataSection(meta, false);
    const joined = lines.join("\n");

    expect(joined).not.toContain("flags");
  });

  it("includes flags when present (isGroup, isThread, hasAttachments, isReply)", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "slack",
      chatType: "thread",
      flags: { isGroup: true, isThread: true, hasAttachments: true, isReply: true },
    };
    const lines = buildInboundMetadataSection(meta, false);
    const joined = lines.join("\n");

    expect(joined).toContain('"isGroup": true');
    expect(joined).toContain('"isThread": true');
    expect(joined).toContain('"hasAttachments": true');
    expect(joined).toContain('"isReply": true');
  });

  it('contains heading "## Current Message Context"', () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "discord",
      chatType: "dm",
      flags: {},
    };
    const lines = buildInboundMetadataSection(meta, false);
    expect(lines[0]).toBe("## Current Message Context");
  });

  it('contains "Do not reveal these internal identifiers"', () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "discord",
      chatType: "dm",
      flags: {},
    };
    const lines = buildInboundMetadataSection(meta, false);
    const joined = lines.join("\n");
    expect(joined).toContain("Do not reveal these internal identifiers");
  });

  it("JSON is valid (parseable with JSON.parse)", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "group",
      flags: { isGroup: true },
    };
    const lines = buildInboundMetadataSection(meta, false);
    // Extract JSON between ``` markers
    const jsonStart = lines.indexOf("```json");
    const jsonEnd = lines.indexOf("```", jsonStart + 1);
    const jsonLines = lines.slice(jsonStart + 1, jsonEnd);
    const jsonStr = jsonLines.join("\n");

    expect(() => JSON.parse(jsonStr)).not.toThrow();
    const parsed = JSON.parse(jsonStr);
    expect(parsed.message_id).toBe("msg-1");
    expect(parsed.channel).toBe("telegram");
    expect(parsed.flags.isGroup).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- inbound metadata integration
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- inbound metadata integration", () => {
  const sampleMeta: InboundMetadata = {
    messageId: "msg-abc",
    senderId: "user-xyz",
    chatId: "chat-123",
    channel: "telegram",
    chatType: "group",
    flags: { isGroup: true },
  };

  // Inbound metadata relocated to user-message preamble (prompt-assembly.ts).
  // The assembler no longer includes these sections in the system prompt.

  it("full mode excludes inbound metadata section even when inboundMeta provided", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      inboundMeta: sampleMeta,
    });

    expect(result).not.toContain("## Current Message Context");
    expect(result).not.toContain('"message_id": "msg-abc"');
  });

  it("full mode excludes inbound metadata section when inboundMeta undefined", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
    });

    expect(result).not.toContain("## Current Message Context");
  });

  it("minimal mode excludes inbound metadata section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      inboundMeta: sampleMeta,
    });

    expect(result).not.toContain("## Current Message Context");
  });

  it("system prompt excludes date/time section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      runtimeInfo: { host: "myhost", os: "linux" },
      inboundMeta: sampleMeta,
      bootstrapFiles: [{ path: "AGENTS.md", content: "agent instructions" }],
    });

    expect(result).not.toContain("## Current Date & Time");
    // Runtime section should still be present
    expect(result).toContain("## Runtime");
    expect(result).toContain("## Project Context");
  });

  it("canary token no longer in system prompt (relocated to dynamic preamble)", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      inboundMeta: sampleMeta,
    });
    expect(result).not.toContain("CTKN_");
  });
});

// ---------------------------------------------------------------------------
// buildMediaFilesSection -- unit tests (206-01)
// ---------------------------------------------------------------------------

describe("buildMediaFilesSection", () => {
  it("returns [] when isMinimal is true", () => {
    expect(buildMediaFilesSection(true, true, "/ws", true, true)).toEqual([]);
  });

  it("returns [] when mediaPersistenceEnabled is false", () => {
    expect(buildMediaFilesSection(true, true, "/ws", false, false)).toEqual([]);
  });

  it("returns [] when hasMemoryTools is false", () => {
    expect(buildMediaFilesSection(false, true, "/ws", true, false)).toEqual([]);
  });

  it("returns [] when hasMessageTool is false", () => {
    expect(buildMediaFilesSection(true, false, "/ws", true, false)).toEqual([]);
  });

  it("returns [] when workspaceDir is undefined", () => {
    expect(buildMediaFilesSection(true, true, undefined, true, false)).toEqual([]);
  });

  it("includes section heading and file organization when all conditions met", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("## Persisted Media Files");
    expect(joined).toContain("photos/<uuid>");
    expect(joined).toContain("videos/<uuid>");
    expect(joined).toContain("documents/<uuid>");
    expect(joined).toContain("audio/<uuid>");
  });

  it("includes memory_search instruction for retrieval", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("memory_search");
    expect(joined).toContain("photo from");
  });

  it("includes message attach instruction with action=attach", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain('action="attach"');
    expect(joined).toContain("attachment_url");
  });

  it("includes workspace dir in absolute path instruction", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("/home/user/ws");
  });

  it("warns against guessing filenames (UUID anti-hallucination)", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("Never guess filenames");
    expect(joined).toContain("UUID");
  });

  it("warns against reading binary files", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("Do NOT read binary files");
  });

  it("clarifies MEDIA: vs message attach distinction", () => {
    const lines = buildMediaFilesSection(true, true, "/home/user/ws", true, false);
    const joined = lines.join("\n");

    expect(joined).toContain("MEDIA:");
    expect(joined).toContain("web URLs");
    expect(joined).toContain("workspace files");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- media files integration (206-01)
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- media files integration", () => {
  it("includes Persisted Media Files section when all conditions met", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: true,
      toolNames: ["memory_search", "message"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: true,
    });

    expect(result).toContain("## Persisted Media Files");
    expect(result).toContain("memory_search");
    expect(result).toContain('action="attach"');
  });

  it("excludes Persisted Media Files section when mediaPersistenceEnabled is false", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: true,
      toolNames: ["memory_search", "message"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: false,
    });

    expect(result).not.toContain("## Persisted Media Files");
  });

  it("excludes Persisted Media Files section when mediaPersistenceEnabled is undefined", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: true,
      toolNames: ["memory_search", "message"],
      workspaceDir: "/home/user/ws",
    });

    expect(result).not.toContain("## Persisted Media Files");
  });

  it("excludes Persisted Media Files section in minimal mode", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      hasMemoryTools: true,
      toolNames: ["memory_search", "message"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: true,
    });

    expect(result).not.toContain("## Persisted Media Files");
  });

  it("excludes Persisted Media Files section when no memory tools", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: false,
      toolNames: ["message"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: true,
    });

    expect(result).not.toContain("## Persisted Media Files");
  });

  it("excludes Persisted Media Files section when message tool absent", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: true,
      toolNames: ["memory_search"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: true,
    });

    expect(result).not.toContain("## Persisted Media Files");
  });

  it("Persisted Media Files section appears after Media Sharing section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      hasMemoryTools: true,
      toolNames: ["memory_search", "message"],
      workspaceDir: "/home/user/ws",
      mediaPersistenceEnabled: true,
      outboundMediaEnabled: true,
    });

    const mediaSharingIdx = result.indexOf("## Media Sharing");
    const mediaFilesIdx = result.indexOf("## Persisted Media Files");

    expect(mediaSharingIdx).toBeGreaterThan(-1);
    expect(mediaFilesIdx).toBeGreaterThan(-1);
    expect(mediaFilesIdx).toBeGreaterThan(mediaSharingIdx);
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- Media Sharing MEDIA: clarification (206-01)
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- Media Sharing MEDIA: clarification", () => {
  it("Media Sharing section mentions MEDIA: is for web URLs only", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      outboundMediaEnabled: true,
    });

    expect(result).toContain("MEDIA: directives are for web URLs only");
    expect(result).toContain("action=attach");
  });
});

// ---------------------------------------------------------------------------
// buildPrivilegedToolsSection — unit tests
// ---------------------------------------------------------------------------

const ALL_PRIVILEGED_TOOLS = [
  "agents_manage", "obs_query", "sessions_manage", "memory_manage",
  "channels_manage", "tokens_manage", "models_manage",
];

describe("buildPrivilegedToolsSection", () => {
  it("returns empty when no privileged tools present", () => {
    const result = buildPrivilegedToolsSection(["read", "exec"], false);
    expect(result).toEqual([]);
  });

  it("returns empty in minimal mode even with privileged tools", () => {
    const result = buildPrivilegedToolsSection(["agents_manage"], true);
    expect(result).toEqual([]);
  });

  it("includes section heading when privileged tools present", () => {
    const result = buildPrivilegedToolsSection(["agents_manage"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Privileged Tools & Approval Gate");
  });

  it("includes approval gate behavior subsection", () => {
    const result = buildPrivilegedToolsSection(["agents_manage", "sessions_manage"], false);
    const joined = result.join("\n").toLowerCase();
    expect(joined).toContain("approval");
    expect(joined).toContain("denied");
    expect(joined).toContain("timed out");
  });

  it("includes fleet management patterns subsection", () => {
    const result = buildPrivilegedToolsSection(ALL_PRIVILEGED_TOOLS, false);
    const joined = result.join("\n");
    expect(joined).toContain("suspend");
    expect(joined).toContain("rotate");
    expect(joined).toContain("flush");
    expect(joined).toMatch(/[Cc]reate vs/);
  });

  it("includes gated vs read-only distinction for read-only tools", () => {
    const result = buildPrivilegedToolsSection(["obs_query", "models_manage"], false);
    const joined = result.join("\n");
    // Section should still appear (these are privileged tools)
    expect(joined).toContain("## Privileged Tools & Approval Gate");
    // Should reference read-only / no approval
    expect(joined).toMatch(/[Rr]ead-only|no approval/);
  });

  it("includes all 3 subsections when all privileged tools present", () => {
    const result = buildPrivilegedToolsSection(ALL_PRIVILEGED_TOOLS, false);
    const joined = result.join("\n");
    // Subsection 1: overview
    expect(joined).toContain("Gated vs Read-Only");
    // Subsection 2: approval gate behavior
    expect(joined).toContain("### Approval Gate Behavior");
    // Subsection 3: fleet management patterns
    expect(joined).toContain("### Fleet Management Patterns");
  });
});

// ---------------------------------------------------------------------------
// buildToolingSection — privileged tool descriptions
// ---------------------------------------------------------------------------

describe("buildToolingSection -- privileged tool summaries", () => {
  it("includes privileged tool summaries in tool listing", () => {
    const lines = buildToolingSection(
      ["agents_manage", "obs_query", "models_manage"],
      false,
    );
    const joined = lines.join("\n");

    expect(joined).toContain("agents_manage");
    expect(joined).toContain("Manage full agent fleet");
    expect(joined).toContain("obs_query");
    expect(joined).toContain("Query platform diagnostics");
    expect(joined).toContain("models_manage");
    expect(joined).toContain("List models and test availability");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPrompt -- privileged tools integration (244-01)
// ---------------------------------------------------------------------------

describe("assembleRichSystemPrompt -- privileged tools integration", () => {
  it("full mode defers privileged tools section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["agents_manage", "sessions_manage"],
    });

    // Deferred to JIT injection
    expect(result).not.toContain("Privileged Tools");
    expect(result).not.toContain("Approval Gate");
  });

  it("full mode omits privileged tools section when no supervisor tools", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      toolNames: ["read", "exec"],
    });

    expect(result).not.toContain("Privileged Tools");
  });

  it("minimal mode omits privileged tools section", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      toolNames: ["agents_manage"],
    });

    expect(result).not.toContain("Privileged Tools");
  });
});

// ---------------------------------------------------------------------------
// buildCodingFallbackSection
// ---------------------------------------------------------------------------

describe("buildCodingFallbackSection", () => {
  it("includes coding fallback when exec is available", () => {
    const result = buildCodingFallbackSection(["exec", "read", "write"], false);
    expect(result.length).toBeGreaterThan(0);
    const joined = result.join("\n");
    expect(joined).toContain("Coding & Execution Fallback");
    expect(joined).toContain("exec");
    expect(joined).not.toContain("Proactive Subagent");
  });

  it("does not include delegation (moved to buildTaskDelegationSection)", () => {
    const result = buildCodingFallbackSection(["exec", "sessions_spawn", "read"], false);
    const joined = result.join("\n");
    expect(joined).toContain("Coding & Execution Fallback");
    expect(joined).not.toContain("Delegation");
  });

  it("returns empty when exec is not available", () => {
    const result = buildCodingFallbackSection(["read", "write", "sessions_spawn"], false);
    expect(result).toHaveLength(0);
  });

  it("returns empty in minimal mode", () => {
    const result = buildCodingFallbackSection(["exec", "sessions_spawn"], true);
    expect(result).toHaveLength(0);
  });

  it("assembler defers coding fallback and task delegation sections", () => {
    const result = assembleRichSystemPrompt({
      toolNames: ["exec", "sessions_spawn"],
      promptMode: "full",
    });
    // Both sections deferred to JIT injection
    expect(result).not.toContain("Coding & Execution Fallback");
    expect(result).not.toContain("## Task Delegation");
  });

  it("assembler excludes coding fallback and task delegation in minimal mode", () => {
    const result = assembleRichSystemPrompt({
      toolNames: ["exec", "sessions_spawn"],
      promptMode: "minimal",
    });
    expect(result).not.toContain("Coding & Execution Fallback");
    expect(result).not.toContain("Task Delegation");
  });

  // -------------------------------------------------------------------------
  // JIT section deferral
  // -------------------------------------------------------------------------

  it("full mode defers Task Delegation, Privileged Tools, Confirmation Protocol, Coding Fallback; keeps Config/Secret integrity", () => {
    const result = assembleRichSystemPrompt({
      toolNames: ["exec", "sessions_spawn", "gateway", "agents_manage"],
      promptMode: "full",
    });

    // Deferred sections ABSENT
    expect(result).not.toContain("## Task Delegation");
    expect(result).not.toContain("## Privileged Tools & Approval Gate");
    expect(result).not.toContain("## Self-Update & Configuration");
    expect(result).not.toContain("Confirmation Protocol");
    expect(result).not.toContain("## Coding & Execution Fallback");

    // Config/Secret integrity PRESENT (always-present)
    expect(result).toContain("Config File Integrity");
    expect(result).toContain("Secret File Integrity");
    expect(result).toContain("Never modify config YAML");
    expect(result).toContain("Never modify .env files directly");
  });

  // -------------------------------------------------------------------------
  // Post-Compaction Recovery section
  // -------------------------------------------------------------------------

  it("full mode includes post-compaction recovery when AGENTS.md has matching sections", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      bootstrapFiles: [
        {
          path: "AGENTS.md",
          content: "## Session Startup\nDo startup things.\n\n## Red Lines\nNever do bad things.",
        },
      ],
    });
    expect(result).toContain("Post-Compaction Recovery");
    expect(result).toContain("Re-execute your startup sequence");
    expect(result).toContain("Do startup things");
  });

  it("full mode omits post-compaction recovery when AGENTS.md has no matching sections", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "full",
      bootstrapFiles: [
        {
          path: "AGENTS.md",
          content: "## Other Section\nStuff here.",
        },
      ],
    });
    expect(result).not.toContain("Post-Compaction Recovery");
  });

  it("minimal mode omits post-compaction recovery", () => {
    const result = assembleRichSystemPrompt({
      promptMode: "minimal",
      bootstrapFiles: [
        {
          path: "AGENTS.md",
          content: "## Session Startup\nDo startup things.\n\n## Red Lines\nNever do bad things.",
        },
      ],
    });
    expect(result).not.toContain("Post-Compaction Recovery");
  });
});

// ---------------------------------------------------------------------------
// assembleRichSystemPromptBlocks — multi-block splitting
// ---------------------------------------------------------------------------

describe("assembleRichSystemPromptBlocks", () => {
  it("returns object with staticPrefix, attribution, and semiStableBody properties", () => {
    const blocks = assembleRichSystemPromptBlocks({
      promptMode: "full",
      agentName: "TestBot",
      toolNames: ["tool1"],
    });
    expect(blocks).toHaveProperty("staticPrefix");
    expect(blocks).toHaveProperty("attribution");
    expect(blocks).toHaveProperty("semiStableBody");
    expect(typeof blocks.staticPrefix).toBe("string");
    expect(typeof blocks.attribution).toBe("string");
    expect(typeof blocks.semiStableBody).toBe("string");
  });

  it("identity invariant: staticPrefix + SECTION_SEPARATOR + attribution + SECTION_SEPARATOR + semiStableBody === assembleRichSystemPrompt for mode 'full'", () => {
    const params = {
      promptMode: "full" as const,
      agentName: "CacheBot",
      toolNames: ["tool1", "message", "exec"],
      skillsPrompt: "skill info",
      hasMemoryTools: true,
      workspaceDir: "/tmp/ws",
      heartbeatPrompt: "check email",
      reasoningEnabled: true,
      runtimeInfo: {
        host: "myhost",
        os: "linux",
        arch: "x64",
        model: "claude-sonnet",
      },
      bootstrapFiles: [{ path: "AGENTS.md", content: "agent instructions" }] as BootstrapContextFile[],
      userLanguage: "Hebrew",
      reactionLevel: "minimal" as const,
      outboundMediaEnabled: true,
    };

    const monolithic = assembleRichSystemPrompt(params);
    const blocks = assembleRichSystemPromptBlocks(params);
    const reassembled = blocks.staticPrefix + SECTION_SEPARATOR + blocks.attribution + SECTION_SEPARATOR + blocks.semiStableBody;
    expect(reassembled).toBe(monolithic);
  });

  it("identity invariant holds for mode 'minimal'", () => {
    const params = {
      promptMode: "minimal" as const,
      agentName: "MinBot",
      toolNames: ["tool1"],
      userLanguage: "English",
    };

    const monolithic = assembleRichSystemPrompt(params);
    const blocks = assembleRichSystemPromptBlocks(params);
    const reassembled = blocks.staticPrefix + SECTION_SEPARATOR + blocks.attribution + SECTION_SEPARATOR + blocks.semiStableBody;
    expect(reassembled).toBe(monolithic);
  });

  it("mode 'none' returns identity in staticPrefix with empty attribution and semiStableBody", () => {
    const blocks = assembleRichSystemPromptBlocks({
      promptMode: "none",
      agentName: "NoneBot",
    });
    expect(blocks.staticPrefix).toContain("You are NoneBot");
    expect(blocks.attribution).toBe("");
    expect(blocks.semiStableBody).toBe("");
  });

  it("staticPrefix contains identity and persona but NOT Safety or Language", () => {
    const blocks = assembleRichSystemPromptBlocks({
      promptMode: "full",
      agentName: "TestBot",
      toolNames: ["tool1"],
      userLanguage: "Hebrew",
    });
    expect(blocks.staticPrefix).toContain("You are TestBot");
    expect(blocks.staticPrefix).not.toContain("## Safety");
    expect(blocks.staticPrefix).not.toContain("## Available Tools");
  });

  it("attribution contains Safety and Language content", () => {
    const blocks = assembleRichSystemPromptBlocks({
      promptMode: "full",
      agentName: "TestBot",
      toolNames: ["tool1"],
      userLanguage: "Hebrew",
    });
    expect(blocks.attribution).toContain("## Safety");
    expect(blocks.attribution).not.toContain("You are TestBot");
    expect(blocks.attribution).not.toContain("## Available Tools");
  });

  it("semiStableBody contains Tool section but not identity line or Safety", () => {
    const blocks = assembleRichSystemPromptBlocks({
      promptMode: "full",
      agentName: "TestBot",
      toolNames: ["tool1"],
    });
    expect(blocks.semiStableBody).toContain("## Available Tools");
    expect(blocks.semiStableBody).not.toContain("You are TestBot");
    expect(blocks.semiStableBody).not.toContain("## Safety");
  });

  it("identity invariant holds with additionalSections", () => {
    const params = {
      promptMode: "full" as const,
      agentName: "TestBot",
      toolNames: ["tool1"],
      additionalSections: ["## Extra Section\nExtra content", "## Another\nMore content"],
    };

    const monolithic = assembleRichSystemPrompt(params);
    const blocks = assembleRichSystemPromptBlocks(params);
    const reassembled = blocks.staticPrefix + SECTION_SEPARATOR + blocks.attribution + SECTION_SEPARATOR + blocks.semiStableBody;
    expect(reassembled).toBe(monolithic);
  });

  it("identity invariant holds with bootstrapFiles (SOUL.md persona)", () => {
    const params = {
      promptMode: "full" as const,
      agentName: "PersonaBot",
      toolNames: ["tool1"],
      bootstrapFiles: [
        { path: "SOUL.md", content: "You are a helpful poet." },
        { path: "AGENTS.md", content: "## Red Lines\nDo not lie." },
      ] as BootstrapContextFile[],
    };

    const monolithic = assembleRichSystemPrompt(params);
    const blocks = assembleRichSystemPromptBlocks(params);
    const reassembled = blocks.staticPrefix + SECTION_SEPARATOR + blocks.attribution + SECTION_SEPARATOR + blocks.semiStableBody;
    expect(reassembled).toBe(monolithic);
  });

  it("empty additionalSections array does not add trailing separator", () => {
    const paramsEmpty = {
      promptMode: "full" as const,
      agentName: "TestBot",
      toolNames: ["tool1"],
      additionalSections: [],
    };
    const paramsNone = {
      promptMode: "full" as const,
      agentName: "TestBot",
      toolNames: ["tool1"],
    };

    const blocksEmpty = assembleRichSystemPromptBlocks(paramsEmpty);
    const blocksNone = assembleRichSystemPromptBlocks(paramsNone);
    // Both should produce identical output
    const reassembledEmpty = blocksEmpty.staticPrefix + SECTION_SEPARATOR + blocksEmpty.attribution + SECTION_SEPARATOR + blocksEmpty.semiStableBody;
    const reassembledNone = blocksNone.staticPrefix + SECTION_SEPARATOR + blocksNone.attribution + SECTION_SEPARATOR + blocksNone.semiStableBody;
    expect(reassembledEmpty).toBe(reassembledNone);
  });

  it("SECTION_SEPARATOR is the documented separator pattern", () => {
    expect(SECTION_SEPARATOR).toBe("\n\n---\n\n");
  });
});

// ---------------------------------------------------------------------------
// Operational PromptMode (design-doc §Testing #1-3, #6)
// ---------------------------------------------------------------------------

/** Realistic params used across operational-mode tests to mirror a production cron run. */
function makeOperationalParams() {
  const bootstrapFiles: BootstrapContextFile[] = [
    { path: "SOUL.md", content: "You are a helpful persona." },
    { path: "ROLE.md", content: "Role: news-watcher with specific duties and output format." },
    { path: "AGENTS.md", content: "Long AGENTS.md content with operating instructions and behavior rules." },
    { path: "TOOLS.md", content: "Notes about available tools and their preferred usage patterns." },
    { path: "USER.md", content: "User preferences: verbose output disabled, prefers concise summaries." },
    { path: "HEARTBEAT.md", content: "Every tick, check pending tasks and email." },
    { path: "BOOTSTRAP.md", content: "Onboarding steps for first-run." },
  ];
  const runtimeInfo: RuntimeInfo = {
    agentId: "test-bot",
    host: "test-host",
    os: "linux",
    arch: "x64",
    model: "claude-sonnet",
  };
  return {
    agentName: "TestBot",
    toolNames: ["read", "write", "web_search", "message", "memory_store", "memory_search", "cron", "discover"],
    skillsPrompt: "skill info",
    hasMemoryTools: true,
    workspaceDir: "/tmp/ws",
    heartbeatPrompt: "check email every 10 minutes",
    reasoningEnabled: true,
    runtimeInfo,
    bootstrapFiles,
    outboundMediaEnabled: true,
    autonomousMediaEnabled: true,
    userLanguage: "English",
    sepEnabled: true,
  };
}

describe("SECTIONS descriptor contract (design-doc §Testing #3)", () => {
  it("every SECTION descriptor declares a non-empty includeIn set", () => {
    for (const s of SECTIONS) {
      expect(s.includeIn.size).toBeGreaterThan(0);
      expect(s.id).toBeTruthy();
      expect(typeof s.id).toBe("string");
      expect(typeof s.build).toBe("function");
    }
  });

  it("SECTION ids are unique", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no descriptor claims 'none' mode (short-circuited in assembler)", () => {
    for (const s of SECTIONS) {
      expect(s.includeIn.has("none")).toBe(false);
    }
  });

  it("SECTIONS array has the expected minimum length (guard against accidental deletions)", () => {
    // Canonical order has 30 base sections (identity, persona, safety, language,
    // tooling, tool-call-style, self-update, config-secret, privileged,
    // compact-recover, post-compact, coding-fallback, task-delegation, skills,
    // memory-recall, workspace, documentation, messaging, background,
    // silent-replies, heartbeats, reactions, media-sharing, media-files,
    // autonomous-media, reasoning, sep, runtime-meta, sender-trust,
    // project-context).
    expect(SECTIONS.length).toBeGreaterThanOrEqual(30);
  });
});

describe("PromptMode block invariant (design-doc §Testing #1)", () => {
  it.each(["full", "operational", "minimal"] as const)(
    "assembleRichSystemPromptBlocks identity holds for mode=%s",
    (mode) => {
      const params = { ...makeOperationalParams(), promptMode: mode };
      const blocks = assembleRichSystemPromptBlocks(params);
      // Join non-empty blocks with SECTION_SEPARATOR (empty blocks are dropped
      // by the assembler's joinSections helper).
      const parts = [blocks.staticPrefix, blocks.attribution, blocks.semiStableBody].filter(Boolean);
      const joined = parts.join(SECTION_SEPARATOR);
      expect(joined).toEqual(assembleRichSystemPrompt(params));
    },
  );
});

describe("staticPrefix/attribution byte-identity full vs operational (design-doc §Testing #2)", () => {
  it("staticPrefix and attribution cache blocks are byte-identical between 'full' and 'operational'", () => {
    const params = makeOperationalParams();
    const fullBlocks = assembleRichSystemPromptBlocks({ ...params, promptMode: "full" });
    const opBlocks = assembleRichSystemPromptBlocks({ ...params, promptMode: "operational" });

    // Cache prefix invariant: the static prefix (identity+persona) and
    // attribution (safety+language) must match byte-for-byte so that
    // Anthropic's cache_control entry on the identity prefix remains valid
    // across cron/heartbeat/interactive sessions.
    expect(opBlocks.staticPrefix).toEqual(fullBlocks.staticPrefix);
    expect(opBlocks.attribution).toEqual(fullBlocks.attribution);

    // Body differs because operational strips interactive-only sections.
    expect(opBlocks.semiStableBody).not.toEqual(fullBlocks.semiStableBody);
    expect(opBlocks.semiStableBody.length).toBeLessThan(fullBlocks.semiStableBody.length);
  });

  it("operational mode drops interactive-only sections but keeps core operational ones", () => {
    const params = makeOperationalParams();
    const full = assembleRichSystemPrompt({ ...params, promptMode: "full" });
    const op = assembleRichSystemPrompt({ ...params, promptMode: "operational" });

    // Present in full but not in operational (MODES_FULL-only sections)
    expect(full).toContain("## Safety");
    expect(op).toContain("## Safety");
    // Sections that drop in operational
    expect(full).toContain("## Heartbeats");
    expect(op).not.toContain("## Heartbeats");
    expect(full).toContain("## Silent Replies");
    expect(op).not.toContain("## Silent Replies");

    // Present in both (MODES_FULL_OP sections)
    expect(op).toContain("## Available Tools");
    expect(op).toContain("## Workspace");
    expect(op).toContain("## Project Context");
  });
});

describe("Snapshot regression: operational prompt trim delta (design-doc §Testing #6)", () => {
  it("operational mode saves at least 4500 chars vs full mode for a representative prompt", () => {
    // Representative params mirror a real cron job: full tool list, real
    // bootstrap files, heartbeat prompt, skills, documentation, etc.
    const params = makeOperationalParams();

    const fullPrompt = assembleRichSystemPrompt({ ...params, promptMode: "full" });
    const opPrompt = assembleRichSystemPrompt({ ...params, promptMode: "operational" });

    const delta = fullPrompt.length - opPrompt.length;

    // Design doc claims ~10,100 tokens ≈ ~30,000 chars saved per run.
    // Use a conservative 4500-char floor (~±10% of a 1500-token floor) to
    // tolerate section-content drift while catching accidental regressions
    // where an "operational"-excluded section slips back in.
    expect(delta).toBeGreaterThanOrEqual(4500);
    expect(opPrompt.length).toBeLessThan(fullPrompt.length);
  });
});
