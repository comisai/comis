/**
 * Background task types for automatic tool execution promotion.
 *
 * @module
 */

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
  id: string;
  agentId: string;
  toolName: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  // In-memory only (not serialized):
  _promise?: Promise<unknown>;
  _abortController?: AbortController;
  _hardTimeoutTimer?: ReturnType<typeof setTimeout>;
}

/** Serializable subset of BackgroundTask for file persistence. */
export interface PersistedTaskState {
  id: string;
  agentId: string;
  toolName: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}
