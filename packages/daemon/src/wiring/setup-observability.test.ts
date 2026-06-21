// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { themeForName } from "@comis/core";
import type { ActivityEvent, TurnActivityContext, SpendConfig } from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCreateCostTracker = vi.hoisted(() => vi.fn(() => ({
  record: vi.fn(),
  getAll: vi.fn(() => []),
})));

// A spy spend accumulator: createSpendAccumulator returns this so the tests can
// assert recordSpend/rehydrate are invoked with the derived scope.
const mockSpendAccumulator = vi.hoisted(() => ({
  rehydrate: vi.fn(),
  recordSpend: vi.fn(),
  checkAndReserve: vi.fn(),
  reconcile: vi.fn(),
}));
const mockCreateSpendAccumulator = vi.hoisted(() => vi.fn(() => mockSpendAccumulator));

const mockCreateDiagnosticCollector = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const mockCreateBillingEstimator = vi.hoisted(() => vi.fn(() => ({ estimate: vi.fn() })));
const mockCreateChannelActivityTracker = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const mockCreateDeliveryTracer = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));

// The opt-in extension's registration entry-point — mocked so the seam test
// asserts it is reached ONLY when enabled, without a real OTel SDK. A controllable
// `_shouldThrow` flag exercises the honest-degradation (throwing-import) path.
const mockOtelHandle = vi.hoisted(() => ({ shutdown: vi.fn(async () => undefined) }));
const mockRegisterOtelExporter = vi.hoisted(() => vi.fn(() => mockOtelHandle));
const otelMockState = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("@comis/agent", () => ({
  createCostTracker: mockCreateCostTracker,
  createSpendAccumulator: mockCreateSpendAccumulator,
}));

// The seam does `await import("@comis/observability-otel")`. Mock that module so
// the test controls whether registerOtelExporter resolves or throws. When
// `otelMockState.shouldThrow` is set, accessing the export throws (simulating an
// unavailable/broken extension) — the seam must WARN, not crash.
vi.mock("@comis/observability-otel", () => ({
  get registerOtelExporter() {
    if (otelMockState.shouldThrow) throw new Error("simulated: extension unavailable");
    return mockRegisterOtelExporter;
  },
}));

vi.mock("../observability/diagnostic-collector.js", () => ({
  createDiagnosticCollector: mockCreateDiagnosticCollector,
}));

vi.mock("../observability/billing-estimator.js", () => ({
  createBillingEstimator: mockCreateBillingEstimator,
}));

vi.mock("../observability/channel-activity-tracker.js", () => ({
  createChannelActivityTracker: mockCreateChannelActivityTracker,
}));

vi.mock("../observability/delivery-tracer.js", () => ({
  createDeliveryTracer: mockCreateDeliveryTracer,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    on(event: string, handler: (...args: any[]) => any) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return this;
    },
    off: vi.fn(),
    once: vi.fn(),
    emit(event: string, data: unknown) {
      const list = handlers.get(event) ?? [];
      for (const h of list) h(data);
      return true;
    },
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    _handlers: handlers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupObservability", () => {
  let mockCreateTokenTracker: ReturnType<typeof vi.fn>;
  let mockTokenTracker: any;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTokenTracker = { prune: vi.fn() };
    mockCreateTokenTracker = vi.fn(() => mockTokenTracker);

    // Spy on setInterval to verify prune timer setup
    setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({
      unref: vi.fn(),
      ref: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as any);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  async function getSetupObservability() {
    const mod = await import("./setup-observability.js");
    return mod.setupObservability;
  }

  // -------------------------------------------------------------------------
  // 1. Creates token tracker with eventBus
  // -------------------------------------------------------------------------

  it("calls _createTokenTracker with eventBus", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    expect(mockCreateTokenTracker).toHaveBeenCalledWith(eventBus);
  });

  // -------------------------------------------------------------------------
  // 2. Creates sharedCostTracker and subscribes to token_usage event
  // -------------------------------------------------------------------------

  it("creates sharedCostTracker and subscribes to observability:token_usage", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    expect(mockCreateCostTracker).toHaveBeenCalled();
    expect(result.sharedCostTracker).toBeDefined();

    // Verify subscription to observability:token_usage
    const handlers = eventBus._handlers.get("observability:token_usage");
    expect(handlers).toBeDefined();
    expect(handlers!.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 3. Fires token_usage event and verifies record() called
  // -------------------------------------------------------------------------

  it("calls sharedCostTracker.record when observability:token_usage fires", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    const payload = {
      agentId: "agent-1",
      channelId: "chan-1",
      executionId: "exec-1",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: 0.01,
      provider: "openai",
      model: "gpt-4",
    };

    eventBus.emit("observability:token_usage", payload);

    expect(result.sharedCostTracker.record).toHaveBeenCalledWith(
      "agent-1",
      "chan-1",
      "exec-1",
      {
        input: 100,
        output: 50,
        totalTokens: 150,
        cost: 0.01,
        provider: "openai",
        model: "gpt-4",
        operationType: "interactive",
      },
    );
  });

  // -------------------------------------------------------------------------
  // 4. Creates all 4 diagnostic modules
  // -------------------------------------------------------------------------

  it("creates diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    expect(mockCreateDiagnosticCollector).toHaveBeenCalledWith({ eventBus });
    expect(mockCreateBillingEstimator).toHaveBeenCalledWith({
      costTracker: result.sharedCostTracker,
    });
    expect(mockCreateChannelActivityTracker).toHaveBeenCalledWith({ eventBus });
    expect(mockCreateDeliveryTracer).toHaveBeenCalledWith({ eventBus });

    expect(result.diagnosticCollector).toBeDefined();
    expect(result.billingEstimator).toBeDefined();
    expect(result.channelActivityTracker).toBeDefined();
    expect(result.deliveryTracer).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 5. Sets up prune interval with .unref()
  // -------------------------------------------------------------------------

  it("sets up prune interval with .unref()", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    // setInterval should have been called with 30-minute interval
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      30 * 60 * 1000,
    );

    // .unref() should have been called on the returned timer
    const timer = setIntervalSpy.mock.results[0].value;
    expect(timer.unref).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Returns all result fields
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 7. Subscribes to observability:cache_break event
  // -------------------------------------------------------------------------

  it("subscribes to observability:cache_break event", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();
    const mockLogger = { info: vi.fn() };

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      logger: mockLogger,
    });

    const handlers = eventBus._handlers.get("observability:cache_break");
    expect(handlers).toBeDefined();
    expect(handlers!.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 8. Emitting cache_break logs at INFO with structured fields
  // -------------------------------------------------------------------------

  it("logs cache_break event with structured fields at INFO level", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();
    const mockLogger = { info: vi.fn() };

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      logger: mockLogger,
    });

    const payload = {
      provider: "anthropic",
      reason: "system_prompt_changed",
      tokenDrop: 5000,
      tokenDropRelative: 0.42,
      previousCacheRead: 12000,
      currentCacheRead: 7000,
      callCount: 15,
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
      },
      toolsChanged: ["tool-a", "tool-b"],
      ttlCategory: "medium",
      agentId: "agent-test",
      sessionKey: "session-test",
      timestamp: Date.now(),
    };

    eventBus.emit("observability:cache_break", payload);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        reason: "system_prompt_changed",
        tokenDrop: 5000,
        tokenDropRelative: 0.42,
        agentId: "agent-test",
        sessionKey: "session-test",
        ttlCategory: "medium",
        toolsChanged: 2,
        systemChanged: true,
        modelChanged: false,
      }),
      "Cache break detected",
    );
  });

  // -------------------------------------------------------------------------
  // 9. Returns all result fields
  // -------------------------------------------------------------------------

  it("returns all expected result fields", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    expect(result.tokenTracker).toBe(mockTokenTracker);
    expect(result.sharedCostTracker).toBeDefined();
    expect(result.diagnosticCollector).toBeDefined();
    expect(result.billingEstimator).toBeDefined();
    expect(result.channelActivityTracker).toBeDefined();
    expect(result.deliveryTracer).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 10. Theme wiring: a forwarded ascii theme reaches the ActivityStream so the
  //     subagent label is emoji-free (proves theme threads end-to-end here).
  // -------------------------------------------------------------------------

  it("forwards an ascii theme so the constructed stream strips emoji from the subagent label", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      theme: themeForName("ascii"),
    });

    const ctx: TurnActivityContext = {
      agentId: "agent-1",
      sessionKey: "session-1",
      traceId: "trace-1",
      channelType: "telegram",
      channelKey: "chat-9",
      chatType: "direct",
      inboundMessageId: "m-1",
      rendererKey: "agent-1:telegram:chat-9:direct",
    };
    const received: ActivityEvent[] = [];
    const sub = result.activityStream.subscribeForTurn(ctx, (e) => received.push(e));
    eventBus.emit("session:sub_agent_spawned", {
      runId: "run-wiring",
      parentSessionKey: "session-1",
      agentId: "agent-1",
      task: "do work",
      timestamp: 1,
    });
    sub.unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0].defaultLabel).toBe("[SUB] agent-1 subagent");
    expect(received[0].defaultLabel).not.toContain("🤖");
  });

  // -------------------------------------------------------------------------
  // 11. Spend kill-switch (Phase 177-03): CONSTRUCT the daemon-wide accumulator
  //     + the live recordSpend subscriber inside setupObservability. REHYDRATE
  //     lives at the boot root (daemon.ts) — covered by rehydrateSpendFromStore.
  // -------------------------------------------------------------------------

  const spendConfig: SpendConfig = {
    perAgentUsd: null,
    perTenantUsd: null,
    daemonGlobalUsd: 10,
    perTurnMax: 0.5,
    action: "warn",
    warnAtFraction: 0.8,
    pricingFallback: "snapshot",
    onUnknownPricing: "warn",
  };

  function makeConfigWithSpend(): any {
    return { observability: { spend: spendConfig } };
  }

  it("constructs exactly ONE daemon-wide spend accumulator when clock + config are provided", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock: createFakeClock(1_000_000) as any,
      config: makeConfigWithSpend(),
    } as any);

    expect(mockCreateSpendAccumulator).toHaveBeenCalledTimes(1);
    // The ceilings flow from observability.spend.
    expect(mockCreateSpendAccumulator).toHaveBeenCalledWith(
      expect.objectContaining({
        ceilings: expect.objectContaining({ daemonGlobalUsd: 10, warnAtFraction: 0.8 }),
      }),
    );
    // Threaded out on the wiring object (so the per-agent guards hold a reference).
    expect((result as any).spendAccumulator).toBe(mockSpendAccumulator);
  });

  it("increments the accumulator live from observability:token_usage, deriving tenant via parseFormattedSessionKey (NOT agentId)", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock: createFakeClock(1_000_000) as any,
      config: makeConfigWithSpend(),
    } as any);

    // A formatted sessionKey "tenantX:user1:channel1" → tenantId "tenantX".
    eventBus.emit("observability:token_usage", {
      agentId: "agent-1",
      channelId: "channel1",
      executionId: "exec-1",
      sessionKey: "tenantX:user1:channel1",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      provider: "anthropic",
      model: "claude",
    });

    expect(mockSpendAccumulator.recordSpend).toHaveBeenCalledWith(
      { tenantId: "tenantX", agentId: "agent-1" }, // L1: tenant from the parser, NOT agentId
      0.05,
    );
  });

  it("does NOT construct an accumulator when clock/config are absent (existing call shape unaffected)", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
    });

    expect(mockCreateSpendAccumulator).not.toHaveBeenCalled();
    expect((result as any).spendAccumulator).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 12. The config-gated await-import seam (178-02 Task 3): load the opt-in
  //     @comis/observability-otel extension ONLY when otel/prometheus enabled;
  //     default-off touches nothing; a throwing import WARNs, never crashes.
  // -------------------------------------------------------------------------

  function configWith(observability: Record<string, unknown>): any {
    return { observability: { spend: spendConfig, ...observability } };
  }

  it("loads the otel extension + resolves an otelHandle when observability.otel.enabled:true", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock: createFakeClock(1_000_000) as any,
      config: configWith({ otel: { enabled: true }, prometheus: { enabled: false } }),
    } as any);

    expect(mockRegisterOtelExporter).toHaveBeenCalledTimes(1);
    // The spend accumulator reference is threaded into the exporter (gauge source).
    expect(mockRegisterOtelExporter).toHaveBeenCalledWith(
      expect.objectContaining({ eventBus, spendAccumulator: mockSpendAccumulator }),
    );
    expect((result as any).otelHandle).toBe(mockOtelHandle);
  });

  it("loads the extension when ONLY prometheus.enabled:true (independent of otel.enabled)", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock: createFakeClock(1_000_000) as any,
      config: configWith({ otel: { enabled: false }, prometheus: { enabled: true } }),
    } as any);

    expect(mockRegisterOtelExporter).toHaveBeenCalledTimes(1);
    expect((result as any).otelHandle).toBe(mockOtelHandle);
  });

  it("default-off (both flags false): NEVER attempts the import, otelHandle is undefined", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock: createFakeClock(1_000_000) as any,
      config: configWith({ otel: { enabled: false }, prometheus: { enabled: false } }),
    } as any);

    expect(mockRegisterOtelExporter).not.toHaveBeenCalled();
    expect((result as any).otelHandle).toBeUndefined();
  });

  it("honest degradation: an enabled-but-throwing extension WARNs with a hint and still RESOLVES (never crashes boot)", async () => {
    otelMockState.shouldThrow = true; // simulate the extension import throwing
    const eventBus = createMockEventBus();
    const mockLogger = { info: vi.fn(), warn: vi.fn() };
    const setupObservability = await getSetupObservability();

    // Must RESOLVE (not reject) even though the seam import throws.
    const result = await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      logger: mockLogger as any,
      clock: createFakeClock(1_000_000) as any,
      config: configWith({ otel: { enabled: true }, prometheus: { enabled: false } }),
    } as any);

    expect((result as any).otelHandle).toBeUndefined();
    // A WARN with a hint was logged (the self-DoS guard, T-178-06).
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.any(String) }),
      expect.any(String),
    );
    otelMockState.shouldThrow = false;
  });

  // -------------------------------------------------------------------------
  // 13. MD-01: a non-loopback prometheus.host bind is a deliberate-but-risky
  //     posture — emit a startup WARN-with-hint naming the exposure (the
  //     /metrics surface serves operational shape unauthenticated). Do NOT
  //     reject 0.0.0.0 (a valid choice behind a reverse proxy) — just warn.
  // -------------------------------------------------------------------------

  it("MD-01: WARNs with a hint when prometheus.enabled + a NON-loopback host (0.0.0.0) — names the unauthenticated exposure", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const mockLogger = { info: vi.fn(), warn: vi.fn() };
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      logger: mockLogger as any,
      clock: createFakeClock(1_000_000) as any,
      config: configWith({
        otel: { enabled: false },
        prometheus: { enabled: true, host: "0.0.0.0" },
      }),
    } as any);

    // A WARN with a hint fired, and the hint names the exposure + the knob.
    const nonLoopbackWarn = mockLogger.warn.mock.calls.find(
      ([obj]) =>
        obj &&
        typeof obj === "object" &&
        typeof (obj as any).hint === "string" &&
        /metrics|loopback|reverse.proxy|unauthenticated/i.test((obj as any).hint),
    );
    expect(nonLoopbackWarn, "a non-loopback bind must WARN with an exposure hint").toBeTruthy();
    // The hint names the actual host (the "name the knob" discipline).
    expect(JSON.stringify(nonLoopbackWarn![0])).toContain("0.0.0.0");
    // The extension still loads (the bind is a valid deliberate choice, not rejected).
    expect(mockRegisterOtelExporter).toHaveBeenCalledTimes(1);
  });

  it("MD-01: does NOT WARN for a loopback host (127.0.0.1 / ::1 / localhost) — the safe default is silent", async () => {
    otelMockState.shouldThrow = false;
    const setupObservability = await getSetupObservability();

    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      vi.clearAllMocks();
      const eventBus = createMockEventBus();
      const mockLogger = { info: vi.fn(), warn: vi.fn() };
      await setupObservability({
        eventBus: eventBus as any,
        _createTokenTracker: mockCreateTokenTracker,
        logger: mockLogger as any,
        clock: createFakeClock(1_000_000) as any,
        config: configWith({ otel: { enabled: false }, prometheus: { enabled: true, host } }),
      } as any);

      const exposureWarn = mockLogger.warn.mock.calls.find(
        ([obj]) =>
          obj &&
          typeof obj === "object" &&
          typeof (obj as any).hint === "string" &&
          /loopback|reverse.proxy|unauthenticated/i.test((obj as any).hint),
      );
      expect(exposureWarn, `loopback host '${host}' must NOT trigger the exposure WARN`).toBeUndefined();
    }
  });

  it("MD-01: does NOT WARN about the bind when prometheus is DISABLED (even with a non-loopback host configured)", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const mockLogger = { info: vi.fn(), warn: vi.fn() };
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      logger: mockLogger as any,
      clock: createFakeClock(1_000_000) as any,
      // prometheus off → the host is inert; no exposure exists to warn about.
      config: configWith({ otel: { enabled: false }, prometheus: { enabled: false, host: "0.0.0.0" } }),
    } as any);

    const exposureWarn = mockLogger.warn.mock.calls.find(
      ([obj]) => obj && typeof obj === "object" && /metrics|loopback/i.test(String((obj as any).hint ?? "")),
    );
    expect(exposureWarn, "a disabled prometheus surface must not warn about its host").toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 14. LOW-1: the clock is forwarded to the extension ONLY when present —
  //     never `clock: undefined` cast to ClockPort (the legacy/test call shape
  //     passes no clock). The extension never calls clock, but an unsound
  //     `undefined as ClockPort` is still a latent contract lie.
  // -------------------------------------------------------------------------

  it("LOW-1: forwards clock to the extension ONLY when present — no `clock: undefined` when clock is absent", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    // Enable prometheus so the seam runs, but pass NO clock (the legacy shape).
    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      config: configWith({ otel: { enabled: false }, prometheus: { enabled: true } }),
    } as any);

    expect(mockRegisterOtelExporter).toHaveBeenCalledTimes(1);
    const deps = mockRegisterOtelExporter.mock.calls[0]![0] as Record<string, unknown>;
    // The `clock` key must be ABSENT (conditionally spread) — never present-with-undefined.
    expect("clock" in deps, "clock must not be forwarded as `undefined` (the unsound cast)").toBe(false);
  });

  it("LOW-1: forwards the real clock when one IS provided", async () => {
    otelMockState.shouldThrow = false;
    const eventBus = createMockEventBus();
    const clock = createFakeClock(1_000_000) as any;
    const setupObservability = await getSetupObservability();

    await setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      clock,
      config: configWith({ otel: { enabled: false }, prometheus: { enabled: true } }),
    } as any);

    const deps = mockRegisterOtelExporter.mock.calls[0]![0] as Record<string, unknown>;
    expect(deps["clock"]).toBe(clock);
  });
});
