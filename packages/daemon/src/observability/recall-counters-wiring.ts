// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-counters bus wiring.
 *
 * The composition-root glue between the three `memory:*` bus events and the
 * in-process recall counter registry from `@comis/observability`. It stands up
 * ONE `createRecallCounters()` registry (daemon-lifetime — RESETS ON RESTART)
 * and subscribes it to:
 *
 *   - `memory:recalled`    → onRecalled (per-lane candidate counts + hit tally)
 *   - `memory:reranked`    → onReranked (run + fallback when err OR timeout)
 *   - `memory:consolidated`→ onConsolidated (clusters + observations throughput)
 *
 * The returned `{ snapshot }` accessor is the SAME registry the daemon threads
 * into `MemoryApiDeps.recallCounters` so the `memory.recall_stats` handler
 * reads live counters — NOT a fresh registry per call.
 *
 * Mirrors `obs-persistence-wiring.ts`'s `eventBus.on(...)` subscriber model.
 * Counts only ever cross the bus (AGENTS.md §2.7) — no content, ids, or query
 * text — so the registry holds integers exclusively.
 *
 * @module
 */

import type { TypedEventBus } from "@comis/core";
import { createRecallCounters } from "@comis/observability";
import type { RecallCountersSnapshot } from "@comis/observability";

/**
 * The accessor returned by {@link wireRecallCounters}. Threaded into
 * `MemoryApiDeps.recallCounters` so the `memory.recall_stats` handler reads the
 * live, shared snapshot.
 */
export interface RecallCountersWiring {
  /** Defensive-copy snapshot of the live, shared in-process counters. */
  snapshot: () => RecallCountersSnapshot;
}

/**
 * Stand up the single shared recall-counter registry and subscribe it to the
 * three `memory:*` bus events. Returns the `snapshot` accessor for the daemon
 * to inject into the memory handler deps.
 *
 * @param eventBus - the daemon's typed event bus
 * @returns the shared-registry snapshot accessor
 */
export function wireRecallCounters(eventBus: TypedEventBus): RecallCountersWiring {
  // ONE registry for the daemon lifetime — the snapshot accessor below returns
  // a defensive copy off THIS instance, so the recall_stats handler always
  // reads the accumulated live counters.
  const counters = createRecallCounters();

  eventBus.on("memory:recalled", (p) => {
    counters.onRecalled({
      lanes: { fts: p.ftsCandidates, vector: p.vectorCandidates, entity: p.entityCandidates },
      finalCount: p.finalCount,
      rerankerAvailable: p.rerankerAvailable,
    });
  });

  eventBus.on("memory:reranked", (p) => {
    counters.onReranked({ fellBack: p.fellBack, timedOut: p.timedOut });
  });

  eventBus.on("memory:consolidated", (p) => {
    counters.onConsolidated({
      clustersProcessed: p.clustersProcessed,
      observationsCreated: p.observationsCreated,
    });
  });

  return { snapshot: counters.snapshot };
}
