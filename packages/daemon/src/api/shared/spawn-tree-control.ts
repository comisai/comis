// SPDX-License-Identifier: Apache-2.0
/**
 * Shared spawn-tree revocation and hard-stop mechanics.
 *
 * Both the operator autonomy handlers and the caller-scoped sub-agent handler
 * use this boundary so graph cancellation, process termination, lease
 * revocation, durable invalidation, root retirement, logging, and events cannot
 * drift between entry points.
 */

import {
  RunKillContract,
  toSafeErrorLogString,
  type DurableRunPort,
  type EventMap,
} from "@comis/core";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import type { GraphCoordinator } from "../../graph/graph-coordinator.js";

export interface SpawnTreeControlDeps {
  leaseManager: LeaseManager;
  subAgentRunner: { killByRootRun(rootRunId: string): { killed: number } };
  graphCoordinator?: Pick<GraphCoordinator, "cancelByRootRunId">;
  durableRuns?: DurableRunPort;
  revokeDurableRoot?: (rootRunId: string) => void;
  retireRootRunId?: (rootRunId: string) => boolean;
  eventBus?: { emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void };
  now?: () => number;
  logger: ComisLogger;
}

/** Retire every durable authority associated with a revoked root. */
export async function invalidateSpawnTreeState(
  deps: SpawnTreeControlDeps,
  rootRunId: string,
  method: string,
): Promise<boolean> {
  if (deps.durableRuns !== undefined) {
    const invalidated = await deps.durableRuns.invalidateForRevoke(rootRunId);
    if (!invalidated.ok) {
      deps.logger.warn(
        {
          method,
          err: toSafeErrorLogString(invalidated.error),
          hint: "Verify the tree is stopped and repair durable-run storage before restarting the daemon",
          errorKind: "dependency" as const,
        },
        "Durable record invalidate-on-revoke failed (lease still revoked)",
      );
    }
  }
  deps.revokeDurableRoot?.(rootRunId);
  return deps.retireRootRunId?.(rootRunId) ?? false;
}

/** Cancel and revoke one whole spawn tree through every authority layer. */
export async function killSpawnTree(
  deps: SpawnTreeControlDeps,
  rootRunId: string,
): Promise<{ killed: number }> {
  const graphCancellation = deps.graphCoordinator?.cancelByRootRunId(rootRunId)
    ?? { graphsCancelled: 0, killed: 0 };
  const runnerCancellation = deps.subAgentRunner.killByRootRun(rootRunId);
  const killed = graphCancellation.killed + runnerCancellation.killed;
  deps.leaseManager.revokeByRootRun(rootRunId);
  const rootGenerationRetired = await invalidateSpawnTreeState(
    deps,
    rootRunId,
    RunKillContract.method,
  );

  deps.logger.info(
    {
      method: RunKillContract.method,
      killed,
      graphsCancelled: graphCancellation.graphsCancelled,
      rootGenerationRetired,
    },
    "Spawn tree killed (hard stop) and its leases revoked",
  );
  deps.eventBus?.emit("autonomy:killed", {
    rootRunId,
    killed,
    timestamp: deps.now?.() ?? 0,
  });
  return { killed };
}
