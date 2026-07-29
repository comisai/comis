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

  return {
    code: "spawn_ceiling",
    detail:
      `the local sub-agent admission guard refused a spawn because ${occupancy}; `
      + `reason=${reason}; no child was created for the rejected call`,
    suggestedNextSteps: [
      "wait for a running sub-agent to finish or stop one that is no longer needed",
      `if the workload requires a wider tree, raise ${configKey} in the config file and restart the daemon`,
      "obs.explain depth=full",
    ],
  };
};
