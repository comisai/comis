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
import type { NormalizedMessage, SessionKey } from "@comis/core";
import type { SourceTerminalScope } from "../source-message-terminal.js";
import type { InboundMessageProvenancePlan } from "@comis/agent";

/** Execution metadata owned by the lane for one handler invocation. */
export interface QueueExecutionContext {
  /** Aborted when steer or shutdown cancels the active lane execution. */
  readonly signal: AbortSignal;
  /** Earliest retained channel-ingress timestamp represented by this work. */
  readonly receivedAt: number;
  /** Exact-once lifecycle authority for every ingress represented by this work. */
  readonly sourceTerminalScope: SourceTerminalScope;
  /** Exact ingress occurrence plans represented by this queue execution. */
  readonly inboundProvenancePlans: readonly InboundMessageProvenancePlan[];
}

export type QueueMessageHandler = (
  messages: NormalizedMessage[],
  execution: QueueExecutionContext,
) => Promise<void>;

export type QueueAsyncScope = <T>(task: () => T) => T;

export interface QueueEntryOwnership {
  /** True after the queue enters the handler for this retained entry. */
  executionStarted: boolean;
  /** Prevents duplicate release across overflow, shutdown, and coalescing. */
  resourcesReleased: boolean;
  /** Release resources when queue ownership ends before pipeline cleanup. */
  readonly releaseResources?: () => void;
}

/**
 * One accepted inbound message and the execution ownership captured with it.
 * Keeping these fields together prevents coalescing/overflow from pairing one
 * message with another turn's handler or async request context.
 */
export interface QueuedMessageEntry {
  readonly message: NormalizedMessage;
  readonly inboundProvenancePlans: readonly InboundMessageProvenancePlan[];
  readonly sessionKey: SessionKey;
  readonly channelType: string;
  readonly enqueuedAt: number;
  readonly receivedAt: number;
  readonly logicalCount: number;
  readonly handler: QueueMessageHandler;
  readonly runInAsyncScope: QueueAsyncScope;
  /** Resource ownership retained when summaries replace the message payload. */
  readonly ownership: QueueEntryOwnership;
  /** Exact source tuple ownership retained across coalescing and shutdown. */
  readonly sourceTerminalScope: SourceTerminalScope;
}

export interface SessionLane {
  /** Public formatted session key shared by every principal-scoped lane. */
  readonly baseSessionKey: string;
  /** Shared base-session PQueue; principal lanes never execute concurrently. */
  readonly queue: PQueue;
  /** Atomic message entries accumulated during collect/steer execution. */
  pendingEntries: QueuedMessageEntry[];
  /** Accepted messages represented by active, queued, or collected work. */
  logicalDepth: number;
  /** Whether the lane is currently executing an agent run */
  isExecuting: boolean;
  /** Timestamp of last activity (enqueue or execution end) for idle cleanup */
  lastActivityMs: number;
  /** Optional abort controller for steer mode cancellation */
  abortController?: AbortController;
  /** Entry currently inside its handler, retained for shutdown terminalization. */
  activeEntry?: QueuedMessageEntry;
}
