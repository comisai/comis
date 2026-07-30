// SPDX-License-Identifier: Apache-2.0
/** Graph cancellation helpers shared by graph.cancel and root-scoped hard stops. */

import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
} from "./graph-coordinator-state.js";

export interface GraphCancellationResult {
  cancelled: boolean;
  killed: number;
}

export interface RootGraphCancellationResult {
  graphsCancelled: number;
  killed: number;
}

type CancellationDeps = Pick<GraphCoordinatorDeps, "eventBus" | "subAgentRunner">;

export function cancelGraphRun(
  state: CoordinatorSharedState,
  deps: CancellationDeps,
  graphId: string,
  complete: (gs: GraphRunState) => void,
): GraphCancellationResult {
  const gs = state.graphs.get(graphId);
  if (!gs || gs.stateMachine.isTerminal()) {
    return { cancelled: false, killed: 0 };
  }

  gs.cancelReason = "manual";
  gs.cacheWarmCleanup?.();
  let killed = 0;

  for (const [runId, nodeId] of [...gs.runIdToNode]) {
    if (deps.subAgentRunner.killRun(runId).killed) killed++;
    gs.stateMachine.markNodeFailed(nodeId, "Cancelled");
  }
  gs.runIdToNode.clear();

  for (const [nodeId, driverState] of gs.driverStates) {
    if (driverState.currentRunId) {
      if (deps.subAgentRunner.killRun(driverState.currentRunId).killed) killed++;
      gs.driverRunIdMap.delete(driverState.currentRunId);
    }
    if (driverState.pendingParallel) {
      for (const [runId] of driverState.pendingParallel) {
        if (deps.subAgentRunner.killRun(runId).killed) killed++;
        gs.driverRunIdMap.delete(runId);
      }
    }
    driverState.driver.onAbort(driverState.ctx);
    deps.eventBus.emit("graph:driver_lifecycle", {
      graphId: gs.graphId,
      nodeId,
      typeId: driverState.driver.typeId,
      phase: "aborted",
    });
    gs.stateMachine.markNodeFailed(nodeId, "Cancelled");
  }
  gs.driverStates.clear();
  gs.driverRunIdMap.clear();

  for (let index = state.spawnQueue.length - 1; index >= 0; index--) {
    if (state.spawnQueue[index]!.graphId === graphId) {
      state.spawnQueue.splice(index, 1);
    }
  }

  for (const handler of gs.waitHandlers.values()) {
    deps.eventBus.off("message:received", handler);
  }
  gs.waitHandlers.clear();
  gs.syntheticRunResults.clear();

  gs.runningCount = 0;
  gs.stateMachine.cancel();
  complete(gs);
  return { cancelled: true, killed };
}

export function cancelGraphsByRootRunId(
  state: CoordinatorSharedState,
  deps: CancellationDeps,
  rootRunId: string,
  complete: (gs: GraphRunState) => void,
): RootGraphCancellationResult {
  let graphsCancelled = 0;
  let killed = 0;
  for (const gs of [...state.graphs.values()]) {
    if ((gs.rootRunId ?? gs.graphId) !== rootRunId) continue;
    const result = cancelGraphRun(state, deps, gs.graphId, complete);
    if (!result.cancelled) continue;
    graphsCancelled++;
    killed += result.killed;
  }
  return { graphsCancelled, killed };
}
