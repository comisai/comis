// SPDX-License-Identifier: Apache-2.0
/**
 * `createEvictRegistry` — the daemon-wide evicted-`rootRunId` set.
 *
 * The shared state between two seams:
 *   - the `autonomy.evict` admin RPC handler WRITES it (`mark(rootRunId)`) when an
 *     operator forcibly demotes an in-flight unattended run, and
 *   - the bounded-autonomy chokepoint READS it (`isEvicted(rootRunId)`) at the
 *     NEXT gate decision (mid-run, NOT at mint/next-spawn) to resolve
 *     the run's effective profile to `default`.
 *
 * Evict is semantically DISTINCT from revoke (cooperative stop) and kill (hard
 * stop): it DEMOTES — the run KEEPS GOING under the `default` profile (which still
 * escalates outward, never auto-sends), it does NOT abort. This registry is the
 * read/write primitive that makes that demotion mid-run-effective; the
 * chokepoint wires the read side.
 *
 * Discipline (the daemon arch gates): the service NEVER throws; the logger is
 * injected (no module-level logger); logging is content-free (§2.7 — the method +
 * the newly/already enum only, NEVER the run's body — `rootRunId` is an id, not a
 * body). `clear(rootRunId)` is the run-end cleanup that keeps the backing set
 * bounded under a storm of completed roots — mirrors the per-root map
 * eviction discipline `createBoundedAutonomy.releaseSpawn` follows for its sibling
 * per-root state.
 *
 * @module
 */
import type { ComisLogger } from "@comis/infra";

/** The evicted-`rootRunId` set — write side (handler) + read side (chokepoint). */
export interface EvictRegistry {
  /**
   * Demote a run: mark its `rootRunId` so the chokepoint resolves its mode to
   * `default` from the NEXT gate decision. Idempotent — a second mark
   * of an already-evicted root is a no-op on the set. Returns `{ newlyEvicted }`
   * so the handler can report whether THIS call changed state (`true`) or the run
   * was already demoted (`false`).
   */
  mark(rootRunId: string): { newlyEvicted: boolean };
  /**
   * Is this run demoted? The read primitive the chokepoint consults BEFORE
   * resolving the effective mode. `false` for an unknown root.
   */
  isEvicted(rootRunId: string): boolean;
  /**
   * Drop a run's evicted flag — the run-end cleanup. Idempotent (a clear of an
   * unknown root is a no-op). Keeps the backing set from growing unbounded under a
   * churn of completed roots.
   */
  clear(rootRunId: string): void;
}

/**
 * Construct the evicted-`rootRunId` registry. Backed by a `Set<string>`; the
 * composition root constructs ONE per daemon and threads it onto the dispatch
 * deps so the `autonomy.evict` handler (write) and the
 * chokepoint (read) share the same instance.
 *
 * @param deps.logger - structured logger for the content-free §2.7 mark line.
 */
export function createEvictRegistry(deps: { logger: ComisLogger }): EvictRegistry {
  const logger = deps.logger.child({ submodule: "evict-registry" });
  // The evicted-rootRunId set. `clear` drops entries on run-end so a storm of
  // completed roots cannot grow it without bound.
  const evicted = new Set<string>();

  return {
    mark(rootRunId): { newlyEvicted: boolean } {
      const newlyEvicted = !evicted.has(rootRunId);
      evicted.add(rootRunId);
      // §2.7 content-free: the method + the newly/already enum only — NEVER the
      // run's body. `rootRunId` is an operator-supplied id, not a payload.
      logger.info(
        { method: "autonomy.evict", newlyEvicted },
        "Run marked evicted (demote to default mid-run)",
      );
      return { newlyEvicted };
    },

    isEvicted(rootRunId): boolean {
      return evicted.has(rootRunId);
    },

    clear(rootRunId): void {
      evicted.delete(rootRunId);
    },
  };
}
