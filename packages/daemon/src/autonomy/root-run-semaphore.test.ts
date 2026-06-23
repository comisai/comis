// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the per-`rootRunId` spawn semaphore (Phase 213-04, CEIL-01).
 *
 * The structural runaway-bound of the bounded-autonomy floor: a unified ceiling
 * keyed on `rootRunId` so a `for(;;) spawn()` is bounded TREE-WIDE (not per-caller),
 * mirroring the graph `gatedSpawn` admit-or-deny shape (`graph-concurrency.ts:20`)
 * and the `spend-accumulator.ts:228` SYNCHRONOUS atomic reserve (no `await` between
 * the read and the write, so K event-loop-concurrent callers each see the prior
 * reservation and admissions are bounded to a single overshoot).
 *
 * Pins:
 *   - the concurrency limb admits exactly `maxConcurrentSelfAgents`, then denies
 *     with `reason: "concurrency"`; a release frees one slot,
 *   - the depth limb denies at `currentDepth >= maxSpawnDepth` (`reason: "depth"`),
 *   - the fanout limb denies at `fanout >= maxChildrenPerAgent` (`reason: "fanout"`),
 *   - two DIFFERENT roots have INDEPENDENT counters (the tree-scoping invariant),
 *   - the for(;;)-spawn bound: N+1 acquires yield exactly N oks then denies, and
 *     the active map holds ONE entry per tree (keyed per root, not per spawn),
 *   - releaseSpawn floors at 0 (a double-release never drives active negative).
 *
 * No wall clock / timer is touched (the `globals.test.ts` gate); the module returns
 * a discriminated union, never throwing (`raw-throw.test.ts`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createRootRunSemaphore, type RootRunSemaphore } from "./root-run-semaphore.js";

/** Build the SUT with sane caps; each test overrides the limb it exercises. */
function makeSemaphore(
  overrides: Partial<{
    maxConcurrentSelfAgents: number;
    maxSpawnDepth: number;
    maxChildrenPerAgent: number;
  }> = {},
): RootRunSemaphore {
  return createRootRunSemaphore({
    maxConcurrentSelfAgents: overrides.maxConcurrentSelfAgents ?? 4,
    maxSpawnDepth: overrides.maxSpawnDepth ?? 3,
    maxChildrenPerAgent: overrides.maxChildrenPerAgent ?? 5,
  });
}

describe("root-run-semaphore — per-rootRunId atomic spawn bound (CEIL-01)", () => {
  it("admits up to maxConcurrentSelfAgents then denies with reason concurrency, and a release frees one slot", () => {
    const sem = makeSemaphore({ maxConcurrentSelfAgents: 2 });

    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
    // Third over the concurrency cap → denied.
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: false, reason: "concurrency" });

    // Free one slot → a new acquire is admitted again.
    sem.releaseSpawn("root-A");
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
  });

  it("denies a spawn at or beyond maxSpawnDepth with reason depth and admits one below", () => {
    const sem = makeSemaphore({ maxSpawnDepth: 3 });

    // currentDepth >= max → denied on the shape bound (before the resource bound).
    expect(sem.tryAcquireSpawn("root-A", 3, 0)).toEqual({ ok: false, reason: "depth" });
    // One below the cap → admitted.
    expect(sem.tryAcquireSpawn("root-A", 2, 0)).toEqual({ ok: true });
  });

  it("denies a spawn at or beyond maxChildrenPerAgent with reason fanout and admits one below", () => {
    const sem = makeSemaphore({ maxChildrenPerAgent: 5 });

    expect(sem.tryAcquireSpawn("root-A", 1, 5)).toEqual({ ok: false, reason: "fanout" });
    expect(sem.tryAcquireSpawn("root-A", 1, 4)).toEqual({ ok: true });
  });

  it("keeps two different roots on independent counters so one at its cap does not block another", () => {
    const sem = makeSemaphore({ maxConcurrentSelfAgents: 1 });

    // root-A consumes its single slot.
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: false, reason: "concurrency" });

    // root-B is a DIFFERENT tree — its first acquire is admitted regardless of A.
    expect(sem.tryAcquireSpawn("root-B", 1, 0)).toEqual({ ok: true });
  });

  it("bounds a for-loop spawn storm to exactly N admits and holds one active entry per tree", () => {
    const N = 3;
    const sem = makeSemaphore({ maxConcurrentSelfAgents: N });

    let admitted = 0;
    // A simulated `for(;;) spawn()` from one tree — N+1 attempts.
    for (let i = 0; i < N + 1; i++) {
      if (sem.tryAcquireSpawn("root-storm", 1, i).ok) admitted++;
    }

    expect(admitted).toBe(N);
    // Keyed per tree: the active count is N (the reservations), tracked under ONE root.
    expect(sem.activeCount("root-storm")).toBe(N);
    // An untouched root reports zero (no phantom per-spawn entries).
    expect(sem.activeCount("root-other")).toBe(0);
  });

  it("floors releaseSpawn at zero so a double-release never drives active negative", () => {
    const sem = makeSemaphore({ maxConcurrentSelfAgents: 1 });

    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
    sem.releaseSpawn("root-A");
    // Over-release: must NOT push active below 0.
    sem.releaseSpawn("root-A");
    expect(sem.activeCount("root-A")).toBe(0);

    // After the floor, the cap is still respected (not corrupted into "free forever").
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: true });
    expect(sem.tryAcquireSpawn("root-A", 1, 0)).toEqual({ ok: false, reason: "concurrency" });
  });
});
