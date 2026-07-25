// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind } from "../logging/log-fields.js";

type TaskStoreErrorCode =
  | "not_initialized"
  | "invalid_path"
  | "invalid_state"
  | "lock_contended"
  | "lock_failed"
  | "io"
  | "store_full"
  | "ownership_unproven"
  | "disabled";

type TaskExtractionFailureStage =
  | "queue_transfer"
  | "root_registration"
  | "model"
  | "model_output"
  | "deadline"
  | "live_gate"
  | "persistence_fence"
  | "store"
  | "internal";

type TaskCheckTerminalOutcome =
  | "dismissed"
  | "retry_scheduled"
  | "expired"
  | "delivered"
  | "delivery_partial"
  | "delivery_unknown"
  | "configuration_disabled"
  | "delivery_window_closed"
  | "failed";

type TaskStoreOperation =
  | "claim"
  | "begin_delivery"
  | "settle_delivery"
  | "dismiss"
  | "fail"
  | "extraction_persist";

/** Durable ownership and volatile inference events for inferred follow-up tasks. */
export interface SchedulerTaskEvents {
  /** Boot-time recovery of durable follow-up attempts under the daemon singleton lock. */
  "scheduler:task_ownership_reconciliation": {
    agentId: string;
    durationMs: number;
    timestamp: number;
  } & (
    | {
      status: "completed";
      recoveredChecking: number;
      recoveredDelivering: number;
    }
    | {
      status: "failed";
      errorCode: TaskStoreErrorCode;
      errorKind: ErrorKind;
    }
  );

  /** Candidate persistence completed before this observational event was emitted. */
  "scheduler:task_extraction_completed": {
    agentId: string;
    rootRunId: string;
    itemCount: number;
    candidateCount: number;
    createdCount: number;
    mergedCount: number;
    sourceExecutionIds: readonly string[];
    taskIds: readonly string[];
    durationMs: number;
    timestamp: number;
    releaseErrorKind?: ErrorKind;
  };

  /** A volatile extraction batch was dropped and cannot be replayed safely. */
  "scheduler:task_extraction_failed": {
    agentId: string;
    rootRunId: string | null;
    itemCount: number;
    sourceExecutionIds: readonly string[];
    stage: TaskExtractionFailureStage;
    errorKind: ErrorKind;
    releaseErrorKind?: ErrorKind;
    durationMs: number;
    timestamp: number;
  };

  /** A checking claim is durable and model work may now begin. */
  "scheduler:task_check_started": {
    agentId: string;
    sessionKey?: string;
    attemptId: string;
    rootRunId: string;
    correlationId: string;
    taskIds: readonly string[];
    sourceExecutionIds: readonly string[];
    originTraceIds: readonly string[];
    durationMs: number;
    timestamp: number;
  };

  /** A task attempt's terminal or retry transition is durable. */
  "scheduler:task_check_terminal": {
    agentId: string;
    sessionKey?: string;
    attemptId: string;
    rootRunId: string;
    correlationId: string;
    taskIds: readonly string[];
    sourceExecutionIds: readonly string[];
    originTraceIds: readonly string[];
    outcome: TaskCheckTerminalOutcome;
    recovery: "live" | "ownership_recovery";
    errorKind?: ErrorKind;
    deliveredChunks?: number | null;
    failedChunks?: number | null;
    ambiguousChunks?: number | null;
    durationMs: number;
    timestamp: number;
  };

  /** Accepted task delivery whose exact origin-history projection could not be persisted. */
  "scheduler:task_delivery_history_failed": {
    attemptId: string;
    agentId: string;
    rootRunId: string;
    taskIds: readonly string[];
    errorKind: ErrorKind;
    durationMs: number;
    timestamp: number;
  };

  /** Every due origin group was deferred by the rolling visibility cap. */
  "scheduler:task_cap_deferred": {
    agentId: string;
    rootRunId: string;
    correlationId: string;
    deferredTaskCount: number;
    expiredTaskCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** A strict task-store transaction failed; durable state was not inferred. */
  "scheduler:task_store_degraded": {
    agentId: string;
    operation: TaskStoreOperation;
    errorCode: TaskStoreErrorCode;
    errorKind: ErrorKind;
    rootRunId?: string;
    attemptId?: string;
    durationMs: number;
    timestamp: number;
  };

  /** One locked cancellation transaction durably terminalized pending tasks. */
  "scheduler:task_cancelled": {
    agentId: string;
    taskIds: readonly string[];
    activeTaskCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** A recovery-only whole-authority reset completed and was reinitialized strictly. */
  "scheduler:task_store_reset": {
    agentId: string;
    operationId: string;
    beforeDigest: string | null;
    afterDigest: string;
    durationMs: number;
    timestamp: number;
  };
}
