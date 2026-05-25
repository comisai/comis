// SPDX-License-Identifier: Apache-2.0
/**
 * Unit suite for the per-turn capability-index renderer.
 *
 * Every snapshot test pairs the inline shape lock with at least two
 * `.toContain` and two `.not.toContain` behavior assertions, and every
 * snapshot guards both forbidden literals (the discovery-tool / regex-search
 * names must not leak into the rendered text).
 *
 * Do NOT auto-update via `vitest -u` without re-reading the render contract
 * -- snapshot-as-substitute is an anti-pattern and silently swallows
 * contract drift.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildCapabilityIndexContext } from "./capability-index-context.js";
import type { ExcludeDeferralResult, DeferredToolEntry } from "./tool-deferral.js";
import type { ToolCapabilityPort, PromptSkillCapability, ClusterConfig } from "@comis/core";
// Relative path through `core/src/` (4 levels up from
// `packages/agent/src/executor/`). The `__test-helpers/` directory is excluded
// from `core/tsconfig.json` build but vitest resolves the source file directly.
// Production source MUST NOT use this path -- an architecture-grep catches
// violations.
import { createCapabilityPortStub } from "../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import { TOOL_ORDER } from "../bootstrap/sections/tool-descriptions.js";

// ---------------------------------------------------------------------------
// Local fixture factories (inline make<X>(overrides) at file top).
// ---------------------------------------------------------------------------

/**
 * Build a {@link ToolDefinition} matching `pi-coding-agent`'s shape with the
 * minimum surface needed by the renderer (the renderer only reads `.name`).
 * Mirrors `tool-deferral.test.ts:30-48` makeTool.
 */
function makeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `desc-${name}`,
    parameters: {
      type: "object" as const,
      properties: {},
    },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
  } as unknown as ToolDefinition;
}

/**
 * Build an {@link ExcludeDeferralResult} with empty defaults; spread overrides
 * to inject test-specific arrays. The shape MUST type-check against the source
 * interface in `tool-deferral.ts`.
 */
function makeDeferralResult(
  overrides: Partial<ExcludeDeferralResult> = {},
): ExcludeDeferralResult {
  return {
    activeTools: [],
    deferredEntries: [],
    discoveredTools: [],
    discoverTool: null,
    deferredCount: 0,
    deferredNames: [],
    ...overrides,
  };
}

function makeDeferredEntry(name: string): DeferredToolEntry {
  return { name, description: `desc-${name}`, original: makeTool(name) };
}

function makeSkill(
  name: string,
  overrides: Partial<PromptSkillCapability> = {},
): PromptSkillCapability {
  return {
    name,
    description: `desc-${name}`,
    replacesPackages: [],
    ...overrides,
  };
}

/**
 * Synthesize a chart-class fixture for the budget assertion.
 *
 * Composition: ~60 builtin/platform + 20 MCP + 15 visible prompt skills.
 *  - 60 active builtin/platform tools (pad TOOL_ORDER + extra synthetic names).
 *  - 20 active MCP tools across 3 servers (alpha=8, bravo=7, charlie=5).
 *  - The caller pairs this with a port stub returning 15 visible skills.
 *
 * Total active = 80 surfaces, well above the 32 elision threshold so the >32
 * elision path is exercised and the budget proof is meaningful.
 */
function makeChartClassFixture(): ExcludeDeferralResult {
  const active: ToolDefinition[] = [];
  // 60 builtins: start with TOOL_ORDER (covers ~37) then pad with synthetic names.
  for (let i = 0; i < 60; i++) {
    const name = TOOL_ORDER[i] ?? `synthetic_builtin_${i}`;
    active.push(makeTool(name));
  }
  // 20 MCP tools across 3 servers.
  const mcpServers: Array<[string, number]> = [
    ["alpha", 8],
    ["bravo", 7],
    ["charlie", 5],
  ];
  for (const [server, count] of mcpServers) {
    for (let i = 0; i < count; i++) {
      active.push(makeTool(`mcp__${server}--tool_${i}`));
    }
  }
  return makeDeferralResult({ activeTools: active });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("buildCapabilityIndexContext", () => {
  // -------------------------------------------------------------------------
  // Six-field struct shape lock
  // -------------------------------------------------------------------------
  it("returns a frozen six-field struct with correct primitive types", () => {
    const port = createCapabilityPortStub();
    const result = buildCapabilityIndexContext(makeDeferralResult(), port);

    // Shape: every required field exists with the expected primitive type.
    expect(typeof result.text).toBe("string");
    expect(typeof result.capabilityIndexTokens).toBe("number");
    expect(typeof result.clusterCount).toBe("number");
    expect(typeof result.activeToolCount).toBe("number");
    expect(typeof result.deferredToolCount).toBe("number");
    expect(typeof result.promptSkillCount).toBe("number");
    expect(Object.keys(result).sort()).toEqual(
      [
        "activeToolCount",
        "capabilityIndexTokens",
        "clusterCount",
        "deferredToolCount",
        "promptSkillCount",
        "text",
      ].sort(),
    );
    // Frozen so callers can rely on identity.
    expect(Object.isFrozen(result)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Gate respect (text === "" + zero counts when disabled)
  // -------------------------------------------------------------------------
  it("returns the EMPTY sentinel when isCapabilityIndexEnabled() is false", () => {
    const port = createCapabilityPortStub({
      isCapabilityIndexEnabled: () => false,
      getBuiltinCluster: () => "execution",
      getClusterConfig: () => ({
        label: "Execution",
        priority: 100,
        preferOverInstalls: false,
      }),
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: [makeTool("exec"), makeTool("read")] }),
      port,
    );

    expect(result.text).toBe("");
    expect(result.capabilityIndexTokens).toBe(0);
    expect(result.clusterCount).toBe(0);
    expect(result.activeToolCount).toBe(0);
    expect(result.deferredToolCount).toBe(0);
    expect(result.promptSkillCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // All-zero counts -> EMPTY (no `## Capabilities` heading)
  // -------------------------------------------------------------------------
  it("returns EMPTY when all three surface counts are zero", () => {
    const port = createCapabilityPortStub();
    const result = buildCapabilityIndexContext(makeDeferralResult(), port);

    expect(result.text).toBe("");
    expect(result.text).not.toContain("## Capabilities");
    expect(result.activeToolCount).toBe(0);
    expect(result.deferredToolCount).toBe(0);
    expect(result.promptSkillCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Single-cluster builtin (snapshot + behavior pair)
  // -------------------------------------------------------------------------
  it("renders single-cluster builtin tools (snapshot + behavior pair)", () => {
    // DO NOT auto-update via `vitest -u` without re-reading the render
    // contract.
    const port = createCapabilityPortStub({
      getBuiltinCluster: (name) =>
        name === "exec" || name === "read" ? "execution" : undefined,
      getClusterConfig: (id) =>
        id === "execution"
          ? { label: "Execution", priority: 100, preferOverInstalls: false }
          : undefined,
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: [makeTool("exec"), makeTool("read")] }),
      port,
    );

    expect(result.text).toMatchInlineSnapshot(`
      "## Capabilities

      Map the task to one of these connected capabilities before using exec to install libraries.

      - Active tools: callable now.
      - Deferred tools: connected, but load them through the discovery mechanism available in your active toolspace before invoking them.
      - Prompt skills: available instructions/workflows; use the existing skill-loading mechanism when the task matches.

      ### Execution
      - read, exec"
    `);

    // Behavior assertions.
    expect(result.text).toContain("## Capabilities");
    expect(result.text).toContain("Execution");
    expect(result.text).toContain("read, exec");
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
    expect(result.activeToolCount).toBe(2);
    expect(result.clusterCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Active MCP rendering (server grouping under cluster)
  // -------------------------------------------------------------------------
  it("renders active MCP tools grouped by server under operator-hint cluster", () => {
    const port = createCapabilityPortStub({
      getMcpServerHint: (server) =>
        server === "finance-data"
          ? { cluster: "finance", description: "stock quotes", replacesPackages: ["yfinance"] }
          : undefined,
      getClusterConfig: (id) =>
        id === "finance"
          ? { label: "Finance", priority: 50, preferOverInstalls: true }
          : undefined,
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({
        activeTools: [
          makeTool("mcp__finance-data--get-quote"),
          makeTool("mcp__finance-data--get-history"),
        ],
      }),
      port,
    );

    expect(result.text).toContain("## Capabilities");
    expect(result.text).toContain("### Finance");
    expect(result.text).toContain("[finance-data]");
    expect(result.text).toContain("get-history, get-quote");
    expect(result.text).toContain(
      "Prefer connected tools and available skills over installing equivalent libraries.",
    );
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
    expect(result.activeToolCount).toBe(2);
    expect(result.clusterCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Orphan deferred dropped silently
  // -------------------------------------------------------------------------
  it("drops deferred MCP tools whose server is not in connectedServers", () => {
    const port = createCapabilityPortStub({
      // No connected servers -- the deferred entry is orphaned.
      getConnectedMcpServers: () => [],
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({
        deferredEntries: [makeDeferredEntry("mcp__missing-server--some-tool")],
      }),
      port,
    );

    expect(result.deferredToolCount).toBe(0);
    // No surface counts at all -> EMPTY sentinel.
    expect(result.text).toBe("");
    expect(result.text).not.toContain("missing-server");
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Hidden skills not rendered (port returns empty list)
  // -------------------------------------------------------------------------
  it("does not render skills when getPromptSkillCapabilities() returns empty", () => {
    const port = createCapabilityPortStub({
      getPromptSkillCapabilities: () => [],
      getBuiltinCluster: (name) => (name === "exec" ? "execution" : undefined),
      getClusterConfig: (id) =>
        id === "execution"
          ? { label: "Execution", priority: 100, preferOverInstalls: false }
          : undefined,
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: [makeTool("exec")] }),
      port,
    );

    expect(result.promptSkillCount).toBe(0);
    // No `### Prompt skills` cluster header should be emitted (the
    // preamble bullet "Prompt skills: available..." is unrelated text).
    expect(result.text).not.toContain("### Prompt skills");
    // No `- skills:` body line either.
    expect(result.text).not.toContain("- skills:");
    expect(result.text).toContain("## Capabilities");
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Reserved-cluster fallbacks
  //   - connected MCP without operator hint -> external-integrations
  //   - skill without cluster field         -> prompt-skills
  //   - non-MCP tool without builtin cluster -> other-tools
  // -------------------------------------------------------------------------
  it("falls back to reserved cluster IDs (external-integrations / prompt-skills / other-tools)", () => {
    const reservedConfig: Record<string, ClusterConfig> = {
      "external-integrations": {
        label: "External integrations",
        priority: 9999,
        preferOverInstalls: true,
      },
      "prompt-skills": {
        label: "Prompt skills",
        priority: 9999,
        preferOverInstalls: true,
      },
      "other-tools": {
        label: "Other tools",
        priority: 9999,
        preferOverInstalls: false,
      },
    };
    const port = createCapabilityPortStub({
      // Force the three fallback paths:
      getBuiltinCluster: () => undefined,
      getMcpServerHint: () => undefined,
      getClusterConfig: (id) => reservedConfig[id],
      getPromptSkillCapabilities: () => [makeSkill("css-cleanup")],
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({
        activeTools: [
          makeTool("exec"), // unmapped builtin -> "other-tools"
          makeTool("mcp__random-server--tool_x"), // unhinted MCP -> "external-integrations"
        ],
      }),
      port,
    );

    expect(result.text).toContain("External integrations");
    expect(result.text).toContain("Prompt skills");
    expect(result.text).toContain("Other tools");
    expect(result.clusterCount).toBe(3);
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Per-server cap at 8 with `+N more` and preferOverInstalls callout
  // -------------------------------------------------------------------------
  it("caps per-server tool list at 8 with `+N more` and emits preferOverInstalls callout", () => {
    const port = createCapabilityPortStub({
      getMcpServerHint: (server) =>
        server === "big-server"
          ? { cluster: "integrations", description: "big", replacesPackages: [] }
          : undefined,
      getClusterConfig: (id) =>
        id === "integrations"
          ? { label: "Integrations", priority: 100, preferOverInstalls: true }
          : undefined,
    });
    // 9 active MCP tools from one server (cap=8 + 1 more).
    const tools: ToolDefinition[] = [];
    for (let i = 0; i < 9; i++) tools.push(makeTool(`mcp__big-server--tool_${i}`));
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: tools }),
      port,
    );

    expect(result.text).toContain("[big-server]");
    expect(result.text).toContain("+1 more");
    expect(result.text).toContain(
      "Prefer connected tools and available skills over installing equivalent libraries.",
    );
    expect(result.activeToolCount).toBe(9);
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Elision boundary: at 32 names present, at 33 names dropped
  // -------------------------------------------------------------------------
  it("at exactly 32 active tools, per-cluster name lists are present", () => {
    const port = createCapabilityPortStub({
      getMcpServerHint: () => ({
        cluster: "many",
        description: "many",
        replacesPackages: [],
      }),
      getClusterConfig: () => ({
        label: "Many",
        priority: 100,
        preferOverInstalls: false,
      }),
    });
    const tools: ToolDefinition[] = [];
    for (let i = 0; i < 32; i++) tools.push(makeTool(`mcp__server_${i}--tool`));
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: tools }),
      port,
    );

    expect(result.activeToolCount).toBe(32);
    // At 32, name lists remain -- header `[server_X]` + `: tool` body present.
    expect(result.text).toContain("[server_0]");
    expect(result.text).toContain(": tool");
    // The summary count-line shape from elision must NOT appear.
    expect(result.text).not.toMatch(/\(\d+ tools\)$/m);
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  it("at exactly 33 active tools, per-cluster name lists are dropped (headers + counts only)", () => {
    const port = createCapabilityPortStub({
      getMcpServerHint: () => ({
        cluster: "many",
        description: "many",
        replacesPackages: [],
      }),
      getClusterConfig: () => ({
        label: "Many",
        priority: 100,
        preferOverInstalls: false,
      }),
    });
    const tools: ToolDefinition[] = [];
    for (let i = 0; i < 33; i++) tools.push(makeTool(`mcp__server_${i}--tool`));
    const result = buildCapabilityIndexContext(
      makeDeferralResult({ activeTools: tools }),
      port,
    );

    expect(result.activeToolCount).toBe(33);
    // Cluster header still present.
    expect(result.text).toContain("### Many");
    // Count line present.
    expect(result.text).toContain("(33 tools)");
    // No per-server `[server_X]` prefix because name lists are dropped.
    expect(result.text).not.toContain("[server_0]");
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Cluster sort `(priority asc, clusterId asc)` with alphabetical-on-tie
  // -------------------------------------------------------------------------
  it("cluster sort is (priority asc, clusterId asc) with alphabetical tie-break", () => {
    // Two clusters at SAME priority (100): cluster-zebra and cluster-alpha
    // -> alphabetical tie-break puts alpha BEFORE zebra.
    // A third cluster at priority 50 must render before both.
    const port = createCapabilityPortStub({
      getBuiltinCluster: (name) => {
        if (name === "exec") return "cluster-zebra"; // priority 100
        if (name === "read") return "cluster-alpha"; // priority 100
        if (name === "write") return "cluster-priority-low"; // priority 50
        // unknown_tool -> falls into other-tools (priority 9999)
        return undefined;
      },
      getClusterConfig: (id) => {
        const map: Record<string, ClusterConfig> = {
          "cluster-zebra": { label: "Cluster Zebra", priority: 100, preferOverInstalls: false },
          "cluster-alpha": { label: "Cluster Alpha", priority: 100, preferOverInstalls: false },
          "cluster-priority-low": {
            label: "Cluster Priority Low",
            priority: 50,
            preferOverInstalls: false,
          },
          "other-tools": {
            label: "Other tools",
            priority: 9999,
            preferOverInstalls: false,
          },
        };
        return map[id];
      },
    });
    // `read` is in TOOL_ORDER before `exec`; `unknown_tool` not in TOOL_ORDER.
    const result = buildCapabilityIndexContext(
      makeDeferralResult({
        activeTools: [
          makeTool("exec"),
          makeTool("read"),
          makeTool("write"),
          makeTool("unknown_tool"),
        ],
      }),
      port,
    );

    // Order check: priority-50 first, then alpha (100), then zebra (100), then other-tools (9999).
    const idxLow = result.text.indexOf("Cluster Priority Low");
    const idxAlpha = result.text.indexOf("Cluster Alpha");
    const idxZebra = result.text.indexOf("Cluster Zebra");
    const idxOther = result.text.indexOf("Other tools");
    expect(idxLow).toBeGreaterThan(-1);
    expect(idxAlpha).toBeGreaterThan(idxLow);
    expect(idxZebra).toBeGreaterThan(idxAlpha);
    expect(idxOther).toBeGreaterThan(idxZebra);
    expect(result.clusterCount).toBe(4);

    // Within-cluster: `read` precedes `exec` per TOOL_ORDER (read=0, exec=4).
    // Both live in their own clusters here, so we cannot assert in-cluster
    // builtins ordering against each other. Instead exercise unknown-tool
    // alphabetical fallback: `unknown_tool` lands in `other-tools` alone.
    expect(result.text).toContain("unknown_tool");

    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Within-cluster TOOL_ORDER: read precedes exec
  // -------------------------------------------------------------------------
  it("within-cluster builtins follow TOOL_ORDER (read precedes exec; unknown last)", () => {
    const port = createCapabilityPortStub({
      getBuiltinCluster: () => "io",
      getClusterConfig: (id) =>
        id === "io"
          ? { label: "IO", priority: 100, preferOverInstalls: false }
          : undefined,
    });
    const result = buildCapabilityIndexContext(
      makeDeferralResult({
        activeTools: [
          makeTool("unknown_tool"),
          makeTool("exec"),
          makeTool("read"),
        ],
      }),
      port,
    );
    // TOOL_ORDER: read (0), edit (1), notebook_edit (2), write (3), exec (4)
    // Unknown -> Number.MAX_SAFE_INTEGER -> alphabetical last among unknowns.
    // Restrict the search to the cluster body (after the `### IO` heading)
    // because the preamble line "before using exec to install libraries"
    // also contains the substring "exec".
    const headingIdx = result.text.indexOf("### IO");
    expect(headingIdx).toBeGreaterThan(-1);
    const body = result.text.slice(headingIdx);
    // Body shape: "### IO\n- read, exec, unknown_tool"
    expect(body).toMatch(/- read, exec, unknown_tool/);
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });

  // -------------------------------------------------------------------------
  // Chart-class budget proof (capabilityIndexTokens <= 600)
  // -------------------------------------------------------------------------
  it("chart-class fixture (~80 active + 15 skills) keeps capabilityIndexTokens <= 600", () => {
    // Composition: 60 builtins + 20 MCP across 3 servers + 15 skills.
    // Total active = 80 (well above 32 elision threshold; name lists drop).
    const skills: PromptSkillCapability[] = [];
    for (let i = 0; i < 15; i++) skills.push(makeSkill(`skill_${i}`));
    const port = createCapabilityPortStub({
      getBuiltinCluster: () => "core",
      getMcpServerHint: () => ({
        cluster: "integrations",
        description: "ext",
        replacesPackages: [],
      }),
      getConnectedMcpServers: () => ["alpha", "bravo", "charlie"],
      getPromptSkillCapabilities: () => skills,
      getClusterConfig: (id) => {
        if (id === "core") return { label: "Core", priority: 10, preferOverInstalls: false };
        if (id === "integrations")
          return { label: "Integrations", priority: 100, preferOverInstalls: true };
        if (id === "prompt-skills")
          return { label: "Prompt skills", priority: 9999, preferOverInstalls: true };
        return undefined;
      },
    });
    const result = buildCapabilityIndexContext(makeChartClassFixture(), port);

    expect(result.activeToolCount).toBe(80);
    expect(result.promptSkillCount).toBe(15);
    expect(result.capabilityIndexTokens).toBeLessThanOrEqual(600);
    // Sanity: text is non-empty and uses headers + counts (elision active).
    expect(result.text).toContain("## Capabilities");
    expect(result.text).toContain("(60 tools)"); // Core cluster (60 builtins)
    expect(result.text).toContain("(20 tools)"); // Integrations cluster (20 MCP)
    expect(result.text).not.toContain("discover_tools");
    expect(result.text).not.toContain("tool_search_tool_regex");
  });
});
