// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-utility write-back wiring.
 *
 * The composition-root glue between the `memory:recall_used` bus event (emitted
 * by @comis/agent's `postExecution` after a turn) and the
 * `MemoryUsefulnessStore.recordUsage` port (the @comis/memory adapter). The
 * daemon is the ONLY place holding BOTH the bus AND the adapter — the agent↛memory
 * build cut means the agent emits ids+counts on the bus and the daemon does the
 * write. Mirrors `wireRecallCounters` (recall-counters-wiring.ts). Counts + ids
 * ONLY ever cross the bus (AGENTS.md §2.7) — never memory content.
 *
 * Default-OFF: the `feedbackEnabled` gate makes the subscriber a no-op write
 * when no agent has `rag.feedback.enabled` — byte-identical to the prior
 * feedback-off behaviour. The write-back is fire-and-forget / non-fatal: a failing or
 * slow `recordUsage` warns and continues; it never throws out of the bus handler
 * and never blocks/fails the turn.
 *
 * @module
 */

import type {
  TypedEventBus,
  MemoryUsefulnessStore,
  ClockPort,
  ComisLogger,
} from "@comis/core";

/** Dependencies for {@link wireMemoryUsefulness}. */
export interface MemoryUsefulnessWiringDeps {
  /** Configured deployment tenant that authorizes every write in this daemon. */
  tenantId: string;
  /** The daemon's typed event bus (source of `memory:recall_used`). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory adapter for the usefulness port (the write target). */
  usefulnessStore: MemoryUsefulnessStore;
  /** Injected clock for `scope.now` — never `Date.now()`. */
  clock: ClockPort;
  /** Structured logger for the non-fatal failure WARN. */
  logger: ComisLogger;
  /**
   * Per-process gate: true when ANY agent has `rag.feedback.enabled`. Default-OFF
   * (no agent on) → the subscriber writes NOTHING.
   */
  feedbackEnabled: () => boolean;
}

/**
 * Stand up the `memory:recall_used` → `recordUsage` write-back subscriber on the
 * daemon's bus. Fire-and-forget / non-fatal; default-OFF via `feedbackEnabled`.
 */
export function wireMemoryUsefulness(deps: MemoryUsefulnessWiringDeps): void {
  deps.eventBus.on("memory:recall_used", (p) => {
    // Default-off: write nothing when no agent has feedback enabled.
    if (!deps.feedbackEnabled()) return;
    // Nothing attributed this turn → no write (avoids an empty transaction).
    if (p.usedIds.length === 0 && p.ignoredIds.length === 0) return;

    const scope = {
      tenantId: deps.tenantId,
      agentId: p.agentId,
      now: deps.clock.now(),
      // Per-intent write side: forward the recall's query-INTENT so the adapter
      // records the PER-INTENT usefulness bucket. When the event carries no
      // intent the key is OMITTED entirely (not `intent: undefined`) → the
      // adapter resolves the GLOBAL bucket, byte-identical to the pre-per-intent
      // write. intent is a
      // closed-union string (counts/ids/intent ONLY cross the bus, never bodies).
      ...(p.intent !== undefined ? { intent: p.intent } : {}),
    };

    // Fire-and-forget: NEVER throw out of the bus handler. A failing
    // recordUsage warns + continues; the turn already completed. The handler only
    // ever reads ids + counts off the event (the bus carries no bodies).
    // Hoisted for the WARN observability fields (the canonical agentId field).
    // The scope above is the single per-agent isolation boundary; the
    // warns reuse this local rather than re-reading the event field.
    const agentId = p.agentId;
    void deps.usefulnessStore
      .recordUsage(p.usedIds, p.ignoredIds, scope)
      .then((r) => {
        if (!r.ok) {
          deps.logger.warn(
            {
              agentId,
              usedCount: p.usedIds.length,
              ignoredCount: p.ignoredIds.length,
              errorKind: "internal" as const,
              hint: "usefulness recordUsage failed; the recall-utility signal was not persisted for this turn",
            },
            "usefulness write-back failed (non-fatal)",
          );
        }
      })
      .catch((e: unknown) => {
        // A rejected promise (not an err Result) is still non-fatal.
        deps.logger.warn(
          {
            agentId,
            err: e instanceof Error ? e : new Error(String(e)),
            errorKind: "internal" as const,
            hint: "usefulness recordUsage threw; the recall-utility signal was not persisted for this turn",
          },
          "usefulness write-back threw (non-fatal)",
        );
      });
  });
}
