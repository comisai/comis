// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdicts for local sub-agent resource guards. */
import type { IncidentSignals } from "@comis/core";

type ResourceGuardVerdict = {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
};

const SPAWN_CEILING_BINDING =
  /(autonomy\.spawn\.(?:maxConcurrentSelfAgents|maxSpawnDepth|maxChildrenPerAgent))=(\d+); current=(\d+); reason=(concurrency|depth|fanout)/;

export const spawnCeilingVerdict = (
  signals: IncidentSignals,
): ResourceGuardVerdict | null => {
  const failure = signals.failures.find(
    (candidate) =>
      candidate.classifiedFailureBy === "runtime_guard"
      && candidate.matchedRule === "spawn_ceiling",
  );
  if (failure === undefined) return null;

  const binding = failure.errorPreview.match(SPAWN_CEILING_BINDING);
  const configKey = binding?.[1] ?? "autonomy.spawn";
  const limit = binding?.[2];
  const current = binding?.[3];
  const reason = binding?.[4] ?? "capacity";
  const occupancy =
    limit !== undefined && current !== undefined
      ? `${configKey}=${limit}; current=${current}`
      : configKey;
  const recovery =
    reason === "depth"
      ? [
          `raise ${configKey} in the config file and restart the daemon, or continue without another nested spawn`,
          "retrying at the same depth cannot create a child",
        ]
      : reason === "fanout"
        ? [
            "wait for one of this caller's children to finish or stop one that is no longer needed",
            `if this caller needs more simultaneous children, raise ${configKey} in the config file and restart the daemon`,
          ]
        : [
            "wait for a running sub-agent to finish or stop one that is no longer needed",
            `if the workload needs more simultaneous agents, raise ${configKey} in the config file and restart the daemon`,
          ];

  return {
    code: "spawn_ceiling",
    detail:
      `the local sub-agent admission guard refused a spawn because ${occupancy}; `
      + `reason=${reason}; no child was created for the rejected call`,
    suggestedNextSteps: [...recovery, "obs.explain depth=full"],
  };
};

/** A node's explicit or inherited token ceiling is upstream of terminal delivery symptoms. */
export const nodeBudgetExceededVerdict = (
  signals: IncidentSignals,
): ResourceGuardVerdict | null => {
  const breach = (signals.nodeBudgetBreaches ?? []).at(-1);
  if (breach === undefined) return null;

  const binding =
    breach.capSource === "node"
      ? `the node's own tokenBudget for ${breach.nodeId}`
      : breach.capSource === "operator-default"
        ? "security.agentToAgent.tokenBudget"
        : breach.capSource === "inherit-share"
          ? "the graph budget.maxTokens inherit-share"
          : "an unresolved per-node token budget";
  return {
    code: "node_budget_exceeded",
    detail:
      `graph node ${breach.nodeId} was stopped by ${binding}: `
      + `tokensUsed=${String(breach.tokensUsed)}, tokenBudget=${String(breach.tokenBudget)}; `
      + "tokensUsed=0 is expected when admission rejected the first model call",
    suggestedNextSteps: [
      `raise ${binding}, or reduce the node task`,
      "inspect graph.status to confirm the node is terminal failed rather than still spending",
      "obs.explain depth=full",
    ],
  };
};
