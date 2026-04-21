// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ShutdownDeps } from "./setup-shutdown.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Captured onShutdown callback from _registerGracefulShutdown. */
let capturedOnShutdown: (() => Promise<void>) | null = null;

function createMinimalDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  const mockShutdownHandle = {
    isShuttingDown: false,
    trigger: vi.fn(async () => {}),
  };

  return {
    logger: createMockLogger() as any,
    daemonLogger: createMockLogger() as any,
    processMonitor: { start: vi.fn(), stop: vi.fn() } as any,
    container: { shutdown: vi.fn(async () => {}) } as any,
    exitFn: vi.fn(),
    _registerGracefulShutdown: vi.fn((opts: any) => {
      capturedOnShutdown = opts.onShutdown;
      return mockShutdownHandle;
    }),
    activeExecutions: undefined,
    subAgentRunner: { shutdown: vi.fn(async () => {}) },
    cronSchedulers: new Map(),
    resetSchedulers: new Map(),
    browserServices: new Map(),
    tokenTracker: {
      getAll: vi.fn(() => []),
      record: vi.fn(),
      getByTrace: vi.fn(),
      aggregateByProvider: vi.fn(),
      aggregateByModel: vi.fn(),
      prune: vi.fn(),
    } as any,
    startupTimestamp: Date.now() - 10_000,
    diagnosticCollector: { dispose: vi.fn() } as any,
    channelActivityTracker: { dispose: vi.fn() } as any,
    deliveryTracer: { dispose: vi.fn() } as any,
    db: { close: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupShutdown", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedOnShutdown = null;
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  // Lazy import so spies are in place
  async function getSetupShutdown() {
    const mod = await import("./setup-shutdown.js");
    return mod.setupShutdown;
  }

  // -------------------------------------------------------------------------
  // 1. Ordered teardown sequence
  // -------------------------------------------------------------------------

  it("executes ordered teardown in correct sequence", async () => {
    const cronScheduler = { stop: vi.fn() };
    const resetScheduler = { stop: vi.fn() };
    const browserService = { stop: vi.fn(async () => {}) };
    const channelManager = { stopAll: vi.fn(async () => {}) };
    const heartbeatRunner = { stop: vi.fn() } as any;
    const mediaTempManager = { stopCleanupInterval: vi.fn() } as any;
    const gatewayHandle = { stop: vi.fn(async () => {}) } as any;

    const deps = createMinimalDeps({
      cronSchedulers: new Map([["agent-1", cronScheduler as any]]),
      resetSchedulers: new Map([["agent-1", resetScheduler as any]]),
      browserServices: new Map([["agent-1", browserService as any]]),
      channelManager,
      heartbeatRunner,
      mediaTempManager,
      gatewayHandle,
      tokenTracker: {
        getAll: vi.fn(() => [
          { cost: { total: 0.05 }, tokens: { total: 500 } },
          { cost: { total: 0.10 }, tokens: { total: 1000 } },
        ]),
      } as any,
    });

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    expect(result.shutdownHandle).toBeDefined();

    // Invoke the captured onShutdown callback
    expect(capturedOnShutdown).not.toBeNull();
    await capturedOnShutdown!();

    // Verify cost summary logged (use closeTo for floating point)
    const summaryCall = (deps.daemonLogger.info as ReturnType<typeof vi.fn>).mock.calls
      .find((args: any[]) => args[1] === "Daemon session summary");
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0].totalExecutions).toBe(2);
    expect(summaryCall![0].totalCostUsd).toBeCloseTo(0.15);
    expect(summaryCall![0].totalTokens).toBe(1500);

    // Verify component shutdown order through shutdownOrder field
    const infoArgs = (deps.daemonLogger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: any[]) => args[0]?.shutdownOrder !== undefined)
      .map((args: any[]) => ({ component: args[0].component, order: args[0].shutdownOrder }));

    // Verify ordering is monotonically increasing
    for (let i = 1; i < infoArgs.length; i++) {
      expect(infoArgs[i].order).toBeGreaterThan(infoArgs[i - 1].order);
    }

    // Gateway must be the FIRST component stopped (quick-164)
    const gatewayEntry = infoArgs.find((e: any) => e.component === "gateway");
    expect(gatewayEntry).toBeDefined();
    const minOrder = Math.min(...infoArgs.map((e: any) => e.order));
    expect(gatewayEntry!.order).toBe(minOrder);

    // Verify key components were stopped
    expect(deps.subAgentRunner.shutdown).toHaveBeenCalled();
    expect(cronScheduler.stop).toHaveBeenCalled();
    expect(resetScheduler.stop).toHaveBeenCalled();
    expect(browserService.stop).toHaveBeenCalled();
    expect(channelManager.stopAll).toHaveBeenCalled();
    expect(heartbeatRunner.stop).toHaveBeenCalled();
    expect(mediaTempManager.stopCleanupInterval).toHaveBeenCalled();
    expect(gatewayHandle.stop).toHaveBeenCalled();
    expect(deps.diagnosticCollector.dispose).toHaveBeenCalled();
    expect(deps.channelActivityTracker.dispose).toHaveBeenCalled();
    expect(deps.deliveryTracer.dispose).toHaveBeenCalled();
    expect(deps.db.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Optional component handling
  // -------------------------------------------------------------------------

  it("handles missing optional deps without errors", async () => {
    const deps = createMinimalDeps({
      channelManager: undefined,
      heartbeatRunner: undefined,
      gatewayHandle: undefined,
      mediaTempManager: undefined,
      secretStore: undefined,
      approvalGate: undefined,
      auditAggregator: undefined,
      injectionRateLimiter: undefined,
      backgroundIndexingPromise: undefined,
      skillWatcherHandles: undefined,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    // Should complete without throwing
    await expect(capturedOnShutdown!()).resolves.toBeUndefined();

    // Required components still cleaned up
    expect(deps.subAgentRunner.shutdown).toHaveBeenCalled();
    expect(deps.diagnosticCollector.dispose).toHaveBeenCalled();
    expect(deps.channelActivityTracker.dispose).toHaveBeenCalled();
    expect(deps.deliveryTracer.dispose).toHaveBeenCalled();
    expect(deps.db.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. In-flight execution warning
  // -------------------------------------------------------------------------

  it("warns about in-flight executions during shutdown", async () => {
    const activeExecutions = new Map([
      ["exec-1", { agentId: "agent-1", startedAt: Date.now() - 5000 }],
      ["exec-2", { agentId: "agent-2", startedAt: Date.now() - 2000 }],
    ]);

    const deps = createMinimalDeps({ activeExecutions });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        activeCount: 2,
        hint: "These executions will be interrupted by shutdown",
        errorKind: "internal",
      }),
      "Interrupting in-flight agent executions",
    );
  });

  // -------------------------------------------------------------------------
  // 4. Approval gate disposal
  // -------------------------------------------------------------------------

  it("disposes approval gate when provided", async () => {
    const approvalGate = { dispose: vi.fn() } as any;
    const deps = createMinimalDeps({ approvalGate });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(approvalGate.dispose).toHaveBeenCalled();

    // Verify it logs with shutdownOrder
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "approval-gate" }),
      "Component stopped",
    );
  });

  // -------------------------------------------------------------------------
  // 5. Skill watcher cleanup
  // -------------------------------------------------------------------------

  it("closes all skill watcher handles during shutdown", async () => {
    const handle1 = { close: vi.fn(async () => {}) };
    const handle2 = { close: vi.fn(async () => {}) };
    const skillWatcherHandles = new Map([
      ["agent-1", handle1],
      ["agent-2", handle2],
    ]);

    const deps = createMinimalDeps({ skillWatcherHandles });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(handle1.close).toHaveBeenCalled();
    expect(handle2.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Background indexing promise
  // -------------------------------------------------------------------------

  it("waits for background indexing promise with timeout", async () => {
    let resolved = false;
    const backgroundIndexingPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50);
    });

    const deps = createMinimalDeps({ backgroundIndexingPromise });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    // The promise should have resolved (50ms < 5000ms timeout)
    expect(resolved).toBe(true);
    // DB close still called after
    expect(deps.db.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Secret store and audit/injection cleanup
  // -------------------------------------------------------------------------

  it("closes secret store, destroys audit aggregator and injection rate limiter", async () => {
    const secretStore = { close: vi.fn() } as any;
    const auditAggregator = { destroy: vi.fn() };
    const injectionRateLimiter = { destroy: vi.fn() };

    const deps = createMinimalDeps({ secretStore, auditAggregator, injectionRateLimiter });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(secretStore.close).toHaveBeenCalled();
    expect(auditAggregator.destroy).toHaveBeenCalled();
    expect(injectionRateLimiter.destroy).toHaveBeenCalled();

    // Verify ordering: secret store, audit aggregator, injection rate limiter all have shutdownOrder
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "secret-store" }),
      "Component stopped",
    );
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "audit-aggregator" }),
      "Component stopped",
    );
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "injection-rate-limiter" }),
      "Component stopped",
    );
  });

  // -------------------------------------------------------------------------
  // 8. SIGUSR2 handler
  // -------------------------------------------------------------------------

  it("registers SIGUSR2 handler that triggers shutdown", async () => {
    const deps = createMinimalDeps();

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);

    // Find the SIGUSR2 handler registration
    const sigusr1Call = processOnSpy.mock.calls.find(
      (call) => call[0] === "SIGUSR2",
    );
    expect(sigusr1Call).toBeDefined();

    // Invoke the handler
    const handler = sigusr1Call![1] as () => void;
    handler();

    expect(deps.daemonLogger.info).toHaveBeenCalledWith("SIGUSR2 received, initiating restart");
    expect(result.shutdownHandle.trigger).toHaveBeenCalledWith("SIGUSR2");
  });

  // -------------------------------------------------------------------------
  // 9. unhandledRejection handler
  // -------------------------------------------------------------------------

  it("registers unhandledRejection handler that logs error", async () => {
    const deps = createMinimalDeps();

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    // Find the unhandledRejection handler
    const rejectionCall = processOnSpy.mock.calls.find(
      (call) => call[0] === "unhandledRejection",
    );
    expect(rejectionCall).toBeDefined();

    // Invoke with an Error
    const handler = rejectionCall![1] as (reason: unknown) => void;
    const testError = new Error("test rejection");
    handler(testError);

    expect(deps.daemonLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: testError,
        hint: "Check stack trace for origin of unhandled promise",
        errorKind: "internal",
      }),
      "Unhandled promise rejection (non-fatal)",
    );
  });

  it("unhandledRejection handler converts non-Error reasons to string", async () => {
    const deps = createMinimalDeps();

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    const rejectionCall = processOnSpy.mock.calls.find(
      (call) => call[0] === "unhandledRejection",
    );
    const handler = rejectionCall![1] as (reason: unknown) => void;

    // Call with non-Error reason
    handler("string rejection reason");

    expect(deps.daemonLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "string rejection reason",
      }),
      "Unhandled promise rejection (non-fatal)",
    );
  });

  // -------------------------------------------------------------------------
  // 10. Browser stop failure is non-fatal
  // -------------------------------------------------------------------------

  it("continues shutdown when browser service stop fails", async () => {
    const failingBrowser = { stop: vi.fn(async () => { throw new Error("Chrome crashed"); }) };
    const channelManager = { stopAll: vi.fn(async () => {}) };

    const deps = createMinimalDeps({
      browserServices: new Map([["agent-1", failingBrowser as any]]),
      channelManager,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    // Should not throw despite browser failure
    await expect(capturedOnShutdown!()).resolves.toBeUndefined();

    // Subsequent components still stopped
    expect(channelManager.stopAll).toHaveBeenCalled();
    expect(deps.diagnosticCollector.dispose).toHaveBeenCalled();
    expect(deps.db.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11. Returns shutdownHandle
  // -------------------------------------------------------------------------

  it("returns shutdownHandle from _registerGracefulShutdown", async () => {
    const deps = createMinimalDeps();

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);

    expect(result).toHaveProperty("shutdownHandle");
    expect(result.shutdownHandle).toHaveProperty("trigger");
    expect(result.shutdownHandle).toHaveProperty("isShuttingDown");
  });

  // -------------------------------------------------------------------------
  // 12. DB close is last
  // -------------------------------------------------------------------------

  it("closes database as the last shutdown step", async () => {
    const secretStore = { close: vi.fn() } as any;
    const auditAggregator = { destroy: vi.fn() };
    const injectionRateLimiter = { destroy: vi.fn() };
    const gatewayHandle = { stop: vi.fn(async () => {}) } as any;

    const deps = createMinimalDeps({
      secretStore,
      auditAggregator,
      injectionRateLimiter,
      gatewayHandle,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    // The db.close shutdownOrder should be the highest
    const infoArgs = (deps.daemonLogger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: any[]) => args[0]?.shutdownOrder !== undefined);

    const dbEntry = infoArgs.find((args: any[]) => args[0].component === "memory-database");
    expect(dbEntry).toBeDefined();

    // Memory database should have the highest shutdownOrder
    const maxOrder = Math.max(...infoArgs.map((args: any[]) => args[0].shutdownOrder));
    expect(dbEntry![0].shutdownOrder).toBe(maxOrder);

    // Gateway should have the lowest shutdownOrder (quick-164)
    const gatewayEntry = infoArgs.find((args: any[]) => args[0].component === "gateway");
    expect(gatewayEntry).toBeDefined();
    const minOrder = Math.min(...infoArgs.map((args: any[]) => args[0].shutdownOrder));
    expect(gatewayEntry![0].shutdownOrder).toBe(minOrder);
  });

  // -------------------------------------------------------------------------
  // 13. Embedding cache disposal
  // -------------------------------------------------------------------------

  it("calls disposeEmbedding callback during shutdown when provided", async () => {
    const disposeEmbedding = vi.fn(async () => {});
    const deps = createMinimalDeps({ disposeEmbedding } as any);

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(disposeEmbedding).toHaveBeenCalledTimes(1);
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "embedding-cache" }),
      "Component stopped",
    );
  });

  it("handles shutdown when disposeEmbedding is undefined (no embedding provider)", async () => {
    const deps = createMinimalDeps({ disposeEmbedding: undefined } as any);

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    // Should not throw, db.close still called
    expect(deps.db.close).toHaveBeenCalled();
  });

  it("disposeEmbedding runs before db.close in shutdown sequence", async () => {
    const callOrder: string[] = [];
    const disposeEmbedding = vi.fn(async () => { callOrder.push("dispose"); });
    const db = { close: vi.fn(() => { callOrder.push("db.close"); }) };
    const deps = createMinimalDeps({ disposeEmbedding, db } as any);

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    const disposeIdx = callOrder.indexOf("dispose");
    const dbCloseIdx = callOrder.indexOf("db.close");
    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(dbCloseIdx).toBeGreaterThan(disposeIdx);
  });

  // -------------------------------------------------------------------------
  // 14. Empty activeExecutions does not warn
  // -------------------------------------------------------------------------

  it("does not warn when activeExecutions is empty", async () => {
    const deps = createMinimalDeps({
      activeExecutions: new Map(),
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 15. Gateway stops before all other components (quick-164)
  // -------------------------------------------------------------------------

  it("gateway stops before all other components", async () => {
    const callOrder: string[] = [];

    const gatewayHandle = { stop: vi.fn(async () => { callOrder.push("gateway"); }) } as any;
    const channelManager = { stopAll: vi.fn(async () => { callOrder.push("channel-manager"); }) };
    const subAgentRunner = { shutdown: vi.fn(async () => { callOrder.push("sub-agent-runner"); }) };
    const heartbeatRunner = { stop: vi.fn(() => { callOrder.push("heartbeat-runner"); }) } as any;

    const deps = createMinimalDeps({
      gatewayHandle,
      channelManager,
      subAgentRunner,
      heartbeatRunner,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);
    await capturedOnShutdown!();

    // Gateway must be the first component in the call order
    expect(callOrder[0]).toBe("gateway");
    // Other components come after
    expect(callOrder).toContain("sub-agent-runner");
    expect(callOrder).toContain("channel-manager");
    expect(callOrder).toContain("heartbeat-runner");
  });

  // -------------------------------------------------------------------------
  // 16. Per-step timeout: hung channel-manager (quick-164)
  // -------------------------------------------------------------------------

  it("per-step timeout allows shutdown to continue when a step hangs", async () => {
    // Channel manager returns a promise that never resolves
    const channelManager = { stopAll: vi.fn(() => new Promise<void>(() => {})) };

    const deps = createMinimalDeps({
      channelManager,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    // Shutdown should complete (not hang) -- the per-step timeout kicks in
    await capturedOnShutdown!();

    // DB close was still called (proving the sequence continued past the hung step)
    expect(deps.db.close).toHaveBeenCalled();

    // A warning was logged for the timed-out step
    expect(deps.daemonLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "channel-manager",
        errorKind: "timeout",
      }),
      "Shutdown step timed out or failed, continuing",
    );
  }, 15_000);

  // -------------------------------------------------------------------------
  // 17. Per-step timeout: hung gateway stop (quick-164)
  // -------------------------------------------------------------------------

  it("per-step timeout allows shutdown to continue when gateway stop hangs", async () => {
    // Gateway stop returns a promise that never resolves
    const gatewayHandle = { stop: vi.fn(() => new Promise<void>(() => {})) } as any;
    const subAgentRunner = { shutdown: vi.fn(async () => {}) };

    const deps = createMinimalDeps({
      gatewayHandle,
      subAgentRunner,
    });

    const setupShutdown = await getSetupShutdown();
    setupShutdown(deps);

    // Shutdown should complete (not hang)
    await capturedOnShutdown!();

    // Subsequent steps were still called
    expect(subAgentRunner.shutdown).toHaveBeenCalled();
    expect(deps.db.close).toHaveBeenCalled();

    // A warning was logged for the timed-out gateway step
    expect(deps.daemonLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "gateway",
        errorKind: "timeout",
      }),
      "Shutdown step timed out or failed, continuing",
    );
  }, 15_000);
});
