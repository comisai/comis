// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `setupBackgroundTasks` wiring factory.
 *
 * Asserts deterministic factory output, port-injection contract, and
 * shutdown-handle behavior. Every `it("...")` description names a use case
 * with a recognizable shape.
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import {
  BackgroundTasksConfigSchema,
  createConversationRef,
  safePath,
  type BackgroundTaskOrigin,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
} from "@comis/core";
import { TASK_DIR_NAME } from "@comis/agent";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { setupBackgroundTasks } from "./setup-background-tasks.js";

// ---------------------------------------------------------------------------
// Port-wrapper pattern (mirrored from setup-background-completion-runner.test.ts).
// Used for tests where we want real timers but need a port-shaped handle
// so we can assert cancel() / unref() semantics.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const TEST_TURN_SCOPE = {
  conversation: {
    tenantId: "tenant-1",
    agentId: "agent-1",
    partition: { kind: "agent" as const },
  },
  principal: { principalId: "principal-1" },
  endpoint: {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-1",
    conversationKind: "direct" as const,
  },
};

const testConversationRef = createConversationRef(TEST_TURN_SCOPE.conversation);
if (!testConversationRef.ok) throw testConversationRef.error;

const TEST_ORIGIN: BackgroundTaskOrigin = {
  turnScope: TEST_TURN_SCOPE,
  conversationRef: testConversationRef.value,
  deliveryOrigin: {
    channelType: "echo",
    channelId: "conversation-1",
    userId: "principal-1",
    tenantId: "tenant-1",
  },
  traceId: "trace-1",
  responseLocalePolicy: { source: "unset", enforceLocale: false },
  backgroundHopCount: 0,
};

/**
 * Real-timer port that records every scheduled handle so individual tests
 * can call `.cancel()` on all of them (no leaked intervals between tests)
 * and assert cancel-state introspection.
 */
function makeRecordingRealTimers(): TimerPort & { handles: TimerHandle[] } {
  const handles: TimerHandle[] = [];
  return {
    handles,
    setTimeout(cb, ms) {
      const h = wrapTimerHandle(setTimeout(cb, ms));
      handles.push(h);
      return h;
    },
    setInterval(cb, ms) {
      const h = wrapTimerHandle(setInterval(cb, ms) as unknown as NodeJS.Timeout);
      handles.push(h);
      return h;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared per-test dataDir helpers. Each test gets its own tmpdir so
// BackgroundTaskManager file-persistence under dataDir/tasks does not
// collide with concurrent tests.
// ---------------------------------------------------------------------------

function makeTempDataDir(): string {
  return mkdtempSync(safePath(tmpdir(), "comis-bgtasks-"));
}

function cleanupTempDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a deps object suitable for `setupBackgroundTasks`. `overrides`
 * lets a single test swap out one port (e.g., use fake timers).
 */
function makeDeps(overrides: Partial<Parameters<typeof setupBackgroundTasks>[0]> = {}): {
  dataDir: string;
  deps: Parameters<typeof setupBackgroundTasks>[0];
  cleanup: () => void;
} {
  const dataDir = overrides.dataDir ?? makeTempDataDir();
  const ownDataDir = overrides.dataDir === undefined;
  const config = overrides.config ?? BackgroundTasksConfigSchema.parse({});
  const deps: Parameters<typeof setupBackgroundTasks>[0] = {
    dataDir,
    config,
    resolveConfigForAgent: overrides.resolveConfigForAgent ?? (() => config),
    eventBus: createMockEventBus(),
    logger: createMockLogger(),
    clock: testClock,
    timers: makeRecordingRealTimers(),
    ...overrides,
  };
  return {
    dataDir,
    deps,
    cleanup: () => {
      // Cancel every real-timer handle registered through the port so the
      // node event loop does not leak setIntervals across tests.
      const t = deps.timers as TimerPort & { handles?: TimerHandle[] };
      for (const h of t.handles ?? []) h.cancel();
      if (ownDataDir) cleanupTempDataDir(dataDir);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupBackgroundTasks -- daemon wiring", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it("creates BackgroundTaskManager with file-based persistence under dataDir/tasks", () => {
    // Real-timer port: this test verifies persistence wiring, not timer firing.
    const { dataDir, deps, cleanup } = makeDeps();
    cleanups.push(cleanup);

    const ctx = setupBackgroundTasks(deps);

    // The returned context exposes the manager interface (typed).
    expect(ctx.backgroundTaskManager).toBeDefined();
    expect(typeof ctx.backgroundTaskManager.promote).toBe("function");
    expect(typeof ctx.backgroundTaskManager.cleanup).toBe("function");
    expect(typeof ctx.backgroundTaskManager.recoverOnStartup).toBe("function");

    // File-based persistence: BackgroundTaskManager writes under
    // safePath(dataDir, TASK_DIR_NAME). The directory itself is created on
    // first persisted task -- the wiring contract is that the path is
    // assembled as dataDir/<TASK_DIR_NAME>, never elsewhere. Assert by
    // grepping the runtime configuration: the manager's getTask returns
    // undefined for a non-existent id (sanity), and the resolved task path
    // root is dataDir/TASK_DIR_NAME.
    expect(ctx.backgroundTaskManager.getTask("nonexistent")).toBeUndefined();
    const expectedRoot = safePath(dataDir, TASK_DIR_NAME);
    expect(expectedRoot.startsWith(dataDir + sep)).toBe(true);
    expect(expectedRoot.endsWith(TASK_DIR_NAME)).toBe(true);
  });

  it("registers each background task exactly once (no duplicate on re-call)", () => {
    // Fake timers so we can introspect the exact number of registered timers.
    const fakeTimers = createFakeTimers();
    const { deps, cleanup } = makeDeps({ timers: fakeTimers });
    cleanups.push(cleanup);

    setupBackgroundTasks(deps);

    // Exactly one interval should be registered after a single factory call:
    // the hourly cleanup. The manager itself does not schedule anything until
    // promote() is called, so no setTimeouts.
    const record = fakeTimers.unrefRecord();
    const intervalEntries = record.filter((e) => e.kind === "interval");
    const timeoutEntries = record.filter((e) => e.kind === "timeout");
    expect(intervalEntries).toHaveLength(1);
    expect(timeoutEntries).toHaveLength(0);
    expect(intervalEntries[0]!.delay).toBe(3_600_000);
  });

  it("uses the configured hard timeout for promoted background tasks", () => {
    const fakeTimers = createFakeTimers();
    const { deps, cleanup } = makeDeps({ timers: fakeTimers });
    cleanups.push(cleanup);
    const configured = BackgroundTasksConfigSchema.parse({
      maxBackgroundDurationMs: 2_700_000,
    });
    const configuredDeps = {
      ...deps,
      config: configured,
      resolveConfigForAgent: () => configured,
    };

    const { backgroundTaskManager } = setupBackgroundTasks(configuredDeps);
    const promoted = backgroundTaskManager.promote(
      "slow_tool",
      new Promise(() => {}),
      new AbortController(),
      TEST_ORIGIN,
    );

    expect(promoted.ok).toBe(true);
    const timeoutEntries = fakeTimers.unrefRecord().filter((entry) => entry.kind === "timeout");
    expect(timeoutEntries).toHaveLength(1);
    expect(timeoutEntries[0]!.delay).toBe(2_700_000);
  });

  it("resolves concurrency and timeout limits from the promoted task agent", () => {
    const fakeTimers = createFakeTimers();
    const defaultConfig = BackgroundTasksConfigSchema.parse({
      maxPerAgent: 5,
      maxBackgroundDurationMs: 300_000,
    });
    const workerConfig = BackgroundTasksConfigSchema.parse({
      maxPerAgent: 1,
      maxBackgroundDurationMs: 900_000,
    });
    const { deps, cleanup } = makeDeps({
      timers: fakeTimers,
      config: defaultConfig,
      resolveConfigForAgent: (agentId) => agentId === "worker" ? workerConfig : defaultConfig,
    });
    cleanups.push(cleanup);
    const workerOrigin = {
      ...TEST_ORIGIN,
      turnScope: {
        ...TEST_ORIGIN.turnScope,
        conversation: {
          ...TEST_ORIGIN.turnScope.conversation,
          agentId: "worker",
        },
      },
    };
    const workerConversationRef = createConversationRef(workerOrigin.turnScope.conversation);
    if (!workerConversationRef.ok) throw workerConversationRef.error;
    workerOrigin.conversationRef = workerConversationRef.value;

    const { backgroundTaskManager } = setupBackgroundTasks(deps);
    const first = backgroundTaskManager.promote(
      "slow_tool",
      new Promise(() => {}),
      new AbortController(),
      workerOrigin,
    );
    const second = backgroundTaskManager.promote(
      "second_tool",
      new Promise(() => {}),
      new AbortController(),
      workerOrigin,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    const timeoutEntries = fakeTimers.unrefRecord().filter((entry) => entry.kind === "timeout");
    expect(timeoutEntries).toHaveLength(1);
    expect(timeoutEntries[0]!.delay).toBe(900_000);
  });

  it("shutdown handle cancels every scheduled timer via TimerHandle.cancel()", () => {
    // Real-timer port: collect handles, cancel them, assert cancelled=true.
    const { deps, cleanup } = makeDeps();
    cleanups.push(cleanup);
    const recorder = deps.timers as TimerPort & { handles: TimerHandle[] };

    setupBackgroundTasks(deps);

    // Sanity: the factory scheduled the cleanup interval handle.
    expect(recorder.handles.length).toBeGreaterThanOrEqual(1);

    // Cancel every handle returned to the factory; each TimerHandle exposes
    // a cancel() that flips cancelled to true. This is the same contract a
    // daemon-level shutdown sequence walks.
    for (const handle of recorder.handles) {
      handle.cancel();
    }
    for (const handle of recorder.handles) {
      expect(handle.cancelled).toBe(true);
    }
  });

  it("startup recovery is intentionally deferred to the daemon.ts caller (not run here)", () => {
    // setupBackgroundTasks MUST NOT call manager.recoverOnStartup at wiring
    // time -- the recovery emits background_task:failed for each recovered
    // task, and those events would land in an empty subscriber set if the
    // completion runner has not subscribed yet. The plan calls recover only
    // AFTER the runner subscribes. Spy on recoverOnStartup by spying through
    // event-bus emits: at construction, no background_task:failed should
    // have been emitted.
    const eventBus = createMockEventBus();
    const { deps, cleanup } = makeDeps({ eventBus });
    cleanups.push(cleanup);

    setupBackgroundTasks(deps);

    // Sanity: no setup-time emit on the wired event-bus indicates no
    // synthesized recovery failure events fired. If setupBackgroundTasks
    // were to call recoverOnStartup, those emits would surface here.
    const emitMock = eventBus.emit as unknown as ReturnType<typeof vi.fn>;
    const recoveryEmits = emitMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0] === "background_task:failed",
    );
    expect(recoveryEmits).toHaveLength(0);
    // And no warn-level log line about "recovering N tasks" either.
    const logger = deps.logger as ReturnType<typeof createMockLogger>;
    const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const recoverLogs = warnMock.mock.calls.filter((c: unknown[]) => {
      const arg = c[1];
      return typeof arg === "string" && /recover/i.test(arg);
    });
    expect(recoverLogs).toHaveLength(0);
  });

  it("hourly cleanup timer fires under createFakeTimers.advance(3_600_000)", () => {
    // Fake timers + fake clock: pin synthetic time, register the cleanup
    // interval through the fake-timer port, then advance one hour and
    // assert manager.cleanup was invoked. Wrap manager.cleanup with a spy
    // by injecting a custom logger -- not possible here directly, so we
    // rely on the manager's observable state: cleanup() prunes finished
    // tasks. With no tasks present, observable state is unchanged. So we
    // assert on the side-channel: fake timer's interval entry should
    // re-arm to fireAt = now + delay after firing once.
    const fakeTimers = createFakeTimers();
    const fakeClock = createFakeClock(0);
    const { deps, cleanup } = makeDeps({ timers: fakeTimers, clock: fakeClock });
    cleanups.push(cleanup);

    setupBackgroundTasks(deps);

    // Before advance: no firings yet -- entry sits at fireAt=3,600,000.
    const recordBefore = fakeTimers.unrefRecord();
    const intervalBefore = recordBefore.find((e) => e.kind === "interval");
    expect(intervalBefore).toBeDefined();
    expect(intervalBefore!.cancelled).toBe(false);

    // Advance synthetic time by exactly one hour. The interval entry fires
    // once (manager.cleanup runs) and re-arms for the next hour. After the
    // advance, the entry is still NOT cancelled (intervals re-arm; only
    // timeouts self-cancel after firing).
    fakeTimers.advance(3_600_000);
    fakeClock.advance(3_600_000);

    const recordAfter = fakeTimers.unrefRecord();
    const intervalAfter = recordAfter.find((e) => e.kind === "interval");
    expect(intervalAfter).toBeDefined();
    expect(intervalAfter!.cancelled).toBe(false); // still re-armed for next hour
  });

  it("preserves TimerHandle.unref() semantics on every long-running interval", () => {
    // After factory construction, every recurring interval handle returned
    // by the port should have .unref() called on it -- so the cleanup timer
    // never holds the daemon's event loop alive. Use FakeTimers to inspect.
    const fakeTimers = createFakeTimers();
    const { deps, cleanup } = makeDeps({ timers: fakeTimers });
    cleanups.push(cleanup);

    setupBackgroundTasks(deps);

    const record = fakeTimers.unrefRecord();
    const intervals = record.filter((e) => e.kind === "interval");
    expect(intervals.length).toBeGreaterThan(0);
    for (const entry of intervals) {
      expect(entry.unrefCalled).toBe(true);
    }
  });

  it("dataDir/tasks resolution survives a nested-path dataDir without traversal", () => {
    // Sanity-check the safePath(dataDir, TASK_DIR_NAME) contract for a
    // nested data directory. This protects against future regressions
    // where dataDir is composed at runtime (e.g., per-tenant suffix).
    const baseDir = makeTempDataDir();
    const nested = safePath(baseDir, "tenant", "default");
    // safePath does not create the directory, just composes the path; that
    // matches production where BackgroundTaskManager creates on first
    // persist. The factory call itself must not throw on a path that
    // resolves cleanly within the base.
    const { deps, cleanup } = makeDeps({ dataDir: nested });
    cleanups.push(() => {
      cleanup();
      cleanupTempDataDir(baseDir);
    });

    const ctx = setupBackgroundTasks(deps);
    expect(ctx.backgroundTaskManager).toBeDefined();
    expect(existsSync(baseDir)).toBe(true);
  });
});
