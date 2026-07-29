// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdict for a sub-agent admission ceiling refusal. */
import type { IncidentSignals } from "@comis/core";

type SpawnCeilingVerdict = {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
};

const SPAWN_CEILING_BINDING =
  /(autonomy\.spawn\.(?:maxConcurrentSelfAgents|maxSpawnDepth|maxChildrenPerAgent))=(\d+); current=(\d+); reason=(concurrency|depth|fanout)/;

export const spawnCeilingVerdict = (
  signals: IncidentSignals,
): SpawnCeilingVerdict | null => {
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
