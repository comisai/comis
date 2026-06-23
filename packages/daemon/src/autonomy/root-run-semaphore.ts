// SPDX-License-Identifier: Apache-2.0
/**
 * The unified per-`rootRunId` spawn semaphore (Phase 213-04, CEIL-01) — the
 * structural runaway-bound of the bounded-autonomy floor.
 *
 * A `for(;;) spawn()` fork-bomb (the Claude Code #68619 4M-token precedent) is
 * bounded TREE-WIDE here: the active sub-agent count is keyed on `rootRunId` (the
 * tree root), NOT per caller, so every descendant of one root shares a single
 * counter and a self-spawning loop trips the concurrency cap instead of running
 * unbounded. This is an ADDITIONAL gate the chokepoints consult at the spawn
 * convergence point (Plan 07) — it does NOT replace the graph `gatedSpawn` FIFO
 * (`graph/graph-concurrency.ts`, whose `globalCompletionHandler` explicitly
 * ignores `sessions_spawn` runs — that IS the CEIL-01 gap); the two counters stay
 * independent.
 *
 * The admit-or-deny shape mirrors `gatedSpawn` (`graph-concurrency.ts:20`); the
 * reserve mirrors the `spend-accumulator.ts:228` discipline — a SYNCHRONOUS body
 * with NO `await` between the headroom read and the `active++` write. JS is
 * single-threaded per event-loop tick, so K event-loop-concurrent `for(;;)
 * spawn()` callers each see the reservation the prior one left, bounding
 * admissions to a single overshoot (never K trees' worth).
 *
 * Discipline (the daemon arch gates): returns a discriminated union, NEVER throws
 * (`raw-throw.test.ts` — the chokepoint converts `{ok:false}` to a deny + a
 * `session:sub_agent_spawn_rejected` event in Plan 07); touches no wall
 * clock / timer (`globals.test.ts`). It is a pure in-memory limiter — content-free
 * (it operates on COUNTS keyed by an opaque `rootRunId` only).
 *
 * @module
 */

/** Per-tree spawn state: the live sub-agent count for one `rootRunId`. */
interface RootSpawnState {
  active: number;
}

/** The reasons a spawn admission is denied — a closed discriminated union. */
export type SpawnDenyReason = "concurrency" | "depth" | "fanout";

/** The per-`rootRunId` spawn semaphore surface. */
export interface RootRunSemaphore {
  /**
   * Atomically check the depth → fanout → concurrency bounds and RESERVE one
   * concurrency slot for `rootRunId` if all pass. The check order is shape bounds
   * (depth, fanout) before the resource bound (concurrency). The reserve is
   * synchronous (no `await` between the read and the `active++` write), so K
   * event-loop-concurrent callers serialize and each sees the prior reservation.
   *
   * @param rootRunId the tree-root id the spawn belongs to (shared by all descendants).
   * @param depth the depth of the spawn being attempted (`>= maxSpawnDepth` denies).
   * @param fanout the caller's current child count (`>= maxChildrenPerAgent` denies).
   * @returns `{ ok: true }` on admission; `{ ok: false, reason }` on a denied bound.
   */
  tryAcquireSpawn(
    rootRunId: string,
    depth: number,
    fanout: number,
  ): { ok: true } | { ok: false; reason: SpawnDenyReason };
  /**
   * Release one concurrency slot for `rootRunId`, paired one-to-one with a prior
   * successful `tryAcquireSpawn`. Floors at 0 — a double-release never drives the
   * active count negative (which would corrupt the cap into "free forever").
   */
  releaseSpawn(rootRunId: string): void;
  /** The live sub-agent count for `rootRunId` (0 for an untouched root) — for the composite/audit + tests. */
  activeCount(rootRunId: string): number;
}

/**
 * Create the per-`rootRunId` spawn semaphore. All numeric caps come from the
 * resolved autonomy config (`ResolvedAutonomy.spawn.*` — `maxConcurrentSelfAgents`
 * 4, `maxSpawnDepth` 3, `maxChildrenPerAgent` 5 on the `standard` profile); there
 * are no hard-coded limits here.
 */
export function createRootRunSemaphore(cfg: {
  maxConcurrentSelfAgents: number;
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
}): RootRunSemaphore {
  // In-memory per-tree active counts, keyed on rootRunId (ONE entry per tree —
  // never one per spawn; the warning sign of a mis-scoped counter, RESEARCH
  // Pitfall 1).
  const roots = new Map<string, RootSpawnState>();

  return {
    tryAcquireSpawn(rootRunId, depth, fanout): { ok: true } | { ok: false; reason: SpawnDenyReason } {
      // ── SYNCHRONOUS atomic body: NO `await` between the reads and the write. ──
      // Shape bounds first (depth, fanout), then the resource bound (concurrency).
      if (depth >= cfg.maxSpawnDepth) return { ok: false, reason: "depth" };
      if (fanout >= cfg.maxChildrenPerAgent) return { ok: false, reason: "fanout" };

      const s = roots.get(rootRunId) ?? { active: 0 };
      if (s.active >= cfg.maxConcurrentSelfAgents) return { ok: false, reason: "concurrency" };

      // Reserve: increment BEFORE returning, so the next event-loop-concurrent
      // caller for this tree sees this reservation.
      s.active++;
      roots.set(rootRunId, s);
      return { ok: true };
    },

    releaseSpawn(rootRunId): void {
      const s = roots.get(rootRunId);
      if (s) s.active = Math.max(0, s.active - 1);
    },

    activeCount(rootRunId): number {
      return roots.get(rootRunId)?.active ?? 0;
    },
  };
}
