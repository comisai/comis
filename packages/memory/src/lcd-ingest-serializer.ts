// SPDX-License-Identifier: Apache-2.0
/**
 * Per-conversation single-flight ingest serializer.
 *
 * The afterTurn leaf + condense compaction passes run DEFERRED — detached off the
 * turn, so afterTurn returns before the compaction's store write
 * completes. That introduces a SECOND writer to a conversation's lossless store
 * (the deferred compaction) which can race the NEXT turn's synchronous ingest on
 * the `(conversation_id, agent_id, tenant_id, seq)` unique index and the
 * `lcd_context_items` ordinals. This serializer is the integrity
 * boundary between them: BOTH the live ingest write AND the deferred compaction
 * write enqueue onto a per-conversation `PQueue({ concurrency: 1 })`, so on one
 * conversation they are strictly one-at-a-time and can never interleave.
 *
 * Per-conversation (NOT a single global lock): each conversationId lazily gets
 * its OWN queue, so operations on DIFFERENT conversations run concurrently — a
 * busy conversation never blocks an idle one. This mirrors the SHAPE of
 * `withSessionLock` (per-session lock file, no cross-session blocking) but is a
 * pure in-process ordering primitive (no filesystem, no lock contention).
 *
 * Infra-free by rule: `@comis/memory` has no infra-logging dependency and
 * AGENTS.md §2.4 forbids importing the infra logger directly. This module ONLY
 * orders writes — it does NOT log. The serialized-ingest-wait observability
 * (WARN + `context:dag_degraded`) is added agent-side where the injected
 * `ComisLogger` exists; the serializer stays a silent
 * ordering seam.
 *
 * `p-queue` is a `@comis/memory` dependency (the agent has none — the agent
 * reaches this queue through the `ContextStorePort.runOnConversation` port
 * method the store exposes, keeping the agent↛memory cut intact).
 *
 * @module
 */

import PQueue from "p-queue";

/**
 * The per-conversation single-flight serializer surface.
 *
 * `runOnConversation(convId, fn)` enqueues `fn` onto the queue dedicated to
 * `convId` and resolves to its return value (FIFO within a conversation). A
 * rejecting `fn` rejects this call's promise but frees the queue's single slot
 * so the next operation still runs — the queue is never wedged by a failure.
 */
export interface IngestSerializer {
  /**
   * Run `fn` on `conversationId`'s single-flight queue. Operations on the same
   * conversation are strictly serialized; operations on different conversations
   * run concurrently. Accepts a synchronous OR async `fn` (the live ingest's
   * better-sqlite3 `append` is synchronous; the deferred compaction is async).
   */
  runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Create a per-conversation single-flight serializer.
 *
 * Backed by a `Map<conversationId, PQueue>` where each queue has
 * `concurrency: 1` (single-flight). Queues are lazily created on first use for a
 * conversation and retained for the process lifetime (the conversation set is
 * bounded by the active sessions; an unbounded-growth eviction policy is a
 * deferred concern, not a correctness issue here).
 */
export function createIngestSerializer(): IngestSerializer {
  // One single-flight queue per conversationId. Lazily created; never a single
  // global queue (that would serialize UNRELATED conversations — the test
  // "different conversationIds run concurrently" guards against that regression).
  const queues = new Map<string, PQueue>();

  function queueFor(conversationId: string): PQueue {
    let queue = queues.get(conversationId);
    if (queue === undefined) {
      // concurrency: 1 ⇒ strictly one operation at a time for this conversation
      // (the single-flight invariant). A rejecting task frees the slot, so the
      // queue recovers (p-queue does not wedge on a rejected task).
      queue = new PQueue({ concurrency: 1 });
      queues.set(conversationId, queue);
    }
    return queue;
  }

  return {
    runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
      // p-queue's `add` returns Promise<T | void> (void when the task is
      // skipped, which only happens with throwOnTimeout/priority cancellation —
      // neither used here), so the cast to Promise<T> is sound for our usage.
      return queueFor(conversationId).add(() => fn()) as Promise<T>;
    },
  };
}
