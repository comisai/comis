// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for assembleTools — the executor's tool assembly pipeline.
 *
 * assembleTools runs once per execute() and:
 *   1. Merges per-request AgentTool[] with deps.customTools (dedup by name).
 *   2. Constructs a SettingsManager (file-backed, with in-memory fallback).
 *   3. Applies Comis config overrides (sdkRetry, thinkingLevel, compaction).
 *   4. Calls assembleExecutionPrompt(), then estimates system token count.
 *   5. Configures DefaultResourceLoader options (skills filter, system prompt override).
 *   6. Runs the tool deferral + lifecycle + JIT/pruning/snapshot/normalize chain.
 *   7. Builds the per-turn capability-index render result.
 *
 * Strategy: vi.mock every heavy collaborator (SettingsManager, prompt-assembly,
 * tool-deferral, lifecycle, JIT wrapper, capability index, schema pipeline,
 * discovery tracker) so the test focuses on the merge / override / wiring
 * decisions in this module itself.
 *
 * Use-case design: every `it("...")` description names a use case ≥20 chars
 * ending in a recognizable shape.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must precede SUT import (vi.mock hoists).
// vi.hoisted lifts the spies above vi.mock so they're initialized first.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  settingsApplyOverrides: vi.fn(),
  settingsManagerInstance: { applyOverrides: vi.fn() },
  settingsManagerCreate: vi.fn(),
  settingsManagerInMemory: vi.fn(),
  assembleExecutionPromptMock: vi.fn(),
  applyToolDeferralMock: vi.fn(),
  buildDeferredToolsContextMock: vi.fn(),
  createDiscoverToolMock: vi.fn(),
  createAutoDiscoveryStubsMock: vi.fn(),
  applyToolBudgetFitMock: vi.fn(),
  computeWindowFitBudgetMock: vi.fn(),
  extractRecentlyUsedToolNamesMock: vi.fn(),
  buildCapabilityIndexContextMock: vi.fn(),
  getOrCreateDiscoveryTrackerMock: vi.fn(),
  getOrCreateTrackerMock: vi.fn(),
  createJitGuideWrapperMock: vi.fn(),
  applySchemasPruningMock: vi.fn(),
  applySchemaSnapshotMock: vi.fn(),
  applyProviderNormalizationMock: vi.fn(),
  applyPersistedReactiveStripMock: vi.fn(),
  applyMutationSerializerMock: vi.fn(),
}));

// Re-bind applyOverrides spy to the shared instance so applyOverrides records
// the call via mocks.settingsApplyOverrides.
mocks.settingsManagerInstance.applyOverrides = mocks.settingsApplyOverrides;

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: {
    create: mocks.settingsManagerCreate,
    inMemory: mocks.settingsManagerInMemory,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DefaultResourceLoader is class
  DefaultResourceLoader: class MockDefaultResourceLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- options shape varies
    constructor(_opts: any) {
      // Mock: capture options as needed via spy.
    }
  },
}));

vi.mock("./prompt-assembly.js", () => ({
  assembleExecutionPrompt: mocks.assembleExecutionPromptMock,
}));

vi.mock("./tool-deferral.js", () => ({
  applyToolDeferral: mocks.applyToolDeferralMock,
  buildDeferredToolsContext: mocks.buildDeferredToolsContextMock,
  createDiscoverTool: mocks.createDiscoverToolMock,
  createAutoDiscoveryStubs: mocks.createAutoDiscoveryStubsMock,
  applyToolBudgetFit: mocks.applyToolBudgetFitMock,
  computeWindowFitBudget: mocks.computeWindowFitBudgetMock,
  extractRecentlyUsedToolNames: mocks.extractRecentlyUsedToolNamesMock,
  // resolveModelTier has been deleted in Plan 151-03 (K1 requirement)
  CORE_TOOLS: new Set(["bash", "file_read"]),
}));

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

// KNOB-02: passthrough spy on the profile budget — the threading pin (KNOB-02-20)
// must observe BOTH the windowProvenance argument reaching the call site AND the
// REAL computed budget (rawContextWindowTokens / windowCapSource). The actual
// implementation runs unchanged for every other test in this file.
vi.mock("../context-engine/budget-capacity-cap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context-engine/budget-capacity-cap.js")>();
  return {
    ...actual,
    computeTokenBudgetForProfile: vi.fn(actual.computeTokenBudgetForProfile),
  };
});

// ---------------------------------------------------------------------------
// SUT + co-imports
// ---------------------------------------------------------------------------

import { assembleTools } from "./executor-tool-assembly.js";
import type { ToolAssemblyDeps, ToolAssemblyParams } from "./executor-tool-assembly.js";
import { computeTokenBudgetForProfile } from "../context-engine/budget-capacity-cap.js";
import { toolDefOverheadChars } from "./tool-overhead.js";
import { TypedEventBus, scriptTokenFactor, type SessionKey } from "@comis/core";
import { createCapabilityPortStub } from "../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string, description = "test tool", parameters?: unknown): unknown {
  return {
    name,
    label: name,
    description,
    parameters: parameters ?? { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: undefined,
    }),
  };
}

const TEST_SESSION_KEY: SessionKey = {
  tenantId: "tenant-a",
  userId: "user_a",
  channelId: "chan-a",
};

function makeDeps(overrides?: Partial<ToolAssemblyDeps>): ToolAssemblyDeps {
  return {
    customTools: [],
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agentdir",
    logger: createMockLogger(),
    eventBus: new TypedEventBus(),
    toolCapabilityPort: createCapabilityPortStub({ isCapabilityIndexEnabled: () => false }),
    clock: createFakeClock(1_700_000_000_000),
    ...overrides,
  };
}

function makeMsg(): { id: string; text: string; senderId: string; channelId: string; channelType: string; timestamp: number; attachments: never[]; metadata: Record<string, never> } {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    text: "hello",
    senderId: "user_a",
    channelId: "chan-a",
    channelType: "test",
    timestamp: 1_700_000_000_000,
    attachments: [],
    metadata: {},
  };
}

function makeSm(): { buildSessionContext(): { messages: unknown[] }; getSessionDir(): string } {
  return {
    buildSessionContext: () => ({ messages: [] }),
    getSessionDir: () => "/tmp/agentdir/sessions/test",
  };
}

function makeParams(overrides?: Partial<ToolAssemblyParams>): ToolAssemblyParams {
  const deps = overrides?.deps ?? makeDeps();
  return {
    config: {
      name: "test-agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      contextEngine: { enabled: true, version: "pipeline" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig has many fields
    } as any,
    deps,
    sessionKey: TEST_SESSION_KEY,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NormalizedMessage shape simplified
    msg: makeMsg() as any,
    isFirstMessageInSession: true,
    sm: makeSm(),
    formattedKeyForGuides: "tenant-a:user_a:chan-a",
    deliveredGuides: new Set<string>(),
    resolvedModel: {
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      contextWindow: 200_000,
      reasoning: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock defaults — reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsManagerCreate.mockReturnValue(mocks.settingsManagerInstance);
  mocks.settingsManagerInMemory.mockReturnValue(mocks.settingsManagerInstance);
  mocks.assembleExecutionPromptMock.mockResolvedValue({
    systemPrompt: "x".repeat(400),
    dynamicPreamble: "",
    inlineMemory: undefined,
  });
  mocks.extractRecentlyUsedToolNamesMock.mockReturnValue(new Set());
  mocks.getOrCreateTrackerMock.mockReturnValue({
    recordTurn: vi.fn(),
    getCurrentTurn: () => 1,
    getDemotedToolNames: vi.fn().mockReturnValue(new Set()),
  });
  mocks.getOrCreateDiscoveryTrackerMock.mockReturnValue({
    serialize: vi.fn().mockReturnValue([]),
    restore: vi.fn(),
    getDiscoveredNames: vi.fn().mockReturnValue(new Set()),
  });
  mocks.applyToolDeferralMock.mockImplementation((tools: unknown[]) => ({
    activeTools: tools,
    discoveredTools: [],
    deferredEntries: [],
    deferredNames: [],
    discoverTool: undefined,
  }));
  // Default: the window-aware fit pass is a no-op (active tools already fit) —
  // it mutates deferralResult in place, so the no-op default does nothing.
  mocks.applyToolBudgetFitMock.mockImplementation(() => undefined);
  // Default window-fit budget: a wide window so neither the prompt-fit fallback
  // nor the tool-fit pass engages (matches the real helper's shape).
  mocks.computeWindowFitBudgetMock.mockReturnValue({
    effectiveWindow: 200_000,
    outputHeadroom: 768,
    messageFloorTokens: 2_048,
  });
  mocks.buildDeferredToolsContextMock.mockReturnValue("");
  mocks.createAutoDiscoveryStubsMock.mockReturnValue([]);
  mocks.buildCapabilityIndexContextMock.mockReturnValue({
    text: "",
    builtinCount: 0,
    mcpCount: 0,
    skillCount: 0,
  });
  mocks.createJitGuideWrapperMock.mockImplementation((tools: unknown[]) => tools);
  mocks.applySchemasPruningMock.mockImplementation((params: { tools: unknown[] }) => params.tools);
  mocks.applySchemaSnapshotMock.mockImplementation((params: { tools: unknown[] }) => params.tools);
  mocks.applyProviderNormalizationMock.mockImplementation((params: { tools: unknown[] }) => params.tools);
  mocks.applyPersistedReactiveStripMock.mockImplementation((params: { tools: unknown[] }) => params.tools);
  mocks.applyMutationSerializerMock.mockImplementation((tools: unknown[]) => tools);
});

// ---------------------------------------------------------------------------
// Custom tools merging
// ---------------------------------------------------------------------------

describe("assembleTools — per-request tool merging with deps.customTools", () => {
  it("returns deps.customTools unchanged when no per-request tools are supplied (no merge needed)", async () => {
    const customTools = [makeTool("a"), makeTool("b")] as unknown[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
    const result = await assembleTools(makeParams({ deps: makeDeps({ customTools: customTools as any }) }));
    expect(mocks.applyToolDeferralMock).toHaveBeenCalled();
    const passed = mocks.applyToolDeferralMock.mock.calls[0][0] as unknown[];
    expect(passed.length).toBe(2);
    expect(result.mergedCustomTools.length).toBeGreaterThan(0);
  });

  it("reserves system-token budget for the POST-deferral active tools, not the full pre-deferral set", async () => {
    // Live finding (2026-06-12 UC-2): cachedSystemTokensEstimate was computed at
    // ÷3.5 over mergedCustomTools BEFORE applyToolDeferral ran, so a small-class
    // agent that defers ~58 of 82 tools still reserved budget for all 82 — a ~16K
    // over-reservation that squeezed the history partition and falsely
    // context-exhausted multi-turn local-model sessions. The estimate must reflect
    // the tools that actually ship (active + discovered + discover_tools), not the
    // deferred ones (which the stub filter strips from the wire).
    const manyTools = Array.from({ length: 30 }, (_, i) => makeTool(`tool-${i}`, "a".repeat(200)));
    const activeSubset = manyTools.slice(0, 4);

    // Run A: deferral keeps ALL 30 active (no deferral).
    mocks.applyToolDeferralMock.mockImplementationOnce((tools: unknown[]) => ({
      activeTools: tools, discoveredTools: [], deferredEntries: [], deferredNames: [], discoverTool: undefined,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noDefer = await assembleTools(makeParams({ deps: makeDeps({ customTools: manyTools as any }) }));

    // Run B: deferral keeps only 4 active, defers 26.
    mocks.applyToolDeferralMock.mockImplementationOnce(() => ({
      activeTools: activeSubset,
      discoveredTools: [],
      deferredEntries: manyTools.slice(4).map((t) => ({ name: (t as { name: string }).name })),
      deferredNames: manyTools.slice(4).map((t) => (t as { name: string }).name),
      discoverTool: undefined,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deferred = await assembleTools(makeParams({ deps: makeDeps({ customTools: manyTools as any }) }));

    // The deferred run ships far fewer tool schemas, so its reservation must be smaller.
    expect(deferred.cachedSystemTokensEstimate).toBeLessThan(noDefer.cachedSystemTokensEstimate);
  });

  // -------------------------------------------------------------------------
  // ROOT-CAUSE context-exhaustion guard (2026-06-22): the window-aware
  // tool-budget fit pass must run on the SHIPPING active set (active +
  // discovered + discover_tools), and when it defers more tools the assembly
  // must reflect the refined partition (smaller mergedCustomTools + smaller
  // cachedSystemTokensEstimate). Pre-patch assembleTools never called a budget
  // fit pass, so a nano window over-shipped tools and the pre-flight threw
  // ContextExhaustionError on every turn.
  // -------------------------------------------------------------------------
  it("runs the window-aware tool-budget fit pass with deferralResult + the budget terms", async () => {
    const tools = [makeTool("read"), makeTool("mcp__srv--x")] as unknown[];
    mocks.applyToolDeferralMock.mockImplementationOnce((t: unknown[]) => ({
      activeTools: t,
      discoveredTools: [],
      deferredEntries: [{ name: "deferred_a", description: "d", original: makeTool("deferred_a") }],
      deferredNames: ["deferred_a"],
      discoverTool: undefined,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assembleTools(makeParams({ deps: makeDeps({ customTools: tools as any }) }));
    expect(mocks.applyToolBudgetFitMock).toHaveBeenCalledTimes(1);
    const [deferralArg, paramsArg] = mocks.applyToolBudgetFitMock.mock.calls[0] as [
      { activeTools: Array<{ name: string }> },
      { contextWindow: number; messageFloorTokens: number; systemPromptText: string; outputHeadroom: number },
    ];
    // The pass receives the live deferralResult (so it can refine it in place).
    expect(deferralArg.activeTools.map((t) => t.name)).toContain("read");
    // And the budget terms — a positive window, message floor, output headroom,
    // and the real system-prompt TEXT (so the fit pass factors its script).
    expect(paramsArg.contextWindow).toBeGreaterThan(0);
    expect(paramsArg.messageFloorTokens).toBeGreaterThan(0);
    expect(paramsArg.outputHeadroom).toBeGreaterThan(0);
    expect(typeof paramsArg.systemPromptText).toBe("string");
    expect(paramsArg.systemPromptText.length).toBeGreaterThan(0);
  });

  it("hands assembleExecutionPrompt a windowFitBudget so the degenerate-window compact fallback can engage", async () => {
    // The Part-2 extension: the prompt-assembly degenerate fallback needs the
    // effective window + headroom + floor. assembleTools must thread that budget
    // into assembleExecutionPrompt (the prompt-fit pass mirrors the tool-fit pass).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assembleTools(makeParams({ deps: makeDeps({ customTools: [makeTool("read")] as any }) }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledTimes(1);
    const promptArg = mocks.assembleExecutionPromptMock.mock.calls[0][0] as {
      windowFitBudget?: { effectiveWindow: number; outputHeadroom: number; messageFloorTokens: number };
    };
    expect(promptArg.windowFitBudget).toBeDefined();
    expect(promptArg.windowFitBudget!.effectiveWindow).toBeGreaterThan(0);
    expect(promptArg.windowFitBudget!.outputHeadroom).toBeGreaterThan(0);
    expect(promptArg.windowFitBudget!.messageFloorTokens).toBe(2_048);
  });

  it("applies the fit pass's in-place refinement: deferring a tool shrinks the shipped set + reservation", async () => {
    const tools = [makeTool("read", "r".repeat(400)), makeTool("mcp__srv--x", "x".repeat(400))] as unknown[];
    mocks.applyToolDeferralMock.mockImplementation((t: unknown[]) => ({
      activeTools: t,
      discoveredTools: [],
      deferredEntries: [],
      deferredNames: [],
      discoverTool: undefined,
    }));

    // Run A: fit pass is a no-op → both tools ship.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noFit = await assembleTools(makeParams({ deps: makeDeps({ customTools: tools as any }) }));

    // Run B: fit pass defers mcp__srv--x by MUTATING deferralResult in place
    // (the production applyToolBudgetFit's contract).
    mocks.applyToolBudgetFitMock.mockImplementationOnce(
      (dr: {
        activeTools: Array<{ name: string }>;
        deferredEntries: Array<{ name: string }>;
        deferredNames: string[];
      }) => {
        const dropped = dr.activeTools.filter((t) => t.name === "mcp__srv--x");
        dr.activeTools = dr.activeTools.filter((t) => t.name !== "mcp__srv--x");
        dr.deferredEntries = [
          ...dr.deferredEntries,
          ...dropped.map((t) => ({ name: t.name, description: "d", original: t })),
        ];
        dr.deferredNames = [...dr.deferredNames, "mcp__srv--x"];
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fit = await assembleTools(makeParams({ deps: makeDeps({ customTools: tools as any }) }));

    const noFitNames = noFit.mergedCustomTools.map((t) => (t as { name: string }).name);
    const fitNames = fit.mergedCustomTools.map((t) => (t as { name: string }).name);
    expect(noFitNames).toContain("mcp__srv--x");
    expect(fitNames).not.toContain("mcp__srv--x");
    expect(fitNames).toContain("read");
    // The deferred tool became reachable via the refined deferred set.
    expect(fit.deferralResult.deferredNames).toContain("mcp__srv--x");
    // Reservation reflects the smaller shipping set.
    expect(fit.cachedSystemTokensEstimate).toBeLessThan(noFit.cachedSystemTokensEstimate);
  });

  it("merges deps.customTools with converted per-request AgentTool[] when convertTools is provided", async () => {
    const customTools = [makeTool("a")];
    const convertedTool = makeTool("b-converted");
    const convertTools = vi.fn().mockReturnValue([convertedTool]);
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
      deps: makeDeps({ customTools: customTools as any, convertTools }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool[] minimal stub
      tools: [{ name: "b-converted" } as any],
    }));
    expect(convertTools).toHaveBeenCalled();
    const passedToDeferral = mocks.applyToolDeferralMock.mock.calls[0][0] as Array<{ name: string }>;
    expect(passedToDeferral.map((t) => t.name).sort()).toEqual(["a", "b-converted"]);
  });

  it("does NOT duplicate a per-request tool that has the same name as an existing deps.customTools tool (name-key dedup)", async () => {
    const customTools = [makeTool("a", "from-custom")];
    const convertTools = vi.fn().mockReturnValue([makeTool("a", "from-converted")]);
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
      deps: makeDeps({ customTools: customTools as any, convertTools }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool[] minimal stub
      tools: [{ name: "a" } as any],
    }));
    const passedToDeferral = mocks.applyToolDeferralMock.mock.calls[0][0] as Array<{ name: string; description?: string }>;
    // Only one tool named "a" should survive, and it must be the deps.customTools copy.
    expect(passedToDeferral.filter((t) => t.name === "a").length).toBe(1);
    expect(passedToDeferral.find((t) => t.name === "a")?.description).toBe("from-custom");
  });
});

// ---------------------------------------------------------------------------
// SettingsManager creation + fallback
// ---------------------------------------------------------------------------

describe("assembleTools — SettingsManager initialization with in-memory fallback", () => {
  it("uses file-backed SettingsManager.create() on the happy path and reports persistent=true", async () => {
    const result = await assembleTools(makeParams());
    expect(mocks.settingsManagerCreate).toHaveBeenCalledWith("/tmp/workspace", "/tmp/agentdir");
    expect(mocks.settingsManagerInMemory).not.toHaveBeenCalled();
    expect(result.persistentSettings).toBe(true);
  });

  it("falls back to SettingsManager.inMemory() with persistent=false when SettingsManager.create() throws", async () => {
    mocks.settingsManagerCreate.mockImplementation(() => {
      throw new Error("ENOENT: settings file not found");
    });
    const logger = createMockLogger();
    const result = await assembleTools(makeParams({ deps: makeDeps({ logger }) }));
    expect(mocks.settingsManagerInMemory).toHaveBeenCalled();
    expect(result.persistentSettings).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      "Settings file load failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Settings overrides
// ---------------------------------------------------------------------------

describe("assembleTools — Comis config overrides applied via settingsManager.applyOverrides()", () => {
  it("disables SDK auto-compaction (compaction.enabled=false) when Comis contextEngine is enabled", async () => {
    await assembleTools(makeParams());
    const passedOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { compaction: { enabled: boolean } };
    expect(passedOverrides.compaction.enabled).toBe(false);
  });

  it("enables SDK auto-compaction (compaction.enabled=true) when Comis contextEngine is explicitly disabled", async () => {
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: { provider: "anthropic", contextEngine: { enabled: false } } as any,
    }));
    const passedOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { compaction: { enabled: boolean } };
    expect(passedOverrides.compaction.enabled).toBe(true);
  });

  it("uses config.sdkRetry values when provided, otherwise applies documented defaults (5 retries, 4000ms)", async () => {
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: { provider: "anthropic", contextEngine: { enabled: true }, sdkRetry: { enabled: true, maxRetries: 9, baseDelayMs: 1000 } } as any,
    }));
    const passedOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { retry: { maxRetries: number; baseDelayMs: number } };
    expect(passedOverrides.retry.maxRetries).toBe(9);
    expect(passedOverrides.retry.baseDelayMs).toBe(1000);

    mocks.settingsApplyOverrides.mockClear();
    await assembleTools(makeParams());
    const defaultOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { retry: { maxRetries: number; baseDelayMs: number } };
    expect(defaultOverrides.retry.maxRetries).toBe(5);
    expect(defaultOverrides.retry.baseDelayMs).toBe(4000);
  });

  it("emits a WARN with errorKind=config when reserveTokens is supplied but is not a positive number", async () => {
    const logger = createMockLogger();
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: {
        provider: "anthropic",
        contextEngine: { enabled: true },
        session: { compaction: { reserveTokens: -1 } },
      } as any,
      deps: makeDeps({ logger }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "session.compaction.reserveTokens",
        errorKind: "config",
      }),
      "Invalid settings override skipped",
    );
  });

  it("forwards the directive thinkingLevel to overrides.defaultThinkingLevel when valid", async () => {
    await assembleTools(makeParams({
      _directives: { thinkingLevel: "high" },
    }));
    const passedOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { defaultThinkingLevel?: string };
    expect(passedOverrides.defaultThinkingLevel).toBe("high");
  });

  it("ignores and WARNs when directive thinkingLevel is outside the canonical set (defaults preserved)", async () => {
    const logger = createMockLogger();
    await assembleTools(makeParams({
      _directives: { thinkingLevel: "ludicrous" },
      deps: makeDeps({ logger }),
    }));
    const passedOverrides = mocks.settingsApplyOverrides.mock.calls[0][0] as { defaultThinkingLevel?: string };
    expect(passedOverrides.defaultThinkingLevel).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: "thinkingLevel", errorKind: "config" }),
      "Invalid settings override skipped",
    );
  });
});

// ---------------------------------------------------------------------------
// Model-capability validation (thinking on non-reasoning model)
// ---------------------------------------------------------------------------

describe("assembleTools — thinkingLevel vs resolvedModel.reasoning capability mismatch", () => {
  it("emits a WARN when a non-off thinkingLevel is set on a model whose reasoning capability is false", async () => {
    const logger = createMockLogger();
    await assembleTools(makeParams({
      _directives: { thinkingLevel: "medium" },
      resolvedModel: { id: "non-reasoning", provider: "anthropic", reasoning: false },
      deps: makeDeps({ logger }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: "medium",
        model: "non-reasoning",
        errorKind: "config",
      }),
      "Thinking level exceeds model capability",
    );
  });

  it("does NOT warn when thinkingLevel='off' is set on a non-reasoning model (off is always valid)", async () => {
    const logger = createMockLogger();
    await assembleTools(makeParams({
      _directives: { thinkingLevel: "off" },
      resolvedModel: { id: "non-reasoning", provider: "anthropic", reasoning: false },
      deps: makeDeps({ logger }),
    }));
    expect((logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) =>
      (c as Array<{ thinkingLevel?: string }>)[0]?.thinkingLevel,
    )).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cachedSystemTokensEstimate calculation
// ---------------------------------------------------------------------------

describe("assembleTools — system token estimate from systemPrompt length + tool def overhead", () => {
  it("estimates more tokens when systemPrompt grows (length proportional to ceil(chars / 4))", async () => {
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(400),
      dynamicPreamble: "",
    });
    const r1 = await assembleTools(makeParams());
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(800),
      dynamicPreamble: "",
    });
    const r2 = await assembleTools(makeParams());
    expect(r2.cachedSystemTokensEstimate).toBeGreaterThan(r1.cachedSystemTokensEstimate);
  });

  it("includes tool definition overhead (name + description + JSON.stringify(parameters)) in the estimate", async () => {
    // Both calls share an identical systemPrompt; only the tool overhead differs.
    mocks.assembleExecutionPromptMock.mockResolvedValue({
      systemPrompt: "x".repeat(200),
      dynamicPreamble: "",
    });
    const r1 = await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
      deps: makeDeps({ customTools: [makeTool("a", "")] as any }),
    }));
    const fatParams = { type: "object", properties: { x: { type: "string", description: "y".repeat(500) } } };
    const r2 = await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
      deps: makeDeps({ customTools: [makeTool("a", "z".repeat(500), fatParams)] as any }),
    }));
    expect(r2.cachedSystemTokensEstimate).toBeGreaterThan(r1.cachedSystemTokensEstimate);
  });
});

// ---------------------------------------------------------------------------
// I1 / WR-01: cachedFreshTailPreambleTokens — the SEPARATE WHOLE-preamble estimate
// ---------------------------------------------------------------------------

describe("assembleTools — fresh-tail preamble token estimate from the WHOLE dynamicPreamble + inlineMemory block (I1 / WR-01)", () => {
  // The budget-path char ratio (constants.ts CHARS_PER_TOKEN_RATIO = 3.5), NOT the
  // ctx-tools' /4 — the estimate must match the token-budget heuristic the DAG
  // subtracts it against.
  const CHARS_PER_TOKEN_RATIO = 3.5;

  it("computes ceil((dynamicPreamble.length + inlineMemory.length) / 3.5) for a non-empty preamble block", async () => {
    const dynamicPreamble = "P".repeat(350);
    const inlineMemory = "M".repeat(700);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble,
      inlineMemory,
    });
    const r = await assembleTools(makeParams());
    expect(r.cachedFreshTailPreambleTokens).toBe(
      Math.ceil((dynamicPreamble.length + inlineMemory.length) / CHARS_PER_TOKEN_RATIO),
    );
    // A non-empty preamble block yields a > 0 estimate.
    expect(r.cachedFreshTailPreambleTokens).toBeGreaterThan(0);
  });

  it("yields 0 for an empty preamble block (no dynamicPreamble, no inlineMemory)", async () => {
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: "",
      inlineMemory: undefined,
    });
    const r = await assembleTools(makeParams());
    expect(r.cachedFreshTailPreambleTokens).toBe(0);
  });

  it("WR-01: measures the WHOLE dynamicPreamble (skills XML / MCP / deferred tools) even with ZERO recalled memory", async () => {
    // The load-bearing WR-01 property: the estimate tracks the ENTIRE fresh-tail
    // preamble, not just recalled memory. A large dynamicPreamble (e.g. a heavy
    // skills-XML / many-MCP agent) with EMPTY inlineMemory (no recall at all) must
    // STILL produce a large estimate, because the whole preamble rides the
    // unconditionally-shipped fresh tail and is reserved nowhere else. Measuring
    // only the recalled bytes would yield ~0 here and under-reserve H → fresh-tail
    // overflow risk. The new field name pins the rename; the assertion pins the
    // whole-preamble semantic.
    const heavyPreambleNoRecall = "S".repeat(7_000); // skills XML + MCP + deferred tools, no memory
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: heavyPreambleNoRecall,
      inlineMemory: undefined, // ZERO recalled memory
    });
    const r = await assembleTools(makeParams());
    // The whole-preamble bytes are counted even though recall is empty.
    expect(r.cachedFreshTailPreambleTokens).toBe(
      Math.ceil(heavyPreambleNoRecall.length / CHARS_PER_TOKEN_RATIO),
    );
    // Concretely large (the heavy preamble dominates) — NOT ~0.
    expect(r.cachedFreshTailPreambleTokens).toBeGreaterThan(1_000);
  });

  it("is SEPARATE from cachedSystemTokensEstimate — growing the preamble block does NOT change S", async () => {
    // The preamble estimate must NOT be folded into S (the recall-dag-budget-partition
    // invariant). Identical systemPrompt + tools, only the preamble block grows.
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(200),
      dynamicPreamble: "",
      inlineMemory: undefined,
    });
    const light = await assembleTools(makeParams());
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(200),
      dynamicPreamble: "P".repeat(1_000),
      inlineMemory: "M".repeat(1_000),
    });
    const heavy = await assembleTools(makeParams());

    // S is identical (the preamble is NOT in S) …
    expect(heavy.cachedSystemTokensEstimate).toBe(light.cachedSystemTokensEstimate);
    // … while the preamble estimate grew.
    expect(heavy.cachedFreshTailPreambleTokens).toBeGreaterThan(light.cachedFreshTailPreambleTokens);
  });
});

// ---------------------------------------------------------------------------
// Tool pipeline chain — every stage is invoked
// ---------------------------------------------------------------------------

describe("assembleTools — full tool pipeline (JIT, prune, snapshot, normalize, mutation-serialize)", () => {
  it("invokes createJitGuideWrapper, applySchemasPruning, applySchemaSnapshot, applyProviderNormalization, applyMutationSerializer exactly once each", async () => {
    await assembleTools(makeParams());
    expect(mocks.createJitGuideWrapperMock).toHaveBeenCalledTimes(1);
    expect(mocks.applySchemasPruningMock).toHaveBeenCalledTimes(1);
    expect(mocks.applySchemaSnapshotMock).toHaveBeenCalledTimes(1);
    expect(mocks.applyProviderNormalizationMock).toHaveBeenCalledTimes(1);
    expect(mocks.applyMutationSerializerMock).toHaveBeenCalledTimes(1);
  });

  it("skips applyProviderNormalization when resolvedModel is undefined (no provider context)", async () => {
    await assembleTools(makeParams({ resolvedModel: undefined }));
    expect(mocks.applyProviderNormalizationMock).not.toHaveBeenCalled();
    expect(mocks.applyMutationSerializerMock).toHaveBeenCalledTimes(1);
  });

  it("passes the capabilityClass from ModelProfile to applySchemasPruning (frontier → not pruned)", async () => {
    // Frontier models (anthropic) have capabilityClass="frontier"; applySchemasPruning
    // only prunes for "nano" — so frontier passes through unchanged (behavior-neutral K1).
    await assembleTools(makeParams({
      resolvedModel: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000, reasoning: false },
      // No modelProfile passed → assembleTools falls back to FAIL_CLOSED_PROFILE when
      // modelProfile is undefined. But when resolvedModel is present, the assembly
      // path uses the provided modelProfile param. Use explicit modelProfile to pin the assertion.
      modelProfile: {
        contextWindow: 200_000,
        maxOutputTokens: 4096,
        capabilityClass: "frontier",
        scaffoldLevel: "light",
        securityLevel: "standard",
        supportsVision: false,
        supportsTools: true,
        supportsPromptCache: false,
        supportsServerToolSearch: false,
        supportsStructuredOutput: false,
        reasoningStyle: "none",
      },
    }));
    const pruneCallArg = mocks.applySchemasPruningMock.mock.calls[0][0] as { capabilityClass: string };
    expect(pruneCallArg.capabilityClass).toBe("frontier");
  });

  it("characterization: frontier-class ModelProfile threads capabilityClass='frontier' to deferralCtx (behavior-neutral — same as old modelTier='large')", async () => {
    // Phase 151 K1 characterization: a frontier model must reach DeferralContext
    // with capabilityClass="frontier", matching the old modelTier="large" behavior.
    // The aggressive-deferral gate (capabilityClass==="nano") must NOT fire for frontier.
    const frontierProfile = {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilityClass: "frontier" as const,
      scaffoldLevel: "light" as const,
      securityLevel: "standard" as const,
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
      reasoningStyle: "none" as const,
    };
    await assembleTools(makeParams({
      resolvedModel: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000, reasoning: false },
      modelProfile: frontierProfile,
    }));
    // applyToolDeferral receives DeferralContext with capabilityClass="frontier"
    const deferralCtxArg = mocks.applyToolDeferralMock.mock.calls[0][1] as Record<string, unknown>;
    expect(deferralCtxArg).not.toBeUndefined();
    // The DeferralContext is the 2nd arg to applyToolDeferral (tools, contextWindow, ctx, ...)
    // Per executor-tool-assembly.ts call signature: applyToolDeferral(mergedCustomTools, contextWindow, deferralCtx, ...)
    // The context is the 3rd positional arg
    const deferralCtxPositional = mocks.applyToolDeferralMock.mock.calls[0][2] as Record<string, unknown>;
    expect(deferralCtxPositional?.capabilityClass).toBe("frontier");
  });

  it("characterization: nano-class ModelProfile threads capabilityClass='nano' to deferralCtx (behavior-neutral — same as old modelTier='small')", async () => {
    // Phase 151 K1 characterization: a nano model must reach DeferralContext
    // with capabilityClass="nano", matching the old modelTier="small" aggressive-deferral behavior.
    const nanoProfile = {
      contextWindow: 8_192,
      maxOutputTokens: 4096,
      capabilityClass: "nano" as const,
      scaffoldLevel: "max" as const,
      securityLevel: "locked" as const,
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
      reasoningStyle: "none" as const,
    };
    await assembleTools(makeParams({
      resolvedModel: { id: "tiny-model", provider: "custom", contextWindow: 8_192, reasoning: false },
      modelProfile: nanoProfile,
    }));
    const deferralCtxPositional = mocks.applyToolDeferralMock.mock.calls[0][2] as Record<string, unknown>;
    expect(deferralCtxPositional?.capabilityClass).toBe("nano");
    // Also verify capabilityClass reaches applySchemasPruning
    const pruneCallArg = mocks.applySchemasPruningMock.mock.calls[0][0] as { capabilityClass: string };
    expect(pruneCallArg.capabilityClass).toBe("nano");
  });
});

// ---------------------------------------------------------------------------
// Capability index + deferred context
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recall-trace config passthrough
//
// assembleTools forwards a SUBSET of deps into assembleExecutionPrompt.deps.
// recallTraceConfig must ride that subset (mirroring dataDir / cacheTraceConfig)
// so prompt-assembly's buildRecallTrace receives the operator's enable flag.
// Strategy: assembleExecutionPrompt is mocked at the file top; we assert the
// `deps` argument it was called with carries the forwarded recallTraceConfig.
// ---------------------------------------------------------------------------

describe("assembleTools — recall-trace config passthrough to prompt assembly", () => {
  it("forwards deps.recallTraceConfig into assembleExecutionPrompt.deps so buildRecallTrace receives the enable flag", async () => {
    // Production-wiring regression guard for the middle link of the chain:
    // setup-agents-runtime → PiExecutorDeps → ToolAssemblyDeps →
    // PromptAssemblyParams.deps.recallTraceConfig → buildRecallTrace.
    //
    // RED on pre-patch code: ToolAssemblyDeps had no recallTraceConfig field
    // and assembleTools never forwarded it, so the prompt-assembly site always
    // saw deps.recallTraceConfig === undefined → buildRecallTrace returned null
    // → no recorder, no traces. cacheTraceConfig is the wired sibling.
    const recallTraceConfig = {
      enabled: true,
      filePath: "/tmp/recall-trace-test.jsonl",
      maxFileBytes: 12_345,
    };
    await assembleTools(makeParams({
      deps: makeDeps({ recallTraceConfig }),
    }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({ recallTraceConfig }),
      }),
    );
  });

  it("forwards an enabled-false recallTraceConfig unchanged (opt-out path stays explicit)", async () => {
    // The default-off contract: when an operator leaves the flag at its
    // schema default (enabled:false), the same object still threads through so
    // buildRecallTrace can apply its null-when-disabled gate at the call site.
    const recallTraceConfig = { enabled: false };
    await assembleTools(makeParams({
      deps: makeDeps({ recallTraceConfig }),
    }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({ recallTraceConfig }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Recall-store passthrough to prompt assembly (the segregated KG / lane stores)
//
// assembleTools forwards a SUBSET of deps into assembleExecutionPrompt.deps —
// the SAME subset prompt-assembly's createMemoryRecall reads. The recall lane
// stores (graph-spread tripleStore, causal store, temporal store) MUST ride
// that subset or the lane stays DORMANT even when enabled:
// the daemon injects the store, createPiExecutor carries it, but the
// prompt-assembly site sees deps.<store> === undefined → the lane gate
// (`deps.tripleStore !== undefined`) short-circuits and the recursive-CTE walk
// never runs. This is the field-plumbing hazard: a missing forward = a silent
// no-op. Strategy: assembleExecutionPrompt is mocked at the file top; assert the
// `deps` argument it was called with carries each forwarded store.
// ---------------------------------------------------------------------------

describe("assembleTools — recall-store passthrough to prompt assembly", () => {
  it("forwards deps.tripleStore into assembleExecutionPrompt.deps so the graph-spread lane reaches createMemoryRecall", async () => {
    // RED on pre-patch code: ToolAssemblyDeps had no tripleStore field and
    // assembleTools never forwarded it, so the prompt-assembly site always saw
    // deps.tripleStore === undefined → the 6th graphSpread lane gate
    // short-circuited and spreadLane never ran (the lane dead even when the
    // daemon injected the store and an operator flipped rag.lanes.graphSpread.enabled).
    const tripleStore = {
      upsertTriple: vi.fn(),
      asOf: vi.fn(),
      currentTruth: vi.fn(),
      spreadLane: vi.fn(),
    } as unknown as import("@comis/core").TripleStorePort;
    await assembleTools(makeParams({
      deps: makeDeps({ tripleStore }),
    }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({ tripleStore }),
      }),
    );
  });

  it("forwards deps.causalStore + deps.temporalStore into assembleExecutionPrompt.deps so the causal + temporal lanes reach createMemoryRecall", async () => {
    // RED on pre-patch code: the assembleExecutionPrompt deps enumeration in
    // assembleTools forwarded entityStore + usefulnessStore but DROPPED
    // causalStore + temporalStore — even though ToolAssemblyDeps carried them
    // and prompt-assembly's createMemoryRecall reads them. So both lanes were
    // silently dead through the real pi-executor path (a latent field-plumbing
    // bug, fixed alongside the tripleStore wiring it sits beside).
    const causalStore = {
      linkCausal: vi.fn(),
      causalLane: vi.fn(),
    } as unknown as import("@comis/core").MemoryCausalStore;
    const temporalStore = {
      spreadLane: vi.fn(),
    } as unknown as import("@comis/core").MemoryTemporalStore;
    await assembleTools(makeParams({
      deps: makeDeps({ causalStore, temporalStore }),
    }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({ causalStore, temporalStore }),
      }),
    );
  });

  it("forwards deps.embeddingStore into assembleExecutionPrompt.deps so the MMR diversity re-rank reaches createMemoryRecall", async () => {
    // RED on pre-patch code: ToolAssemblyDeps had no embeddingStore field and
    // assembleTools never forwarded it, so the prompt-assembly site always saw
    // deps.embeddingStore === undefined → the MMR slot gate
    // (`deps.embeddingStore !== undefined`) short-circuited and the scoped
    // embedding read never ran (MMR a silent no-op even when the daemon injected
    // the store and an operator flipped rag.mmr.enabled). The SAME field-plumbing
    // hazard the temporal/causal/triple forwards above guard against.
    const embeddingStore = {
      readEmbeddings: vi.fn(),
    } as unknown as import("@comis/core").MemoryEmbeddingStore;
    await assembleTools(makeParams({
      deps: makeDeps({ embeddingStore }),
    }));
    expect(mocks.assembleExecutionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({ embeddingStore }),
      }),
    );
  });

});

describe("assembleTools — capability-index render result + deferred-context passthrough", () => {
  it("forwards the toolCapabilityPort into buildCapabilityIndexContext and returns its result on the result object", async () => {
    const portStub = createCapabilityPortStub({ isCapabilityIndexEnabled: () => true });
    const stubResult = { text: "CAP-INDEX-CONTENT", builtinCount: 3, mcpCount: 1, skillCount: 0 };
    mocks.buildCapabilityIndexContextMock.mockReturnValueOnce(stubResult);
    const result = await assembleTools(makeParams({
      deps: makeDeps({ toolCapabilityPort: portStub }),
    }));
    expect(mocks.buildCapabilityIndexContextMock).toHaveBeenCalledWith(expect.any(Object), portStub);
    expect(result.capabilityIndexResult).toBe(stubResult);
  });

  it("returns an empty deferredContext string when applyToolDeferral reports zero deferredEntries", async () => {
    mocks.applyToolDeferralMock.mockReturnValueOnce({
      activeTools: [],
      discoveredTools: [],
      deferredEntries: [],
      deferredNames: [],
      discoverTool: undefined,
    });
    const result = await assembleTools(makeParams());
    expect(mocks.buildDeferredToolsContextMock).not.toHaveBeenCalled();
    expect(result.deferredContext).toBe("");
  });

  it("populates deferredContext from buildDeferredToolsContext when applyToolDeferral reports any deferredEntries", async () => {
    mocks.applyToolDeferralMock.mockReturnValueOnce({
      activeTools: [],
      discoveredTools: [],
      deferredEntries: [{ name: "deferred-a" } as never],
      deferredNames: ["deferred-a"],
      discoverTool: undefined,
    });
    mocks.buildDeferredToolsContextMock.mockReturnValueOnce("<DEFERRED-CONTEXT-BODY>");
    const result = await assembleTools(makeParams());
    expect(mocks.buildDeferredToolsContextMock).toHaveBeenCalled();
    expect(result.deferredContext).toBe("<DEFERRED-CONTEXT-BODY>");
  });
});

// ---------------------------------------------------------------------------
// Discovery state restoration paths
// ---------------------------------------------------------------------------

describe("assembleTools — discovery-state restore from SpawnPacket on subagent inheritance", () => {
  it("restores discovered tool names from executionOverrides.spawnPacket.discoveredDeferredTools when present", async () => {
    const restore = vi.fn();
    mocks.getOrCreateDiscoveryTrackerMock.mockReturnValueOnce({
      serialize: vi.fn().mockReturnValue([]),
      restore,
      getDiscoveredNames: vi.fn().mockReturnValue(new Set()),
    });
    const logger = createMockLogger();
    await assembleTools(makeParams({
      deps: makeDeps({ logger }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExecutionOverrides partial
      executionOverrides: { spawnPacket: { discoveredDeferredTools: ["mcp-a", "mcp-b"] } } as any,
    }));
    expect(restore).toHaveBeenCalledWith(["mcp-a", "mcp-b"]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ restoredCount: 2 }),
      "Discovery state restored from parent SpawnPacket",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-message trust resolution
//
// The deferralCtx's `trustLevel` field gates `PRIVILEGED_TOOL_NAMES` (including
// `mcp_manage`, `agents_manage`, `obs_query`). Previously the context used the
// GLOBAL `defaultTrustLevel` only, so `senderTrustMap` entries never reached
// the deferral gate — admin users mapped via `senderTrustMap` had privileged
// tools deferred. This block asserts the new resolution:
//
//   config.elevatedReply.senderTrustMap[msg.senderId]
//     ?? config.elevatedReply.defaultTrustLevel
//     ?? "external"
//
// Strategy: applyToolDeferral is already mocked at the file top
// (`mocks.applyToolDeferralMock`). We don't re-test the deferral logic itself
// (that lives in tool-deferral.ts and already has its own tests). We assert
// the `deferralCtx.trustLevel` argument that assembleTools passes into the
// mock — the 3rd positional argument of applyToolDeferral(tools, ctxWin, ctx).
// ---------------------------------------------------------------------------

describe("assembleTools — per-message trust resolution", () => {
  it("senderTrustMap entry for admin user resolves trustLevel=admin (privileged tools cleared)", async () => {
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: {
        provider: "anthropic",
        contextEngine: { enabled: true },
        elevatedReply: {
          defaultTrustLevel: "external",
          senderTrustMap: { user_a: "admin" },
        },
      } as any,
    }));
    expect(mocks.applyToolDeferralMock).toHaveBeenCalled();
    const passedCtx = mocks.applyToolDeferralMock.mock.calls[0][2] as { trustLevel: string };
    expect(passedCtx.trustLevel).toBe("admin");
  });

  it("senderId NOT in senderTrustMap falls back to defaultTrustLevel (privileged tools stay deferred)", async () => {
    await assembleTools(makeParams({
      // makeMsg() sets senderId="user_a"; senderTrustMap below only maps user_b.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: {
        provider: "anthropic",
        contextEngine: { enabled: true },
        elevatedReply: {
          defaultTrustLevel: "external",
          senderTrustMap: { user_b: "admin" },
        },
      } as any,
    }));
    const passedCtx = mocks.applyToolDeferralMock.mock.calls[0][2] as { trustLevel: string };
    expect(passedCtx.trustLevel).toBe("external");
  });

  it("defaultTrustLevel=admin with no senderTrustMap resolves trustLevel=admin for unmapped users", async () => {
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: {
        provider: "anthropic",
        contextEngine: { enabled: true },
        elevatedReply: {
          defaultTrustLevel: "admin",
          // senderTrustMap omitted entirely
        },
      } as any,
    }));
    const passedCtx = mocks.applyToolDeferralMock.mock.calls[0][2] as { trustLevel: string };
    expect(passedCtx.trustLevel).toBe("admin");
  });

  it("falls through to 'external' when neither senderTrustMap nor defaultTrustLevel is set", async () => {
    await assembleTools(makeParams({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PerAgentConfig partial cast
      config: {
        provider: "anthropic",
        contextEngine: { enabled: true },
        // elevatedReply omitted entirely
      } as any,
    }));
    const passedCtx = mocks.applyToolDeferralMock.mock.calls[0][2] as { trustLevel: string };
    expect(passedCtx.trustLevel).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// C3: Preamble WARN + deferred-tools truncation (Plan 152-04)
// ---------------------------------------------------------------------------

describe("assembleTools — C3 preamble size WARN when cachedFreshTailPreambleTokens exceeds profile cap", () => {
  // CHARS_PER_TOKEN_RATIO = 3.5; small threshold = 3200 tokens → 3200 * 3.5 = 11200 chars to exceed
  const CHARS_PER_TOKEN_RATIO = 3.5;
  const SMALL_WARN_THRESHOLD_TOKENS = 3_200; // tokens
  const SMALL_WARN_THRESHOLD_CHARS = Math.ceil(SMALL_WARN_THRESHOLD_TOKENS * CHARS_PER_TOKEN_RATIO) + 1; // chars that produce tokens > threshold

  const smallProfile = {
    contextWindow: 32_768,
    maxOutputTokens: 4096,
    capabilityClass: "small" as const,
    scaffoldLevel: "standard" as const,
    securityLevel: "hardened" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none" as const,
  };

  const frontierProfile = {
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    capabilityClass: "frontier" as const,
    scaffoldLevel: "light" as const,
    securityLevel: "standard" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none" as const,
  };

  it("C3: emits logger.warn with hint and errorKind=capacity when small model preamble exceeds threshold", async () => {
    const logger = createMockLogger();
    // Produce a preamble that exceeds the small-class threshold
    const bigPreamble = "P".repeat(SMALL_WARN_THRESHOLD_CHARS);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: bigPreamble,
      inlineMemory: undefined,
    });
    await assembleTools(makeParams({
      modelProfile: smallProfile,
      resolvedModel: { id: "small-model", provider: "custom", contextWindow: 32_768, reasoning: false },
      deps: makeDeps({ logger }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: expect.stringContaining("preamble"),
        capabilityClass: "small",
      }),
      expect.stringContaining("preamble"),
    );
  });

  it("C3: does NOT warn for frontier model even with a large preamble (Infinity threshold)", async () => {
    const logger = createMockLogger();
    // Even a very large preamble should NOT warn for frontier
    const bigPreamble = "P".repeat(SMALL_WARN_THRESHOLD_CHARS * 10);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: bigPreamble,
      inlineMemory: undefined,
    });
    await assembleTools(makeParams({
      modelProfile: frontierProfile,
      resolvedModel: { id: "claude-frontier", provider: "anthropic", contextWindow: 200_000, reasoning: false },
      deps: makeDeps({ logger }),
    }));
    // No warn with errorKind=resource (C3 preamble guard) should have fired
    const capacityWarns = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>)?.errorKind === "resource",
    );
    expect(capacityWarns).toHaveLength(0);
  });

  it("C3: small model with preamble BELOW threshold does NOT warn", async () => {
    const logger = createMockLogger();
    // Preamble well below 3200 tokens
    const smallPreamble = "P".repeat(100);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: smallPreamble,
      inlineMemory: undefined,
    });
    await assembleTools(makeParams({
      modelProfile: smallProfile,
      resolvedModel: { id: "small-model", provider: "custom", contextWindow: 32_768, reasoning: false },
      deps: makeDeps({ logger }),
    }));
    const resourceWarns = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>)?.errorKind === "resource",
    );
    expect(resourceWarns).toHaveLength(0);
  });
});

describe("assembleTools — C3 deferred-tools list capped for small/nano via DEFERRED_TOOLS_MAX_BY_CLASS", () => {
  const smallProfile = {
    contextWindow: 32_768,
    maxOutputTokens: 4096,
    capabilityClass: "small" as const,
    scaffoldLevel: "standard" as const,
    securityLevel: "hardened" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none" as const,
  };

  it("C3: calls buildDeferredToolsContext with maxEntries option for small model when deferred entries exist", async () => {
    // Simulate 50 deferred entries for small model
    const deferredEntries = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` } as never));
    mocks.applyToolDeferralMock.mockReturnValueOnce({
      activeTools: [],
      discoveredTools: [],
      deferredEntries,
      deferredNames: deferredEntries.map((e: { name: string }) => e.name),
      discoverTool: undefined,
    });
    mocks.buildDeferredToolsContextMock.mockReturnValueOnce("<deferred-with-cap>");
    await assembleTools(makeParams({
      modelProfile: smallProfile,
      resolvedModel: { id: "small-model", provider: "custom", contextWindow: 32_768, reasoning: false },
    }));
    // For small class, DEFERRED_TOOLS_MAX_BY_CLASS["small"] = 20, so maxEntries should be passed
    expect(mocks.buildDeferredToolsContextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxEntries: 20 }),
    );
  });

  it("C3: calls buildDeferredToolsContext WITHOUT maxEntries option for frontier model (unlimited)", async () => {
    const frontierProfile = {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilityClass: "frontier" as const,
      scaffoldLevel: "light" as const,
      securityLevel: "standard" as const,
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
      reasoningStyle: "none" as const,
    };
    const deferredEntries = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` } as never));
    mocks.applyToolDeferralMock.mockReturnValueOnce({
      activeTools: [],
      discoveredTools: [],
      deferredEntries,
      deferredNames: deferredEntries.map((e: { name: string }) => e.name),
      discoverTool: undefined,
    });
    mocks.buildDeferredToolsContextMock.mockReturnValueOnce("<deferred-unlimited>");
    await assembleTools(makeParams({
      modelProfile: frontierProfile,
      resolvedModel: { id: "claude-frontier", provider: "anthropic", contextWindow: 200_000, reasoning: false },
    }));
    // For frontier class, DEFERRED_TOOLS_MAX_BY_CLASS["frontier"] = Infinity → no maxEntries passed
    expect(mocks.buildDeferredToolsContextMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// KNOB-02 (Phase 176): window-provenance threading into the profile budget.
// Plan 176-01 made computeTokenBudgetForProfile provenance-AWARE (optional 7th
// arg); without the ToolAssemblyParams field + the call-site pass-through, the
// parameter is never populated — "built-but-not-wired" (Pitfall 4). This is
// the RED pin proving the value REACHES the budget call site.
// ---------------------------------------------------------------------------

describe("assembleTools — KNOB-02 window provenance threading into computeTokenBudgetForProfile", () => {
  // The executor-reconciled profile: contextWindow ALREADY overwritten with the
  // served value (8_192) by pi-executor's resolveModelProfile-on-reconciled-window.
  const servedBoundSmallProfile = {
    contextWindow: 8_192,
    maxOutputTokens: 4096,
    capabilityClass: "small" as const,
    scaffoldLevel: "standard" as const,
    securityLevel: "hardened" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none" as const,
  };

  it("KNOB-02-20: threads params.windowProvenance to the budget call so a served-bound budget reports raw=configured 131072 with windowCapSource 'served'", async () => {
    const budgetSpy = vi.mocked(computeTokenBudgetForProfile);
    await assembleTools(makeParams({
      modelProfile: servedBoundSmallProfile,
      resolvedModel: { id: "qwen-small", provider: "ollama", contextWindow: 131_072, reasoning: false },
      windowProvenance: { configuredWindow: 131_072, served: 8_192, reconcileSource: "served" },
    }));
    // The provenance object must arrive as the 7th argument (index 6) — RED
    // pre-patch: ToolAssemblyParams has no windowProvenance field and the call
    // site passes 6 args, so this is undefined.
    const lastCall = budgetSpy.mock.calls.at(-1);
    expect(lastCall?.[6]).toEqual({ configuredWindow: 131_072, served: 8_192, reconcileSource: "served" });
    // And the REAL budget computed from it reports the TRUE configured window
    // (not the served value masquerading as the model's declared window) with
    // the served cap source — RED pre-patch: raw === 8_192, source === "none".
    const budgetResult = budgetSpy.mock.results.at(-1)?.value as {
      rawContextWindowTokens: number;
      windowCapSource: string;
    };
    expect(budgetResult.rawContextWindowTokens).toBe(131_072);
    expect(budgetResult.windowCapSource).toBe("served");
  });
});

// ---------------------------------------------------------------------------
// TOK-01 (Phase 179): script-aware token factors on the THREE char→token sites
//
// All three executor-tool-assembly conversions divide flat chars by 3.5, blind
// to script density — a Hebrew systemPrompt/preamble carries ~1.8× the tokens
// the flat estimate reserves, voiding the v2.18 fit guarantee for non-Latin.
// Pre-patch every Hebrew case below computes flat chars/3.5 → RED. The fix
// divides each TEXT term's chars by scriptTokenFactor(text) (effective chars),
// rides aggregate char counts (tool-def overhead — machine-Latin JSON) flat,
// and takes ONE ceil over the sum (per-term ceils would inflate ASCII results
// and break the I1 byte-identity pin).
// ---------------------------------------------------------------------------

describe("assembleTools — TOK-01 script-aware system/preamble token estimates", () => {
  // The budget-path char ratio (constants.ts CHARS_PER_TOKEN_RATIO).
  const RATIO = 3.5;
  // Pure-Hebrew payload (letters + neutral spaces → hebrew-letters row factor,
  // shipped 0.50 after the TOK-02 same-commit lowering — pinned exactly in
  // core's token-factor.test.ts): factored tokens ≈ 2× flat — comfortably
  // discriminating. Bounds here import scriptTokenFactor, so they track the
  // table value automatically.
  const HE = "שלום עולם זה מבחן ארוך מאוד לבדיקת חלוקה ";

  it("SITE A: a Hebrew-saturated systemPrompt reserves the FACTORED system-token estimate, not flat chars/3.5", async () => {
    // Pre-patch: cachedSystemTokensEstimate = ceil(hePrompt.length / 3.5) → RED.
    const hePrompt = HE.repeat(100); // ~4_200 Hebrew chars
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: hePrompt,
      dynamicPreamble: "",
    });
    // Default params carry zero custom tools → tool-def overhead chars = 0.
    const r = await assembleTools(makeParams());
    expect(r.cachedSystemTokensEstimate).toBeGreaterThanOrEqual(
      Math.ceil(hePrompt.length / (RATIO * scriptTokenFactor(hePrompt))),
    );
  });

  it("SITE B: a Hebrew dynamicPreamble + Hebrew inlineMemory yields the factored preamble estimate (effective chars, ONE ceil)", async () => {
    // The preamble CAN carry Hebrew (recalled memories, skills). Pre-patch:
    // ceil((pre + mem) / 3.5) flat → RED. Post-patch: each text term divided by
    // its own factor, ONE ceil over the summed effective chars.
    const hePre = HE.repeat(50);
    const heMem = HE.repeat(25);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: "x".repeat(100),
      dynamicPreamble: hePre,
      inlineMemory: heMem,
    });
    const r = await assembleTools(makeParams());
    expect(r.cachedFreshTailPreambleTokens).toBeGreaterThanOrEqual(
      Math.ceil(
        (hePre.length / scriptTokenFactor(hePre) + heMem.length / scriptTokenFactor(heMem)) / RATIO,
      ),
    );
  });

  it("post-deferral recompute preserves the script factor (#190 third site)", async () => {
    // THE #190 pitfall pin: assembleTools RECOMPUTES cachedSystemTokensEstimate over
    // the post-deferral toolset (the tools that actually ship). If only the
    // pre-deferral site were factored, this recompute would OVERWRITE the honest
    // estimate with flat math right before the history partition + fit check
    // consume it. Pre-patch the recompute is flat chars/3.5 → RED even if SITE A
    // were factored, because the returned value IS the recomputed one.
    const hePrompt = HE.repeat(100);
    const manyTools = Array.from({ length: 30 }, (_, i) => makeTool(`tool-${i}`, "d".repeat(50)));
    const activeSubset = manyTools.slice(0, 4);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: hePrompt,
      dynamicPreamble: "",
    });
    // Drive the DEFERRAL path: keep 4 active, defer 26 (mirrors the UC-2 fixture above).
    mocks.applyToolDeferralMock.mockImplementationOnce(() => ({
      activeTools: activeSubset,
      discoveredTools: [],
      deferredEntries: manyTools.slice(4).map((t) => ({ name: (t as { name: string }).name })),
      deferredNames: manyTools.slice(4).map((t) => (t as { name: string }).name),
      discoverTool: undefined,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition[] cast
    const r = await assembleTools(makeParams({ deps: makeDeps({ customTools: manyTools as any }) }));
    // The recomputed estimate covers the POST-deferral overhead (4 active tools,
    // flat machine-Latin chars) PLUS the factored Hebrew systemPrompt — ONE ceil.
    const postDeferralOverhead = toolDefOverheadChars(activeSubset as never);
    expect(r.cachedSystemTokensEstimate).toBeGreaterThanOrEqual(
      Math.ceil((hePrompt.length / scriptTokenFactor(hePrompt) + postDeferralOverhead) / RATIO),
    );
  });

  it("I1: pure-ASCII systemPrompt and preamble estimates are byte-identical to the flat formulas (factor 1.0)", async () => {
    // The Latin guarantee: scriptTokenFactor(ascii) === 1 and ONE ceil over the
    // summed effective chars reproduces today's values EXACTLY (per-term ceil
    // splitting would inflate these — the I1 break this pin guards against).
    const asciiPrompt = "x".repeat(443); // odd lengths exercise the ceil boundary
    const asciiPre = "P".repeat(353);
    const asciiMem = "M".repeat(211);
    mocks.assembleExecutionPromptMock.mockResolvedValueOnce({
      systemPrompt: asciiPrompt,
      dynamicPreamble: asciiPre,
      inlineMemory: asciiMem,
    });
    const r = await assembleTools(makeParams());
    // Expected values computed with TODAY'S flat formulas inline — exact equality.
    expect(r.cachedSystemTokensEstimate).toBe(Math.ceil(asciiPrompt.length / RATIO));
    expect(r.cachedFreshTailPreambleTokens).toBe(
      Math.ceil((asciiPre.length + asciiMem.length) / RATIO),
    );
  });
});
