// SPDX-License-Identifier: Apache-2.0
/**
 * Background task type definitions.
 *
 * @module
 */

import type { BackgroundTaskOrigin, TimerHandle } from "@comis/core";
import { z } from "zod";
export type { BackgroundTaskOrigin };

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

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
export type BackgroundTaskNotificationPolicy = "deferred" | "immediate" | "silent";

/** Durable execution, outbox delivery, and reconciliation lifecycle. */
export type BackgroundSessionState =
  | "pending"
  | "execution_claimed"
  | "executing"
  | "cleanup_pending"
  | "ready_to_deliver"
  | "delivering"
  | "delivered"
  | "parked_permanent"
  | "parked_uncertain"
  | "consumed_live";

export const BackgroundContinuationOutboxSchema = z.strictObject({
  kind: z.enum(["continuation", "fallback"]),
  response: z.string().max(102_400),
  executionId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(512),
  deliveryProtection: z.enum(["ledger", "none"]),
});

export type BackgroundContinuationOutbox = z.infer<typeof BackgroundContinuationOutboxSchema>;

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
  // In-memory only (not serialized):
  _promise?: Promise<unknown>;
  _abortController?: AbortController;
  /** TimerHandle replaces NodeJS.Timeout for cancel-safe shutdown. */
  _hardTimeoutTimer?: TimerHandle;
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
}
