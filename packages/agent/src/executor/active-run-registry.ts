// SPDX-License-Identifier: Apache-2.0
/**
 * ActiveRunRegistry: Tracks running PiExecutor sessions by conversation ref,
 * exposing SDK AgentSession steer/followUp/abort/streaming/compacting
 * handles to external consumers (e.g., channel manager).
 *
 * Purpose: The channel manager needs to know when a session is actively
 * executing and whether the SDK session can accept mid-stream steering.
 * This registry bridges the executor (which owns the AgentSession) and
 * the inbound pipeline (which decides how to route incoming messages).
 *
 * @module
 */

import type { ConversationRef } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Handle exposing steering capabilities of an active SDK AgentSession. */
export interface RunHandle {
  /** Inject a steering message into the active SDK session (mid-stream interrupt). */
  steer(text: string): Promise<void>;
  /** Queue a follow-up message for after the current run completes. */
  followUp(text: string): Promise<void>;
  /** Abort the current execution. */
  abort(): Promise<void>;
  /** Whether the SDK session is currently streaming an LLM response. */
  isStreaming(): boolean;
  /** Whether the SDK session is currently running auto-compaction. */
  isCompacting(): boolean;
}

/** Registry tracking active PiExecutor runs by opaque conversation authority. */
export interface ActiveRunRegistry {
  /** Register an active run. Returns false if the conversation is already registered. */
  register(conversationRef: ConversationRef, handle: RunHandle): boolean;
  /** Deregister an active run. No-op if not registered. */
  deregister(conversationRef: ConversationRef): void;
  /** Get the RunHandle for an active session, or undefined if not running. */
  get(conversationRef: ConversationRef): RunHandle | undefined;
  /** Check if a session has an active run. */
  has(conversationRef: ConversationRef): boolean;
  /** Number of active runs. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ActiveRunRegistry backed by an in-memory Map.
 *
 * - `register()` returns false if the key already exists (guards against
 *   concurrent execution for the same session -- the JSONL session adapter
 *   also guards this, but belt-and-suspenders).
 * - `deregister()` deletes the key silently (no error if missing).
 */
export function createActiveRunRegistry(): ActiveRunRegistry {
  const runs = new Map<ConversationRef, RunHandle>();

  return {
    register(conversationRef: ConversationRef, handle: RunHandle): boolean {
      if (runs.has(conversationRef)) {
        return false;
      }
      runs.set(conversationRef, handle);
      return true;
    },

    deregister(conversationRef: ConversationRef): void {
      runs.delete(conversationRef);
    },

    get(conversationRef: ConversationRef): RunHandle | undefined {
      return runs.get(conversationRef);
    },

    has(conversationRef: ConversationRef): boolean {
      return runs.has(conversationRef);
    },

    get size(): number {
      return runs.size;
    },
  };
}
