// SPDX-License-Identifier: Apache-2.0
/**
 * SessionLane: Per-session queue state for command serialization.
 *
 * Each active session gets a dedicated lane with its own PQueue
 * (concurrency=1) to serialize agent executions. The lane tracks
 * pending messages, execution state, and last activity time for
 * idle cleanup.
 */

import type PQueue from "p-queue";
import type { NormalizedMessage } from "@comis/core";

export interface SessionLane {
  /** Per-session PQueue with concurrency=1 for serialized execution */
  readonly queue: PQueue;
  /** Messages accumulated in collect mode during active execution */
  pendingMessages: NormalizedMessage[];
  /** Whether the lane is currently executing an agent run */
  isExecuting: boolean;
  /** Timestamp of last activity (enqueue or execution end) for idle cleanup */
  lastActivityMs: number;
  /** Optional abort controller for steer mode cancellation */
  abortController?: AbortController;
}
