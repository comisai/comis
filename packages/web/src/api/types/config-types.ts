// SPDX-License-Identifier: Apache-2.0
/**
 * Config versioning domain types.
 *
 * Interfaces for git-backed config version history, diff viewing,
 * rollback, and garbage collection used in the config editor view.
 * Shapes match the backend config-handlers.ts response types.
 */

/** Structured metadata from a config git commit. */
export interface ConfigCommitMetadata {
  readonly section: string;
  readonly key?: string;
  readonly agent?: string;
  readonly user?: string;
  readonly summary: string;
}

/** Single entry in config version history. */
export interface ConfigHistoryEntry {
  readonly sha: string;
  readonly timestamp: string;
  readonly metadata: ConfigCommitMetadata;
  readonly message: string;
}

/** Response from config.history RPC. */
export interface ConfigHistoryResponse {
  readonly entries: ConfigHistoryEntry[];
  readonly error?: string;
}

/** Response from config.diff RPC (unified git diff format). */
export interface ConfigDiffResponse {
  readonly diff: string;
  readonly error?: string;
}

/** Response from config.rollback RPC. */
export interface ConfigRollbackResponse {
  readonly rolledBack: boolean;
  readonly sha: string;
  readonly newCommitSha: string;
  readonly restarting: boolean;
}

/** Response from config.gc RPC. */
export interface ConfigGcResponse {
  readonly gc: boolean;
  readonly squashed?: number;
  readonly newRootSha?: string;
}
