// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildToolingSection,
  buildToolCallStyleSection,
  buildSelfUpdateGatingSection,
  buildConfigSecretIntegritySection,
  buildCompactedOutputRecoverySection,
  buildCodingFallbackSection,
  buildTaskDelegationSection,
  buildPrivilegedToolsSection,
} from "./tooling-sections.js";
import { TOOL_SUMMARIES } from "./tool-descriptions.js";

// ---------------------------------------------------------------------------
// buildToolingSection
// ---------------------------------------------------------------------------

describe("buildToolingSection", () => {
  it("returns empty for empty toolNames", () => {
    expect(buildToolingSection([], "large")).toEqual([]);
  });

  it("returns Available Tools heading with summaries from TOOL_SUMMARIES", () => {
    const result = buildToolingSection(["read", "exec"], "large");
    const joined = result.join("\n");
    expect(joined).toContain("## Available Tools");
    expect(joined).toContain("- read:");
    expect(joined).toContain("- exec:");
  });

  it("orders known tools per TOOL_ORDER (read before exec)", () => {
    const result = buildToolingSection(["exec", "read"], "large");
    const readIdx = result.findIndex((l) => l.startsWith("- read"));
    const execIdx = result.findIndex((l) => l.startsWith("- exec"));
    expect(readIdx).toBeLessThan(execIdx);
  });

  it("places unknown extras alphabetically after known tools", () => {
    const result = buildToolingSection(["read", "zzz_tool", "aaa_tool"], "large");
    const readIdx = result.findIndex((l) => l.startsWith("- read"));
    const aaaIdx = result.findIndex((l) => l.startsWith("- aaa_tool"));
    const zzzIdx = result.findIndex((l) => l.startsWith("- zzz_tool"));
    expect(readIdx).toBeLessThan(aaaIdx);
    expect(aaaIdx).toBeLessThan(zzzIdx);
  });

  it("merges custom toolSummaries with defaults", () => {
    const result = buildToolingSection(["read"], "large", { read: "Custom read description" });
    const joined = result.join("\n");
    expect(joined).toContain("Custom read description");
    expect(joined).not.toContain(TOOL_SUMMARIES["read"]);
  });

  it("renders tools without description as just the name", () => {
    const result = buildToolingSection(["my_custom_tool"], "large");
    const line = result.find((l) => l.includes("my_custom_tool"));
    expect(line).toBe("- my_custom_tool");
  });

  it("includes guidance about using tools", () => {
    const result = buildToolingSection(["read"], "large");
    const joined = result.join("\n");
    expect(joined).toContain("Never guess or fabricate tool results");
  });
});

// ---------------------------------------------------------------------------
// buildToolCallStyleSection
// ---------------------------------------------------------------------------

describe("buildToolCallStyleSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildToolCallStyleSection(true, [])).toEqual([]);
  });

  it("returns Tool Call Style content for full mode", () => {
    const result = buildToolCallStyleSection(false, []);
    const joined = result.join("\n");
    expect(joined).toContain("## Tool Call Style");
    expect(joined).toContain("parallel tool calls");
  });

  it("includes grep/find/ls preference when exec and grep present", () => {
    const joined = buildToolCallStyleSection(false, ["exec", "grep"]).join("\n");
    expect(joined).toContain("Prefer grep/find/ls tools over exec");
  });

  it("includes read-before-edit guideline when read and edit present", () => {
    const joined = buildToolCallStyleSection(false, ["read", "edit"]).join("\n");
    expect(joined).toContain("Use read to examine files before editing");
  });

  it("includes edit precision guideline when edit present", () => {
    const joined = buildToolCallStyleSection(false, ["edit"]).join("\n");
    expect(joined).toContain("old_text must match");
  });

  it("includes write-only-for-new guideline when write present", () => {
    const joined = buildToolCallStyleSection(false, ["write"]).join("\n");
    expect(joined).toContain("Use write only for new files");
  });

  it("includes plain text output guideline when edit or write present", () => {
    const joined = buildToolCallStyleSection(false, ["edit"]).join("\n");
    expect(joined).toContain("output plain text directly");
    const joined2 = buildToolCallStyleSection(false, ["write"]).join("\n");
    expect(joined2).toContain("output plain text directly");
  });

  it("includes show file paths guideline when file tools present", () => {
    const joined = buildToolCallStyleSection(false, ["read"]).join("\n");
    expect(joined).toContain("Show file paths clearly");
  });

  it("omits coding guidelines section when no file tools present", () => {
    const joined = buildToolCallStyleSection(false, ["web_search"]).join("\n");
    expect(joined).not.toContain("### Coding Guidelines");
  });

  it("includes Coding Guidelines heading when guidelines present", () => {
    const joined = buildToolCallStyleSection(false, ["read", "edit", "write", "exec", "grep"]).join("\n");
    expect(joined).toContain("### Coding Guidelines");
  });

  it("includes Python venv guidance when exec is present", () => {
    const joined = buildToolCallStyleSection(false, ["exec"]).join("\n");
    expect(joined).toContain("Python projects");
    expect(joined).toContain("virtualenv");
    expect(joined).toContain("--break-system-packages");
  });

  it("omits Python venv guidance when exec is absent", () => {
    const joined = buildToolCallStyleSection(false, ["read", "write"]).join("\n");
    expect(joined).not.toContain("Python projects");
  });

  it("emits no guidelines in minimal mode even with file tools", () => {
    expect(buildToolCallStyleSection(true, ["read", "edit", "write"])).toEqual([]);
  });

  it("includes Parallel vs Sequential subsection with examples", () => {
    const joined = buildToolCallStyleSection(false, []).join("\n");
    expect(joined).toContain("### Parallel vs Sequential");
    expect(joined).toContain("memory_search + web_search");
    expect(joined).toContain("**Parallel**");
    expect(joined).toContain("**Sequential**");
    expect(joined).toContain("find -> read");
  });
});

// ---------------------------------------------------------------------------
// buildSelfUpdateGatingSection
// ---------------------------------------------------------------------------

describe("buildSelfUpdateGatingSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildSelfUpdateGatingSection(["gateway"], true)).toEqual([]);
  });

  it("returns empty when no admin tool in toolNames", () => {
    expect(buildSelfUpdateGatingSection(["read", "exec"], false)).toEqual([]);
  });

  it("returns Self-Update & Configuration when gateway present", () => {
    const result = buildSelfUpdateGatingSection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Self-Update & Configuration");
    expect(joined).toContain("explicitly asks");
  });

  it("includes Confirmation Protocol when gateway present (non-deferred)", () => {
    const result = buildSelfUpdateGatingSection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).toContain("### Confirmation Protocol");
    expect(joined).toContain("_confirmed: true");
  });

  it("does NOT include Config/Secret integrity (extracted to separate section)", () => {
    const result = buildSelfUpdateGatingSection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("### Config File Integrity");
    expect(joined).not.toContain("### Secret File Integrity");
  });
});

// ---------------------------------------------------------------------------
// buildSelfUpdateGatingSection (deferred)
// ---------------------------------------------------------------------------

describe("buildSelfUpdateGatingSection (deferred)", () => {
  it("returns empty when deferred is true", () => {
    expect(buildSelfUpdateGatingSection(["gateway"], false, true)).toEqual([]);
  });

  it("returns content when deferred is false (default)", () => {
    const result = buildSelfUpdateGatingSection(["gateway"], false);
    expect(result.length).toBeGreaterThan(0);
    expect(result.join("\n")).toContain("## Self-Update & Configuration");
  });

  it("returns content when deferred is explicitly false", () => {
    const result = buildSelfUpdateGatingSection(["gateway"], false, false);
    expect(result.length).toBeGreaterThan(0);
    expect(result.join("\n")).toContain("## Self-Update & Configuration");
  });
});

// ---------------------------------------------------------------------------
// buildConfigSecretIntegritySection
// ---------------------------------------------------------------------------

describe("buildConfigSecretIntegritySection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildConfigSecretIntegritySection(["gateway"], true)).toEqual([]);
  });

  it("returns empty when no confirmation tools present", () => {
    expect(buildConfigSecretIntegritySection(["read", "edit"], false)).toEqual([]);
  });

  it("returns Config File Integrity content when gateway present", () => {
    const result = buildConfigSecretIntegritySection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).toContain("Config File Integrity");
    expect(joined).toContain("Never modify config YAML");
  });

  it("returns Secret File Integrity content when gateway present", () => {
    const result = buildConfigSecretIntegritySection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).toContain("Secret File Integrity");
    expect(joined).toContain(".env");
  });

  it("does NOT contain Confirmation Protocol", () => {
    const result = buildConfigSecretIntegritySection(["gateway", "read"], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("Confirmation Protocol");
  });
});

// ---------------------------------------------------------------------------
// buildCompactedOutputRecoverySection
// ---------------------------------------------------------------------------

describe("buildCompactedOutputRecoverySection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildCompactedOutputRecoverySection(true)).toEqual([]);
  });

  it("returns Handling Compacted Output content for full mode", () => {
    const result = buildCompactedOutputRecoverySection(false);
    const joined = result.join("\n");
    expect(joined).toContain("## Handling Compacted Output");
    expect(joined).toContain("[compacted]");
    expect(joined).toContain("[truncated]");
  });
});

// ---------------------------------------------------------------------------
// buildCodingFallbackSection
// ---------------------------------------------------------------------------

describe("buildCodingFallbackSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildCodingFallbackSection(["exec"], true)).toEqual([]);
  });

  it("returns empty when exec not in toolNames", () => {
    expect(buildCodingFallbackSection(["read", "write"], false)).toEqual([]);
  });

  it("returns Coding & Execution Fallback when exec present", () => {
    const result = buildCodingFallbackSection(["exec"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Coding & Execution Fallback");
    expect(joined).toContain("exec");
    expect(joined).toContain("headless");
  });

});

// ---------------------------------------------------------------------------
// buildTaskDelegationSection
// ---------------------------------------------------------------------------

describe("buildTaskDelegationSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildTaskDelegationSection(["sessions_spawn"], true)).toEqual([]);
  });

  it("returns empty when sessions_spawn is absent", () => {
    expect(buildTaskDelegationSection(["exec", "read"], false)).toEqual([]);
  });

  it("includes delegation criteria when sessions_spawn is present", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Task Delegation");
    expect(joined).toContain("Delegation Criteria");
    expect(joined).toContain("MUST delegate");
    expect(joined).toContain("sessions_spawn");
  });

  it("includes both delegate and do-not-delegate guidance", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false);
    const joined = result.join("\n");
    expect(joined).toContain("Do NOT Delegate");
    expect(joined).toContain("How to Delegate");
  });

  it("includes parallel sub-agent guidance", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false);
    const joined = result.join("\n");
    expect(joined).toContain("Parallel Sub-Agents");
    expect(joined).toContain("parallel tool calls");
    expect(joined).toContain("subagents");
  });

  it("includes sub-agent tool awareness when subAgentToolNames provided", () => {
    const result = buildTaskDelegationSection(
      ["sessions_spawn", "message", "exec", "read"],
      false,
      ["exec", "read", "web_search"],
    );
    const joined = result.join("\n");
    expect(joined).toContain("Sub-Agent Tool Awareness");
    expect(joined).toContain("exec, read, web_search");
    expect(joined).toContain("Sub-agents do NOT have: sessions_spawn, message");
    expect(joined).toContain("CRITICAL");
  });

  it("omits parent-only warning when sub-agent has all parent tools", () => {
    const result = buildTaskDelegationSection(
      ["sessions_spawn", "exec"],
      false,
      ["sessions_spawn", "exec", "read"],
    );
    const joined = result.join("\n");
    expect(joined).toContain("Sub-Agent Tool Awareness");
    expect(joined).not.toContain("do NOT have");
  });

  it("omits sub-agent awareness when subAgentToolNames is undefined", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("Sub-Agent Tool Awareness");
  });

  it("omits sub-agent awareness when subAgentToolNames is empty", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false, []);
    const joined = result.join("\n");
    expect(joined).not.toContain("Sub-Agent Tool Awareness");
  });
});

// ---------------------------------------------------------------------------
// buildPrivilegedToolsSection
// ---------------------------------------------------------------------------

describe("buildPrivilegedToolsSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildPrivilegedToolsSection(["agents_manage"], true)).toEqual([]);
  });

  it("returns empty when no privileged tools present", () => {
    expect(buildPrivilegedToolsSection(["read", "exec", "message"], false)).toEqual([]);
  });

  it("returns Privileged Tools section when at least one privileged tool present", () => {
    const result = buildPrivilegedToolsSection(["agents_manage"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Privileged Tools & Approval Gate");
    expect(joined).toContain("Gated");
    expect(joined).toContain("Read-only");
  });

  it("includes fleet management patterns", () => {
    const result = buildPrivilegedToolsSection(["obs_query", "models_manage"], false);
    const joined = result.join("\n");
    expect(joined).toContain("### Fleet Management Patterns");
  });

  it("works with all 11 privileged tool names", () => {
    const allPrivileged = [
      "agents_manage", "obs_query", "sessions_manage", "memory_manage",
      "channels_manage", "tokens_manage", "models_manage", "providers_manage",
      "skills_manage", "mcp_manage", "heartbeat_manage",
    ];
    const result = buildPrivilegedToolsSection(allPrivileged, false);
    expect(result.length).toBeGreaterThan(0);
  });

  it("recognizes skills_manage, mcp_manage, heartbeat_manage as privileged tools", () => {
    for (const tool of ["skills_manage", "mcp_manage", "heartbeat_manage"]) {
      const result = buildPrivilegedToolsSection([tool], false);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Deferred parameter tests
// ---------------------------------------------------------------------------

describe("deferred parameter on section builders", () => {
  it("buildTaskDelegationSection returns empty when deferred=true", () => {
    expect(buildTaskDelegationSection(["sessions_spawn"], false, undefined, undefined, true)).toEqual([]);
  });

  it("buildTaskDelegationSection returns content when deferred is omitted", () => {
    const result = buildTaskDelegationSection(["sessions_spawn"], false);
    expect(result.length).toBeGreaterThan(0);
  });

  it("buildPrivilegedToolsSection returns empty when deferred=true", () => {
    expect(buildPrivilegedToolsSection(["agents_manage"], false, true)).toEqual([]);
  });

  it("buildPrivilegedToolsSection returns content when deferred is omitted", () => {
    const result = buildPrivilegedToolsSection(["agents_manage"], false);
    expect(result.length).toBeGreaterThan(0);
  });

  it("buildCodingFallbackSection returns empty when deferred=true", () => {
    expect(buildCodingFallbackSection(["exec"], false, true)).toEqual([]);
  });

  it("buildCodingFallbackSection returns content when deferred is omitted", () => {
    const result = buildCodingFallbackSection(["exec"], false);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TOOL_SUMMARIES: session_search entry (migrated from TOOL_DESCRIPTIONS)
// ---------------------------------------------------------------------------

describe("TOOL_SUMMARIES integration", () => {
  it("session_search appears in buildToolingSection output", () => {
    const result = buildToolingSection(["session_search"], "large");
    const joined = result.join("\n");
    expect(joined).toContain("- session_search:");
    expect(joined).toContain(TOOL_SUMMARIES["session_search"]);
  });
});

// ---------------------------------------------------------------------------
// Layer 1D (260430-vwt) -- buildPrivilegedToolsSection "Built-in first"
// bullet rendered from the live pi-ai catalog
// ---------------------------------------------------------------------------

describe("Layer 1D buildPrivilegedToolsSection catalog interpolation", () => {
  it("rendered Built-in first bullet contains every name from getProviders()", async () => {
    const { getProviders } = await import("@mariozechner/pi-ai");
    const result = buildPrivilegedToolsSection(["providers_manage"], false);
    const joined = result.join("\n");
    for (const p of getProviders()) {
      expect(joined, `provider "${p}" missing from rendered tooling section`).toContain(p);
    }
  });

  it("rendered text recommends models_manage list_providers for runtime discovery", () => {
    const result = buildPrivilegedToolsSection(["providers_manage"], false);
    const joined = result.join("\n");
    expect(joined).toContain("models_manage");
    expect(joined).toMatch(/list_providers/);
  });

  it("rendered text no longer pins the literal hardcoded provider roster", () => {
    const result = buildPrivilegedToolsSection(["providers_manage"], false);
    const joined = result.join("\n");
    expect(joined).not.toContain(
      "anthropic, google, openai, groq, mistral, deepseek, cerebras, xai, openrouter",
    );
  });
});
