// SPDX-License-Identifier: Apache-2.0
/**
 * Production-wiring integration test for the window-aware tool-budget
 * fit-enforcement (the VPS gpt-5.3-codex under-defer investigation, 2026-06-22).
 *
 * Unlike executor-tool-assembly.test.ts (which mocks tool-deferral entirely to
 * focus on merge/override wiring), THIS file leaves `tool-deferral.js` AND
 * `budget-capacity-cap.js` REAL, mocking only the heavy/irrelevant collaborators
 * (SDK SettingsManager, prompt-assembly, lifecycle, JIT/pipeline). It drives the
 * FULL assembleTools() path end-to-end for the exact production scenario the VPS
 * deploy-proof reported:
 *
 *   gpt-5.3-codex → capabilityClass "frontier" (openai-codex provider heuristic),
 *   effective window 8192 (the model's own registry window, windowCapSource
 *   "none"), a tiny system prompt (~828 tok), and 65 large tool schemas (~12.7K
 *   tok). The pre-flight throws context_exhausted on assembled > 8192. The
 *   guarantee under test: assembleTools must SHIP a tool set whose schema
 *   overhead fits 8192 − systemPrompt − headroom − MESSAGE_FLOOR — i.e. the fit
 *   pass runs against the SAME 8192 window the pre-flight throws on, and defers.
 *
 * This is the test the unit suites missed: the unit fit-pass tests used a single
 * consistent window, so they could not surface a two-window production mismatch.
 * By exercising the REAL profile→budget→deferral→fit chain, this pins that the
 * window fed to the fit pass IS the effective (8192) window, not a larger nominal.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock ONLY the heavy/irrelevant collaborators. tool-deferral.js and
// budget-capacity-cap.js are deliberately REAL (the SUT under investigation).
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  settingsManagerInstance: { applyOverrides: vi.fn() },
  settingsManagerCreate: vi.fn(),
  settingsManagerInMemory: vi.fn(),
  assembleExecutionPromptMock: vi.fn(),
  createJitGuideWrapperMock: vi.fn(),
  applySchemasPruningMock: vi.fn(),
  applySchemaSnapshotMock: vi.fn(),
  applyProviderNormalizationMock: vi.fn(),
  applyPersistedReactiveStripMock: vi.fn(),
  applyMutationSerializerMock: vi.fn(),
  buildCapabilityIndexContextMock: vi.fn(),
  getOrCreateDiscoveryTrackerMock: vi.fn(),
  getOrCreateTrackerMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: {
    create: mocks.settingsManagerCreate,
    inMemory: mocks.settingsManagerInMemory,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- class shape
  DefaultResourceLoader: class MockDefaultResourceLoader { constructor(_opts: any) {} },
}));

vi.mock("./prompt-assembly.js", () => ({
  assembleExecutionPrompt: mocks.assembleExecutionPromptMock,
}));

// tool-deferral.js: REAL (no mock).
// budget-capacity-cap.js: REAL (no mock).

vi.mock("./capability-index-context.js", () => ({
  buildCapabilityIndexContext: mocks.buildCapabilityIndexContextMock,
}));

vi.mock("./discovery-tracker.js", () => ({
  getOrCreateDiscoveryTracker: mocks.getOrCreateDiscoveryTrackerMock,
}));

vi.mock("./tool-lifecycle.js", () => ({
  getOrCreateTracker: mocks.getOrCreateTrackerMock,
  DEFAULT_LIFECYCLE_CONFIG: { enabled: false, demotionThreshold: 50 },
}));

vi.mock("./jit-guide-injector.js", () => ({
  createJitGuideWrapper: mocks.createJitGuideWrapperMock,
}));

vi.mock("./executor-tool-pipeline.js", () => ({
  applySchemasPruning: mocks.applySchemasPruningMock,
  applySchemaSnapshot: mocks.applySchemaSnapshotMock,
  applyProviderNormalization: mocks.applyProviderNormalizationMock,
  applyPersistedReactiveStrip: mocks.applyPersistedReactiveStripMock,
  applyMutationSerializer: mocks.applyMutationSerializerMock,
}));

import { assembleTools } from "./executor-tool-assembly.js";
import type { ToolAssemblyDeps, ToolAssemblyParams } from "./executor-tool-assembly.js";
import { toolDefOverheadChars } from "./tool-overhead.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import { computeWindowFitBudget, applyToolBudgetFit } from "./tool-deferral.js";
import { runPreflightFitCheck } from "../context-engine/lcd-preflight.js";
import { ContextExhaustionError } from "../context-engine/errors.js";
import type { ModelProfile } from "./model-profile.js";
import { TypedEventBus, type SessionKey } from "@comis/core";
import { createCapabilityPortStub } from "../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tool with a known overhead (name + description + JSON params). */
function makeTool(name: string, descChars: number, paramChars: number): unknown {
  return {
    name,
    label: name,
    description: "d".repeat(descChars),
    parameters: { type: "object", properties: { input: { type: "string", description: "p".repeat(Math.max(0, paramChars - 40)) } } },
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false }),
  };
}

const TEST_SESSION_KEY: SessionKey = { tenantId: "t", userId: "u", channelId: "c" };

/** Frontier profile with the reconciled 8192 effective window baked in (exactly
 *  what pi-executor produces for gpt-5.3-codex: {...resolvedModel,
 *  contextWindow: effectiveWindow}). capabilityClass "frontier" → no class cap →
 *  computeTokenBudgetForProfile windowTokens === 8192. */
const CODEX_PROFILE: ModelProfile = {
  capabilityClass: "frontier",
  scaffoldLevel: "standard",
  securityLevel: "standard",
  reasoningStyle: "none",
  contextWindow: 8_192,
  maxOutputTokens: 4_096,
  supportsVision: false,
  supportsTools: true,
  supportsPromptCache: false,
  supportsServerToolSearch: false,
  supportsStructuredOutput: false,
} as ModelProfile;

function makeDeps(customTools: unknown[]): ToolAssemblyDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[]
    customTools: customTools as any,
    workspaceDir: "/tmp/ws",
    agentDir: "/tmp/agent",
    logger: createMockLogger(),
    eventBus: new TypedEventBus(),
    toolCapabilityPort: createCapabilityPortStub({ isCapabilityIndexEnabled: () => false }),
    clock: createFakeClock(1_700_000_000_000),
  };
}

function makeParams(customTools: unknown[]): ToolAssemblyParams {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig
    config: { name: "codex-agent", provider: "openai-codex", model: "gpt-5.3-codex", contextEngine: { enabled: true } } as any,
    deps: makeDeps(customTools),
    sessionKey: TEST_SESSION_KEY,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NormalizedMessage
    msg: { id: "00000000-0000-4000-8000-000000000001", text: "capital of France?", senderId: "u", channelId: "c", channelType: "telegram", timestamp: 1, attachments: [], metadata: {} } as any,
    isFirstMessageInSession: true,
    sm: { buildSessionContext: () => ({ messages: [] }), getSessionDir: () => "/tmp/agent/s" },
    deliveredGuides: new Set<string>(),
    resolvedModel: { id: "gpt-5.3-codex", provider: "openai-codex", contextWindow: 8_192, reasoning: false },
    modelProfile: CODEX_PROFILE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsManagerCreate.mockReturnValue(mocks.settingsManagerInstance);
  mocks.settingsManagerInMemory.mockReturnValue(mocks.settingsManagerInstance);
  // The tiny ~828-token system prompt the VPS reported (828 * 3.5 ≈ 2898 chars).
  mocks.assembleExecutionPromptMock.mockResolvedValue({
    systemPrompt: "x".repeat(2_898),
    dynamicPreamble: "p".repeat(560), // ~160 tok preamble
    inlineMemory: undefined,
  });
  mocks.getOrCreateTrackerMock.mockReturnValue({ recordTurn: vi.fn(), getCurrentTurn: () => 1, getDemotedToolNames: vi.fn().mockReturnValue(new Set()) });
  mocks.getOrCreateDiscoveryTrackerMock.mockReturnValue({ serialize: vi.fn().mockReturnValue([]), restore: vi.fn(), getDiscoveredNames: vi.fn().mockReturnValue(new Set()), markDiscovered: vi.fn(), markUnavailable: vi.fn(), isDiscovered: () => false });
  mocks.buildCapabilityIndexContextMock.mockReturnValue({ text: "", builtinCount: 0, mcpCount: 0, skillCount: 0 });
  // Pass-through transforms so the shipped tool set is observable unchanged.
  mocks.createJitGuideWrapperMock.mockImplementation((tools: unknown[]) => tools);
  mocks.applySchemasPruningMock.mockImplementation((p: { tools: unknown[] }) => p.tools);
  mocks.applySchemaSnapshotMock.mockImplementation((p: { tools: unknown[] }) => p.tools);
  mocks.applyProviderNormalizationMock.mockImplementation((p: { tools: unknown[] }) => p.tools);
  mocks.applyPersistedReactiveStripMock.mockImplementation((p: { tools: unknown[] }) => p.tools);
  mocks.applyMutationSerializerMock.mockImplementation((tools: unknown[]) => tools);
});

const NANO_PROFILE: ModelProfile = {
  capabilityClass: "nano",
  scaffoldLevel: "max",
  securityLevel: "locked",
  reasoningStyle: "none",
  contextWindow: 8_192,
  maxOutputTokens: 4_096,
  supportsVision: false,
  supportsTools: true,
  supportsPromptCache: false,
  supportsServerToolSearch: false,
  supportsStructuredOutput: false,
} as ModelProfile;

// ---------------------------------------------------------------------------
// The production-wiring guarantee
// ---------------------------------------------------------------------------

describe("assembleTools — window-aware fit runs against the EFFECTIVE window (codex 8K production path)", () => {
  it("ships a tool set whose schema overhead fits the 8192 effective window (defers ~50 of 65)", async () => {
    // 65 large tools (~195 tok each ≈ 12.7K total), as on the VPS.
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    const result = await assembleTools(makeParams(tools));

    // The window the fit pass + the budget reported (must be the EFFECTIVE 8192,
    // NOT the nominal — this is the production-mismatch guard).
    expect(result.budgetWindowTokens).toBe(8_192);

    // The system-token reservation reflects a SHRUNK tool set (the fit pass ran).
    // Pre-fix (under-defer), cachedSystemTokensEstimate would carry all 65 tools.
    const budget = computeWindowFitBudget({ profile: CODEX_PROFILE });
    const sysPromptOnlyTokens = Math.ceil(2_898 / CHARS_PER_TOKEN_RATIO);
    const toolBudget = 8_192 - sysPromptOnlyTokens - budget.outputHeadroom - budget.messageFloorTokens;

    // mergedCustomTools is the shipped set (active + discovered + discover_tools +
    // the zero-cost auto-discovery stubs). The stubs are stripped from the wire by
    // createStubFilterInjector, so the WIRE overhead is the non-stub tools. Measure
    // the non-stub shipped tools' overhead — it must fit the residual budget.
    const DEFERRAL_STUB_MARKER = "__comis_deferral_stub__";
    const shipped = (result.mergedCustomTools as Array<Record<string, unknown>>).filter(
      (t) => t[DEFERRAL_STUB_MARKER] !== true,
    );
    const shippedOverhead = Math.ceil(toolDefOverheadChars(shipped as never) / CHARS_PER_TOKEN_RATIO);
    expect(shippedOverhead).toBeLessThanOrEqual(toolBudget);

    // And the reservation the downstream budget/pre-flight reads is small (not the
    // full 65-tool ~12.7K) — proving the fit pass shrank what ships.
    expect(result.cachedSystemTokensEstimate).toBeLessThanOrEqual(
      sysPromptOnlyTokens + toolBudget,
    );
  });

  // THE KEYSTONE (the lead's explicit ask + the gap the unit tests missed): route
  // the assembled result through the REAL runPreflightFitCheck — the SAME pre-flight
  // that threw `context_exhausted` (assembled 13725 > 8192) on the VPS — and assert
  // it NO LONGER throws after the fit pass deferred. cachedSystemTokensEstimate is
  // exactly what the context engine wires to deps.getSystemTokensEstimate (the OF-01
  // S term = system prompt + SHIPPED tool schemas), so feeding it to the real
  // pre-flight reproduces the production decision end-to-end. The test has teeth:
  // the pre-fix systemTokens (all 65 tools, ~13K) is shown to throw on the same window.
  it("the SAME runPreflightFitCheck no longer throws on 8192 after assembleTools defers (end-to-end)", async () => {
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    const result = await assembleTools(makeParams(tools));
    const effectiveWindow = result.budgetWindowTokens; // 8192
    expect(effectiveWindow).toBe(8_192);

    // Build pre-flight deps that report the POST-FIT systemTokens (the real wiring).
    const preflightDeps = {
      logger: createMockLogger(),
      getThinkingLevel: () => "off",
      getSystemTokensEstimate: () => result.cachedSystemTokensEstimate,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    // A fresh session: a tiny user message in the fresh tail, no history.
    const freshTail = [{ role: "user", content: "capital of France?" }] as never;

    // GREEN: after the fit pass, systemTokens (prompt + ~15 shipped tools) + tiny
    // freshTail fits 8192 − headroom → NO ContextExhaustionError.
    expect(() =>
      runPreflightFitCheck(preflightDeps, effectiveWindow, [], 0, freshTail, "none"),
    ).not.toThrow();

    // TEETH: the pre-fix path (systemTokens = prompt + ALL 65 tool schemas) WOULD
    // throw on the same 8192 window — proving the fit pass is what averts exhaustion.
    const allToolsSystemTokens = Math.ceil(
      (2_898 + toolDefOverheadChars(tools as never)) / CHARS_PER_TOKEN_RATIO,
    );
    const unfitDeps = {
      ...preflightDeps,
      getSystemTokensEstimate: () => allToolsSystemTokens,
    } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    expect(() =>
      runPreflightFitCheck(unfitDeps, effectiveWindow, [], 0, freshTail, "none"),
    ).toThrow(ContextExhaustionError);
  });

  // THE REAL ROOT CAUSE (VPS, 2026-06-22): the fit pass correctly defers to ~12
  // active tools, BUT createAutoDiscoveryStubs then pushes 44 stubs into
  // mergedCustomTools each carrying parameters: entry.original.parameters (FULL
  // schema). createStubFilterInjector strips them from the WIRE (zero wire cost),
  // but any token view that counts the FULL mergedCustomTools (incl. stubs) sees
  // ~13.7K — matching the VPS assembled 13725 — and FALSE-exhausts the 8192 window.
  // This test computes systemTokens over the FULL shipped set (incl. stubs), exactly
  // as the over-counting production path does, and drives the REAL runPreflightFitCheck:
  // RED pre-fix (stubs full schema → > 8192 → throws), GREEN post-fix (stubs minimal).
  // The lead's instruction: route the FULL assembly INCLUDING stubs into the pre-flight,
  // so the stub over-count is what makes it RED — the blind spot the non-stub test missed.
  it("the pre-flight over the FULL shipped set (incl. auto-discovery stubs) does NOT exhaust 8192", async () => {
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    const result = await assembleTools(makeParams(tools));
    const effectiveWindow = result.budgetWindowTokens;
    expect(effectiveWindow).toBe(8_192);

    // systemTokens computed over the FULL mergedCustomTools (active + discovered +
    // discover_tools + the 44 stubs) — what the over-counting path reserves. Uses
    // the same prompt-chars + toolDefOverheadChars basis as estimateSystemTokensFactored.
    const fullSetSystemTokens = Math.ceil(
      (2_898 + toolDefOverheadChars(result.mergedCustomTools as never)) / CHARS_PER_TOKEN_RATIO,
    );
    const deps = {
      logger: createMockLogger(),
      getThinkingLevel: () => "off",
      getSystemTokensEstimate: () => fullSetSystemTokens,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    const freshTail = [{ role: "user", content: "capital of France?" }] as never;

    // After the stub-schema fix, the 44 stubs cost ~0, so the FULL-set systemTokens
    // collapses to ≈ the non-stub reservation (prompt + ~12 active tools) and fits.
    expect(() =>
      runPreflightFitCheck(deps, effectiveWindow, [], 0, freshTail, "none"),
    ).not.toThrow();
  });

  // REGRESSION GUARD (the lead's prescribed pin): getCachedSystemTokensEstimate()
  // — the production S-term the pre-flight reads (executor-context-engine-setup.ts:582
  // ← pi-executor.ts:1025 `() => cachedSystemTokensEstimate` ← assembleTools result)
  // — IS result.cachedSystemTokensEstimate. It MUST stay stub-EXCLUDED (the line-680/681
  // recompute runs over mergedCustomTools BEFORE the auto-discovery stubs are pushed),
  // so it fits the 8192 window with room for the message. A regression that recomputes
  // it over the post-stub set (or reverts to the pre-deferral line-389 value) would push
  // it to ~13K and FALSE-exhaust — the production failure mode. Pin it.
  it("getCachedSystemTokensEstimate() (= result.cachedSystemTokensEstimate) stays stub-excluded and fits 8192", async () => {
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    const result = await assembleTools(makeParams(tools));
    const budget = computeWindowFitBudget({ profile: CODEX_PROFILE });
    // The production S-term the pre-flight consumes. Must leave room for the message
    // floor on the 8192 window — i.e. << the full-65-tool ~13K that exhausted on the VPS.
    expect(result.cachedSystemTokensEstimate).toBeLessThan(8_192 - budget.outputHeadroom - budget.messageFloorTokens);
    // Concretely: prompt(~828) + ~12 active tools, NOT prompt + 65 tools.
    expect(result.cachedSystemTokensEstimate).toBeLessThan(7_000);
  });

  // Multi-turn discovered-tool write-back (the lead's flagged stale-count): when a
  // tool is already DISCOVERED (re-included with its full schema) and the fit pass
  // then DROPS it, it must leave BOTH activeTools AND discoveredTools — else the
  // line-662 mergedCustomTools rebuild re-includes it and the S estimate re-counts it.
  it("a discovered tool dropped by the fit pass leaves discoveredTools too (no stale re-count)", () => {
    const logger = createMockLogger();
    // 1 active + 2 discovered (full schema) + a discover tool; tiny budget forces a drop.
    const discovered = [makeTool("mcp__srv--disc_a", 1_200, 400), makeTool("mcp__srv--disc_b", 1_200, 400)] as never[];
    const dr = {
      activeTools: [makeTool("read", 50, 50)] as never[],
      discoveredTools: discovered,
      deferredEntries: [],
      discoverTool: null,
      deferredCount: 0,
      deferredNames: [],
    };
    applyToolBudgetFit(dr as never, {
      systemPromptText: "x".repeat(50_800), // budget ~717 tok → fits ~1 tool
      contextWindow: 16_000,
      outputHeadroom: 768,
      messageFloorTokens: 0,
      recentlyUsedToolNames: new Set<string>(),
      logger,
    });
    // The dropped discovered tools must NOT linger in discoveredTools.
    const survivingDiscovered = new Set((dr.discoveredTools as Array<{ name: string }>).map((t) => t.name));
    const deferred = new Set(dr.deferredNames);
    for (const name of deferred) {
      expect(survivingDiscovered.has(name)).toBe(false);
    }
    // And whatever stayed active is consistent (no dropped tool re-included anywhere).
    const active = new Set((dr.activeTools as Array<{ name: string }>).map((t) => t.name));
    for (const name of deferred) {
      expect(active.has(name)).toBe(false);
    }
  });

  // THE PRODUCTION PATH (the lead's must-do A): gpt-5.3-codex is capabilityClass
  // NANO on the VPS — NOT frontier. nano's aggressive CORE_TOOLS-only deferral leaves
  // ~1 active + 64 deferred → 64 auto-discovery stubs. With the stub-skip +
  // minimal-schema fix, the post-deferral S term (result.cachedSystemTokensEstimate =
  // what getCachedSystemTokensEstimate() returns = what the pre-flight reads) stays
  // tiny (~prompt + discover_tools, NOT the full 65-tool ~13K the VPS saw at 12758).
  // Feed it into the REAL runPreflightFitCheck → MUST NOT throw on 8192. Earlier the
  // frontier test masked this (frontier defers nothing → different active set).
  it("NANO codex 8192 + 65 tools: getCachedSystemTokensEstimate stays tiny and the REAL pre-flight does not exhaust", async () => {
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    const result = await assembleTools({ ...makeParams(tools), modelProfile: NANO_PROFILE });
    expect(result.budgetWindowTokens).toBe(8_192);
    // The production S-term (= getCachedSystemTokensEstimate()) for the nano path:
    // prompt(~828) + the ~1 surviving active tool, NOT prompt + 65 tools (~13K).
    expect(result.cachedSystemTokensEstimate).toBeLessThan(3_000);

    // Feed THAT exact value into the REAL pre-flight the production dag path runs.
    const deps = {
      logger: createMockLogger(),
      getThinkingLevel: () => "off",
      getSystemTokensEstimate: () => result.cachedSystemTokensEstimate,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    const freshTail = [{ role: "user", content: "capital of France?" }] as never;
    expect(() =>
      runPreflightFitCheck(deps, 8_192, [], 0, freshTail, "none"),
    ).not.toThrow();

    // And the WHOLE shipped set (incl. the 64 stubs) — what any post-stub token view
    // sees — also fits, because toolDefOverheadChars excludes the wire-stripped stubs.
    const fullSetSystemTokens = Math.ceil(
      (2_898 + toolDefOverheadChars(result.mergedCustomTools as never)) / CHARS_PER_TOKEN_RATIO,
    );
    const depsFull = { ...deps, getSystemTokensEstimate: () => fullSetSystemTokens } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    expect(() =>
      runPreflightFitCheck(depsFull, 8_192, [], 0, freshTail, "none"),
    ).not.toThrow();
  });

  // MULTI-TURN nano (the lead's discoveredTools concern): when EVERY deferred tool
  // was previously discovered, deferral re-includes them — some as discoveredTools
  // (full schema, genuinely shipping) and the rest as stubs. Pre-fix, the stubs were
  // counted at full schema → S ballooned (~12758 on da254cea). With the stub-skip,
  // result.cachedSystemTokensEstimate stays bounded (the discovered tools that
  // genuinely ship are counted; the wire-stripped stubs are not), and the REAL
  // pre-flight does not exhaust 8192. A regression that re-counts stubs FAILS here.
  it("NANO multi-turn (all deferred previously discovered): S stays bounded, pre-flight does not exhaust", async () => {
    const tools = Array.from({ length: 65 }, (_, i) => makeTool(`mcp__srv--tool_${i}`, 560, 120));
    mocks.getOrCreateDiscoveryTrackerMock.mockReturnValue({
      serialize: vi.fn().mockReturnValue([]),
      restore: vi.fn(),
      getDiscoveredNames: vi.fn().mockReturnValue(new Set(tools.map((t) => (t as { name: string }).name))),
      markDiscovered: vi.fn(),
      markUnavailable: vi.fn(),
      isDiscovered: () => true,
    });
    const result = await assembleTools({ ...makeParams(tools), modelProfile: NANO_PROFILE });
    expect(result.budgetWindowTokens).toBe(8_192);
    // Bounded well below the ~13K full-65-tool over-count (stubs excluded; only the
    // genuinely-shipping discovered/active tools count). Fits 8192 with headroom+floor.
    expect(result.cachedSystemTokensEstimate).toBeLessThan(8_192 - 768 - 2_048);
    const deps = {
      logger: createMockLogger(),
      getThinkingLevel: () => "off",
      getSystemTokensEstimate: () => result.cachedSystemTokensEstimate,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof runPreflightFitCheck>[0];
    expect(() =>
      runPreflightFitCheck(deps, 8_192, [], 0, [{ role: "user", content: "capital of France?" }] as never, "none"),
    ).not.toThrow();
  });
});
