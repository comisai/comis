// SPDX-License-Identifier: Apache-2.0

/** Content-free managed-run binding transitions. */
export interface ManagedRunEvents {
  "managed_run:prepared": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    timestamp: number;
  };
  "managed_run:activated": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    durationMs: number;
    timestamp: number;
  };
  "managed_run:activation_rejected": {
    managedRunId?: string;
    serviceInstanceId: string;
    agentId: string;
    reasonCode: "activation_rejected" | "agent_not_allowed" | "invalid_preparation" | "preparation_expired" | "replay_conflict" | "service_unavailable";
    timestamp: number;
  };
  "managed_run:activation_unknown": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    reasonCode: "activation_outcome_unknown" | "recovery_join_missing" | "service_state_unavailable";
    timestamp: number;
  };
}
