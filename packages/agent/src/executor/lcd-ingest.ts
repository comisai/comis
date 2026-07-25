// SPDX-License-Identifier: Apache-2.0
/**
 * LCD afterTurn ingest write-path (dag mode).
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
 *      `estimateMessageTokens` (which counts the `thinking` block) — the
 *      store NEVER computes tokens (the contract keeps core/memory free of
 *      the agent estimator dependency).
 *   3. STRUCTURED PARTS AFTER SECURITY PROJECTION: secret-bearing persistence
 *      values are redacted before `parts` pass through the core
 *      `messageToParts` codec. The remaining `metadata.raw` blocks + envelope
 *      keep their structure — NEVER flatten a `tool_use`/`tool_result` to text
 *      (flattening loses the stable id and breaks tool-result pairing on
 *      read-back).
 *
 * Idempotency is the CALLER's responsibility: it derives `startSeq` from the
 * store's persisted count and passes ONLY the not-yet-persisted delta. This
 * helper appends exactly `messages.length` rows starting at `startSeq`; an
 * empty delta appends nothing. The store's unique index on `(conversationRef,
 * seq)` is the final guard against a duplicate seq.
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope` TYPES + the core `messageToParts`
 * runtime codec. The concrete `createLcdStore` is injected by the daemon —
 * NEVER `import { createLcdStore } from "@comis/memory"` here.
 *
 * @module
 */

import { ConversationRefSchema, messageToParts } from "@comis/core"; // CORE codec + authority validator
import { stripInlineRecalledMemory } from "../rag/hybrid-memory-injector.js";
import { neutralizeForgedMarkersInMessage } from "../session/forged-context-markers.js";
import { projectSessionValueForPersistence } from "../session/sanitize-session-secrets.js";
import type { ContextStorePort, ContextStoreScope, ComisLogger, ErrorKind } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "../safety/token-estimator.js";

/**
 * Append a turn's NEW messages to the LCD store at the afterTurn boundary.
 * Non-fatal; tokenCount computed agent-side; structured parts pass through the
 * persistence projection and codec. See the module header for the full
 * contract.
 *
 * @param store    The injected core ContextStorePort (the concrete store is daemon-injected).
 * @param scope    The SECURITY scope columns (conversationRef/tenantId/agentId/sessionKey).
 * @param startSeq The first seq to assign — the caller derives it from the store's persisted count.
 * @param messages The NOT-YET-PERSISTED delta (the caller slices it against the store count).
 * @param now      Injected wall-clock ms (`deps.clock.now()` from the caller) — NOT Date.now().
 * @param logger   For the per-entry failure WARN + the success DEBUG.
 */
/**
 * Carve the TRANSIENT inline-recall block out of a USER message before it is
 * persisted (the lossless store must keep the conversation, not the per-turn
 * rendered prompt's recalled memory). The envelope-wrapper prepends the top-1 RAG
 * memory to the user text for the model; persisting it cross-contaminates the
 * session, bloats the store, and feeds back into later recall. Assistant /
 * toolResult messages never carry the prefix → pass through referentially
 * unchanged. Pure: returns a NEW message only when something was stripped, so the
 * common (no-recall) path keeps the verbatim original.
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
  let forgedMarkersStripped = 0;
  let persistenceRedactions = 0;
  for (const msg of messages) {
    // The agent message is structurally the pi-ai canonical Message at this
    // boundary; the codec + estimator are typed against pi-ai `Message`. Carve the
    // transient inline-recall block out of user turns BEFORE token-count + parts so
    // BOTH reflect the clean conversation (not the per-turn recalled prompt).
    const userStripped = stripRecallFromUserMessage(msg as unknown as Message);
    // Symmetric assistant-side defense: neutralize any forged context-boundary
    // markers (`[System context]` / `[End system context]` / a line-start
    // `[<channel>] <id> (<time>):` header) the model emitted in its OWN output, so
    // model-authored text can never re-enter replay history masquerading as a
    // system/user turn boundary.
    // Role-scoped + idempotent (see forged-context-markers.ts) → the clean path is
    // referentially unchanged and the replayed prefix stays byte-stable.
    const forged = neutralizeForgedMarkersInMessage(userStripped);
    const persistenceProjection = projectSessionValueForPersistence(forged.message);
    const m = persistenceProjection.value;
    persistenceRedactions += persistenceProjection.redactions;
    forgedMarkersStripped += forged.strippedCount;
    const currentSeq = seq;
    seq += 1;
    try {
      store.append({
        scope,
        seq: currentSeq,
        role: m.role, // "user" | "assistant" | "toolResult" (LcdRole)
        tokenCount: estimateMessageTokens(m), // agent-side (counts the thinking block) — store never computes it
        createdAt: now,
        parts: messageToParts(m), // structure preserved after secret projection
      });
      appended += 1;
    } catch (err) {
      // Non-fatal: an ingest failure degrades gracefully (no history persisted
      // this turn) but must NEVER crash the live turn. Per-entry
      // try/catch so a single bad message does not abort the rest of the batch.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          hint: "Check LCD store connectivity and disk space",
          errorKind: "dependency" as ErrorKind,
          conversationRef: scope.conversationRef,
          seq: currentSeq,
        },
        "LCD ingest append failed for one message (non-fatal)",
      );
    }
  }
  if (forgedMarkersStripped > 0) {
    // Operator-visible safety signal: the model emitted context-boundary markers
    // in its OWN output — a self-forgery attempt that was neutralized before it
    // could re-enter replay history. Counts only, no bodies. WARN (not DEBUG) so
    // it is visible at the default log level and can be lifted onto the
    // SystemHealthReport as a health_signal.
    logger.warn(
      {
        step: "lcd-ingest",
        conversationRef: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        forgedMarkersStripped,
        errorKind: "validation" as ErrorKind,
        hint: "assistant output contained inbound-envelope/system-context markers and was neutralized before persistence — the model attempted to fabricate a turn boundary in its own reply (self-forged context)",
      },
      "Neutralized forged context markers in assistant turn",
    );
  }
  if (persistenceRedactions > 0) {
    logger.info(
      {
        step: "lcd-ingest",
        conversationRef: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        redactions: persistenceRedactions,
      },
      "Redacted secret-bearing fields before LCD persistence",
    );
  }
  if (appended > 0) {
    // An operator can reconstruct what was
    // persisted per turn from this line alone. No message bodies — ids/counts only.
    logger.debug(
      {
        step: "lcd-ingest",
        conversationRef: scope.conversationRef,
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
 * Fail-closed rollover predicate: is `scope` safe to ingest a turn
 * under, or is it ambiguous/malformed and must REFUSE the write?
 *
 * Fail-closed posture: an ambiguous session rollover fails CLOSED — it
 * refuses the write rather than silently reattaching a turn's messages to the
 * WRONG (prior) conversation (the silent cross-session-merge threat).
 * Without this ambiguity guard, a malformed scope's append would proceed and
 * stamp cross-session-readable / mis-attached rows.
 *
 * Two refusal conditions (conservative — refuse, never guess):
 *  1. **Invalid authority column.** The opaque conversation reference must
 *     satisfy `ConversationRefSchema`; agentId / tenantId / sessionKey must
 *     tenantId / sessionKey MUST be a non-empty TRIMMED string (SECURITY
 *     columns must never be empty; mirrors the
 *     {@link ingestTurnGuarded} shrink-guard skip+WARN shape). An empty column produces
 *     a row reachable by an unrelated scope.
 *  2. The formatted session key remains display/path metadata. It is not storage
 *     authority and is therefore never compared with the opaque reference.
 *
 * Returns a discriminated result so the caller can log the specific `reason`.
 *
 * @param scope The SECURITY scope columns to validate.
 * @returns `{ ok: true }` when safe, else `{ ok: false; reason }`.
 */
export function isScopeSafeForIngest(
  scope: ContextStoreScope,
): { ok: true } | { ok: false; reason: string } {
  if (!ConversationRefSchema.safeParse(scope.conversationRef).success) {
    return { ok: false, reason: "invalid conversationRef" };
  }
  if (scope.agentId.trim() === "") return { ok: false, reason: "empty agentId" };
  if (scope.tenantId.trim() === "") return { ok: false, reason: "empty tenantId" };
  if (scope.sessionKey.trim() === "") return { ok: false, reason: "empty sessionKey" };
  return { ok: true };
}

/**
 * Derive a stable epoch anchor string from the identity of the first message
 * in the live array. Used to detect JSONL re-bases (the live transcript re-starting
 * from a fresh disjoint session).
 *
 * INVARIANT: live[0] is stable across all turns within a single epoch because
 * SDK compaction is disabled (the SDK never re-orders or removes messages within
 * a session). If SDK compaction were ever enabled, this invariant must be
 * re-evaluated.
 *
 * Collision safety: two messages must share role+timestamp+first-content-prefix to
 * produce the same anchor. This is safe: if a new epoch begins with a message
 * byte-identical to the old epoch's first message, the no-re-anchor path runs
 * live.slice(ingestedLiveLen) which is either a correct delta or a no-op.
 */
export function messageEpochAnchor(msg: AgentMessage): string {
  const m = msg as unknown as { role?: string; timestamp?: number; content?: unknown; toolCallId?: string };
  const role = m.role ?? "";
  const ts = String(m.timestamp ?? 0);
  let fp = "";
  const content = m.content;
  if (role === "toolResult") {
    fp = (m as unknown as { toolCallId?: string }).toolCallId ?? "";
  } else if (typeof content === "string") {
    fp = content.slice(0, 16);
  } else if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { type?: string; text?: string; name?: string };
    fp = first.text?.slice(0, 16) ?? first.name ?? first.type ?? "";
  }
  return `${role}:${ts}:${fp}`;
}

/**
 * Guarded afterTurn ingest: derive the not-yet-persisted delta from the durable
 * epoch cursor and append it — with three distinct guard paths:
 *
 * 1. **New epoch** (live[0] anchor differs from stored cursor, or no cursor yet):
 *    The live transcript re-based (JSONL deleted/re-created). Anchor at the
 *    store's current max seq and append the entire new live array as a
 *    continuation (closing the re-base gap). Emits onRebase("session_rebase").
 *
 * 2. **Genuine in-session shrink** (same anchor, live.length < cursor.ingestedLiveLen):
 *    A real heal/compaction shrank state.messages within the same epoch. SKIP +
 *    WARN (the original shrink fail-safe — unchanged). Emits onDivergence.
 *
 * 3. **Steady state** (same anchor, live grows monotonically): delta =
 *    live.slice(ingestedLiveLen). Byte-identical to the plain
 *    live.slice(persisted) path when ingestedLiveLen === persisted.
 *
 * Also refuses writes on an ambiguous/malformed scope (fail-closed rollover —
 * see {@link isScopeSafeForIngest}).
 *
 * ATOMICITY: `upsertIngestCursor` is called inside the same `store.runOnConversation`
 * lambda as the append (see executor-post-execution.ts call site). The single-flight
 * serializer guarantees cursor + rows are written in the same serialized slot.
 *
 * @param store        The injected core ContextStorePort.
 * @param scope        The SECURITY scope columns (conversationRef/tenantId/agentId/sessionKey).
 * @param live         The live canonical AgentMessage[] (the full conversation).
 * @param now          Injected wall-clock ms (`deps.clock.now()`).
 * @param logger       For the divergence WARN + the delegated ingest logs.
 * @param onFailClosed Optional callback fired ONLY on the fail-closed-rollover
 *                     refuse path, carrying the refusal `reason`. Never carries
 *                     message content; keeps this module bus-free.
 * @param onDivergence Optional callback fired ONLY on the genuine in-session
 *                     shrink skip, carrying `"live_store_divergence"`. Never carries
 *                     message content.
 * @param onRebase     Optional callback fired ONLY on an epoch re-base continuation,
 *                     carrying `"session_rebase"`. An INFO signal (correct continuation,
 *                     not degradation). Never carries message content.
 */
export function ingestTurnGuarded(
  store: ContextStorePort,
  scope: ContextStoreScope,
  live: AgentMessage[],
  now: number,
  logger: ComisLogger,
  onFailClosed?: (reason: string) => void,
  onDivergence?: (reason: string) => void,
  onRebase?: (reason: string) => void,
): void {
  // Fail-closed rollover: refuse the write on an ambiguous/malformed
  // scope BEFORE touching the store, so a mis-derived session key can never
  // silently reattach this turn's messages to a prior conversation.
  // Skip + WARN (errorKind precondition) — non-fatal, like the shrink guard below;
  // NEVER throw (the afterTurn path must not fail the live turn).
  const safe = isScopeSafeForIngest(scope);
  if (!safe.ok) {
    logger.warn(
      {
        conversationRef: scope.conversationRef,
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

  // Guard empty live array (nothing to ingest; no anchor to read —
  // messageEpochAnchor must not be called on live[0] when live is empty).
  if (live.length === 0) return;

  // Read the durable epoch cursor (null = no prior ingest for this conversation).
  const storedCursor = store.getIngestCursor(scope);

  // Compute the identity of the current live[0].
  const currentAnchor = messageEpochAnchor(live[0]!);

  // Epoch change detection — if the anchor differs from the stored cursor,
  // the live transcript has re-based (JSONL deleted/re-created).
  const isNewEpoch = storedCursor === null || storedCursor.epochAnchor !== currentAnchor;

  if (isNewEpoch) {
    // New epoch — re-base continuation.
    // The store's current message count is the seq base; we append from live[0].
    // getMessages is AGENT-SCOPED so each agent keeps an independent
    // seq sequence. The unique (conversation_id, agent_id, tenant_id, seq)
    // index is the per-agent backstop against duplicate seqs.
    const persisted = store.getMessages(scope).length;
    const delta = live; // ingest the entire new live array starting from live[0]
    ingestTurn(store, scope, persisted, delta, now, logger);
    // Persist the cursor INSIDE the same runOnConversation lambda (see call site).
    // Guarantees cursor + rows are written in the same serialized slot (atomicity).
    store.upsertIngestCursor(scope, { epochAnchor: currentAnchor, ingestedLiveLen: live.length }, now);
    // Emit the session_rebase signal (INFO — a correct continuation, not
    // degradation). onDivergence is NOT called (this is not a shrink/corruption).
    onRebase?.("session_rebase");
    return;
  }

  // Steady state or genuine shrink — same epoch (currentAnchor === storedCursor.epochAnchor).
  const { ingestedLiveLen } = storedCursor;

  if (live.length < ingestedLiveLen) {
    // Genuine in-session shrink (same epoch, live shorter than cursor).
    // This is the original shrink fail-safe — still skip + WARN so the divergence
    // is observable. onRebase is NOT called (this is not a re-base; the anchor matched).
    logger.warn(
      {
        conversationRef: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        liveLen: live.length,
        ingestedLiveLen,
        hint: "live array shorter than cursor ingestedLiveLen within the same epoch — skipping ingest to avoid seq collision; investigate any heal/compaction that shrank state.messages",
        errorKind: "precondition" as ErrorKind,
      },
      "LCD ingest skipped: live/store divergence",
    );
    // Let the agent-side caller emit a content-free context:dag_degraded
    // (reason: live_store_divergence) so the shrink divergence is queryable as a
    // health_signal, not log-file-only.
    onDivergence?.("live_store_divergence");
    return;
  }

  // Steady state — append only the delta (live.slice(ingestedLiveLen)).
  // When ingestedLiveLen === persisted (the common path), this is byte-identical
  // to the plain live.slice(persisted) behavior (pinned by the steady-state parity test).
  // persisted is AGENT-SCOPED via getMessages(scope).
  const persisted = store.getMessages(scope).length;
  const delta = live.slice(ingestedLiveLen);
  if (delta.length > 0) {
    ingestTurn(store, scope, persisted, delta, now, logger);
  }
  // Always update the cursor (even if delta is empty — keeps updatedAt fresh and
  // ensures ingestedLiveLen is authoritative for subsequent calls).
  store.upsertIngestCursor(scope, { epochAnchor: currentAnchor, ingestedLiveLen: live.length }, now);
}
