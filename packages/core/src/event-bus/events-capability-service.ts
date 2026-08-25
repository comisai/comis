// SPDX-License-Identifier: Apache-2.0

/** Content-free linked service activation and health transitions. */
export interface CapabilityServiceEvents {
  /** One complete candidate became the published active view. */
  "capability_service:activation_completed": {
    revision: number;
    viewHash: string;
    activeCount: number;
    failedCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** A structural candidate failure left the previously published view unchanged. */
  "capability_service:activation_failed": {
    reasonCode: "activation_in_progress" | "construction_failed" | "duplicate_activator" | "missing_activator";
    serviceInstanceId?: string;
    cleanupFailureCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** One leaf instance is present in the active view as explicit failed state. */
  "capability_service:instance_failed": {
    serviceInstanceId: string;
    serviceDefinitionId: string;
    reasonCode: "health_mismatch" | "start_failed";
    cleanupFailed: boolean;
    timestamp: number;
  };
}
