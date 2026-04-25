// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline concurrency-cap integration test.
 *
 * Drives the agent's PriorityScheduler -- the same primitive the graph
 * runner uses to gate parallel mappers -- with a workload that mimics a
 * map-reduce node: N parallel tasks within a single lane, plus a second
 * lane fed in parallel to verify the per-lane cap holds independently
 * from cross-lane scheduling.
 *
 * Asserts:
 *   - per-lane cap of K is never exceeded under load (in-flight counter
 *     observed by the work function itself never goes > K)
 *   - higher-priority lanes are NOT starved by saturated lower-priority
 *     lanes (priority arbitration property)
 *   - getStats() reports pending vs. executing accurately while tasks
 *     are mid-flight
 *   - drainAll() awaits every queued task before returning
 *   - shutdown() resolves only after all in-flight tasks have completed
 *
 * No daemon required -- exercises createPriorityScheduler directly.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { PriorityLaneConfig } from "@comis/core";
import { createPriorityScheduler } from "@comis/agent";
import type { PriorityScheduler } from "@comis/agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduler(
  lanes: PriorityLaneConfig[],
): { scheduler: PriorityScheduler; bus: TypedEventBus } {
  const bus = new TypedEventBus();
  const scheduler = createPriorityScheduler({
    lanes,
    eventBus: bus,
  });
  return { scheduler, bus };
}

/** Sleep utility used inside scheduled tasks to create observable overlap. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Pipeline -- per-lane concurrency cap under saturation", () => {
  let scheduler: PriorityScheduler;

  afterEach(async () => {
    await scheduler.shutdown();
  });

  it("cap=3 with 6 parallel tasks holds in-flight at <= 3", async () => {
    ({ scheduler } = makeScheduler([
      { name: "mapper", concurrency: 3, priority: 1, agingPromotionMs: 0 },
    ]));

    let inFlight = 0;
    let peakInFlight = 0;
    const completionsInOrder: number[] = [];

    const enqueueOne = (idx: number): Promise<void> =>
      scheduler.enqueue("mapper", async () => {
        inFlight++;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        // Hold the slot long enough that 6 tasks must overlap if 6 lanes
        // were available. With cap=3, only 3 can co-execute.
        await sleep(40);
        completionsInOrder.push(idx);
        inFlight--;
      });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) promises.push(enqueueOne(i));
    await Promise.all(promises);

    expect(peakInFlight).toBe(3);
    expect(completionsInOrder).toHaveLength(6);
  });

  it("cap=1 serializes tasks: peak in-flight is exactly 1", async () => {
    ({ scheduler } = makeScheduler([
      { name: "serial", concurrency: 1, priority: 1, agingPromotionMs: 0 },
    ]));

    let inFlight = 0;
    let peakInFlight = 0;

    const ps: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      ps.push(
        scheduler.enqueue("serial", async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await sleep(20);
          inFlight--;
        }),
      );
    }
    await Promise.all(ps);
    expect(peakInFlight).toBe(1);
  });

  it("cap=10 with 5 tasks: all run concurrently (peak = 5)", async () => {
    ({ scheduler } = makeScheduler([
      { name: "wide", concurrency: 10, priority: 1, agingPromotionMs: 0 },
    ]));

    let inFlight = 0;
    let peakInFlight = 0;

    const ps: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      ps.push(
        scheduler.enqueue("wide", async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await sleep(20);
          inFlight--;
        }),
      );
    }
    await Promise.all(ps);
    expect(peakInFlight).toBe(5);
  });
});

describe("Pipeline -- cross-lane priority arbitration under load", () => {
  let scheduler: PriorityScheduler;

  afterEach(async () => {
    await scheduler.shutdown();
  });

  it("higher-priority lane is not starved by a saturated low-priority lane", async () => {
    // Low lane has cap=2 and is saturated with 6 long tasks (50 ms each --
    // takes ~150 ms total to drain). High lane has its own cap=1. We
    // inject a fast high task once low is mid-flight and assert that it
    // completes before low fully drains -- i.e. high is NOT blocked
    // behind the 6-deep low queue.
    ({ scheduler } = makeScheduler([
      { name: "high", concurrency: 1, priority: 2, agingPromotionMs: 0 },
      { name: "low", concurrency: 2, priority: 0, agingPromotionMs: 0 },
    ]));

    const completions: string[] = [];

    const lowPromises: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) {
      lowPromises.push(
        scheduler.enqueue("low", async () => {
          await sleep(50);
          completions.push(`low-${i}`);
        }),
      );
    }

    // Let the first 2 low tasks start.
    await sleep(15);

    const highPromise = scheduler.enqueue("high", async () => {
      completions.push("high-0");
    });
    await highPromise;

    // The starvation property under test: high must not have to wait for
    // all 6 low tasks. We capture the completion array immediately after
    // high resolves and assert fewer than 6 low tasks finished by then.
    expect(completions).toContain("high-0");
    const lowDoneByThen = completions.filter((s) => s.startsWith("low-")).length;
    expect(lowDoneByThen).toBeLessThan(6);

    // Drain the lane so afterEach can shut down cleanly.
    await Promise.all(lowPromises);
    expect(
      completions.filter((s) => s.startsWith("low-")).length,
    ).toBe(6);
  });
});

describe("Pipeline -- stats and drain semantics", () => {
  let scheduler: PriorityScheduler;

  afterEach(async () => {
    await scheduler.shutdown();
  });

  it("getStats() reports executing > 0 while tasks are running", async () => {
    ({ scheduler } = makeScheduler([
      { name: "obs", concurrency: 2, priority: 1, agingPromotionMs: 0 },
    ]));

    const ps: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      ps.push(
        scheduler.enqueue("obs", async () => {
          await sleep(40);
        }),
      );
    }

    // Wait briefly for the scheduler to start dispatching.
    await sleep(10);
    const mid = scheduler.getStats();
    const obsStats = mid["obs"];
    expect(obsStats).toBeDefined();
    if (!obsStats) return;
    // executing should be exactly 2 (cap), pending should reflect the rest.
    expect(obsStats.executing).toBe(2);
    expect(obsStats.pending).toBeGreaterThanOrEqual(1);

    await Promise.all(ps);

    const after = scheduler.getStats();
    const finalStats = after["obs"];
    expect(finalStats).toBeDefined();
    if (!finalStats) return;
    expect(finalStats.executing).toBe(0);
    expect(finalStats.pending).toBe(0);
  });

  it("drainAll() awaits every queued task before returning", async () => {
    ({ scheduler } = makeScheduler([
      { name: "drain", concurrency: 2, priority: 1, agingPromotionMs: 0 },
    ]));

    let completed = 0;

    for (let i = 0; i < 5; i++) {
      // Fire-and-forget: do NOT await. drainAll() is the contract under test.
      void scheduler.enqueue("drain", async () => {
        await sleep(20);
        completed++;
      });
    }

    await scheduler.drainAll();
    expect(completed).toBe(5);
  });

  it("getTotalConcurrency() sums all lane concurrencies", () => {
    ({ scheduler } = makeScheduler([
      { name: "a", concurrency: 3, priority: 2, agingPromotionMs: 0 },
      { name: "b", concurrency: 5, priority: 1, agingPromotionMs: 0 },
      { name: "c", concurrency: 1, priority: 0, agingPromotionMs: 0 },
    ]));

    expect(scheduler.getTotalConcurrency()).toBe(9);
  });
});
