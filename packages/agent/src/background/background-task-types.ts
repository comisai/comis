// SPDX-License-Identifier: Apache-2.0
/**
 * Background task type definitions.
 *
 * @module
 */

import type { BackgroundTaskOrigin, TimerHandle } from "@comis/core";
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

/**
 * Three-state session lifecycle for a background task's notification routing.
 * State-machine transitions are the single source of truth for at-most-once
 * fallback.
 *
 * - "pending"    — Promotion happened; no completion event yet (or completion
 *                   event arrived but dispatcher has not classified it).
 * - "notified"   — Fallback notification fired (user-visible literal text);
 *                   recovery-after-restart MUST NOT re-emit.
 * - "dispatched" — Re-entry triggered against the originating session;
 *                   no fallback notification needed.
 */
export type BackgroundSessionState =
  | "pending"
  | "executing"
  | "delivering"
  | "delivered"
  | "fallback_pending"
  | "fallback_delivered"
  | "consumed_live";

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
  /** Live three-state session lifecycle. Optional; recovery defaults to
   *  "pending" when absent. The dispatcher inspects this before firing
   *  fallbackNotifyFn. */
  dispatchState?: BackgroundSessionState;
  continuationExecutionId: string;
  dispatchAttempts: number;
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
   * Three-state session lifecycle. Optional; recovery defaults to "pending"
   * when absent. The dispatcher inspects this before firing fallbackNotifyFn.
   */
  dispatchState?: BackgroundSessionState;
  continuationExecutionId: string;
  dispatchAttempts: number;
}
