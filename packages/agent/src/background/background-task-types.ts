// SPDX-License-Identifier: Apache-2.0
/**
 * Background task type definitions.
 *
 * @module
 */

import type { BackgroundTaskOrigin } from "@comis/core";
export type { BackgroundTaskOrigin };

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

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
   *  Required (no silent fallback per SPEC AC-3). */
  origin: BackgroundTaskOrigin;
  // In-memory only (not serialized):
  _promise?: Promise<unknown>;
  _abortController?: AbortController;
  _hardTimeoutTimer?: ReturnType<typeof setTimeout>;
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
   *  survives daemon restarts (SPEC AC-11). */
  origin: BackgroundTaskOrigin;
}
