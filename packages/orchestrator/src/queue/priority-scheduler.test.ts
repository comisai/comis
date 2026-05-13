// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { PriorityLaneConfig } from "@comis/core";
import { createPriorityScheduler } from "./priority-scheduler.js";
import type { PriorityScheduler } from "./priority-scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestLanes(): PriorityLaneConfig[] {
  return [
    { name: "high", concurrency: 3, priority: 2, agingPromotionMs: 30_000 },
    { name: "normal", concurrency: 5, priority: 1, agingPromotionMs: 60_000 },
    { name: "low", concurrency: 2, priority: 0, agingPromotionMs: 0 },
  ];
}

function createTestScheduler(
  lanes?: PriorityLaneConfig[],
): { scheduler: PriorityScheduler; eventBus: TypedEventBus } {
  const eventBus = new TypedEventBus();
  const scheduler = createPriorityScheduler({
    lanes: lanes ?? createTestLanes(),
    eventBus,
  });
  return { scheduler, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PriorityScheduler", () => {
  let scheduler: PriorityScheduler;
  let eventBus: TypedEventBus;

  beforeEach(() => {
    const ctx = createTestScheduler();
    scheduler = ctx.scheduler;
    eventBus = ctx.eventBus;
  });

  afterEach(async () => {
    await scheduler.shutdown();
  });

  it("enqueues and executes tasks in correct lanes", async () => {
    const results: string[] = [];

    await Promise.all([
      scheduler.enqueue("high", async () => {
        results.push("high-1");
      }),
      scheduler.enqueue("normal", async () => {
        results.push("normal-1");
      }),
    ]);

    expect(results).toContain("high-1");
    expect(results).toContain("normal-1");
    expect(results).toHaveLength(2);
  });

  it("respects per-lane concurrency limits", async () => {
    // Create a scheduler with a lane that has concurrency=2
    await scheduler.shutdown();
    const ctx = createTestScheduler([
      { name: "limited", concurrency: 2, priority: 0, agingPromotionMs: 0 },
    ]);
    scheduler = ctx.scheduler;

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 5; i++) {
      promises.push(
        scheduler.enqueue("limited", async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          // Small delay to allow overlap
          await new Promise((resolve) => setTimeout(resolve, 50));
          currentConcurrent--;
        }),
      );
    }

    await Promise.all(promises);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it("falls back to lowest-priority lane for unknown lane name", async () => {
    const results: string[] = [];

    await scheduler.enqueue("nonexistent", async () => {
      results.push("fallback");
    });

    expect(results).toEqual(["fallback"]);

    // Verify the task ran via the low lane (lowest priority=0)
    const stats = scheduler.getStats();
    // After completion, pending/executing should be 0 for all lanes
    expect(stats["low"]!.pending).toBe(0);
    expect(stats["low"]!.executing).toBe(0);
  });

  it("getStats returns correct pending/executing counts", async () => {
    // Pre-execution check
    const initialStats = scheduler.getStats();
    expect(initialStats["high"]!.pending).toBe(0);
    expect(initialStats["high"]!.executing).toBe(0);
    expect(initialStats["normal"]!.concurrency).toBe(5);
    expect(initialStats["low"]!.priority).toBe(0);

    // Enqueue a task that blocks so we can observe executing count
    let resolveTask: () => void;
    const blocker = new Promise<void>((r) => {
      resolveTask = r;
    });

    const taskPromise = scheduler.enqueue("high", async () => {
      await blocker;
    });

    // Let the task start executing
    await new Promise((r) => setTimeout(r, 20));
    const duringStats = scheduler.getStats();
    expect(duringStats["high"]!.executing).toBe(1);

    resolveTask!();
    await taskPromise;

    const afterStats = scheduler.getStats();
    expect(afterStats["high"]!.executing).toBe(0);
  });

  it("getTotalConcurrency sums all lane concurrencies", () => {
    // high=3 + normal=5 + low=2 = 10
    expect(scheduler.getTotalConcurrency()).toBe(10);
  });

  it("pause stops all lanes from processing new tasks", async () => {
    scheduler.pause();

    const results: string[] = [];
    const promise = scheduler.enqueue("high", async () => {
      results.push("executed");
    });

    // Allow time for potential execution
    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([]);

    // Resume and wait for completion
    scheduler.resume();
    await promise;
    expect(results).toEqual(["executed"]);
  });

  it("drainAll waits for all lanes to complete", async () => {
    const results: string[] = [];

    // Enqueue tasks to all lanes (don't await)
    void scheduler.enqueue("high", async () => {
      await new Promise((r) => setTimeout(r, 30));
      results.push("high");
    });
    void scheduler.enqueue("normal", async () => {
      await new Promise((r) => setTimeout(r, 30));
      results.push("normal");
    });
    void scheduler.enqueue("low", async () => {
      await new Promise((r) => setTimeout(r, 30));
      results.push("low");
    });

    await scheduler.drainAll();

    expect(results).toContain("high");
    expect(results).toContain("normal");
    expect(results).toContain("low");
    expect(results).toHaveLength(3);
  });

  it("shutdown pauses, drains, and clears", async () => {
    const results: string[] = [];

    // Enqueue a task
    void scheduler.enqueue("high", async () => {
      results.push("completed");
    });

    await scheduler.shutdown();

    // Task should have completed (drain)
    // Note: task may or may not have executed depending on timing,
    // but shutdown should complete without error
    const stats = scheduler.getStats();
    for (const lane of Object.values(stats)) {
      expect(lane.pending).toBe(0);
      expect(lane.executing).toBe(0);
    }

    // New enqueue should throw after shutdown
    await expect(
      scheduler.enqueue("high", async () => {}),
    ).rejects.toThrow("shut down");
  });

  it("aging sweep emits priority:aged_promotion for old pending tasks", async () => {
    vi.useFakeTimers();

    // Create fresh scheduler under fake timers
    const freshEventBus = new TypedEventBus();
    const freshScheduler = createPriorityScheduler({
      lanes: [
        { name: "high", concurrency: 3, priority: 2, agingPromotionMs: 0 },
        { name: "normal", concurrency: 1, priority: 1, agingPromotionMs: 100 },
      ],
      eventBus: freshEventBus,
    });

    const events: Array<{ fromLane: string; toLane: string; waitTimeMs: number }> = [];
    freshEventBus.on("priority:aged_promotion", (ev) => {
      events.push({ fromLane: ev.fromLane, toLane: ev.toLane, waitTimeMs: ev.waitTimeMs });
    });

    // Saturate the normal lane so tasks queue up
    let resolveBlocker: () => void;
    const blocker = new Promise<void>((r) => {
      resolveBlocker = r;
    });

    // Block the only normal slot
    void freshScheduler.enqueue("normal", async () => {
      await blocker;
    });

    // This task will be pending (waiting for the blocked slot)
    void freshScheduler.enqueue("normal", async () => {});

    // Let the first task start executing
    await vi.advanceTimersByTimeAsync(10);

    // Advance past the aging threshold (100ms) plus sweep interval (5000ms)
    await vi.advanceTimersByTimeAsync(5_100);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.fromLane).toBe("normal");
    expect(events[0]!.toLane).toBe("high");
    expect(events[0]!.waitTimeMs).toBeGreaterThanOrEqual(100);

    // Clean up
    resolveBlocker!();
    await vi.advanceTimersByTimeAsync(100);
    await freshScheduler.shutdown();
    vi.useRealTimers();
  });
});
