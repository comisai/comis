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
  LcdSummary,
  TypedEventBus,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEngineConfig } from "@comis/core";
import { ContextEngineConfigSchema } from "@comis/core";
import {
  selectLeafChunk,
  summarizeLeafChunk,
  MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
  type LeafChunkItem,
  type LeafSummarizerDeps,
} from "../context-engine/lcd-leaf-summarizer.js";
import { resolveCompactionStrategy } from "../context-engine/compaction-capability-router.js";
import { isSecurityRelevantMessage } from "../context-engine/security-context-pinner.js";
import {
  buildNanoStructuredExtraction,
  resolveSummaryTargetTokens,
} from "../context-engine/summarize-tier-targets.js";
import { LCD_MAX_LEAF_PASSES_PER_TURN } from "../context-engine/constants.js";
import type {
  CondenseChildSummary,
  SummaryRefRun,
} from "../context-engine/lcd-condense.js";

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
  /**
   * B-2: hard cap on leaf passes per afterTurn drain (the infinite-loop backstop).
   * The drain re-resolves the view each iteration and stops on the FIRST of:
   * utilization ≤ contextThreshold, a no-progress guard, OR this cap. Optional —
   * defaults to {@link LCD_MAX_LEAF_PASSES_PER_TURN} when absent so existing
   * single-pass callers/tests are unchanged (they get the bounded multi-pass drain
   * with the safe default). Set LOW: under `deferCompaction:false` each pass is a
   * synchronous LLM round-trip, so a turn must never fire unbounded summarizer calls.
   */
  maxLeafPassesPerTurn?: number;
}

/**
 * The model-facing context resolved from the `context_items` view (the SAME
 * source the assembler budgets, `lcd-assembler.ts:101-114,161-168`). This is the
 * single source of truth for BOTH the utilization gate (CR-02) and the chunk
 * selection / ordinal-window mapping (CR-01) — sourcing either half from the raw
 * lossless `getMessages()` set is the defect that let the trigger fire forever
 * (raw never shrinks) yet make no progress (it re-selects the already-collapsed
 * oldest and fails the ordinal-window lookup).
 */
export interface ResolvedContext {
  /**
   * The contiguous run of `message`-ref items, oldest-first, that FOLLOWS any
   * leading `summary`-refs (a leaf never re-summarizes a prior summary in 129;
   * summary-refs are depth-0 terminals). This is the pure input chunk selection
   * consumes — so `selectLeafChunk` always picks LIVE message-refs whose ids map
   * back to a `context_items` ordinal, and the second pass collapses the NEXT
   * chunk instead of re-hitting the first one.
   */
  history: LeafChunkItem[];
  /** Message id → its `context_items` ordinal (for the exact C3 window). */
  ordinalById: Map<string, number>;
  /**
   * Total tokens of the RESOLVED view = every summary-ref `tokenCount`
   * (`getSummaries`) + every message-ref `tokenCount` (the row). This is what the
   * model actually sees, so utilization reflects the compaction the trigger
   * performed (CR-02) — not the un-compacted raw history.
   */
  resolvedTokens: number;
  /**
   * The per-depth CONTIGUOUS summary-ref runs (Phase 130, C2 — RESEARCH Open Q2):
   * walking `context_items` in order, every maximal run of `summary`-refs sharing
   * one `depth` is one {@link SummaryRefRun}; a run BREAKS at any message-ref or a
   * depth change. The condense pass selects the shallowest run ≥ fanout from this
   * list — so utilization (CR-02), leaf selection (CR-01) AND condense selection
   * all come from the SAME single `getContextItems`/`getMessages`/`getSummaries`
   * read (the "one resolved view is source of truth" invariant). Because a run is
   * contiguous by construction, the condense window can never span a
   * non-contiguous fanout (Pitfall 3 / T-130-08).
   */
  summaryRunsByDepth: SummaryRefRun[];
  /**
   * The SAME oldest-first `getSummaries` snapshot the runs/utilization were
   * derived from (WR-01). The condense trigger reads `previousSummary` (the
   * most-recent same-depth summary content, for continuity) from THIS array —
   * never a second `getSummaries` call — so the whole pass observes one resolved
   * view and a later, possibly-diverged snapshot can never re-decide continuity.
   */
  summaries: LcdSummary[];
}

/**
 * Resolve the model-facing context from `context_items`. Token authority
 * (Pitfall 2): the STORED per-row/per-summary `tokenCount` (counts F3 thinking),
 * NOT a re-estimate of the reconstructed message (which would exclude thinking).
 * Mirrors the synthetic-session gate's `runOneLeafPass` driver — skip leading
 * summary-refs, take the contiguous message-ref run, and stop at the next summary
 * (never spanning a summary boundary so the persisted ordinal range stays
 * contiguous). Summary-ref tokens are summed across the WHOLE view for
 * utilization even though they are not selectable chunk items.
 */
export function resolveContext(store: ContextStorePort, scope: ContextStoreScope): ResolvedContext {
  // R4 (132-03): the three reads are scoped by (conversation, agent, tenant) so a
  // leaf/condense pass observes ONLY the acting agent's view (WR-02). `scope` is
  // the SAME scope the afterTurn ingest stamped; the assembler uses the matching
  // read scope, so trigger + assembler agree on what the agent sees.
  const items = store.getContextItems(scope);
  const rowById = new Map(store.getMessages(scope).map((r) => [r.id, r]));
  // Index summaries by id for BOTH the utilization token sum (CR-02) AND the
  // per-depth contiguous-run construction (C2): the run needs each child's
  // depth/content/tokenCount/taint, all on the `LcdSummary` row. Read
  // `getSummaries` ONCE here (WR-01) and carry the array out on `ResolvedContext`
  // so the trigger derives taint + previousSummary from this single snapshot.
  const summaries = store.getSummaries(scope);
  const summaryById = new Map(summaries.map((s) => [s.summaryId, s]));

  const history: LeafChunkItem[] = [];
  const ordinalById = new Map<string, number>();
  let resolvedTokens = 0;

  // Per-depth contiguous summary-ref run accumulation (C2). `summaryRunsByDepth`
  // collects every COMPLETED run; `openRun` is the run currently being extended
  // (flushed when the next item is a message-ref OR a summary-ref of a different
  // depth). The leaf `history`/`ordinalById`/`resolvedTokens` are UNCHANGED — the
  // condense data rides alongside on the SAME single walk (one resolved view).
  const summaryRunsByDepth: SummaryRefRun[] = [];
  let openRun: SummaryRefRun | undefined;
  const flushOpenRun = (): void => {
    if (openRun !== undefined) {
      summaryRunsByDepth.push(openRun);
      openRun = undefined;
    }
  };

  // The leaf-history collection STOPS after the first contiguous message run (it
  // never spans a summary boundary so the leaf window stays contiguous). The
  // condense-run + token accumulation walk the WHOLE view regardless — so a
  // Pitfall-3 layout `[s0 m1 s2 s3 s4]` still captures the trailing s2..s4 run
  // even though the leaf walk stopped at s2. One read, two derived views.
  let leafWalkStopped = false;

  for (const item of items) {
    if (item.refKind !== "message") {
      // A summary terminal. For utilization (CR-02) count its tokens across the
      // WHOLE view. For the CONDENSE half it is a candidate child: extend the open
      // same-depth run or start a new one (a depth change breaks the prior run).
      const summary = summaryById.get(item.refId);
      resolvedTokens += summary?.tokenCount ?? 0;

      if (summary !== undefined) {
        const childItem: CondenseChildSummary = {
          summaryId: summary.summaryId,
          ordinal: item.ordinal,
          depth: summary.depth,
          content: summary.content,
          tokenCount: summary.tokenCount,
          // Carry `taint` from THIS snapshot so the condense trigger reads
          // `taint = OR(children)` off the selected run — never a second,
          // possibly-diverged getSummaries read (WR-01).
          taint: summary.taint,
        };
        if (openRun !== undefined && openRun.depth === summary.depth) {
          openRun.children.push(childItem);
          openRun.endOrdinal = item.ordinal;
        } else {
          flushOpenRun();
          openRun = {
            depth: summary.depth,
            children: [childItem],
            startOrdinal: item.ordinal,
            endOrdinal: item.ordinal,
          };
        }
      }

      // LEAF-half contiguity (UNCHANGED semantics): skip a LEADING summary (an
      // already-collapsed oldest leaf); once the contiguous message run has
      // started, the leaf walk is DONE (never span across a summary). The condense
      // accumulation above already ran for this item, so the full summary-ref
      // prefix/suffix is captured even though the leaf walk stopped.
      if (history.length > 0) leafWalkStopped = true;
      continue;
    }
    // A message-ref breaks any open summary run (Pitfall 3: a run never spans a
    // surviving message-ref).
    flushOpenRun();
    const row = rowById.get(item.refId);
    if (row === undefined) continue;
    // Only collect leaf history for the FIRST contiguous message run (do not span
    // a summary boundary). resolvedTokens still sums every message-ref.
    if (!leafWalkStopped) {
      history.push({
        id: row.id,
        msg: partsToMessage(row) as unknown as AgentMessage,
        tokens: row.tokenCount,
        createdAt: row.createdAt,
      });
      ordinalById.set(row.id, item.ordinal);
    }
    resolvedTokens += row.tokenCount;
  }
  // Flush a run still open at the end of the view (a trailing summary-ref run).
  flushOpenRun();

  return { history, ordinalById, resolvedTokens, summaryRunsByDepth, summaries };
}

/**
 * The most recent leaf summary content (for continuity) — passed to the
 * summarizer as `previousSummary` (the 8th `generateSummary` param). The store
 * returns summaries oldest-first, so the LAST element is the most recent. R4
 * (132-03): the read is agent + tenant scoped via `scope` (WR-02).
 */
function previousSummaryContent(store: ContextStorePort, scope: ContextStoreScope): string | undefined {
  const summaries = store.getSummaries(scope);
  if (summaries.length === 0) return undefined;
  return summaries[summaries.length - 1]!.content;
}

/**
 * Map the selected chunk's first/last covered message id to the contiguous
 * `context_items` ordinal window `[startOrdinal, endOrdinal]` (the C3 window),
 * using the `ordinalById` map built by {@link resolveContext} from the SAME
 * resolved view the chunk was selected from. `startOrdinal` is the ordinal of
 * the chunk's FIRST message id; `endOrdinal` the LAST. Because both the chunk and
 * the map derive from one resolved `context_items` walk, the lookup always
 * succeeds for a selected message-ref — the divergence path is retained only as a
 * defensive guard against a future non-1:1 mapping (it never corrupts ordering).
 */
function chunkOrdinalWindow(
  ordinalById: Map<string, number>,
  firstMessageId: string,
  lastMessageId: string,
): { startOrdinal: number; endOrdinal: number } | undefined {
  const startOrdinal = ordinalById.get(firstMessageId);
  const endOrdinal = ordinalById.get(lastMessageId);
  if (startOrdinal === undefined || endOrdinal === undefined) return undefined;
  if (endOrdinal < startOrdinal) return undefined;
  return { startOrdinal, endOrdinal };
}

/**
 * The terminal outcome of one leaf pass — drives the B-2 drain loop. `made` is
 * true ONLY when a leaf summary was actually persisted (real progress); every
 * other `reason` is a no-progress / drained terminator that ends the loop.
 */
type LeafPassReason =
  | "compacted" // a leaf summary was persisted — real progress, keep draining.
  | "below-threshold" // the resolved view fits under contextThreshold — drained.
  | "empty-history" // no resolvable message-ref history — nothing to do.
  | "no-chunk" // no evictable out-of-tail history — nothing to do.
  | "too-small" // the oldest chunk is below MIN_SHRINKABLE — cannot shrink.
  | "divergence"; // the chunk ids did not resolve to an ordinal window (C3 guard).

interface LeafPassResult {
  /** True ⇒ a leaf summary was persisted this pass (the only "keep draining" case). */
  made: boolean;
  /** The terminal reason (for the drain loop + diagnosability). */
  reason: LeafPassReason;
}

/**
 * Run ONE leaf pass against the CURRENT store state and return whether it made
 * progress. Re-resolves the model-facing `context_items` view itself (CR-01/CR-02)
 * so a caller looping this observes its own prior compaction. Throws only on a
 * store/summarizer fault (the {@link maybeRunLeafPass} drain wraps the whole loop
 * in one try/catch so a throw in pass K never loses passes 1..K-1, which are
 * already committed atomically). All B-13 `lcd-leaf-gate` DEBUG lines live here so
 * they fire on EVERY drain iteration (a stalled drain stays diagnosable).
 */
async function runOneLeafPass(
  store: ContextStorePort,
  scope: ContextStoreScope,
  opts: LeafPassOptions,
  summarizerDeps: LeafSummarizerDeps,
  now: number,
  nowFn: (() => number) | undefined,
  logger: ComisLogger,
  eventBus: TypedEventBus | undefined,
): Promise<LeafPassResult> {
  const conversationId = scope.conversationId;
  // O1: per-pass START clock read (the injected clock CALLABLE — NEVER
  // Date.now()/performance.now(), the globals gate). A second read at emit gives
  // this pass's real elapsed; a scalar-only caller (no nowFn) degrades to 0.
  const passStart = nowFn?.() ?? now;

  // Resolve the model-facing context from context_items (CR-01/CR-02): the
  // utilization gate AND chunk selection both read this resolved view — never the
  // raw lossless getMessages() set — so the pass observes prior compaction (a view
  // that fits under threshold goes inert) and selects LIVE message-refs that
  // resolve to an ordinal window (it collapses the NEXT chunk, not the already-
  // summarized oldest).
  const { history, ordinalById, resolvedTokens } = resolveContext(store, scope);
  if (history.length === 0) { logger.debug({ conversationId, agentId: scope.agentId, step: "lcd-leaf-gate", reason: "empty-history", resolvedTokens, windowTokens: opts.windowTokens }, "lcd leaf pass gate skip"); return { made: false, reason: "empty-history" }; }

  // Utilization = resolved context tokens / W. The numerator is the RESOLVED view
  // (summary-ref tokens + surviving message-ref tokens), the same set the assembler
  // budgets — NOT the un-compacted raw history (which never shrinks). Tokens are
  // the stored authority (Pitfall 2): a re-estimate would EXCLUDE F3 thinking.
  const utilization = resolvedTokens / opts.windowTokens;
  logger.debug({ conversationId, agentId: scope.agentId, step: "lcd-leaf-gate", historyLength: history.length, resolvedTokens, windowTokens: opts.windowTokens, utilization: Math.round(utilization * 1000) / 1000, contextThreshold: opts.contextThreshold }, "lcd leaf pass evaluated");
  if (utilization <= opts.contextThreshold) return { made: false, reason: "below-threshold" }; // drained.

  // S4: build the set of security-pinned message ids (from markers on summarizerDeps).
  // These messages are never selected as eviction candidates (S4 invariant).
  let pinnedMessageIds: Set<string> | undefined;
  if (summarizerDeps.securityMarkers) {
    const pinned = history.filter((it) =>
      /* eslint-disable @typescript-eslint/no-explicit-any */
      isSecurityRelevantMessage(it.msg as any, summarizerDeps.securityMarkers!)
      /* eslint-enable @typescript-eslint/no-explicit-any */
    );
    if (pinned.length > 0) {
      pinnedMessageIds = new Set(pinned.map((it) => it.id));
      logger.debug(
        {
          conversationId,
          agentId: scope.agentId,
          step: "lcd-leaf-gate",
          securityPinnedCount: pinned.length,
        },
        "S4: security-relevant messages excluded from LCD leaf eviction",
      );
    }
  }

  // Select the oldest out-of-tail chunk (pair-safe, capped at leafChunkTokens)
  // from the RESOLVED message-ref run — so the selected ids always map back to a
  // context_items ordinal (the second-pass divergence is structurally gone).
  // S4: pass pinnedMessageIds so pinned messages are excluded from chunk selection.
  const chunk = selectLeafChunk(history, opts.freshTailTurns, opts.leafChunkTokens, pinnedMessageIds);
  if (chunk === undefined) return { made: false, reason: "no-chunk" }; // no evictable out-of-tail history.

  // Skip a trivially-tiny chunk (WR-01): a chunk below the minimum shrinkable size
  // cannot be replaced by any non-empty summary that is STRICTLY smaller, so
  // summarizing it would only emit a degenerate (empty/larger) leaf. This is also a
  // drain NO-PROGRESS terminator: a re-resolve would re-select the SAME sub-minimum
  // oldest run, so the loop must stop here (not spin).
  if (chunk.tokens < MIN_SHRINKABLE_LEAF_CHUNK_TOKENS) return { made: false, reason: "too-small" };

  // Map the chunk's message range → the contiguous context_items ordinal window
  // BEFORE summarizing (so a divergence skips cheaply, without an LLM call).
  const firstMessageId = chunk.messageIds[0]!;
  const lastMessageId = chunk.messageIds[chunk.messageIds.length - 1]!;
  const window = chunkOrdinalWindow(ordinalById, firstMessageId, lastMessageId);
  if (window === undefined) {
    // The selected message ids are not a resolvable message-ref window in the
    // current view (a divergence). Skip rather than corrupt ordinals (C3) — and end
    // the drain (a re-resolve would re-select the same unresolvable chunk).
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
    // Phase 160 I1: emit a content-free context:dag_degraded so the leaf-window
    // divergence persists as a health_signal row (queryable by the fleet lens)
    // instead of being a Pino-only WARN. Identifiers + reason + timing only —
    // NEVER message/summary content (mirrors the context:dag_compacted emit
    // below). Reuse the injected clock for durationMs/timestamp (the globals gate
    // bans Date.now()); a scalar-only caller degrades durationMs to 0.
    eventBus?.emit("context:dag_degraded", {
      conversationId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      reason: "leaf_window_divergence",
      durationMs: Math.max(0, (nowFn?.() ?? now) - passStart),
      timestamp: nowFn?.() ?? now,
    });
    return { made: false, reason: "divergence" };
  }

  // Build the chunk items in covered order (the summarizer + the leaf time-range
  // authority). The chunk's messageIds are seq-ordered; pair them to the matching
  // history items so the summarizer sees the verbatim reconstructed messages + their
  // stored tokenCounts.
  const idToItem = new Map(history.map((it) => [it.id, it]));
  const chunkItems: LeafChunkItem[] = chunk.messageIds
    .map((id) => idToItem.get(id))
    .filter((it): it is LeafChunkItem => it !== undefined);

  // C4/C5: resolve compaction strategy based on capability class.
  const compactionStrategy = resolveCompactionStrategy(
    summarizerDeps.capabilityClass ?? "frontier",
    summarizerDeps.preferEvictionByCapability ?? true,
    summarizerDeps.strongerSummarizerModel ?? "",
  );
  const securityPinnedCount = pinnedMessageIds?.size ?? 0;

  if (compactionStrategy === "eviction" || compactionStrategy === "deterministic") {
    // Small/nano: skip LLM summarization — use deterministic fallback.
    logger.warn(
      {
        conversationId,
        agentId: scope.agentId,
        hint: `C5: capabilityClass=${summarizerDeps.capabilityClass ?? "frontier"} prefers eviction — using deterministic fallback for LCD leaf pass`,
        errorKind: "config" as ErrorKind,
        capabilityClass: summarizerDeps.capabilityClass ?? "frontier",
        strategy: compactionStrategy,
      },
      "C5: LCD leaf compaction capability gate — eviction selected",
    );

    // Emit context:compaction_routed event
    eventBus?.emit("context:compaction_routed", {
      agentId: summarizerDeps.agentId ?? scope.agentId,
      sessionKey: summarizerDeps.sessionKey ?? scope.sessionKey,
      capabilityClass: summarizerDeps.capabilityClass ?? "frontier",
      strategy: compactionStrategy,
      layer: "lcd",
      securityPinnedCount,
      timestamp: now,
    });

    // Deterministic Level-3 fallback (SUM-02): nano structured extraction replaces
    // the bare count-note with decisions/files/entities/constraints. Still carries
    // LEAF_FALLBACK_SUMMARY_MARKER so DOC-01 scans detect it. Passes shrink invariant
    // (computeShrinkBounds guard inside buildNanoStructuredExtraction).
    const nanoExtraction = buildNanoStructuredExtraction(
      chunkItems.map((it) => it.msg),
      chunk.tokens,
    );
    const fallbackContent = nanoExtraction.content;
    const fallbackTokenCount = nanoExtraction.tokenCount;
    store.appendLeafSummary({
      scope,
      content: fallbackContent,
      descendantCount: chunkItems.length,
      earliestAt: chunkItems.length > 0 ? Math.min(...chunkItems.map((it) => it.createdAt)) : now,
      latestAt: chunkItems.length > 0 ? Math.max(...chunkItems.map((it) => it.createdAt)) : now,
      tokenCount: fallbackTokenCount,
      fileIds: [],
      fallback: true,
      taint: false,
      createdAt: now,
      startOrdinal: window.startOrdinal,
      endOrdinal: window.endOrdinal,
    });

    // O1 timing + dag_compacted event
    const durationMs = Math.max(0, (nowFn?.() ?? now) - passStart);
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
    logger.info(
      {
        step: "lcd-leaf",
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        descendantCount: chunkItems.length,
        escalationLevel: 3,
        fallback: true,
        durationMs,
      },
      "LCD leaf summary persisted (C5: deterministic eviction)",
    );
    return { made: true, reason: "compacted" };
  }

  // Emit context:compaction_routed for llm/strong-summarizer paths (observability)
  eventBus?.emit("context:compaction_routed", {
    agentId: summarizerDeps.agentId ?? scope.agentId,
    sessionKey: summarizerDeps.sessionKey ?? scope.sessionKey,
    capabilityClass: summarizerDeps.capabilityClass ?? "frontier",
    strategy: compactionStrategy,
    layer: "lcd",
    securityPinnedCount,
    timestamp: now,
  });

  // Summarize (3-level escalation; non-fatal inside — always returns a result).
  // SUM-02: resolve tier-aware effective leaf target (nano ≤256, small ≤400, mid ≤800, frontier uncapped).
  const effectiveLeafTarget = resolveSummaryTargetTokens(
    summarizerDeps.capabilityClass ?? "frontier",
    0, // leaf depth is always 0
    opts.leafTargetTokens,
  );
  const previousSummary = previousSummaryContent(store, scope);
  const result = await summarizeLeafChunk(chunkItems, summarizerDeps, {
    reserveTokens: effectiveLeafTarget,
    previousSummary,
  });

  // Persist + link + range-replace at the EXACT [startOrdinal, endOrdinal] window —
  // one atomic store transaction (C3). The store recomputes the covered-run
  // descendantCount/time-range; we pass the chunk values as advisory + the exact
  // window the summary-ref replaces.
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

  // O1 (Phase 133): real per-pass timing — a SECOND injected-clock read at emit
  // minus this pass's `passStart`. A scalar-only caller (no nowFn) degrades to 0.
  const durationMs = Math.max(0, (nowFn?.() ?? now) - passStart);
  // Emit the existing compaction event ONCE PER PASS (reuse, counts only — never
  // content; honest per-pass counts, Pitfall 3).
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
  return { made: true, reason: "compacted" };
}

/**
 * AfterTurn threshold sweep: a BOUNDED multi-pass leaf DRAIN (B-2). Loops
 * {@link runOneLeafPass} — re-resolving the model-facing view each iteration so it
 * observes its own compaction (CR-02) — until the FIRST of:
 *   - utilization ≤ `contextThreshold` (the view is drained — the success exit),
 *   - a no-progress guard fires (no chunk / chunk < MIN_SHRINKABLE / ordinal-window
 *     divergence — re-resolving would re-select the SAME chunk, so the loop stops),
 *   - the hard `maxLeafPassesPerTurn` cap is reached (the infinite-loop backstop).
 * It NEVER loops without one of these terminating it.
 *
 * Why bounded BOTH ways: under `deferCompaction:false` the afterTurn drain runs
 * INLINE + synchronously, so each pass is a real LLM round-trip blocking the live
 * turn — the cap guarantees a turn can never fire unbounded synchronous summarizer
 * calls. A sustained over-threshold load the cap can't fully drain in one turn keeps
 * draining on the NEXT afterTurn (the gate stays armed) rather than stalling at one
 * pass forever (the B-2 stall this replaces).
 *
 * Non-fatal end-to-end (mirrors `ingestTurnGuarded`): the WHOLE loop is wrapped in
 * one try/catch → WARN → return, so a throw in pass K never fails the live turn and
 * never loses passes 1..K-1 (each persisted atomically). See the module header.
 *
 * @param store          The injected core ContextStorePort (daemon-injected concrete store).
 * @param scope          The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param opts           The gating + sizing knobs from `config.contextEngine` (incl. the optional cap).
 * @param summarizerDeps The injected summarizer + model getters (the 132 spend-governance seam). Absent ⇒ no-op.
 * @param now            Injected wall-clock ms (`deps.clock.now()`) — NEVER the ambient time global. Stamps `timestamp`.
 * @param nowFn          Injected clock CALLABLE (`deps.clock.now`) for the per-pass timing reads (O1). Absent ⇒ durationMs 0.
 * @param logger         For the per-pass completion INFO + the non-fatal WARN.
 * @param eventBus       Optional bus to emit `context:dag_compacted` once per actual pass.
 */
export async function maybeRunLeafPass(
  store: ContextStorePort,
  scope: ContextStoreScope,
  opts: LeafPassOptions,
  summarizerDeps: LeafSummarizerDeps | undefined,
  now: number,
  nowFn: (() => number) | undefined,
  logger: ComisLogger,
  eventBus?: TypedEventBus,
): Promise<void> {
  // Gated on the summarizer deps + a positive window (a missing getter / model is a
  // clean skip, not a fault — mirrors the `deps.contextStore` ingest gate).
  if (summarizerDeps === undefined) { logger.debug({ conversationId: scope.conversationId, agentId: scope.agentId, step: "lcd-leaf-gate", reason: "no-summarizer-deps" }, "lcd leaf pass gate skip"); return; }
  if (!Number.isFinite(opts.windowTokens) || opts.windowTokens <= 0) { logger.debug({ conversationId: scope.conversationId, agentId: scope.agentId, step: "lcd-leaf-gate", reason: "bad-window", windowTokens: opts.windowTokens }, "lcd leaf pass gate skip"); return; }

  // The hard cap (the infinite-loop backstop): the supplied knob or the LOW default.
  // Clamp to >= 1 so a misconfigured 0/negative still attempts one pass (degenerate
  // single-pass — the prior behavior) rather than silently disabling compaction.
  const maxPasses = Math.max(1, Math.floor(opts.maxLeafPassesPerTurn ?? LCD_MAX_LEAF_PASSES_PER_TURN));
  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      const { made } = await runOneLeafPass(store, scope, opts, summarizerDeps, now, nowFn, logger, eventBus);
      if (!made) break; // drained / no-progress / divergence — stop (never spin).
    }
  } catch (err) {
    // Non-fatal (T-129-18): any failure degrades to a WARN + return — the live turn
    // is unaffected (mirror ingestTurnGuarded). errorKind `dependency` (a
    // summarizer/store failure is an external-dependency fault). Passes that already
    // committed before the throw are kept (each appendLeafSummary is atomic).
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId: scope.conversationId,
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
  /** SUMW-02: the turn's budget window — `computeTokenBudgetForProfile().windowTokens`
   *  = min(reconciled contextWindow, capability class cap), captured at the executor
   *  BEFORE any dispose (a plain number — dispose-safe on the deferred C4 path). The
   *  utilization denominator: one window truth with assembly + preflight. REQUIRED —
   *  an optional-with-fallback would silently restore the configured-window
   *  denominator (the DIST-01 4×-late-arming bug class). */
  budgetWindowTokens: number;
  /** Injected wall-clock ms (`deps.clock.now()`) — never the ambient time global. Stamps `timestamp`. */
  now: number;
  /** Injected clock CALLABLE (`deps.clock.now`) for the O1 two-read pass timing. Absent ⇒ durationMs 0. */
  nowFn?: () => number;
  /** For the trigger's completion INFO + non-fatal WARN. */
  logger: ComisLogger;
  /** Optional bus for the `context:dag_compacted` emit on a completed pass. */
  eventBus?: TypedEventBus;
}

/**
 * Thin afterTurn call-site wiring for the leaf pass: resolve the summarizer deps,
 * gate on their presence, build {@link LeafPassOptions} from `config.contextEngine`
 * (defaulted via `ContextEngineConfigSchema`) with `windowTokens` taken from the
 * threaded per-turn `budgetWindowTokens` (SUMW-02 — the SAME budget window the
 * assembler + preflight use, NOT the session model's configured window), then
 * delegate to {@link maybeRunLeafPass}.
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
  const { store, scope, contextEngine, getSummarizerDeps, budgetWindowTokens, now, nowFn, logger, eventBus } = params;
  // Gate: no summarizer-deps getter ⇒ the leaf pass is off (clean skip).
  if (getSummarizerDeps === undefined) return;
  const summarizerDeps = getSummarizerDeps();
  if (summarizerDeps === undefined) return;

  // Default the config the same way `setupContextEngine` does (line 141): an
  // absent contextEngine block resolves to the schema defaults (contextThreshold
  // 0.75, leafChunkTokens 20_000, leafTargetTokens 1_200, freshTailTurns 8).
  const cfg = contextEngine ?? ContextEngineConfigSchema.parse({});

  await maybeRunLeafPass(
    store,
    scope,
    {
      contextThreshold: cfg.contextThreshold,
      leafChunkTokens: cfg.leafChunkTokens,
      leafTargetTokens: cfg.leafTargetTokens,
      freshTailTurns: cfg.freshTailTurns,
      // SUMW-02: the utilization denominator W is the threaded per-turn budget
      // window (min(reconciled contextWindow, class cap)) — never the summarizer
      // snapshot's configured window, which armed ~4× late on capped small
      // models (DIST-01). The maybeRunLeafPass finite-positive gate is unchanged.
      windowTokens: budgetWindowTokens,
    },
    summarizerDeps,
    now,
    nowFn,
    logger,
    eventBus,
  );
}
