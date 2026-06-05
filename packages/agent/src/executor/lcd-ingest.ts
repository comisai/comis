// SPDX-License-Identifier: Apache-2.0
/**
 * LCD afterTurn ingest write-path (Phase 128 dag-mode, A1).
 *
 * Appends a turn's NEW messages to the injected LCD `ContextStorePort` at the
 * `postExecution` (afterTurn) boundary. Extracted into its own module because
 * `executor-post-execution.ts` is already over the 800L file-size cap — the
 * call site there is a thin gated invocation; the body lives here.
 *
 * Three load-bearing contracts (mirroring the existing `memoryPort` afterTurn
 * persist idiom):
 *   1. NON-FATAL: an ingest failure must NEVER fail the live turn. Each append
 *      is wrapped per-entry (try/catch + log); the caller gates on
 *      `deps.contextStore` presence so a missing store skips cleanly.
 *   2. AGENT-SIDE TOKENS: `tokenCount` is computed here via
 *      `estimateMessageTokens` (which counts the F3 `thinking` block) — the
 *      store NEVER computes tokens (the 127 contract keeps core/memory free of
 *      the agent estimator dependency).
 *   3. VERBATIM PARTS: `parts` come from the core `messageToParts` codec
 *      (verbatim `metadata.raw` blocks + envelope) — NEVER flatten a
 *      `tool_use`/`tool_result` to text (the deleted dag-assembler loop bug).
 *
 * Idempotency is the CALLER's responsibility: it derives `startSeq` from the
 * store's persisted count and passes ONLY the not-yet-persisted delta. This
 * helper appends exactly `messages.length` rows starting at `startSeq`; an
 * empty delta appends nothing. The store's unique index on `(conversationId,
 * seq)` is the final guard against a duplicate seq (T-128-09).
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope` TYPES + the core `messageToParts`
 * runtime codec. The concrete `createLcdStore` is injected by the daemon —
 * NEVER `import { createLcdStore } from "@comis/memory"` here.
 *
 * @module
 */

import { messageToParts } from "@comis/core"; // CORE codec (allowed; the agent↛memory cut keeps the concrete store injected)
import type { ContextStorePort, ContextStoreScope, ComisLogger, ErrorKind } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "../safety/token-estimator.js";

/**
 * Append a turn's NEW messages to the LCD store at the afterTurn boundary
 * (A1 write-path). Non-fatal; tokenCount computed agent-side; parts verbatim
 * via the codec. See the module header for the full contract.
 *
 * @param store    The injected core ContextStorePort (the concrete store is daemon-injected).
 * @param scope    The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param startSeq The first seq to assign — the caller derives it from the store's persisted count.
 * @param messages The NOT-YET-PERSISTED delta (the caller slices it against the store count).
 * @param now      Injected wall-clock ms (`deps.clock.now()` from the caller) — NOT Date.now().
 * @param logger   For the per-entry failure WARN + the success DEBUG.
 */
export function ingestTurn(
  store: ContextStorePort,
  scope: ContextStoreScope,
  startSeq: number,
  messages: AgentMessage[],
  now: number,
  logger: ComisLogger,
): void {
  let seq = startSeq;
  let appended = 0;
  for (const msg of messages) {
    // The agent message is structurally the pi-ai canonical Message at this
    // boundary; the codec + estimator are typed against pi-ai `Message`.
    const m = msg as unknown as Message;
    const currentSeq = seq;
    seq += 1;
    try {
      store.append({
        scope,
        seq: currentSeq,
        role: m.role, // "user" | "assistant" | "toolResult" (LcdRole)
        tokenCount: estimateMessageTokens(m), // agent-side (F3 counts thinking) — store never computes it
        createdAt: now,
        parts: messageToParts(m), // verbatim metadata.raw blocks + envelope (F1)
      });
      appended += 1;
    } catch (err) {
      // Non-fatal: an ingest failure degrades gracefully (no history persisted
      // this turn) but must NEVER crash the live turn (T-128-10). Per-entry
      // try/catch so a single bad message does not abort the rest of the batch.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          hint: "Check LCD store connectivity and disk space",
          errorKind: "dependency" as ErrorKind,
          conversationId: scope.conversationId,
          seq: currentSeq,
        },
        "LCD ingest append failed for one message (non-fatal)",
      );
    }
  }
  if (appended > 0) {
    // Post-incident visibility (§2.7): an operator can reconstruct what was
    // persisted per turn from this line alone. No message bodies — ids/counts only.
    logger.debug(
      {
        step: "lcd-ingest",
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        appended,
        startSeq,
      },
      "LCD turn ingested",
    );
  }
}

/**
 * Guarded afterTurn ingest: derive the not-yet-persisted delta from the store's
 * persisted high-water mark and append it — but SKIP cleanly (with a WARN) when
 * the live array is SHORTER than the high-water mark (WR-01).
 *
 * The store is strictly append-only, so its count only grows; in steady state
 * the live array (`session.agent.state.messages`) is the full conversation and
 * leads the store by the in-flight turn's delta (`live.length >= persisted`),
 * and `delta = live.slice(persisted)` is the not-yet-persisted tail. But if a
 * future heal/compaction ever reassigns `state.messages` SMALLER than the store,
 * `live.slice(persisted)` is empty (a permanent history gap — the turn's real
 * messages are never persisted) or, on a rewritten tail, re-appends at a `seq`
 * that already exists — the unique `(conversationId, seq)` index throws, the
 * per-entry catch in {@link ingestTurn} swallows it, and the high-water mark
 * never advances past the collision. We detect that divergence and skip the
 * append, WARNing (errorKind `precondition` — an unmet guard-state, §2.7) so the
 * divergence is observable rather than silent.
 *
 * @param store    The injected core ContextStorePort.
 * @param scope    The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param live     The live canonical AgentMessage[] (the full conversation).
 * @param now      Injected wall-clock ms (`deps.clock.now()`).
 * @param logger   For the divergence WARN + the delegated ingest logs.
 */
export function ingestTurnGuarded(
  store: ContextStorePort,
  scope: ContextStoreScope,
  live: AgentMessage[],
  now: number,
  logger: ComisLogger,
): void {
  // R4 (132-03): the high-water mark is AGENT-SCOPED — getMessages(scope) counts
  // ONLY this agent's persisted rows, so each agent in a shared conversation owns
  // an independent seq sequence (WR-02). The unique (conversation_id, agent_id,
  // tenant_id, seq) index is the per-agent backstop against a duplicate seq.
  const persisted = store.getMessages(scope).length;
  if (live.length < persisted) {
    logger.warn(
      {
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        liveLen: live.length,
        persisted,
        hint: "live array shorter than the LCD store high-water mark — skipping ingest this turn to avoid a seq collision / silent history gap; investigate any heal/compaction that shrank state.messages",
        errorKind: "precondition" as ErrorKind,
      },
      "LCD ingest skipped: live/store divergence",
    );
    return;
  }
  const delta = live.slice(persisted);
  ingestTurn(store, scope, persisted, delta, now, logger);
}
