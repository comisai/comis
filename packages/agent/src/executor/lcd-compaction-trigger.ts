// SPDX-License-Identifier: Apache-2.0
/**
 * LCD afterTurn threshold-sweep trigger (Phase 129 dag-mode, C1/C3).
 *
 * Activates the previously-inert `contextThreshold` config: at the afterTurn
 * (`postExecution`) boundary, when context utilization exceeds
 * `contextThreshold` (0.75 × W by default), fire ONE leaf pass — select the
 * oldest out-of-tail chunk, summarize it (the Plan-03 3-level escalation), and
 * range-replace the covered `context_items` message-refs with one summary-ref at
 * the EXACT covered ordinal window (C3). Below the threshold, nothing fires (the
 * trigger is inert until load-bearing).
 *
 * Extracted into its own module because `executor-post-execution.ts` is already
 * over the 800L file-size cap — the call site there is a thin gated invocation
 * (mirroring how `ingestTurn` lives in `lcd-ingest.ts`); the body lives here.
 *
 * Three load-bearing contracts (mirroring `ingestTurnGuarded`):
 *   1. NON-FATAL: a summarizer / store failure must NEVER fail the live turn.
 *      The whole body is wrapped in one try/catch → WARN (errorKind
 *      `dependency`) and returns; the call site simply awaits a promise that
 *      never rejects (T-129-18). The leaf summarizer's own deterministic Level-3
 *      truncation is the in-pass degrade; a store failure is the outer degrade.
 *   2. AGENT-SIDE TOKENS: utilization + chunk-size use the STORED per-message
 *      `tokenCount` (computed at ingest via `estimateMessageTokens`, which counts
 *      the F3 `thinking` block — re-estimation under-counts); the persisted
 *      summary `tokenCount` is the leaf summarizer's `tokenCount`. The store
 *      NEVER computes tokens (the 127 contract keeps core/memory estimator-free).
 *   3. INJECTED CLOCK: every timestamp comes from the supplied `now`, never the
 *      ambient wall-clock global (the globals gate; AGENTS.md §2.2).
 *
 * The C3 ordinal mapping is the tampering guard (T-129-22): the
 * `[startOrdinal, endOrdinal]` window passed to `appendLeafSummary` is the
 * contiguous run of message-refs covering the selected chunk — `startOrdinal` is
 * the ordinal of the FIRST covered message-ref, `endOrdinal` the LAST. A wrong
 * window silently corrupts context_items ordering, so it is read back + asserted
 * in the RED test (`getContextItems` shows the summary-ref at `startOrdinal` with
 * `descendantCount == chunk length`).
 *
 * Bounded (T-129-19): ONE leaf pass per call. 129 fires inline + synchronously;
 * Phase 132 makes it deferred/background + adds bounded spend + a circuit breaker
 * — so the whole pass lives behind THIS one function for a clean 132 swap.
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope`/`LcdMessage` TYPES + the core
 * `partsToMessage` runtime codec + the agent-side leaf summarizer + token
 * estimator. The concrete `createLcdStore` is injected by the daemon — this
 * module NEVER imports the memory package directly (the build cut). It NEVER logs
 * message or summary content — ids/counts/durations/level only (AGENTS.md §2.2;
 * T-129-20).
 *
 * @module
 */

import { partsToMessage } from "@comis/core"; // CORE codec (the agent↛memory cut keeps the concrete store injected)
import type {
  ContextStorePort,
  ContextStoreScope,
  ComisLogger,
  ErrorKind,
  TypedEventBus,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEngineConfig } from "@comis/core";
import { ContextEngineConfigSchema } from "@comis/core";
import {
  selectLeafChunk,
  summarizeLeafChunk,
  type LeafChunkItem,
  type LeafSummarizerDeps,
} from "../context-engine/lcd-leaf-summarizer.js";

/**
 * The gating + sizing knobs for one leaf pass, sourced from `config.contextEngine`
 * at the call site. `contextThreshold` is the now-LOAD-BEARING utilization gate.
 */
export interface LeafPassOptions {
  /** Utilization fraction that triggers a leaf pass (`contextThreshold`, 0.75). */
  contextThreshold: number;
  /** Chunk token cap for one leaf (`leafChunkTokens`, 20_000). */
  leafChunkTokens: number;
  /** Summary token target (`leafTargetTokens`, 1_200) → the SDK `reserveTokens`. */
  leafTargetTokens: number;
  /** Trailing STEPS protected from eviction (`freshTailTurns`, 8 — a step count). */
  freshTailTurns: number;
  /** The model's context window W (the utilization denominator). */
  windowTokens: number;
}

/**
 * Reconstruct the conversation history from the store as `LeafChunkItem[]` — the
 * pure input the leaf summarizer's chunk selection consumes. Token authority
 * (Pitfall 2): the STORED per-message `tokenCount` (counts F3 thinking), NOT a
 * re-estimate of the reconstructed message (which would exclude thinking).
 */
function reconstructHistory(store: ContextStorePort, conversationId: string): LeafChunkItem[] {
  const rows = store.getMessages(conversationId);
  return rows.map((row) => ({
    id: row.id,
    msg: partsToMessage(row) as unknown as AgentMessage,
    tokens: row.tokenCount,
    createdAt: row.createdAt,
  }));
}

/**
 * The most recent leaf summary content (for continuity) — passed to the
 * summarizer as `previousSummary` (the 8th `generateSummary` param). The store
 * returns summaries oldest-first, so the LAST element is the most recent.
 */
function previousSummaryContent(store: ContextStorePort, conversationId: string): string | undefined {
  const summaries = store.getSummaries(conversationId);
  if (summaries.length === 0) return undefined;
  return summaries[summaries.length - 1]!.content;
}

/**
 * Map the selected chunk's first/last covered message id to the contiguous
 * `context_items` ordinal window `[startOrdinal, endOrdinal]` (the C3 window).
 * `startOrdinal` is the ordinal of the message-ref whose `refId` matches the
 * chunk's FIRST message id; `endOrdinal` the LAST. Returns `undefined` when
 * either endpoint is not a `message`-ref in the current view (a divergence the
 * caller treats as a skip rather than corrupting ordering).
 */
function chunkOrdinalWindow(
  store: ContextStorePort,
  conversationId: string,
  firstMessageId: string,
  lastMessageId: string,
): { startOrdinal: number; endOrdinal: number } | undefined {
  const items = store.getContextItems(conversationId);
  let startOrdinal: number | undefined;
  let endOrdinal: number | undefined;
  for (const item of items) {
    if (item.refKind !== "message") continue;
    if (item.refId === firstMessageId) startOrdinal = item.ordinal;
    if (item.refId === lastMessageId) endOrdinal = item.ordinal;
  }
  if (startOrdinal === undefined || endOrdinal === undefined) return undefined;
  if (endOrdinal < startOrdinal) return undefined;
  return { startOrdinal, endOrdinal };
}

/**
 * AfterTurn threshold sweep: fire ONE leaf pass when context utilization exceeds
 * `opts.contextThreshold`, otherwise no-op. Non-fatal end-to-end (mirrors
 * `ingestTurnGuarded`). See the module header for the full contract.
 *
 * @param store          The injected core ContextStorePort (daemon-injected concrete store).
 * @param scope          The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param opts           The gating + sizing knobs from `config.contextEngine`.
 * @param summarizerDeps The injected summarizer + model getters (the 132 spend-governance seam). Absent ⇒ no-op.
 * @param now            Injected wall-clock ms (`deps.clock.now()`) — NEVER the ambient time global.
 * @param logger         For the completion INFO + the non-fatal WARN.
 * @param eventBus       Optional bus to emit `context:dag_compacted` on a completed pass.
 */
export async function maybeRunLeafPass(
  store: ContextStorePort,
  scope: ContextStoreScope,
  opts: LeafPassOptions,
  summarizerDeps: LeafSummarizerDeps | undefined,
  now: number,
  logger: ComisLogger,
  eventBus?: TypedEventBus,
): Promise<void> {
  // Gated on the summarizer deps + a positive window (a missing getter / model
  // is a clean skip, not a fault — mirrors the `deps.contextStore` ingest gate).
  if (summarizerDeps === undefined) return;
  if (!Number.isFinite(opts.windowTokens) || opts.windowTokens <= 0) return;

  const conversationId = scope.conversationId;
  try {
    const history = reconstructHistory(store, conversationId);
    if (history.length === 0) return;

    // Utilization = total context tokens / W. The numerator uses the stored
    // per-message tokenCount (Pitfall 2) — estimateContextTokens over the
    // reconstructed messages would EXCLUDE F3 thinking and under-count, so sum
    // the stored authority directly.
    const totalTokens = history.reduce((acc, it) => acc + it.tokens, 0);
    const utilization = totalTokens / opts.windowTokens;
    if (utilization <= opts.contextThreshold) return; // inert below threshold.

    // Select the oldest out-of-tail chunk (pair-safe, capped at leafChunkTokens).
    const chunk = selectLeafChunk(history, opts.freshTailTurns, opts.leafChunkTokens);
    if (chunk === undefined) return; // no evictable out-of-tail history — no-op.

    // Map the chunk's message range → the contiguous context_items ordinal window
    // BEFORE summarizing (so a divergence skips cheaply, without an LLM call).
    const firstMessageId = chunk.messageIds[0]!;
    const lastMessageId = chunk.messageIds[chunk.messageIds.length - 1]!;
    const window = chunkOrdinalWindow(store, conversationId, firstMessageId, lastMessageId);
    if (window === undefined) {
      // The selected message ids are not a resolvable message-ref window in the
      // current view (a divergence). Skip rather than corrupt ordinals (C3).
      logger.warn(
        {
          conversationId,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          hint: "leaf chunk message ids did not resolve to a context_items ordinal window; skipping the pass to avoid corrupting ordering",
          errorKind: "precondition" as ErrorKind,
        },
        "LCD leaf pass skipped: ordinal-window divergence",
      );
      return;
    }

    // Build the chunk items in covered order (the summarizer + the leaf time-range
    // authority). The chunk's messageIds are seq-ordered; pair them to the
    // matching history items so the summarizer sees the verbatim reconstructed
    // messages + their stored tokenCounts.
    const idToItem = new Map(history.map((it) => [it.id, it]));
    const chunkItems: LeafChunkItem[] = chunk.messageIds
      .map((id) => idToItem.get(id))
      .filter((it): it is LeafChunkItem => it !== undefined);

    // Summarize (3-level escalation; non-fatal inside — always returns a result).
    const previousSummary = previousSummaryContent(store, conversationId);
    const result = await summarizeLeafChunk(chunkItems, summarizerDeps, {
      reserveTokens: opts.leafTargetTokens,
      previousSummary,
    });

    // Persist + link + range-replace at the EXACT [startOrdinal, endOrdinal]
    // window — one atomic store transaction (C3). The store recomputes the
    // covered-run descendantCount/time-range; we pass the chunk values as
    // advisory + the exact window the summary-ref replaces.
    store.appendLeafSummary({
      scope,
      content: result.content,
      descendantCount: result.descendantCount,
      earliestAt: result.earliestAt,
      latestAt: result.latestAt,
      tokenCount: result.tokenCount,
      fileIds: [],
      fallback: result.fallback,
      taint: false,
      createdAt: now,
      startOrdinal: window.startOrdinal,
      endOrdinal: window.endOrdinal,
    });

    // Inline synchronous pass in 129 — `durationMs` is 0 here (no second clock
    // read; the injected clock is the only time source and the ambient
    // wall-clock global is banned). Real pass-timing lands with deferred/background
    // execution in Phase 132/133. The field is present for payload-shape
    // compatibility with the existing `context:dag_compacted` event.
    const durationMs = 0;
    // Emit the existing compaction event (reuse, counts only — never content).
    eventBus?.emit("context:dag_compacted", {
      conversationId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      leafSummariesCreated: 1,
      condensedSummariesCreated: 0,
      maxDepthReached: 0,
      totalSummariesCreated: 1,
      durationMs,
      timestamp: now,
    });

    // Completion INFO (§2.7): ids/counts/level/durations only — NEVER content.
    logger.info(
      {
        step: "lcd-leaf",
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        descendantCount: result.descendantCount,
        escalationLevel: result.level,
        fallback: result.fallback,
        durationMs,
      },
      "LCD leaf summary persisted",
    );
  } catch (err) {
    // Non-fatal (T-129-18): any failure degrades to a WARN + return — the live
    // turn is unaffected (mirror ingestTurnGuarded). errorKind `dependency`
    // (a summarizer/store failure is an external-dependency fault).
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        hint: "LCD leaf pass failed; the turn is unaffected — check the summarizer model/key and LCD store connectivity",
        errorKind: "dependency" as ErrorKind,
      },
      "LCD leaf pass failed (non-fatal)",
    );
  }
}

/**
 * The minimal inputs the afterTurn call site threads into {@link runLeafPassAfterTurn}.
 * Keeping the wiring behind ONE param object lets `executor-post-execution.ts`
 * (already over the 800L cap) add a single thin gated call instead of building
 * the opts + resolving the summarizer deps inline.
 */
export interface RunLeafPassAfterTurnParams {
  /** The injected core ContextStorePort (the same store the ingest wrote to). */
  store: ContextStorePort;
  /** The SECURITY scope built once for the afterTurn ingest (reused verbatim). */
  scope: ContextStoreScope;
  /** `config.contextEngine` (may be undefined — defaulted via the schema here). */
  contextEngine: ContextEngineConfig | undefined;
  /**
   * Getter for the leaf summarizer deps (model getters + the injected summarizer
   * seam). ABSENT ⇒ the leaf pass is gated off cleanly (no trigger, no summary)
   * — the wiring gate, mirroring how the ingest gates on `deps.contextStore`.
   */
  getSummarizerDeps: (() => LeafSummarizerDeps) | undefined;
  /** Injected wall-clock ms (`deps.clock.now()`) — never the ambient time global. */
  now: number;
  /** For the trigger's completion INFO + non-fatal WARN. */
  logger: ComisLogger;
  /** Optional bus for the `context:dag_compacted` emit on a completed pass. */
  eventBus?: TypedEventBus;
}

/**
 * Thin afterTurn call-site wiring for the leaf pass: resolve the summarizer deps,
 * gate on their presence, build {@link LeafPassOptions} from `config.contextEngine`
 * (defaulted via `ContextEngineConfigSchema`) with `windowTokens` taken from the
 * summarizer's `getModel().contextWindow`, then delegate to {@link maybeRunLeafPass}.
 *
 * This is the single call `executor-post-execution.ts` adds inside its existing
 * `if (deps.contextStore)` block (after `ingestTurnGuarded`) — the body stays in
 * this module so the call site stays under the file-size cap. Non-fatal end to
 * end: {@link maybeRunLeafPass} never rejects, so awaiting this never surfaces an
 * error to the live turn.
 *
 * @param params - the minimal afterTurn inputs (see {@link RunLeafPassAfterTurnParams}).
 */
export async function runLeafPassAfterTurn(params: RunLeafPassAfterTurnParams): Promise<void> {
  const { store, scope, contextEngine, getSummarizerDeps, now, logger, eventBus } = params;
  // Gate: no summarizer-deps getter ⇒ the leaf pass is off (clean skip).
  if (getSummarizerDeps === undefined) return;
  const summarizerDeps = getSummarizerDeps();
  if (summarizerDeps === undefined) return;

  // Default the config the same way `setupContextEngine` does (line 141): an
  // absent contextEngine block resolves to the schema defaults (contextThreshold
  // 0.75, leafChunkTokens 20_000, leafTargetTokens 1_200, freshTailTurns 8).
  const cfg = contextEngine ?? ContextEngineConfigSchema.parse({});
  // The utilization denominator W is the model's context window from the
  // summarizer deps (the live model getter), NOT a config knob.
  const windowTokens = summarizerDeps.getModel().contextWindow;

  await maybeRunLeafPass(
    store,
    scope,
    {
      contextThreshold: cfg.contextThreshold,
      leafChunkTokens: cfg.leafChunkTokens,
      leafTargetTokens: cfg.leafTargetTokens,
      freshTailTurns: cfg.freshTailTurns,
      windowTokens,
    },
    summarizerDeps,
    now,
    logger,
    eventBus,
  );
}
