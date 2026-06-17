// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShutdownDeps } from "./setup-shutdown.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
//
// The previous test scaffolding captured the `onShutdown` callback via
// the `_registerGracefulShutdown` factory seam.
// After inlining, the seam is gone and tests drive teardown by calling
// `result.shutdownHandle.trigger("SIGTERM")` directly. The inlined
// `shutdown(signal)` does processMonitor.stop() → onShutdown() →
// container.shutdown() → logger.flush() → exitFn(0). Tests provide an
// `exitFn` mock that simply records the call (no throw).
// ---------------------------------------------------------------------------

function createMinimalDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    logger: createMockLogger() as any,
    daemonLogger: createMockLogger() as any,
    processMonitor: { start: vi.fn(), stop: vi.fn() } as any,
    container: { shutdown: vi.fn(async () => {}) } as any,
    exitFn: vi.fn(),
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
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    // The exit-code tests below set process.exitCode on the real (vitest) process;
    // reset so a SIGUSR2-shutdown test can't make the worker exit 42.
    process.exitCode = 0;
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

    // Drive the inlined shutdown body directly via the public handle
    // (factory seam removed).
    await result.shutdownHandle.trigger("SIGTERM");

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
    // 15s timeout (matches the per-step-timeout tests below): this is the
    // first and largest test in the file and drives the full real-timer
    // teardown chain across ~26 steps. Under the saturated parallel suite
    // the default 5s budget is CPU-starvation-flaky even though no step
    // actually hangs.
  }, 15_000);

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
    const result = setupShutdown(deps);

    // Should complete without throwing
    await expect(result.shutdownHandle.trigger("SIGTERM")).resolves.toBeUndefined();

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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

  it("WR-01: invokes destroyReactionWiring() on shutdown (cancels the reaction/session map + reaction limiter timers)", async () => {
    const destroyReactionWiring = vi.fn();
    const deps = createMinimalDeps({ destroyReactionWiring });

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    expect(destroyReactionWiring).toHaveBeenCalledTimes(1);
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "reaction-wiring" }),
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

    // Spy on the inlined trigger so the SIGUSR2 handler invocation is
    // observable (trigger is now the real shutdown fn, not a vi.fn()
    // returned by the dead factory seam). Override the
    // implementation to a no-op so the SIGUSR2 handler doesn't run the
    // full teardown chain during this unit test.
    const triggerSpy = vi
      .spyOn(result.shutdownHandle, "trigger")
      .mockImplementation(async () => {});

    // Invoke the handler
    const handler = sigusr1Call![1] as () => void;
    handler();

    expect(deps.daemonLogger.info).toHaveBeenCalledWith("SIGUSR2 received, initiating restart");
    expect(triggerSpy).toHaveBeenCalledWith("SIGUSR2");
  });

  // 8b. Exit code is set EARLY so it survives an event-loop drain during teardown.
  // FULL INCIDENT (UC-29 daemon-down regression, fresh-VPS run 2026-06-14): a SIGUSR2
  // config-change restart (triggered by `comis config apply` / token mutations) shut
  // down gracefully, but the event loop emptied during the (unref'd-timer) flush wait
  // BEFORE the explicit exitFnLocal() at the end ran — so the process exited NATURALLY
  // with code 0 instead of 42. systemd's RestartForceExitStatus=42 therefore never
  // fired and the daemon stayed DOWN after every config apply. Setting process.exitCode
  // up front (right after the re-entry guard) makes a natural drain-exit carry the right
  // code regardless of which exit path wins the race. A SIGUSR2 restart must exit 42
  // (→ systemd respawns); an operator SIGTERM must exit 0 (no respawn); the error/timeout
  // paths still call exitFnLocal(1), and an explicit process.exit(code) overrides exitCode.
  it("SIGUSR2 shutdown sets process.exitCode=42 (restart) so a drained exit still respawns", async () => {
    const deps = createMinimalDeps();
    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);

    await result.shutdownHandle.trigger("SIGUSR2");

    expect(process.exitCode).toBe(42);
    expect(deps.exitFn).toHaveBeenCalledWith(42);
  }, 15_000);

  it("SIGTERM shutdown sets process.exitCode=0 (operator stop, no respawn)", async () => {
    const deps = createMinimalDeps();
    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);

    await result.shutdownHandle.trigger("SIGTERM");

    expect(process.exitCode).toBe(0);
    expect(deps.exitFn).toHaveBeenCalledWith(0);
  }, 15_000);

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
    const result = setupShutdown(deps);

    // Should not throw despite browser failure
    await expect(result.shutdownHandle.trigger("SIGTERM")).resolves.toBeUndefined();

    // Subsequent components still stopped
    expect(channelManager.stopAll).toHaveBeenCalled();
    expect(deps.diagnosticCollector.dispose).toHaveBeenCalled();
    expect(deps.db.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11. Returns shutdownHandle
  // -------------------------------------------------------------------------

  it("returns a shutdownHandle with trigger and isShuttingDown surface", async () => {
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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    expect(disposeEmbedding).toHaveBeenCalledTimes(1);
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "embedding-cache" }),
      "Component stopped",
    );
  });

  it("handles shutdown when disposeEmbedding is undefined (no embedding provider)", async () => {
    const deps = createMinimalDeps({ disposeEmbedding: undefined } as any);

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    // Should not throw, db.close still called
    expect(deps.db.close).toHaveBeenCalled();
  });

  it("disposeEmbedding runs before db.close in shutdown sequence", async () => {
    const callOrder: string[] = [];
    const disposeEmbedding = vi.fn(async () => { callOrder.push("dispose"); });
    const db = { close: vi.fn(() => { callOrder.push("db.close"); }) };
    const deps = createMinimalDeps({ disposeEmbedding, db } as any);

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    const disposeIdx = callOrder.indexOf("dispose");
    const dbCloseIdx = callOrder.indexOf("db.close");
    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(dbCloseIdx).toBeGreaterThan(disposeIdx);
  });

  // The reranker dispose step must log durationMs like every sibling step.
  it("disposes the reranker and logs durationMs for observability parity", async () => {
    const disposeReranker = vi.fn(async () => {});
    const deps = createMinimalDeps({ disposeReranker } as any);

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    expect(disposeReranker).toHaveBeenCalledTimes(1);
    expect(deps.daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "reranker",
        durationMs: expect.any(Number),
      }),
      "Component stopped",
    );
  });

  // -------------------------------------------------------------------------
  // 14. Empty activeExecutions does not warn
  // -------------------------------------------------------------------------

  it("does not warn when activeExecutions is empty", async () => {
    const deps = createMinimalDeps({
      activeExecutions: new Map(),
    });

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);

    // Shutdown should complete (not hang) -- the per-step timeout kicks in
    await result.shutdownHandle.trigger("SIGTERM");

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
    const result = setupShutdown(deps);

    // Shutdown should complete (not hang)
    await result.shutdownHandle.trigger("SIGTERM");

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

  // -------------------------------------------------------------------------
  // 18. Per-step timer does not leak on the fast path
  // -------------------------------------------------------------------------

  it("clears each per-step timer when the step resolves fast (no timer leak)", async () => {
    // withStepTimeout races the step against a STEP_TIMEOUT_MS timer. When
    // the step wins (the common case), the timer must be cleared — otherwise
    // every teardown leaks ~one 5s timer per step. Drive a fast shutdown
    // under fake timers and assert nothing remains pending afterward.
    vi.useFakeTimers();
    try {
      const deps = createMinimalDeps({
        gatewayHandle: { stop: vi.fn(async () => {}) } as any,
        channelManager: { stopAll: vi.fn(async () => {}) },
        heartbeatRunner: { stop: vi.fn() } as any,
        cronSchedulers: new Map([["agent-1", { stop: vi.fn() } as any]]),
        browserServices: new Map([["agent-1", { stop: vi.fn(async () => {}) } as any]]),
      });

      const setupShutdown = await getSetupShutdown();
      const result = setupShutdown(deps);
      await result.shutdownHandle.trigger("SIGTERM");

      // Every per-step timer plus the hard-timeout must have been cleared.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Mode-invariant tests (tmpdir-scoped, real fs).
//
// The two writeFileSync sites in setup-shutdown
// (restart-approvals.json + restart-approval-cache.json) MUST produce
// files at mode `0o600` post-migration. These tests drive the actual
// onShutdown callback against a real tmpdir with a `dataDir`,
// asserting both artifacts land at the §1.4 invariant.
// ---------------------------------------------------------------------------

describe("setup-shutdown honors §1.4 mode invariants", () => {
  let baseDir: string;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "comis-setup-shutdown-mode-"));
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    rmSync(baseDir, { recursive: true, force: true });
  });

  async function getSetupShutdown() {
    const mod = await import("./setup-shutdown.js");
    return mod.setupShutdown;
  }

  function buildDeps(): ShutdownDeps {
    const approvalGate = {
      serializePending: vi.fn(() => [{ id: "ap-1", status: "pending" }]),
      serializeApprovalCache: vi.fn(() => [{ id: "cache-1", until: 0 }]),
      dispose: vi.fn(),
    } as any;
    return {
      logger: createMockLogger() as any,
      daemonLogger: createMockLogger() as any,
      processMonitor: { start: vi.fn(), stop: vi.fn() } as any,
      container: { shutdown: vi.fn(async () => {}) } as any,
      exitFn: vi.fn(),
      subAgentRunner: { shutdown: vi.fn(async () => {}) },
      cronSchedulers: new Map(),
      resetSchedulers: new Map(),
      browserServices: new Map(),
      tokenTracker: {
        getAll: vi.fn(() => []),
      } as any,
      startupTimestamp: Date.now() - 10_000,
      diagnosticCollector: { dispose: vi.fn() } as any,
      channelActivityTracker: { dispose: vi.fn() } as any,
      deliveryTracer: { dispose: vi.fn() } as any,
      db: { close: vi.fn(), pragma: vi.fn() },
      dataDir: baseDir,
      approvalGate,
    };
  }

  it("writes_restart_approvals_with_mode_0o600", async () => {
    const deps = buildDeps();
    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    const filePath = join(baseDir, "restart-approvals.json");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("writes_restart_approval_cache_with_mode_0o600", async () => {
    const deps = buildDeps();
    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    const filePath = join(baseDir, "restart-approval-cache.json");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Regression: brokerStop must run AFTER shutdownBackgroundProcesses drains.
//
// The bug: setup-shutdown.ts stopped the broker (brokerStop) before draining
// background exec processes (shutdownBackgroundProcesses). Any live exec using
// the broker proxy (HTTPS_PROXY → broker TCP port) had its connections cut
// while still running. Fix: reverse the order.
// ---------------------------------------------------------------------------

describe("brokerStop runs after shutdownBackgroundProcesses (shutdown ordering)", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  async function getSetupShutdown() {
    const mod = await import("./setup-shutdown.js");
    return mod.setupShutdown;
  }

  function createCr03Deps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
    return {
      logger: createMockLogger() as any,
      daemonLogger: createMockLogger() as any,
      processMonitor: { start: vi.fn(), stop: vi.fn() } as any,
      container: { shutdown: vi.fn(async () => {}) } as any,
      exitFn: vi.fn(),
      subAgentRunner: { shutdown: vi.fn(async () => {}) },
      cronSchedulers: new Map(),
      resetSchedulers: new Map(),
      browserServices: new Map(),
      tokenTracker: { getAll: vi.fn(() => []) } as any,
      startupTimestamp: Date.now() - 1_000,
      diagnosticCollector: { dispose: vi.fn() } as any,
      channelActivityTracker: { dispose: vi.fn() } as any,
      deliveryTracer: { dispose: vi.fn() } as any,
      db: { close: vi.fn() },
      ...overrides,
    };
  }

  it("brokerStop runs after shutdownBackgroundProcesses (exec processes drain before broker closes)", async () => {
    const callOrder: string[] = [];

    const shutdownBackgroundProcesses = vi.fn(async () => {
      callOrder.push("shutdownBackgroundProcesses");
    });
    const brokerStop = vi.fn(async () => {
      callOrder.push("brokerStop");
    });

    const deps = createCr03Deps({ shutdownBackgroundProcesses, brokerStop });

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    expect(shutdownBackgroundProcesses).toHaveBeenCalled();
    expect(brokerStop).toHaveBeenCalled();

    const bgIdx = callOrder.indexOf("shutdownBackgroundProcesses");
    const brokerIdx = callOrder.indexOf("brokerStop");

    // CORRECT ordering: background processes drained BEFORE broker closes
    expect(bgIdx).toBeGreaterThanOrEqual(0);
    expect(brokerIdx).toBeGreaterThanOrEqual(0);
    expect(brokerIdx).toBeGreaterThan(bgIdx);
  });

  it("brokerStop shutdownOrder value is greater than shutdownBackgroundProcesses shutdownOrder", async () => {
    const brokerStop = vi.fn(async () => {});
    const shutdownBackgroundProcesses = vi.fn(async () => {});

    const deps = createCr03Deps({ brokerStop, shutdownBackgroundProcesses });

    const setupShutdown = await getSetupShutdown();
    const result = setupShutdown(deps);
    await result.shutdownHandle.trigger("SIGTERM");

    const infoArgs = (deps.daemonLogger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: any[]) => args[0]?.shutdownOrder !== undefined && args[0]?.component);

    const bgEntry = infoArgs.find((args: any[]) => args[0].component === "background-processes");
    const brokerEntry = infoArgs.find((args: any[]) => args[0].component === "broker");

    expect(bgEntry).toBeDefined();
    expect(brokerEntry).toBeDefined();

    // brokerStop shutdownOrder must be higher than background-processes shutdownOrder
    expect(brokerEntry![0].shutdownOrder).toBeGreaterThan(bgEntry![0].shutdownOrder);
  });

  // -------------------------------------------------------------------------
  // Data-dir singleton lock release (D14) — acquire/release path symmetry
  // -------------------------------------------------------------------------
  //
  // The lock is acquired at boot on the env-resolved dataDir
  // (COMIS_DATA_DIR ?? ~/.comis, daemon.ts) BEFORE config bootstrap. The
  // `dataDir` dep here, however, is the config-resolved value
  // (`container.config.dataDir || dataDir`), and core's resolveConfigPaths
  // defaults an empty config.dataDir to ~/.comis WITHOUT consulting
  // COMIS_DATA_DIR. So whenever COMIS_DATA_DIR points elsewhere, releasing at
  // `dataDir` unlinks the wrong directory and the real lock leaks — every
  // in-process restart (integration harness) then dies with EEXIST because
  // the lock's PID (the test process itself) is still alive, and a crashed
  // production daemon leaves a stale lock until PID-liveness recovery.
  // The dedicated `lockDataDir` dep carries the boot dataDir so release is
  // symmetric with acquire.

  it("releases the data-dir lock at the boot dataDir (lockDataDir), not the config-resolved dataDir", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "shutdown-configdir-"));
    const bootDir = mkdtempSync(join(tmpdir(), "shutdown-bootdir-"));
    const { writeFileSync, existsSync } = await import("node:fs");
    try {
      // A lock in each dir: the boot-dir lock is the daemon's own (acquired
      // at boot); the config-dir lock belongs to a hypothetical other daemon
      // whose dataDir config points there — not ours to release.
      writeFileSync(join(bootDir, ".daemon.lock"), String(process.pid));
      writeFileSync(join(configDir, ".daemon.lock"), "99999");

      const deps = createMinimalDeps({
        dataDir: configDir,
        lockDataDir: bootDir,
      } as Partial<ShutdownDeps>);

      const setupShutdown = await getSetupShutdown();
      const result = setupShutdown(deps);
      await result.shutdownHandle.trigger("SIGTERM");

      expect(existsSync(join(bootDir, ".daemon.lock")), "boot-dir lock must be released").toBe(false);
      expect(existsSync(join(configDir, ".daemon.lock")), "config-dir lock is not ours to release").toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(bootDir, { recursive: true, force: true });
    }
  });
});
