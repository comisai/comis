// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createConversationRef, safePath, TypedEventBus } from "@comis/core";
import { err, ok } from "@comis/shared";
import { createBackgroundTaskManager, type BackgroundTaskManager } from "./background-task-manager.js";
import { loadTask, persistTaskSync } from "./background-task-persistence.js";
import type { BackgroundTaskOrigin, PersistedTaskState } from "./background-task-types.js";
import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals so vi.useFakeTimers()
// continues to intercept Date.now / setTimeout below.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
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

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

function createMockEventBus() {
  const emit = vi.fn();
  return {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => {
      emit(event, payload);
      return { hadListeners: false, failures: [], pendingFailures: Promise.resolve([]) };
    }),
  } as unknown as import("@comis/core").TypedEventBus;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> & { agentId?: string; sessionKey?: string } = {}): BackgroundTaskOrigin {
  const agentId = overrides.agentId ?? "default";
  const tenantId = overrides.sessionKey?.split(":")[0] ?? "default";
  const endpoint = { channelType: "echo", channelInstanceId: "test-instance", conversationId: "test", conversationKind: "direct" as const };
  const turnScope = {
    conversation: { tenantId, agentId, partition: { kind: "endpoint-conversation-principal" as const, endpoint, principalId: "user1" } },
    principal: { principalId: "user1" },
    endpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType: "echo", channelId: "test", userId: "user1", tenantId },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "agentId" && key !== "sessionKey")),
  };
}

describe("BackgroundTaskManager", () => {
  let dataDir: string;
  let manager: BackgroundTaskManager;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    dataDir = safePath(tmpdir(), `comis-bg-mgr-test-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    eventBus = createMockEventBus();
    logger = createMockLogger();
    manager = createBackgroundTaskManager({
      dataDir,
      eventBus,
      logger,
      clock: testClock,
      timers: testTimers,
      maxPerAgent: 2,
      maxTotal: 3,
      maxBackgroundDurationMs: 100, // 100ms for testing
    });
  });

  afterEach(() => {
    // Clean up any timers set by the manager
    for (const task of manager.getAllTasks()) {
      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("promote", () => {
    it("creates a task with status running and increments counters", () => {
      const promise = new Promise(() => {});
      const ac = new AbortController();
      const result = manager.promote("exec_command", promise, ac, buildOrigin({ agentId: "agent-1" }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const task = manager.getTask(result.value);
      expect(task).toBeDefined();
      expect(task!.status).toBe("running");
      expect(task!.origin.turnScope.conversation.agentId).toBe("agent-1");
      expect(task!.toolName).toBe("exec_command");
    });

    it("emits background_task:promoted event", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      expect(result.ok).toBe(true);
      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:promoted",
        expect.objectContaining({ agentId: "agent-1", toolName: "tool" }),
      );
    });

    it("rejects when per-agent limit reached", () => {
      const origin = buildOrigin({ agentId: "agent-1" });
      manager.promote("t1", new Promise(() => {}), new AbortController(), origin);
      manager.promote("t2", new Promise(() => {}), new AbortController(), origin);
      const result = manager.promote("t3", new Promise(() => {}), new AbortController(), origin);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("Concurrency limit exceeded");
      expect(result.error.message).toContain("agent-1");
    });

    it("rejects when total limit reached", () => {
      manager.promote("t1", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a1" }));
      manager.promote("t2", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a2" }));
      manager.promote("t3", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a3" }));
      const result = manager.promote("t4", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a4" }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("total");
    });

    it("rejects admission when the protected task record cannot commit", () => {
      const blockedDataDir = safePath(dataDir, "blocked");
      writeFileSync(blockedDataDir, "not-a-directory");
      const blockedManager = createBackgroundTaskManager({
        dataDir: blockedDataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: testTimers,
      });

      const promoted = blockedManager.promote(
        "tool",
        new Promise(() => {}),
        new AbortController(),
        buildOrigin({ agentId: "agent-1" }),
      );

      expect(promoted.ok).toBe(false);
      expect(blockedManager.getAllTasks()).toHaveLength(0);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        "background_task:promoted",
        expect.anything(),
      );
    });
  });

  describe("complete", () => {
    it("sets status completed with truncated result and decrements counters", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const taskId = result.value;

      manager.complete(taskId, { data: "hello" });

      const task = manager.getTask(taskId);
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe('{"data":"hello"}');
      expect(task!.completedAt).toBeGreaterThan(0);

      // Counter decremented: can promote again
      const newResult = manager.promote("t2", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      expect(newResult.ok).toBe(true);
    });

    it("emits background_task:completed event", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;
      manager.complete(result.value, "done");

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:completed",
        expect.objectContaining({ agentId: "agent-1", toolName: "tool" }),
      );
    });

    it("retains running ownership when terminal persistence fails", () => {
      const result = manager.promote(
        "tool",
        new Promise(() => {}),
        new AbortController(),
        buildOrigin({ agentId: "agent-1" }),
      );
      if (!result.ok) return;
      const agentDir = safePath(dataDir, "agent-1");
      rmSync(agentDir, { recursive: true, force: true });
      writeFileSync(agentDir, "not-a-directory");

      const completed = manager.complete(result.value, "done");

      expect(completed.ok).toBe(false);
      expect(manager.getTask(result.value)?.status).toBe("running");
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        "background_task:completed",
        expect.objectContaining({ taskId: result.value }),
      );
    });
  });

  describe("waitForTask", () => {
    it("waits for the original promoted promise and returns its completed task", async () => {
      let resolveTask: ((value: { data: string }) => void) | undefined;
      const promise = new Promise<{ data: string }>((resolve) => {
        resolveTask = resolve;
      });
      const promoted = manager.promote(
        "tool",
        promise,
        new AbortController(),
        buildOrigin({ agentId: "agent-1" }),
      );
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) return;

      const waiting = manager.waitForTask(promoted.value);
      resolveTask?.({ data: "arrived" });
      const result = await waiting;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("completed");
      expect(result.value.result).toBe('{"data":"arrived"}');
      expect(manager.getTask(promoted.value)?.status).toBe("completed");
      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:completed",
        expect.objectContaining({ taskId: promoted.value, toolName: "tool" }),
      );
    });

    it("reports periodic wait progress and clears the heartbeat after settlement", async () => {
      let resolveTask: ((value: string) => void) | undefined;
      let intervalCallback: (() => void) | undefined;
      const cancelInterval = vi.fn();
      const controlledTimers: TimerPort = {
        setTimeout: vi.fn(() => ({
          cancelled: false,
          cancel: vi.fn(),
          unref: vi.fn(),
        })),
        setInterval: vi.fn((callback) => {
          intervalCallback = callback;
          return {
            cancelled: false,
            cancel: cancelInterval,
            unref: vi.fn(),
          };
        }),
      };
      const controlledManager = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: controlledTimers,
        maxBackgroundDurationMs: 300_000,
      });
      const promise = new Promise<string>((resolve) => {
        resolveTask = resolve;
      });
      const promoted = controlledManager.promote(
        "slow_report",
        promise,
        new AbortController(),
        buildOrigin({ agentId: "agent-1" }),
      );
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) return;

      const onWaiting = vi.fn();
      const waitWithProgress = controlledManager.waitForTask as unknown as (
        taskId: string,
        progress: () => void,
        intervalMs: number,
      ) => ReturnType<BackgroundTaskManager["waitForTask"]>;
      const waiting = waitWithProgress(promoted.value, onWaiting, 60_000);

      expect(controlledTimers.setInterval).toHaveBeenCalledWith(expect.any(Function), 60_000);
      intervalCallback?.();
      expect(onWaiting).toHaveBeenCalledTimes(1);

      resolveTask?.("arrived");
      const result = await waiting;

      expect(result.ok).toBe(true);
      expect(cancelInterval).toHaveBeenCalledTimes(1);
    });

    it("returns after hard timeout when the provider ignores abort", async () => {
      let hardTimeout: (() => void) | undefined;
      const cancelHeartbeat = vi.fn();
      const controlledManager = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: {
          setTimeout: vi.fn((callback) => {
            hardTimeout = callback;
            return { cancelled: false, cancel: vi.fn(), unref: vi.fn() };
          }),
          setInterval: vi.fn(() => ({
            cancelled: false,
            cancel: cancelHeartbeat,
            unref: vi.fn(),
          })),
        },
        maxBackgroundDurationMs: 1_000,
      });
      const promoted = controlledManager.promote(
        "abort_insensitive",
        new Promise(() => undefined),
        new AbortController(),
        buildOrigin({ agentId: "agent-1" }),
      );
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) return;
      const waiting = controlledManager.waitForTask(promoted.value, vi.fn(), 100);
      hardTimeout?.();
      const result = await waiting;
      expect(result).toMatchObject({ ok: true, value: { status: "failed", error: "Hard timeout exceeded" } });
      expect(cancelHeartbeat).toHaveBeenCalledOnce();
    });
  });

  describe("fail", () => {
    it("sets status failed with error message and decrements counters", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;
      const taskId = result.value;

      manager.fail(taskId, new Error("oops"));

      const task = manager.getTask(taskId);
      expect(task!.status).toBe("failed");
      expect(task!.error).toBe("oops");

      // Counter decremented
      const r2 = manager.promote("t2", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      expect(r2.ok).toBe(true);
    });

    it("emits background_task:failed event", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;
      manager.fail(result.value, "error");

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:failed",
        expect.objectContaining({ agentId: "agent-1", error: "error" }),
      );
    });
  });

  describe("cancel", () => {
    it("aborts the AbortController and sets status cancelled", () => {
      const ac = new AbortController();
      const result = manager.promote("tool", new Promise(() => {}), ac, buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;

      const cancelResult = manager.cancel(result.value);
      expect(cancelResult.ok).toBe(true);
      expect(ac.signal.aborted).toBe(true);

      const task = manager.getTask(result.value);
      expect(task!.status).toBe("cancelled");
    });

    it("returns error for nonexistent task", () => {
      const result = manager.cancel("nonexistent");
      expect(result.ok).toBe(false);
    });

    it("returns error for non-running task", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;
      manager.complete(result.value, "done");

      const cancelResult = manager.cancel(result.value);
      expect(cancelResult.ok).toBe(false);
    });

    it("emits background_task:cancelled event", () => {
      const result = manager.promote("tool", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));
      if (!result.ok) return;
      manager.cancel(result.value);

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:cancelled",
        expect.objectContaining({ agentId: "agent-1" }),
      );
    });
  });

  describe("getTasks / getTask", () => {
    it("getTasks returns only tasks for the specified agent", () => {
      manager.promote("t1", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a1" }));
      manager.promote("t2", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "a2" }));

      expect(manager.getTasks("a1")).toHaveLength(1);
      expect(manager.getTasks("a2")).toHaveLength(1);
      expect(manager.getTasks("a3")).toHaveLength(0);
    });

    it("getTask returns undefined for unknown task", () => {
      expect(manager.getTask("nonexistent")).toBeUndefined();
    });
  });

  describe("hard timeout", () => {
    it("marks task failed after maxBackgroundDurationMs", async () => {
      vi.useFakeTimers();
      try {
        const ac = new AbortController();
        const result = manager.promote("slow_tool", new Promise(() => {}), ac, buildOrigin({ agentId: "agent-1" }));
        if (!result.ok) return;

        vi.advanceTimersByTime(101);

        const task = manager.getTask(result.value);
        expect(task!.status).toBe("failed");
        expect(task!.error).toContain("Hard timeout exceeded");
        expect(ac.signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("recoverOnStartup", () => {
    it("recovers running tasks and emits failed events", () => {
      // Pre-persist a "running" task to disk (with origin, as required)
      const task: PersistedTaskState = {
        id: "recovered-1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "recovered-1",
        dispatchAttempts: 0,
      };
      persistTaskSync(dataDir, task);

      // Create a fresh manager and recover
      const mgr2 = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: testTimers,
        maxPerAgent: 5,
        maxTotal: 20,
      });
      mgr2.recoverOnStartup(() => ok(undefined));

      const recovered = mgr2.getTask("recovered-1");
      expect(recovered).toBeDefined();
      expect(recovered!.status).toBe("failed");
      expect(recovered!.error).toBe("Daemon restarted while task was running");

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:failed",
        expect.objectContaining({
          taskId: "recovered-1",
          error: "Daemon restarted while task was running",
        }),
      );

      expect(logger.info).toHaveBeenCalledWith(
        { count: 1 },
        "Recovered background tasks marked as failed",
      );
    });

    it("records a canonical incident when startup terminalization cannot persist", () => {
      const task: PersistedTaskState = {
        id: "recovered-storage-failure",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
        origin: buildOrigin({ agentId: "a1" }),
        continuationExecutionId: "recovered-storage-failure",
        dispatchAttempts: 0,
      };
      persistTaskSync(dataDir, task);
      const recordIncident = vi.fn(() => ok(undefined));
      const mgr2 = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: testTimers,
        persistenceOps: {
          open: vi.fn(() => {
            throw new Error("storage unavailable");
          }),
          write: vi.fn(),
          sync: vi.fn(),
          close: vi.fn(),
          rename: vi.fn(),
          unlink: vi.fn(),
        },
      });

      mgr2.recoverOnStartup(recordIncident);

      expect(mgr2.getTask(task.id)?.status).toBe("running");
      expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        toolName: task.toolName,
        sessionKey: expect.any(String),
        projectedSessionKey: expect.any(Object),
      }));
    });

    it("retries startup terminalization until the failed state commits", async () => {
      vi.useFakeTimers();
      try {
        const task: PersistedTaskState = {
          id: "recovered-terminal-retry",
          toolName: "tool1",
          status: "running",
          startedAt: 1000,
          origin: buildOrigin({ agentId: "a1" }),
          continuationExecutionId: "recovered-terminal-retry",
          dispatchAttempts: 0,
        };
        persistTaskSync(dataDir, task);
        let failOpen = true;
        const mgr2 = createBackgroundTaskManager({
          dataDir,
          eventBus,
          logger,
          clock: testClock,
          timers: testTimers,
          persistenceOps: {
            open: (path, flags, mode) => {
              if (failOpen) {
                failOpen = false;
                throw new Error("storage unavailable");
              }
              return openSync(path, flags, mode);
            },
            write: writeFileSync,
            sync: fsyncSync,
            close: closeSync,
            rename: renameSync,
            unlink: unlinkSync,
          },
        });

        mgr2.recoverOnStartup(() => ok(undefined));
        expect(mgr2.getTask(task.id)?.status).toBe("running");

        await vi.advanceTimersByTimeAsync(1_001);

        expect(mgr2.getTask(task.id)?.status).toBe("failed");
        expect(loadTask(dataDir, "a1", task.id)?.status).toBe("failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not release a live task counter for recovered terminal retries", async () => {
      vi.useFakeTimers();
      try {
        let failNextOpen = false;
        const controlled = createBackgroundTaskManager({
          dataDir,
          eventBus,
          logger,
          clock: testClock,
          timers: testTimers,
          maxPerAgent: 1,
          maxTotal: 1,
          persistenceOps: {
            open: (path, flags, mode) => {
              if (failNextOpen) {
                failNextOpen = false;
                throw new Error("storage unavailable");
              }
              return openSync(path, flags, mode);
            },
            write: writeFileSync,
            sync: fsyncSync,
            close: closeSync,
            rename: renameSync,
            unlink: unlinkSync,
          },
        });
        const origin = buildOrigin({ agentId: "a1" });
        const live = controlled.promote(
          "live",
          new Promise(() => {}),
          new AbortController(),
          origin,
        );
        expect(live.ok).toBe(true);
        persistTaskSync(dataDir, {
          id: "recovered-without-counter",
          toolName: "recovered",
          status: "running",
          startedAt: 1,
          origin,
          continuationExecutionId: "recovered-without-counter",
          dispatchAttempts: 0,
        });

        failNextOpen = true;
        controlled.recoverOnStartup(() => ok(undefined));
        await vi.advanceTimersByTimeAsync(1_001);

        const next = controlled.promote(
          "next",
          new Promise(() => {}),
          new AbortController(),
          origin,
        );
        expect(next.ok).toBe(false);
        for (const task of controlled.getAllTasks()) {
          task._hardTimeoutTimer?.cancel();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces and retries canonical incident persistence failures", async () => {
      vi.useFakeTimers();
      try {
        const task: PersistedTaskState = {
          id: "recovered-incident-retry",
          toolName: "tool1",
          status: "running",
          startedAt: 1000,
          origin: buildOrigin({ agentId: "a1" }),
          continuationExecutionId: "recovered-incident-retry",
          dispatchAttempts: 0,
        };
        persistTaskSync(dataDir, task);
        const recorder = vi.fn()
          .mockReturnValueOnce(err(new Error("trajectory unavailable")))
          .mockReturnValue(ok(undefined));
        const mgr2 = createBackgroundTaskManager({
          dataDir,
          eventBus,
          logger,
          clock: testClock,
          timers: testTimers,
          persistenceOps: {
            open: vi.fn(() => {
              throw new Error("storage unavailable");
            }),
            write: vi.fn(),
            sync: vi.fn(),
            close: vi.fn(),
            rename: vi.fn(),
            unlink: vi.fn(),
          },
        });

        mgr2.recoverOnStartup(recorder);

        expect(eventBus.emit).toHaveBeenCalledWith(
          "background_task:notified",
          expect.objectContaining({
            taskId: task.id,
            reason: "recovery_retry_required",
          }),
        );
        await vi.advanceTimersByTimeAsync(1_001);
        expect(recorder).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries incomplete protected-store scans", async () => {
      vi.useFakeTimers();
      try {
        const task: PersistedTaskState = {
          id: "recovered-read-retry",
          toolName: "tool1",
          status: "completed",
          startedAt: 1000,
          completedAt: 2000,
          origin: buildOrigin({ agentId: "a1" }),
          continuationExecutionId: "recovered-read-retry",
          dispatchAttempts: 0,
          dispatchState: "delivered",
        };
        persistTaskSync(dataDir, task);
        let failRead = true;
        const mgr2 = createBackgroundTaskManager({
          dataDir,
          eventBus,
          logger,
          clock: testClock,
          timers: testTimers,
          recoveryOps: {
            readdir: readdirSync,
            stat: statSync,
            read: (path) => {
              if (failRead) {
                failRead = false;
                throw new Error("read unavailable");
              }
              return readFileSync(path, "utf-8");
            },
          },
        });

        mgr2.recoverOnStartup(() => ok(undefined));
        expect(mgr2.getTask(task.id)).toBeUndefined();
        expect(eventBus.emit).toHaveBeenCalledWith(
          "system:error",
          expect.objectContaining({ source: "background-task-recovery" }),
        );

        await vi.advanceTimersByTimeAsync(1_001);
        expect(mgr2.getTask(task.id)?.dispatchState).toBe("delivered");
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a canonical incident for a rejected task record", () => {
      const origin = buildOrigin({ agentId: "a1" });
      const agentDir = safePath(dataDir, "a1");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(safePath(agentDir, "invalid-state.json"), JSON.stringify({
        id: "invalid-state",
        toolName: "tool1",
        status: "unknown",
        startedAt: 1000,
        origin,
        continuationExecutionId: "invalid-state",
        dispatchAttempts: 0,
      }));
      const recorder = vi.fn(() => ok(undefined));
      const mgr2 = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        clock: testClock,
        timers: testTimers,
      });

      mgr2.recoverOnStartup(recorder);

      expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "invalid-state",
        sessionKey: expect.any(String),
        projectedSessionKey: expect.any(Object),
      }));
      expect(eventBus.emit).toHaveBeenCalledWith(
        "background_task:notified",
        expect.objectContaining({
          taskId: "invalid-state",
          reason: "recovery_retry_required",
        }),
      );
    });
  });

  describe("cleanup", () => {
    it("retains unresolved durable delivery authority past retention", () => {
      const origin = buildOrigin({ agentId: "cleanup-agent" });
      persistTaskSync(dataDir, {
        id: "cleanup-open",
        toolName: "tool",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin,
        continuationExecutionId: "cleanup-open",
        dispatchAttempts: 0,
        dispatchState: "ready_to_deliver",
      });
      persistTaskSync(dataDir, {
        id: "cleanup-closed",
        toolName: "tool",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin,
        continuationExecutionId: "cleanup-closed",
        dispatchAttempts: 0,
        dispatchState: "delivered",
      });
      manager.recoverOnStartup(() => ok(undefined));

      manager.cleanup(0);

      expect(manager.getTask("cleanup-open")).toBeDefined();
      expect(manager.getTask("cleanup-closed")).toBeUndefined();
    });
  });

  it("records silent state-only retry resolution without notification", async () => {
    vi.useFakeTimers();
    try {
      const origin = buildOrigin({ agentId: "silent-agent" });
      persistTaskSync(dataDir, {
        id: "silent-state-retry",
        toolName: "tool",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        origin,
        notificationPolicy: "silent",
        continuationExecutionId: "silent-state-retry",
        dispatchAttempts: 1,
        dispatchState: "execution_claimed",
      });
      manager.recoverOnStartup(() => ok(undefined));

      manager.scheduleStateRetry(
        "silent-state-retry",
        "delivered",
        ["execution_claimed"],
      );
      await vi.advanceTimersByTimeAsync(1_001);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "background_task:notified",
        expect.objectContaining({
          taskId: "silent-state-retry",
          notified: false,
          reason: "silent_consumed",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("origin capture", () => {
    it("promote(validOrigin) returns ok(taskId) and task.origin matches", () => {
      const origin = buildOrigin({ agentId: "agent-test", sessionKey: "agent-test:echo:ch1:u1" });
      const result = manager.promote("my_tool", new Promise(() => {}), new AbortController(), origin);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const task = manager.getTask(result.value);
      expect(task).toBeDefined();
      expect(task!.origin).toEqual(origin);
    });

    it("promote(undefined origin) returns Result.err with 'origin' in message", () => {
      const result = manager.promote("my_tool", new Promise(() => {}), new AbortController(), undefined as unknown as BackgroundTaskOrigin);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/origin/i);
    });

    it("promote with an empty agent authority returns Result.err", () => {
      const result = manager.promote("my_tool", new Promise(() => {}), new AbortController(), {
        agentId: "",
        sessionKey: "k",
        channelType: "c",
        channelId: "i",
        traceId: null,
        backgroundHopCount: 0,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("structured turn authority");
    });

    it("promote with an empty formatted key cannot substitute for structured authority", () => {
      const result = manager.promote("my_tool", new Promise(() => {}), new AbortController(), {
        agentId: "a",
        sessionKey: "",
        channelType: "c",
        channelId: "i",
        traceId: null,
        backgroundHopCount: 0,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("structured turn authority");
    });

    it("complete(taskId) emits background_task:completed with origin in payload", () => {
      const origin = buildOrigin({ agentId: "agent-5" });
      const result = manager.promote("tool5", new Promise(() => {}), new AbortController(), origin);
      if (!result.ok) return;

      manager.complete(result.value, "result-data");

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:completed",
        expect.objectContaining({ origin }),
      );
    });

    it("fail(taskId) emits background_task:failed with origin in payload", () => {
      const origin = buildOrigin({ agentId: "agent-6" });
      const result = manager.promote("tool6", new Promise(() => {}), new AbortController(), origin);
      if (!result.ok) return;

      manager.fail(result.value, new Error("boom"));

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:failed",
        expect.objectContaining({ origin }),
      );
    });

    it("getTasks(agentId) filters by origin.turnScope.conversation.agentId", () => {
      manager.promote("t1", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "filter-agent" }));
      manager.promote("t2", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "other-agent" }));
      manager.promote("t3", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "filter-agent" }));

      const tasks = manager.getTasks("filter-agent");
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.origin.turnScope.conversation.agentId === "filter-agent")).toBe(true);
    });

    it("recoverOnStartup emits failed event with origin populated (restart-recovery path)", () => {
      const testDir = safePath(tmpdir(), `comis-bg-mgr-rec-${randomUUID()}`);
      mkdirSync(testDir, { recursive: true });

      try {
        const origin = buildOrigin({ agentId: "recover-agent", sessionKey: "recover-agent:echo:chan:usr" });
        const persisted: PersistedTaskState = {
          id: "restart-task-1",
          toolName: "recover_tool",
          status: "failed",
          startedAt: Date.now() - 5000,
          completedAt: Date.now() - 4000,
          error: "Daemon restarted while task was running",
          origin,
          continuationExecutionId: "restart-task-1",
          dispatchAttempts: 0,
        };

        // Write directly to the agent subdir using safePath
        const agentDir = safePath(testDir, origin.turnScope.conversation.agentId);
        mkdirSync(agentDir, { recursive: true });
        const filePath = safePath(agentDir, `${persisted.id}.json`);
        writeFileSync(filePath, JSON.stringify(persisted, null, 2), "utf-8");

        const recoverEventBus = createMockEventBus();
        const recoverLogger = createMockLogger();
        const recoverMgr = createBackgroundTaskManager({
          dataDir: testDir,
          eventBus: recoverEventBus,
          logger: recoverLogger,
          clock: testClock,
          timers: testTimers,
          maxPerAgent: 5,
          maxTotal: 20,
        });
        recoverMgr.recoverOnStartup(() => ok(undefined));

        expect((recoverEventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
          "background_task:failed",
          expect.objectContaining({
            taskId: "restart-task-1",
            origin,
          }),
        );
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

  });

  // ---------------------------------------------------------------------------
  // recoverOnStartup propagates the persisted `dispatchState` field across the
  // boundary so recovered tasks reflect their pre-restart dispatch state.
  // ---------------------------------------------------------------------------
  describe("recoverOnStartup preserves dispatchState", () => {
    it.each(["execution_claimed", "executing"] as const)(
      "preserves %s execution for journal recovery",
      (dispatchState) => {
      const testDir = safePath(tmpdir(), `comis-bg-mgr-exec-${randomUUID()}`);
      mkdirSync(testDir, { recursive: true });
      try {
        const origin = buildOrigin({ agentId: "exec-agent" });
        persistTaskSync(testDir, {
          id: "exec-task-1",
          toolName: "exec",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          origin,
          dispatchState,
          continuationExecutionId: "continuation-1",
          dispatchAttempts: 1,
        });
        const recovered = createBackgroundTaskManager({
          dataDir: testDir,
          eventBus: createMockEventBus(),
          logger: createMockLogger(),
          clock: testClock,
          timers: testTimers,
        });
        recovered.recoverOnStartup(() => ok(undefined));
        expect(recovered.getTask("exec-task-1")?.dispatchState).toBe(dispatchState);
        expect(loadTask(testDir, "exec-agent", "exec-task-1")?.dispatchState).toBe(dispatchState);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
      },
    );

    it("preserves a parked delivery outcome without replaying it", () => {
      const testDir = safePath(tmpdir(), `comis-bg-mgr-disp-${randomUUID()}`);
      mkdirSync(testDir, { recursive: true });

      try {
        const origin = buildOrigin({ agentId: "disp-agent" });
        const persistedRecord: Record<string, unknown> = {
          id: "disp-task-1",
          toolName: "exec",
          status: "completed",
          startedAt: Date.now() - 5000,
          completedAt: Date.now() - 4000,
          origin,
          dispatchState: "parked_uncertain",
          continuationExecutionId: "disp-task-1",
          dispatchAttempts: 1,
        };

        const agentDir = safePath(testDir, origin.turnScope.conversation.agentId);
        mkdirSync(agentDir, { recursive: true });
        const filePath = safePath(agentDir, `${persistedRecord.id as string}.json`);
        writeFileSync(filePath, JSON.stringify(persistedRecord, null, 2), "utf-8");

        const dispMgr = createBackgroundTaskManager({
          dataDir: testDir,
          eventBus: createMockEventBus(),
          logger: createMockLogger(),
          clock: testClock,
          timers: testTimers,
          maxPerAgent: 5,
          maxTotal: 20,
        });
        dispMgr.recoverOnStartup(() => ok(undefined));

        const recovered = dispMgr.getTask("disp-task-1") as
          | (import("./background-task-types.js").BackgroundTask & {
              dispatchState?: string;
            })
          | undefined;
        expect(recovered).toBeDefined();
        expect(recovered?.dispatchState).toBe("parked_uncertain");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  it("preserves every lifecycle result and later observer when subscribers throw or reject", async () => {
    const isolatedBus = new TypedEventBus();
    const laterPromoted = vi.fn();
    const laterCompleted = vi.fn();
    const laterFailed = vi.fn();
    const laterCancelled = vi.fn();
    isolatedBus.on("background_task:promoted", () => {
      throw new Error("private promoted subscriber content");
    });
    isolatedBus.on("background_task:promoted", laterPromoted);
    isolatedBus.on("background_task:completed", async () => {
      throw new Error("private completed subscriber content");
    });
    isolatedBus.on("background_task:completed", laterCompleted);
    isolatedBus.on("background_task:failed", () => {
      throw new Error("private failed subscriber content");
    });
    isolatedBus.on("background_task:failed", laterFailed);
    isolatedBus.on("background_task:cancelled", () => {
      throw new Error("private cancelled subscriber content");
    });
    isolatedBus.on("background_task:cancelled", laterCancelled);
    manager = createBackgroundTaskManager({
      dataDir,
      eventBus: isolatedBus,
      logger,
      clock: testClock,
      timers: testTimers,
      maxPerAgent: 5,
      maxTotal: 5,
    });

    const completed = manager.promote("complete_tool", new Promise(() => {}), new AbortController(), buildOrigin());
    expect(completed.ok).toBe(true);
    expect(laterPromoted).toHaveBeenCalledOnce();
    if (!completed.ok) return;
    expect(() => manager.complete(completed.value, "done")).not.toThrow();
    expect(manager.getTask(completed.value)?.status).toBe("completed");
    expect(laterCompleted).toHaveBeenCalledOnce();

    const failed = manager.promote("fail_tool", new Promise(() => {}), new AbortController(), buildOrigin());
    if (!failed.ok) return;
    expect(() => manager.fail(failed.value, new Error("authoritative failure"))).not.toThrow();
    expect(manager.getTask(failed.value)?.status).toBe("failed");
    expect(laterFailed).toHaveBeenCalledOnce();

    const cancelled = manager.promote("cancel_tool", new Promise(() => {}), new AbortController(), buildOrigin());
    if (!cancelled.ok) return;
    expect(manager.cancel(cancelled.value)).toMatchObject({ ok: true });
    expect(manager.getTask(cancelled.value)?.status).toBe("cancelled");
    expect(laterCancelled).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private completed subscriber content");
  });
});
