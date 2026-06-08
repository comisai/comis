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
import { stripInlineRecalledMemory } from "../rag/hybrid-memory-injector.js";
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
/**
 * Carve the TRANSIENT inline-recall block out of a USER message before it is
 * persisted (the F1 lossless store must keep the conversation, not the per-turn
 * rendered prompt's recalled memory). The envelope-wrapper prepends the top-1 RAG
 * memory to the user text for the model; persisting it cross-contaminates the
 * session, bloats the store, and feeds back into later recall. Assistant /
 * toolResult messages never carry the prefix → pass through referentially
 * unchanged. Pure: returns a NEW message only when something was stripped, so the
 * common (no-recall) path keeps the verbatim original (F1).
 */
function stripRecallFromUserMessage(m: Message): Message {
  if (m.role !== "user") return m;
  const content = (m as { content: unknown }).content;
  if (typeof content === "string") {
    const cleaned = stripInlineRecalledMemory(content);
    return cleaned === content ? m : ({ ...m, content: cleaned } as Message);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((b) => {
      // The recall is prepended to the message text → it rides the FIRST text block.
      if (!changed && b && (b as { type?: string }).type === "text") {
        const t = (b as { text: string }).text;
        const cleaned = stripInlineRecalledMemory(t);
        if (cleaned !== t) {
          changed = true;
          return { ...b, text: cleaned };
        }
      }
      return b;
    });
    return changed ? ({ ...m, content: next } as Message) : m;
  }
  return m;
}

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
    // boundary; the codec + estimator are typed against pi-ai `Message`. Carve the
    // transient inline-recall block out of user turns BEFORE token-count + parts so
    // BOTH reflect the clean conversation (not the per-turn recalled prompt) — F1.
    const m = stripRecallFromUserMessage(msg as unknown as Message);
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
 * R3 (132-04) fail-closed rollover predicate: is `scope` safe to ingest a turn
 * under, or is it ambiguous/malformed and must REFUSE the write?
 *
 * LOSSLESS-CLAW §5 posture: an ambiguous session rollover fails CLOSED — it
 * refuses the write rather than silently reattaching a turn's messages to the
 * WRONG (prior) conversation (the silent cross-session-merge threat,
 * T-132-04-02). This is the ambiguity guard the codebase lacked: today a
 * malformed scope's append proceeds and stamps cross-session-readable / mis-
 * attached rows.
 *
 * Two refusal conditions (conservative — refuse, never guess):
 *  1. **Empty/blank security column.** Each of conversationId / agentId /
 *     tenantId / sessionKey MUST be a non-empty TRIMMED string (mirrors the
 *     T-128-08 "SECURITY columns must never be empty" intent + the
 *     {@link ingestTurnGuarded} WR-01 skip+WARN shape). An empty column produces
 *     a row reachable by an unrelated scope.
 *  2. **conversationId ↔ sessionKey conflict.** The codebase invariant is
 *     `conversationId === sessionKey === formattedKey`
 *     (executor-post-execution.ts:894, where `conversationId = formattedKey` and
 *     `sessionKey: formattedKey`). A mismatch is internally inconsistent —
 *     refuse rather than GUESS which conversation to attach to.
 *
 * Returns a discriminated result so the caller can log the specific `reason`.
 *
 * @param scope The SECURITY scope columns to validate.
 * @returns `{ ok: true }` when safe, else `{ ok: false; reason }`.
 */
export function isScopeSafeForIngest(
  scope: ContextStoreScope,
): { ok: true } | { ok: false; reason: string } {
  // Condition 1: every security column must be a non-empty trimmed string.
  if (scope.conversationId.trim() === "") return { ok: false, reason: "empty conversationId" };
  if (scope.agentId.trim() === "") return { ok: false, reason: "empty agentId" };
  if (scope.tenantId.trim() === "") return { ok: false, reason: "empty tenantId" };
  if (scope.sessionKey.trim() === "") return { ok: false, reason: "empty sessionKey" };
  // Condition 2: conversationId must equal sessionKey (the formattedKey invariant).
  // A mismatch means the scope is internally inconsistent — refuse rather than
  // reattach to either candidate conversation (LOSSLESS-CLAW §5).
  if (scope.conversationId !== scope.sessionKey) {
    return { ok: false, reason: "conversationId/sessionKey conflict" };
  }
  return { ok: true };
}

/**
 * Guarded afterTurn ingest: derive the not-yet-persisted delta from the store's
 * persisted high-water mark and append it — but SKIP cleanly (with a WARN) when
 * the live array is SHORTER than the high-water mark (WR-01) OR when the scope is
 * ambiguous/malformed (R3 fail-closed rollover — see {@link isScopeSafeForIngest}).
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
 * @param store        The injected core ContextStorePort.
 * @param scope        The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param live         The live canonical AgentMessage[] (the full conversation).
 * @param now          Injected wall-clock ms (`deps.clock.now()`).
 * @param logger       For the divergence WARN + the delegated ingest logs.
 * @param onFailClosed Optional callback fired ONLY on the R3 fail-closed-rollover
 *                     refuse path (NOT the WR-01 shrink skip), carrying the
 *                     refusal `reason`. The agent-side call site uses it to emit
 *                     a content-free `context:dag_degraded` event (the eventBus
 *                     lives agent-side; this module stays bus-free). Never carries
 *                     message content.
 * @param onDivergence Optional callback fired ONLY on the WR-01 live/store-
 *                     divergence skip (the live array is shorter than the store
 *                     high-water mark), carrying the closed-meaning reason tag
 *                     (`"live_store_divergence"`). The agent-side caller turns it
 *                     into a content-free `context:dag_degraded` emit so the
 *                     divergence is queryable as a `health_signal` (Phase 160 I1)
 *                     rather than log-file-only. Never carries message content;
 *                     keeps this module bus-free (mirrors `onFailClosed`).
 */
export function ingestTurnGuarded(
  store: ContextStorePort,
  scope: ContextStoreScope,
  live: AgentMessage[],
  now: number,
  logger: ComisLogger,
  onFailClosed?: (reason: string) => void,
  onDivergence?: (reason: string) => void,
): void {
  // R3 (132-04) fail-closed rollover: refuse the write on an ambiguous/malformed
  // scope BEFORE touching the store, so a mis-derived session key can never
  // silently reattach this turn's messages to a prior conversation (T-132-04-02).
  // Skip + WARN (errorKind precondition) — non-fatal, like the WR-01 guard below;
  // NEVER throw (the afterTurn path must not fail the live turn).
  const safe = isScopeSafeForIngest(scope);
  if (!safe.ok) {
    logger.warn(
      {
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        errorKind: "precondition" as ErrorKind,
        hint: "ambiguous/malformed LCD scope — refusing the ingest write to avoid a cross-session reattach; check the session-key derivation",
      },
      "lcd ingest refused (fail-closed rollover)",
    );
    // Let the agent-side caller emit a content-free context:dag_degraded
    // (reason: fail_closed_rollover) — the reason string is a closed-meaning tag,
    // never message content.
    onFailClosed?.(safe.reason);
    return;
  }

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
    // Let the agent-side caller emit a content-free context:dag_degraded
    // (reason: live_store_divergence) so the WR-01 divergence is queryable as a
    // health_signal (Phase 160 I1), not log-file-only. Closed-meaning tag only —
    // NEVER message content (this module stays bus-free).
    onDivergence?.("live_store_divergence");
    return;
  }
  const delta = live.slice(persisted);
  ingestTurn(store, scope, persisted, delta, now, logger);
}
