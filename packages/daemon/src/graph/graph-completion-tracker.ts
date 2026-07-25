// SPDX-License-Identifier: Apache-2.0
/** Tracks terminal graph work so shutdown cannot abandon an outward receipt commit. */

import { toSafeErrorLogString } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { GraphRunState } from "./graph-coordinator-state.js";

export function createGraphCompletionTracker(
  complete: (gs: GraphRunState) => Promise<Result<void, Error>>,
  logger?: { error(fields: Record<string, unknown>, message: string): void },
): {
  run(gs: GraphRunState): Promise<Result<void, Error>>;
  drain(): Promise<void>;
  clear(): void;
  prune(activeGraphIds: ReadonlySet<string>): void;
} {
  const tails = new Map<string, Promise<Result<void, Error>>>();
  const outcomes = new Map<string, Result<void, Error>>();

  async function invoke(gs: GraphRunState): Promise<Result<void, Error>> {
    const started = tryCatch(() => complete(gs));
    if (!started.ok) return started;
    const completed = await fromPromise(started.value);
    return completed.ok ? completed.value : completed;
  }

  return {
    run(gs): Promise<Result<void, Error>> {
      const outcome = outcomes.get(gs.graphId);
      if (outcome !== undefined) return Promise.resolve(outcome);
      const existing = tails.get(gs.graphId);
      if (existing) return existing;
      const tracked: Promise<Result<void, Error>> = Promise.resolve()
        .then(() => invoke(gs))
        .then((result): Result<void, Error> => {
          const normalized = result.ok ? ok(undefined) : err(result.error);
          outcomes.set(gs.graphId, normalized);
          if (!normalized.ok) {
            tryCatch(() => logger?.error({
              graphId: gs.graphId,
              err: toSafeErrorLogString(normalized.error),
              hint: "Inspect the graph completion boundary; durable graph authority remains resumable",
              errorKind: "internal" as const,
            }, "Graph completion task failed"));
          }
          return normalized;
        })
        .finally(() => {
          if (tails.get(gs.graphId) === tracked) tails.delete(gs.graphId);
        });
      tails.set(gs.graphId, tracked);
      return tracked;
    },
    async drain(): Promise<void> {
      while (tails.size > 0) await Promise.all([...tails.values()]);
    },
    clear(): void {
      tails.clear();
      outcomes.clear();
    },
    prune(activeGraphIds): void {
      for (const graphId of outcomes.keys()) {
        if (!activeGraphIds.has(graphId)) outcomes.delete(graphId);
      }
    },
  };
}
