// SPDX-License-Identifier: Apache-2.0
/** Serialized durable authority transitions for one graph coordinator. */

import { toSafeErrorLogString } from "@comis/core";
import type { GraphRunState } from "./graph-coordinator-state.js";

export interface GraphDurableTransitions {
  run(
    gs: GraphRunState,
    transition: (afterPersistence: (action: () => void) => void) => void,
  ): Promise<boolean>;
  persistThen(gs: GraphRunState, action: () => void): void;
  awaitGraph(gs: GraphRunState): Promise<boolean>;
  prune(activeGraphIds: ReadonlySet<string>): void;
  blockAllAndDrain(graphIds: Iterable<string>): Promise<void>;
  clear(): void;
}

export function createGraphDurableTransitions(deps: {
  requiresBoundary: (gs: GraphRunState) => boolean;
  checkpoint: (gs: GraphRunState) => Promise<boolean>;
  logger?: {
    error(obj: Record<string, unknown>, message: string): void;
  };
}): GraphDurableTransitions {
  const blocked = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  const run: GraphDurableTransitions["run"] = (gs, transition) => {
    if (blocked.has(gs.graphId)) return Promise.resolve(false);
    if (!deps.requiresBoundary(gs)) {
      try {
        transition((action) => action());
        return Promise.resolve(true);
      } catch (cause) {
        deps.logger?.error({
          graphId: gs.graphId,
          err: toSafeErrorLogString(cause),
          hint: "Inspect the graph transition callback; no durable continuation was released",
          errorKind: "internal" as const,
        }, "Graph transition failed");
        return Promise.resolve(false);
      }
    }

    const prior = tails.get(gs.graphId) ?? Promise.resolve();
    const currentResult = prior.then(async (): Promise<boolean> => {
      if (blocked.has(gs.graphId)) return false;
      const continuations: Array<() => void> = [];
      try {
        transition((action) => continuations.push(action));
        if (!(await deps.checkpoint(gs))) {
          blocked.add(gs.graphId);
          return false;
        }
        if (blocked.has(gs.graphId)) return false;
        for (const continuation of continuations) continuation();
        return true;
      } catch (cause) {
        blocked.add(gs.graphId);
        deps.logger?.error({
          graphId: gs.graphId,
          err: toSafeErrorLogString(cause),
          hint: "Inspect the graph transition and durable store; this graph is parked before further work",
          errorKind: "internal" as const,
        }, "Graph durable transition failed");
        return false;
      }
    });
    tails.set(gs.graphId, currentResult.then(() => undefined, () => undefined));
    return currentResult;
  };

  return {
    run,
    persistThen(gs, action): void {
      void run(gs, (afterPersistence) => afterPersistence(action));
    },
    async awaitGraph(gs): Promise<boolean> {
      let observed: Promise<void> | undefined;
      do {
        observed = tails.get(gs.graphId);
        if (observed === undefined) break;
        await observed;
      } while (tails.get(gs.graphId) !== observed);
      return !blocked.has(gs.graphId);
    },
    prune(activeGraphIds): void {
      for (const graphId of tails.keys()) {
        if (!activeGraphIds.has(graphId)) tails.delete(graphId);
      }
      for (const graphId of blocked) {
        if (!activeGraphIds.has(graphId)) blocked.delete(graphId);
      }
    },
    async blockAllAndDrain(graphIds): Promise<void> {
      for (const graphId of graphIds) blocked.add(graphId);
      let observed: Array<[string, Promise<void>]>;
      do {
        observed = [...tails.entries()];
        await Promise.all(observed.map(([, tail]) => tail));
      } while (observed.some(([graphId, tail]) => tails.get(graphId) !== tail));
    },
    clear(): void {
      tails.clear();
      blocked.clear();
    },
  };
}
