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

// ---------------------------------------------------------------------------
// buildToolingSection
//
// The function unconditionally emits only a one-liner pointing at the
// per-turn `## Capabilities` block. There is NO static `## Available Tools`
// flat block and no static-prompt capability-index gate parameter.
// ---------------------------------------------------------------------------

describe("buildToolingSection", () => {
  it("returns empty for empty toolNames", () => {
    expect(buildToolingSection([], "large")).toEqual([]);
  });

  it("emits the residual one-liner regardless of model tier", () => {
    const result = buildToolingSection(["read", "exec"], "large");
    const joined = result.join("\n");
    expect(joined).toContain("When this turn includes a `Capabilities` context");
    expect(joined).toContain("authoritative for parameter shapes");
  });

  it("does NOT emit a static `## Available Tools` flat block", () => {
    const result = buildToolingSection(["read", "exec"], "large");
    const joined = result.join("\n");
    expect(joined).not.toContain("## Available Tools");
    expect(joined).not.toContain("- read");
    expect(joined).not.toContain("- exec");
    expect(joined).not.toContain("Always use tools to gather real data");
  });

  it("ignores custom toolSummaries (the legacy flat block consumer is gone)", () => {
    const result = buildToolingSection(["read"], "large", { read: "Custom read description" });
    const joined = result.join("\n");
    expect(joined).not.toContain("Custom read description");
    expect(joined).toContain("When this turn includes a `Capabilities` context");
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

  it("includes agent administration patterns", () => {
    const result = buildPrivilegedToolsSection(["obs_query", "models_manage"], false);
    const joined = result.join("\n");
    expect(joined).toContain("### System Management Patterns");
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
// buildPrivilegedToolsSection "Built-in first" bullet rendered from the live
// pi-ai catalog
// ---------------------------------------------------------------------------

describe("buildPrivilegedToolsSection catalog interpolation", () => {
  it("rendered Built-in first bullet contains every name from getProviders()", async () => {
    const { getProviders } = await import("@earendil-works/pi-ai/compat");
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

// ---------------------------------------------------------------------------
// Tool-first counterweight. The bullet emits unconditionally when `exec`
// is in `toolNames`; there is no static-prompt capability-index gate. The
// bullet wording is normative — DO NOT auto-update via `vitest -u` without
// verifying the rendered text by hand.
// ---------------------------------------------------------------------------

describe("buildToolCallStyleSection — tool-first counterweight", () => {
  it("emits the tool-first bullet immediately before the Python venv rule when exec is present (snapshot + behavior pair)", () => {
    const result = buildToolCallStyleSection(false, ["exec"]);
    const joined = result.join("\n");

    // Shape lock — verbatim bullet text. Hand-verified at authoring time.
    // DO NOT auto-update via `vitest -u` without re-checking the rendered wording.
    expect(joined).toMatchInlineSnapshot(`
      "## Tool Call Style
      Default: do not narrate routine, low-risk tool calls (just call the tool).
      Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.
      Keep narration brief and value-dense; avoid repeating obvious steps.

      - Prefer parallel tool calls when independent (see below)
      - Read files before writing to verify current state
      - Chain dependent calls sequentially (e.g., find → read → edit)
      - On tool failure: check the error, fix parameters, and retry once. If it fails again, try an alternative approach or report the error to the user.
      - Do not retry the same failing call repeatedly.

      ### Coding Guidelines
      - **Tool-first principle.** When this turn includes a \`Capabilities\` context and the task can be satisfied by a connected tool or available skill, prefer that capability over installing a Python or Node package. Use installs only for capabilities not covered by active tools, deferred tools, or visible prompt skills.
      - **Python projects:** Create a project virtualenv with \`python3 -m venv .venv\`, then call \`.venv/bin/python3\` and \`.venv/bin/pip install <pkgs>\` directly. Do not source the venv activate script — the exec sandbox blocks shell-source. Never use \`--break-system-packages\`. Each project gets its own \`.venv\`.

      ### Parallel vs Sequential
      Call independent tools in parallel to reduce round-trips:
      - **Parallel**: memory_search + web_search (independent data sources)
      - **Parallel**: Multiple read calls for different files -- ALWAYS read in parallel when examining 2+ files
      - **Parallel**: grep + find when searching for different things
      - **Sequential**: find -> read (need file path before reading)
      - **Sequential**: read -> edit (need current content before editing)
      - **Sequential**: memory_search -> memory_store (need results before deciding what to store)"
    `);

    // Behavior assertions:
    // (a) the bullet's lead-in identifies the tool-first principle
    expect(joined).toContain("**Tool-first principle.**");
    // (b) the verbatim opening
    expect(joined).toContain("When this turn includes a `Capabilities` context and the task can be satisfied by");
    // (c) the verbatim ending
    expect(joined).toContain("Use installs only for capabilities not covered by active tools, deferred tools, or visible prompt skills");

    // ORDERING: the new bullet emits BEFORE the existing Python-virtualenv
    // rule (the "immediately before" clause). A reorder regression would fail
    // this check deterministically.
    expect(joined.indexOf("Tool-first principle")).toBeLessThan(joined.indexOf("Python projects"));

    // The venv rule is still emitted because `exec` is present (the venv
    // rule and the tool-first bullet share the outer if(has("exec")) block).
    expect(joined).toContain("Python projects");

    // Forbidden literals (defense in depth at the rendered-output level; the
    // architecture-grep test is the primary file-source enforcement).
    expect(joined).not.toContain("discover_tools");
    expect(joined).not.toContain("tool_search_tool_regex");

    // The bullet must never advise `source .venv/bin/activate` — the exec
    // sandbox blocks it via the `\bsource\s` denylist pattern
    // (exec-security-allowlist.ts). The bullet directs the agent to call
    // .venv/bin/{python3,pip} directly, matching the AGENTS.md template guidance.
    expect(joined).not.toContain("source .venv/bin/activate");
    expect(joined).toContain(".venv/bin/pip install <pkgs>");
    expect(joined).toContain("the exec sandbox blocks shell-source");
  });

  it("does NOT emit the tool-first bullet OR the venv rule when exec is absent", () => {
    const result = buildToolCallStyleSection(false, ["read", "write"]);
    const joined = result.join("\n");

    // Both the tool-first bullet and the venv rule live inside the same
    // outer if(has("exec")) block — both are absent when exec is not in
    // toolNames.
    expect(joined).not.toContain("Tool-first principle");
    expect(joined).not.toContain("When this turn includes a `Capabilities` context");
    expect(joined).not.toContain("Python projects");

    // Sanity: the rest of the section still renders (the function did not
    // return empty — it just skipped the inner exec-gated block).
    expect(joined).toContain("## Tool Call Style");
  });
});
