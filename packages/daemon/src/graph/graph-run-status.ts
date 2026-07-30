// SPDX-License-Identifier: Apache-2.0
/** Canonical graph-run status derived from node state and terminal cause. */

import type { GraphStatus } from "@comis/core";
import type { GraphRunState } from "./graph-coordinator-state.js";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";

export type GraphRunCancelReason = NonNullable<GraphRunState["cancelReason"]>;

export function resolveGraphRunStatus<T extends GraphStatus>(
  cancelReason: GraphRunState["cancelReason"],
  nodeStatus: T,
): T | "cancelled" | "failed" {
  if (cancelReason === undefined) return nodeStatus;
  switch (cancelReason) {
    case "manual":
      return "cancelled";
    case "budget":
    case "timeout":
    case "killed":
      return "failed";
    default: {
      const _exhaustive: never = cancelReason;
      return _exhaustive;
    }
  }
}

export function resolveGraphRunSnapshot(gs: GraphRunState): GraphExecutionSnapshot {
  const snapshot = gs.stateMachine.snapshot();
  return {
    ...snapshot,
    graphStatus: resolveGraphRunStatus(gs.cancelReason, snapshot.graphStatus),
  };
}
