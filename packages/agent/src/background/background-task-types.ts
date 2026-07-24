// SPDX-License-Identifier: Apache-2.0
/**
 * Background task type definitions.
 *
 * @module
 */

import {
  BackgroundTaskOriginSchema,
  type BackgroundTaskOrigin,
  type ErrorKind,
  type SessionKey,
  type TimerHandle,
} from "@comis/core";
import { z } from "zod";
export type { BackgroundTaskOrigin };

export const BackgroundTaskStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatusSchema>;

/**
 * Notification policy for a background task. Typed enum (NOT a boolean):
 * preserves intent across restart-recovery so the recovered task's dispatch
 * path matches its original promote-time intent. A boolean collapses to
 * true/false on rehydrate and loses the distinction between "the operator
 * wanted deferred routing" and "the operator wanted immediate notification".
 *
 * - "deferred"  — Default. Wait for the dispatcher to attempt session
 *                 re-entry; only fall back to user-visible notification
 *                 when re-entry fails (session expired, hop cap hit).
 * - "immediate" — Skip the dispatcher; fire user-visible notification
 *                 immediately. Reserved for tasks that explicitly want
 *                 the literal-text notification.
 * - "silent"    — Skip both dispatcher and user-visible notification.
 *                 Reserved for fully-internal tasks.
 *
 * Default for new promote() calls: "deferred".
 */
export const BackgroundTaskNotificationPolicySchema = z.enum(["deferred", "immediate", "silent"]);
export type BackgroundTaskNotificationPolicy = z.infer<typeof BackgroundTaskNotificationPolicySchema>;

/** Durable execution, outbox delivery, and reconciliation lifecycle. */
export const BackgroundSessionStateSchema = z.enum([
  "pending",
  "execution_claimed",
  "executing",
  "cleanup_pending",
  "ready_to_deliver",
  "pre_send",
  "delivering",
  "delivered",
  "parked_permanent",
  "parked_uncertain",
  "consumed_live",
]);
export type BackgroundSessionState = z.infer<typeof BackgroundSessionStateSchema>;

export const BackgroundContinuationOutboxSchema = z.strictObject({
  kind: z.enum(["continuation", "fallback"]),
  response: z.string().max(102_400),
  executionId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(512),
  deliveryProtection: z.enum(["ledger", "none"]),
});

export type BackgroundContinuationOutbox = z.infer<typeof BackgroundContinuationOutboxSchema>;

export const BackgroundFinalizedResultSchema = z.strictObject({
  response: z.string().max(102_400),
  executionId: z.string().min(1).max(256),
  cleanupRequired: z.boolean(),
});

export type BackgroundFinalizedResult = z.infer<typeof BackgroundFinalizedResultSchema>;

export type BackgroundRecoveryRecorderDisposition = "accepted" | "suppressed";

export type BackgroundRecoveryRecorderFailureKind =
  | "session_adapter_unavailable"
  | "protected_path_unavailable"
  | "persisted_state_capacity"
  | "persisted_state_invalid"
  | "recorder_rejected";

export interface BackgroundRecoveryRecorderFailure {
  readonly kind: BackgroundRecoveryRecorderFailureKind;
  readonly cause: Error;
}

export interface BackgroundRecoveryIncidentInput {
  readonly agentId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly sessionKey: string;
  readonly projectedSessionKey: SessionKey;
  readonly traceId: string | null;
  readonly timestamp: number;
  readonly reason: "recovery_retry_required" | "recovery_resolved";
}

export type BackgroundCompletionDeliveryOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "retryable_pre_send"; readonly errorKind: ErrorKind; readonly message: string }
  | { readonly kind: "permanent"; readonly errorKind: ErrorKind; readonly message: string }
  | { readonly kind: "uncertain"; readonly errorKind: ErrorKind; readonly message: string };

export interface BackgroundCompletionDeliveryInput {
  readonly taskId: string;
  readonly origin: BackgroundTaskOrigin;
  readonly response: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly onSendStart: () => import("@comis/shared").Result<void, Error>;
}

export interface BackgroundFinalizedResultRecoveryInput {
  readonly agentId: string;
  readonly sessionKey: SessionKey;
  readonly journalKey: string;
}

export const PersistedTaskStateSchema = z.strictObject({
  id: z.string().min(1).max(512),
  toolName: z.string().min(1).max(256),
  status: BackgroundTaskStatusSchema,
  startedAt: z.number().finite(),
  completedAt: z.number().finite().optional(),
  result: z.string().max(102_400).optional(),
  error: z.string().max(102_400).optional(),
  origin: BackgroundTaskOriginSchema,
  notificationPolicy: BackgroundTaskNotificationPolicySchema.optional(),
  dispatchState: BackgroundSessionStateSchema.optional(),
  continuationExecutionId: z.string().min(1).max(512),
  dispatchAttempts: z.number().int().nonnegative(),
  continuationOutbox: BackgroundContinuationOutboxSchema.optional(),
  finalizedResult: BackgroundFinalizedResultSchema.optional(),
});

// @optional-field-count: Lifecycle fields are conditional by task state; underscored fields exist only while execution or terminal persistence is in flight.
export interface BackgroundTask {
  id: string;
  toolName: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Originating session attribution (incl. backgroundHopCount) -- captured at
   *  promote-time, persisted on disk, preserved across recoverOnStartup.
   *  Required (no silent fallback). */
  origin: BackgroundTaskOrigin;
  /** Live notification policy. Optional; recovery defaults to "deferred" when
   *  absent. */
  notificationPolicy?: BackgroundTaskNotificationPolicy;
  /** Durable completion lifecycle. */
  dispatchState?: BackgroundSessionState;
  continuationExecutionId: string;
  dispatchAttempts: number;
  continuationOutbox?: BackgroundContinuationOutbox;
  finalizedResult?: BackgroundFinalizedResult;
  // In-memory only (not serialized):
  _promise?: Promise<unknown>;
  _abortController?: AbortController;
  /** TimerHandle replaces NodeJS.Timeout for cancel-safe shutdown. */
  _hardTimeoutTimer?: TimerHandle;
  _pendingFinalizedResult?: BackgroundFinalizedResult;
  _pendingTerminal?: {
    status: Extract<BackgroundTaskStatus, "completed" | "failed" | "cancelled">;
    completedAt: number;
    result?: string;
    error?: string;
  };
  _ownsCounterSlot?: boolean;
}

/** Serializable subset of BackgroundTask for file persistence. */
export interface PersistedTaskState {
  id: string;
  toolName: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Persisted origin -- read back by recoverOnStartup so completion routing
   *  survives daemon restarts. */
  origin: BackgroundTaskOrigin;
  /**
   * Notification policy chosen at promote time. Optional; recovery defaults
   * to "deferred" when absent.
   */
  notificationPolicy?: BackgroundTaskNotificationPolicy;
  /**
   * Durable completion lifecycle.
   */
  dispatchState?: BackgroundSessionState;
  continuationExecutionId: string;
  dispatchAttempts: number;
  continuationOutbox?: BackgroundContinuationOutbox;
  finalizedResult?: BackgroundFinalizedResult;
}

export function isClosedBackgroundTask(task: Pick<BackgroundTask, "status" | "dispatchState">): boolean {
  return task.status === "cancelled"
    || task.dispatchState === "delivered"
    || task.dispatchState === "parked_permanent"
    || task.dispatchState === "parked_uncertain"
    || task.dispatchState === "consumed_live";
}
