// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the install-detour parser.
 *
 * Coverage:
 * - Positive matrix (17 rows): supported PMs, version-stripping, scoped npm, PEP-503
 * - False-positive matrix (13 rows): npm audit, npx, pwsh, python -c, heredocs,
 *   $( ), backticks, quoted echo, single-quoted segments, unbalanced quotes
 * - Normalization: PEP-503 strict (`name__with..dashes` → `name-with-dashes`)
 * - Alias-map construction: operator hints + comis.capability + visibility/disconnected filters
 * - commandDigest properties: 16-hex regex, deterministic, order-insensitive, distinct
 *
 * Uses `createCapabilityPortStub` from `__test-helpers/`. Tests must use the
 * test-only stub factory (NOT the production no-op port). The architecture-grep at
 * `packages/skills/src/__tests__/architecture.test.ts:37-48` enforces this
 * by source-grepping `.test.ts` files for the production-port symbol.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  parseInstallDetour,
  type InstallDetourDecision,
  type DetourOverlap,
} from "./install-detour.js";
import { createCapabilityPortStub } from "../../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import type { ToolCapabilityPort, PromptSkillCapability, McpServerHint, SkillHint } from "@comis/core";

// Type-only imports retained as a documentation handle on the public surface
// (asserts at compile time that both type names are exported and resolvable).
type _PublicTypeSurface = [InstallDetourDecision, DetourOverlap];

// ---------------------------------------------------------------------------
// Test fixtures (per-test factories)
// ---------------------------------------------------------------------------


/** Stub: empty port — no connected servers, no visible skills. Used for matrix tests. */
function makeEmptyPort(): ToolCapabilityPort {
  return createCapabilityPortStub();
}

/** Stub: single connected MCP server with operator hint declaring replacesPackages. */
function makeFinanceDataPort(overrides?: Partial<{
  replacesPackages: readonly string[];
  cluster: string;
  visibleSkills: readonly PromptSkillCapability[];
  connectedServers: readonly string[];
}>): ToolCapabilityPort {
  const replaces = overrides?.replacesPackages ?? ["market-data-lib", "finance-data-client"];
  const cluster = overrides?.cluster ?? "data-fetching-financial";
  const servers = overrides?.connectedServers ?? ["finance-data"];
  const skills = overrides?.visibleSkills ?? [];
  return createCapabilityPortStub({
    getConnectedMcpServers: () => servers,
    getMcpServerHint: (serverName: string): McpServerHint | undefined =>
      serverName === "finance-data"
        ? { cluster, description: "Market data MCP", replacesPackages: replaces }
        : undefined,
    getSkillHint: (): SkillHint | undefined => undefined,
    getPromptSkillCapabilities: () => skills,
  });
}

// ===========================================================================
// POSITIVE MATRIX
// ===========================================================================

describe("parseInstallDetour — positive matrix", () => {
  // Each row uses a port that DOES produce overlaps,
  // so decision is non-null and we can assert packageManager + packages.
  it.each([
    ["pip install matplotlib",                                "pip",  ["matplotlib"]],
    ["pip install Matplotlib",                                "pip",  ["matplotlib"]],
    ["pip install matplotlib==3.5.0",                         "pip",  ["matplotlib"]],
    ["pip install matplotlib --quiet",                        "pip",  ["matplotlib"]],
    ["pip3 install matplotlib pandas",                        "pip",  ["matplotlib", "pandas"]],
    ["python -m pip install matplotlib",                      "pip",  ["matplotlib"]],
    ["python3 -m pip install matplotlib --break-system-packages", "pip", ["matplotlib"]],
    ["npm install lodash",                                    "npm",  ["lodash"]],
    ["npm i lodash@4.17.0",                                   "npm",  ["lodash"]],
    ["npm install @scope/pkg@1.2.3",                          "npm",  ["@scope/pkg"]],
    ["npm add lodash react",                                  "npm",  ["lodash", "react"]],
    ["pnpm install lodash",                                   "pnpm", ["lodash"]],
    ["pnpm add lodash",                                       "pnpm", ["lodash"]],
    ["yarn add lodash",                                       "yarn", ["lodash"]],
    ["pip install pandas_ml",                                 "pip",  ["pandas-ml"]],
    ["pip install foo.bar",                                   "pip",  ["foo-bar"]],
    ["source .venv/bin/activate && pip install matplotlib",   "pip",  ["matplotlib"]],
    // `&` is a POSIX top-level separator (background-and-continue), so an install
    // command after `&` is still detected — `&` is in the single-char operator
    // set splitTopLevelSegments splits on.
    ["echo hi & pip install matplotlib",                      "pip",  ["matplotlib"]],
    ["pip install foo & echo bg",                             "pip",  ["foo"]],
    ["echo a & echo b & npm install lodash",                  "npm",  ["lodash"]],
  ] as const)("parses %j -> %s %j", (input, expectedPm, expectedPkgs) => {
    // Build a port that overlaps EVERY package in the expected list, so
    // parser returns non-null and we can assert the parsed shape.
    const expectedPkgsArr = expectedPkgs as readonly string[];
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["dummy-server"],
      getMcpServerHint: (server: string): McpServerHint | undefined =>
        server === "dummy-server"
          ? { cluster: "x", description: "y", replacesPackages: expectedPkgsArr }
          : undefined,
    });
    const decision = parseInstallDetour(input, port);
    expect(decision).not.toBeNull();
    expect(decision!.packageManager).toBe(expectedPm);
    expect([...decision!.packages].sort()).toEqual([...expectedPkgsArr].sort());
    expect(decision!.commandDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ===========================================================================
// SEPARATOR DISCRIMINATION
// ===========================================================================

describe("parseInstallDetour — `&` vs `&&` separator discrimination", () => {
  it("treats `&` as a top-level separator (background-and-continue)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["matplotlib-server"],
      getMcpServerHint: (s: string): McpServerHint | undefined =>
        s === "matplotlib-server"
          ? { cluster: "viz", description: "y", replacesPackages: ["matplotlib"] }
          : undefined,
    });
    const decision = parseInstallDetour("echo hi & pip install matplotlib", port);
    expect(decision).not.toBeNull();
    expect(decision!.packageManager).toBe("pip");
    expect(decision!.packages).toEqual(["matplotlib"]);
  });

  it("does NOT mis-split `&&` into two `&` separators (two-char lookahead runs first)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["matplotlib-server"],
      getMcpServerHint: (s: string): McpServerHint | undefined =>
        s === "matplotlib-server"
          ? { cluster: "viz", description: "y", replacesPackages: ["matplotlib"] }
          : undefined,
    });
    // The leading segment `source .venv/bin/activate` is harmless; the install lives
    // in the second segment after `&&`. If `&&` were mis-split, the second segment
    // would start with `& pip install matplotlib`, which would fail parseInstallSegment.
    const decision = parseInstallDetour("source .venv/bin/activate && pip install matplotlib", port);
    expect(decision).not.toBeNull();
    expect(decision!.packageManager).toBe("pip");
    expect(decision!.packages).toEqual(["matplotlib"]);
  });

  it("respects quote state — `&` inside single quotes does NOT split", () => {
    // `echo 'foo & bar'` is one segment; the `pip install` after the closing quote
    // belongs to the next top-level segment.
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["x"],
      getMcpServerHint: (s: string): McpServerHint | undefined =>
        s === "x" ? { cluster: "x", description: "y", replacesPackages: ["matplotlib"] } : undefined,
    });
    const decision = parseInstallDetour("echo 'foo & bar' && pip install matplotlib", port);
    expect(decision).not.toBeNull();
    expect(decision!.packages).toEqual(["matplotlib"]);
  });

  it("bails on unbalanced quotes around `&`", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["x"],
      getMcpServerHint: (): McpServerHint | undefined =>
        ({ cluster: "x", description: "y", replacesPackages: ["matplotlib"] }),
    });
    // Unbalanced double quote — splitTopLevelSegments returns null, parser bails.
    const decision = parseInstallDetour('echo "foo & pip install matplotlib', port);
    expect(decision).toBeNull();
  });
});

// ===========================================================================
// FALSE-POSITIVE MATRIX — DOMINANT TEST SURFACE
// ===========================================================================

describe("parseInstallDetour — false-positive matrix", () => {
  // 13-row matrix. Each row maps to a specific parser branch and exercises
  // one false-positive path.
  //
  // INVARIANT: every row asserts that the parser returns `null` AND
  // therefore the executor consuming this parser's output emits ZERO
  // `tool:install_detour_detected` events. The parser is a pure
  // function — it never emits events itself. The executor wraps every
  // emit in `if (decision !== null) { emit(...) }`, so a null decision
  // is structurally equivalent to "zero events emitted."
  //
  // The port stub is constructed to produce overlap IF the parser
  // fired — so any false positive surfaces as a non-null decision
  // (which would fail this test).
  it.each([
    ["npm audit",                                             "second-token-not-install"],
    ["npm audit fix",                                         "second-token-not-install"],
    ["npx some-pkg",                                          "leading-token-not-supported"],
    ["npx --yes pip install x",                               "leading-token-not-supported"],
    ["pwsh -c 'pip install x'",                               "leading-token-not-supported"],
    ["python -c 'subprocess.run([\"pip\",\"install\",\"x\"])'", "second-token-not-m"],
    ["cat <<'EOF'\npip install x\nEOF",                       "heredoc-body-not-leading-token"],
    ["$(echo pip install x)",                                 "command-substitution-not-leading-token"],
    ["`echo pip install x`",                                  "backtick-substitution-not-leading-token"],
    ['echo "pip install x"',                                  "quoted-echo-leading-token-is-echo"],
    ["echo 'pip install x; rm -rf /'",                        "single-quoted-segment-leading-token-is-echo"],
    // Unbalanced quotes — parser-bail path (splitTopLevelSegments returns null)
    ['pip install "x',                                        "unbalanced-double-quote-bail"],
    ["pip install 'x",                                        "unbalanced-single-quote-bail"],
  ] as const)("returns null for %j (branch: %s) and produces zero events", (input, _branch) => {
    // Use a port whose connected servers and hints match the literal
    // package names in every row above (`pip`, `x`, `pkg`, etc.) — so
    // any false positive yields a non-null decision and fails the test.
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["pip", "x", "pkg", "some-pkg", "market-data-lib"],
      getMcpServerHint: (s: string): McpServerHint | undefined => ({
        cluster: "x", description: "y", replacesPackages: [s],
      }),
    });
    const decision = parseInstallDetour(input, port);
    // Primary contract: parser returns null on every false-positive row.
    expect(decision).toBeNull();
    // Equivalent invariant: a null decision means the executor's emit
    // guard `if (decision !== null) { eventBus.emit(...) }` is bypassed,
    // so zero `tool:install_detour_detected` events are emitted for any
    // command in this matrix. The parser itself never accesses an
    // `eventBus`, so this is structurally guaranteed at the type level.
  });
});

// ===========================================================================
// NORMALIZATION
// ===========================================================================

describe("parseInstallDetour — name normalization", () => {
  it.each([
    // PEP-503 strict: `[-_.]+` → `-`
    ["pip install pandas_ml",       "pandas-ml"],
    ["pip install foo.bar",         "foo-bar"],
    ["pip install foo__bar",        "foo-bar"],   // PEP-503 collapses runs
    ["pip install name--with--dashes", "name-with-dashes"],   // PEP-503 collapses runs
    ["pip install Foo.Bar_Baz",     "foo-bar-baz"],
  ] as const)("normalizes %j -> %j (Python PEP-503)", (input, expectedName) => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["dummy"],
      getMcpServerHint: (): McpServerHint | undefined =>
        ({ cluster: "x", description: "y", replacesPackages: [expectedName] }),
    });
    const decision = parseInstallDetour(input, port);
    expect(decision).not.toBeNull();
    expect(decision!.packages).toEqual([expectedName]);
  });

  it("npm preserves @scope/name and lowercases", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["dummy"],
      getMcpServerHint: (): McpServerHint | undefined =>
        ({ cluster: "x", description: "y", replacesPackages: ["@scope/pkg"] }),
    });
    const decision = parseInstallDetour("npm install @SCOPE/PKG", port);
    expect(decision).not.toBeNull();
    expect(decision!.packages).toEqual(["@scope/pkg"]);
  });

  it("npm DOES NOT collapse `_` to `-` (preserves npm convention)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["dummy"],
      getMcpServerHint: (): McpServerHint | undefined =>
        ({ cluster: "x", description: "y", replacesPackages: ["foo_bar"] }),
    });
    const decision = parseInstallDetour("npm install foo_bar", port);
    expect(decision).not.toBeNull();
    expect(decision!.packages).toEqual(["foo_bar"]);
  });
});

// ===========================================================================
// OVERLAP DETECTION
// ===========================================================================

describe("parseInstallDetour — direct overlap", () => {
  it("matches connected MCP server name directly (post-normalization)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["finance-data"],
    });
    const decision = parseInstallDetour("pip install finance-data", port);
    expect(decision).not.toBeNull();
    expect(decision!.overlaps).toHaveLength(1);
    expect(decision!.overlaps[0]).toMatchObject({
      packageName: "finance-data",
      sourceType: "mcp",
      sourceName: "finance-data",
      reason: "direct-server-name",
    });
  });

  it("does NOT infer skill names as direct aliases", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => [],
      getPromptSkillCapabilities: () => [
        { name: "matplotlib", cluster: "charts", replacesPackages: [] },
      ],
    });
    // Skill name == "matplotlib"; no replacesPackages declared.
    // Skill name MUST NOT be inferred as a package alias.
    expect(parseInstallDetour("pip install matplotlib", port)).toBeNull();
  });
});

describe("parseInstallDetour — alias overlap", () => {
  it("MCP operator alias: tooling.mcp.capabilityHints[*].replacesPackages", () => {
    const port = makeFinanceDataPort();    // replaces market-data-lib, finance-data-client
    const decision = parseInstallDetour("pip install market-data-lib", port);
    expect(decision).not.toBeNull();
    expect(decision!.overlaps[0]).toMatchObject({
      sourceType: "mcp",
      sourceName: "finance-data",
      reason: "mcp-operator-alias",
      cluster: "data-fetching-financial",
    });
  });

  it("skill operator alias: tooling.skills.capabilityHints[*].replacesPackages (port.getSkillHint truthy)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => [],
      getPromptSkillCapabilities: () => [
        { name: "chart-workflow", cluster: "charts", replacesPackages: ["chart-workflow-sdk"] },
      ],
      // Operator hint exists for this skill — reason must be "skill-operator-alias"
      getSkillHint: (n: string): SkillHint | undefined =>
        n === "chart-workflow"
          ? { cluster: "charts", replacesPackages: ["chart-workflow-sdk"] }
          : undefined,
    });
    const decision = parseInstallDetour("pip install chart-workflow-sdk", port);
    expect(decision).not.toBeNull();
    expect(decision!.overlaps[0]).toMatchObject({
      sourceType: "skill",
      sourceName: "chart-workflow",
      reason: "skill-operator-alias",
    });
  });

  it("skill comis alias: comis.capability.replacesPackages (port.getSkillHint undefined)", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => [],
      getPromptSkillCapabilities: () => [
        { name: "chart-workflow", cluster: "charts", replacesPackages: ["chart-workflow-sdk"] },
      ],
      // No operator hint — reason must be "skill-comis-alias"
      getSkillHint: () => undefined,
    });
    const decision = parseInstallDetour("pip install chart-workflow-sdk", port);
    expect(decision).not.toBeNull();
    expect(decision!.overlaps[0]).toMatchObject({
      sourceType: "skill",
      sourceName: "chart-workflow",
      reason: "skill-comis-alias",
    });
  });

  it("first-source-wins precedence: MCP alias takes priority over skill alias for the same package", () => {
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => ["finance-data"],
      getMcpServerHint: (s: string): McpServerHint | undefined =>
        s === "finance-data"
          ? { cluster: "data", description: "x", replacesPackages: ["shared-pkg"] }
          : undefined,
      getPromptSkillCapabilities: () => [
        { name: "shared-skill", cluster: "skills", replacesPackages: ["shared-pkg"] },
      ],
    });
    const decision = parseInstallDetour("pip install shared-pkg", port);
    expect(decision).not.toBeNull();
    expect(decision!.overlaps[0]!.sourceType).toBe("mcp");
    expect(decision!.overlaps[0]!.reason).toBe("mcp-operator-alias");
  });
});

describe("parseInstallDetour — visibility filter", () => {
  it("hidden skills (excluded by port.getPromptSkillCapabilities()) produce no overlap", () => {
    // The port already filters by allowedSkills/deniedSkills/eligibility/disableModelInvocation.
    // The parser just calls getPromptSkillCapabilities() —
    // hidden skills never appear in the result. Verify by passing an empty list.
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => [],
      getPromptSkillCapabilities: () => [],   // hidden skills filtered upstream
    });
    expect(parseInstallDetour("pip install some-skill-pkg", port)).toBeNull();
  });
});

describe("parseInstallDetour — disconnected MCP filter", () => {
  it("disconnected servers (excluded by port.getConnectedMcpServers()) produce no overlap, even with a hint", () => {
    // The runtime view filters by status === "connected" upstream.
    // Verify the parser respects an empty connected list
    // even though getMcpServerHint(...) would return a hint if asked.
    const port = createCapabilityPortStub({
      getConnectedMcpServers: () => [],       // server is disconnected
      getMcpServerHint: (s: string): McpServerHint | undefined =>
        s === "finance-data"
          ? { cluster: "data", description: "x", replacesPackages: ["market-data-lib"] }
          : undefined,
    });
    expect(parseInstallDetour("pip install market-data-lib", port)).toBeNull();
    expect(parseInstallDetour("pip install finance-data", port)).toBeNull();
  });
});

// ===========================================================================
// commandDigest PROPERTIES
// ===========================================================================

describe("parseInstallDetour — commandDigest properties", () => {
  it("is hex-only, exactly 16 chars", () => {
    const port = makeFinanceDataPort();
    const decision = parseInstallDetour("pip install market-data-lib", port);
    expect(decision).not.toBeNull();
    expect(decision!.commandDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(decision!.commandDigest).toHaveLength(16);
  });

  it("is deterministic across calls", () => {
    const port = makeFinanceDataPort();
    const a = parseInstallDetour("pip install market-data-lib", port);
    const b = parseInstallDetour("pip install market-data-lib", port);
    expect(a?.commandDigest).toBe(b?.commandDigest);
  });

  it("is order-insensitive (sorted internally)", () => {
    const port = makeFinanceDataPort({
      replacesPackages: ["market-data-lib", "finance-data-client"],
    });
    const a = parseInstallDetour("pip install market-data-lib finance-data-client", port);
    const b = parseInstallDetour("pip install finance-data-client market-data-lib", port);
    expect(a?.commandDigest).toBe(b?.commandDigest);
  });

  it("differs for distinct package sets", () => {
    const port = makeFinanceDataPort();
    const a = parseInstallDetour("pip install market-data-lib", port);
    const b = parseInstallDetour("pip install finance-data-client", port);
    expect(a?.commandDigest).not.toBe(b?.commandDigest);
  });

  it("differs across package managers for the same packages", () => {
    // Construct two ports each producing overlap on "lodash" through a different PM
    const portPip = createCapabilityPortStub({
      getConnectedMcpServers: () => ["dummy"],
      getMcpServerHint: (): McpServerHint | undefined =>
        ({ cluster: "x", description: "y", replacesPackages: ["lodash"] }),
    });
    const a = parseInstallDetour("pip install lodash", portPip);
    const b = parseInstallDetour("npm install lodash", portPip);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.commandDigest).not.toBe(b!.commandDigest);
  });
});

// ===========================================================================
// EXPORT SHAPE / PRIVATE HELPER COVERAGE
// ===========================================================================

describe("install-detour module — public API", () => {
  it("exports parseInstallDetour, InstallDetourDecision, DetourOverlap", () => {
    expect(typeof parseInstallDetour).toBe("function");
    // Type-only assertions: TypeScript already enforces shape; keep symbol-only check
  });

  it("does NOT export private helpers (splitTopLevelSegments, normalizePythonName, etc.)", async () => {
    const mod = await import("./install-detour.js");
    expect((mod as Record<string, unknown>).splitTopLevelSegments).toBeUndefined();
    expect((mod as Record<string, unknown>).buildCommandDigest).toBeUndefined();
    expect((mod as Record<string, unknown>).buildPackageAliasMap).toBeUndefined();
    expect((mod as Record<string, unknown>).normalizePythonName).toBeUndefined();
    expect((mod as Record<string, unknown>).normalizeNpmName).toBeUndefined();
    expect((mod as Record<string, unknown>).parseInstallSegment).toBeUndefined();
    expect((mod as Record<string, unknown>).classifyPackageToken).toBeUndefined();
  });
});

// Suppress unused-import lint for the unused fixture (keeps it as a documented helper).
void makeEmptyPort;
