import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBackgroundTaskManager, type BackgroundTaskManager } from "./background-task-manager.js";
import { persistTaskSync } from "./background-task-persistence.js";
import type { PersistedTaskState } from "./background-task-types.js";

function createMockEventBus() {
  return { emit: vi.fn() } as unknown as import("@comis/core").TypedEventBus;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

describe("BackgroundTaskManager", () => {
  let dataDir: string;
  let manager: BackgroundTaskManager;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    dataDir = join(tmpdir(), `comis-bg-mgr-test-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    eventBus = createMockEventBus();
    logger = createMockLogger();
    manager = createBackgroundTaskManager({
      dataDir,
      eventBus,
      logger,
      maxPerAgent: 2,
      maxTotal: 3,
      maxBackgroundDurationMs: 100, // 100ms for testing
    });
  });

  afterEach(() => {
    // Clean up any timers set by the manager
    for (const task of manager.getAllTasks()) {
      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("promote", () => {
    it("creates a task with status running and increments counters", () => {
      const promise = new Promise(() => {});
      const ac = new AbortController();
      const result = manager.promote("agent-1", "exec_command", promise, ac);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const task = manager.getTask(result.value);
      expect(task).toBeDefined();
      expect(task!.status).toBe("running");
      expect(task!.agentId).toBe("agent-1");
      expect(task!.toolName).toBe("exec_command");
    });

    it("emits background_task:promoted event", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
      expect(result.ok).toBe(true);
      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:promoted",
        expect.objectContaining({ agentId: "agent-1", toolName: "tool" }),
      );
    });

    it("rejects when per-agent limit reached", () => {
      manager.promote("agent-1", "t1", new Promise(() => {}), new AbortController());
      manager.promote("agent-1", "t2", new Promise(() => {}), new AbortController());
      const result = manager.promote("agent-1", "t3", new Promise(() => {}), new AbortController());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("Concurrency limit exceeded");
      expect(result.error.message).toContain("agent-1");
    });

    it("rejects when total limit reached", () => {
      manager.promote("a1", "t1", new Promise(() => {}), new AbortController());
      manager.promote("a2", "t2", new Promise(() => {}), new AbortController());
      manager.promote("a3", "t3", new Promise(() => {}), new AbortController());
      const result = manager.promote("a4", "t4", new Promise(() => {}), new AbortController());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("total");
    });
  });

  describe("complete", () => {
    it("sets status completed with truncated result and decrements counters", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const taskId = result.value;

      manager.complete(taskId, { data: "hello" });

      const task = manager.getTask(taskId);
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe('{"data":"hello"}');
      expect(task!.completedAt).toBeGreaterThan(0);

      // Counter decremented: can promote again
      const newResult = manager.promote("agent-1", "t2", new Promise(() => {}), new AbortController());
      expect(newResult.ok).toBe(true);
    });

    it("emits background_task:completed event", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
      if (!result.ok) return;
      manager.complete(result.value, "done");

      expect((eventBus.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "background_task:completed",
        expect.objectContaining({ agentId: "agent-1", toolName: "tool" }),
      );
    });
  });

  describe("fail", () => {
    it("sets status failed with error message and decrements counters", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
      if (!result.ok) return;
      const taskId = result.value;

      manager.fail(taskId, new Error("oops"));

      const task = manager.getTask(taskId);
      expect(task!.status).toBe("failed");
      expect(task!.error).toBe("oops");

      // Counter decremented
      const r2 = manager.promote("agent-1", "t2", new Promise(() => {}), new AbortController());
      expect(r2.ok).toBe(true);
    });

    it("emits background_task:failed event", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
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
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), ac);
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
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
      if (!result.ok) return;
      manager.complete(result.value, "done");

      const cancelResult = manager.cancel(result.value);
      expect(cancelResult.ok).toBe(false);
    });

    it("emits background_task:cancelled event", () => {
      const result = manager.promote("agent-1", "tool", new Promise(() => {}), new AbortController());
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
      manager.promote("a1", "t1", new Promise(() => {}), new AbortController());
      manager.promote("a2", "t2", new Promise(() => {}), new AbortController());

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
        const result = manager.promote("agent-1", "slow_tool", new Promise(() => {}), ac);
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
      // Pre-persist a "running" task to disk
      const task: PersistedTaskState = {
        id: "recovered-1",
        agentId: "a1",
        toolName: "tool1",
        status: "running",
        startedAt: 1000,
      };
      persistTaskSync(dataDir, task);

      // Create a fresh manager and recover
      const mgr2 = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger,
        maxPerAgent: 5,
        maxTotal: 20,
      });
      mgr2.recoverOnStartup();

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
  });
});
