// SPDX-License-Identifier: Apache-2.0
/** Content-free failure classes emitted by the protected task-store scanner. */
export type BackgroundTaskRecoveryScanFailureKind =
  | "root_read"
  | "agent_path"
  | "agent_stat"
  | "agent_read"
  | "task_path"
  | "task_read"
  | "task_parse"
  | "task_validation";

/** Background recovery standing-state events. */
export interface BackgroundRecoveryEvents {
  /** Latest protected task-store scan state; bounded identifiers only. */
  "background_task:recovery_scan": {
    status: "healthy" | "failed";
    failureCount: number;
    failureKinds: BackgroundTaskRecoveryScanFailureKind[];
    recordRefs: string[];
    timestamp: number;
  };
}
