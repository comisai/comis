import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCreateCostTracker = vi.hoisted(() => vi.fn(() => ({
  record: vi.fn(),
  getAll: vi.fn(() => []),
})));

const mockCreateDiagnosticCollector = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const mockCreateBillingEstimator = vi.hoisted(() => vi.fn(() => ({ estimate: vi.fn() })));
const mockCreateChannelActivityTracker = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const mockCreateDeliveryTracer = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));

vi.mock("@comis/agent", () => ({
  createCostTracker: mockCreateCostTracker,
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
  let mockCreateLatencyRecorder: ReturnType<typeof vi.fn>;
  let mockTokenTracker: any;
  let mockLatencyRecorder: any;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTokenTracker = { prune: vi.fn() };
    mockLatencyRecorder = { prune: vi.fn() };
    mockCreateTokenTracker = vi.fn(() => mockTokenTracker);
    mockCreateLatencyRecorder = vi.fn(() => mockLatencyRecorder);

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
  // 1. Creates token tracker and latency recorder with eventBus
  // -------------------------------------------------------------------------

  it("calls _createTokenTracker and _createLatencyRecorder with eventBus", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
    });

    expect(mockCreateTokenTracker).toHaveBeenCalledWith(eventBus);
    expect(mockCreateLatencyRecorder).toHaveBeenCalledWith(eventBus);
  });

  // -------------------------------------------------------------------------
  // 2. Creates sharedCostTracker and subscribes to token_usage event
  // -------------------------------------------------------------------------

  it("creates sharedCostTracker and subscribes to observability:token_usage", async () => {
    const eventBus = createMockEventBus();
    const setupObservability = await getSetupObservability();

    const result = setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    const result = setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    const result = setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
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

    const result = setupObservability({
      eventBus: eventBus as any,
      _createTokenTracker: mockCreateTokenTracker,
      _createLatencyRecorder: mockCreateLatencyRecorder,
    });

    expect(result.tokenTracker).toBe(mockTokenTracker);
    expect(result.latencyRecorder).toBe(mockLatencyRecorder);
    expect(result.sharedCostTracker).toBeDefined();
    expect(result.diagnosticCollector).toBeDefined();
    expect(result.billingEstimator).toBeDefined();
    expect(result.channelActivityTracker).toBeDefined();
    expect(result.deliveryTracer).toBeDefined();
  });
});
