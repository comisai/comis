// SPDX-License-Identifier: Apache-2.0
/**
 * LCD afterTurn CONDENSE pass (Phase 130, C2) — the mirror of the leaf pass.
 *
 * Where {@link maybeRunLeafPass} (lcd-compaction-trigger.ts) folds a contiguous
 * run of raw MESSAGES into a depth-0 leaf, this pass folds a contiguous run of
 * ≥`condensedMinFanout` same-depth SUMMARIES into one coarser depth+1 condensed
 * summary — turning the single-tier LCD compaction into a multi-tier zoomable
 * hierarchy (C2). It runs AFTER the leaf pass at the afterTurn boundary, so a turn
 * that just created the Nth leaf can immediately fold it.
 *
 * It lives in its OWN module (not in lcd-compaction-trigger.ts) to keep that file
 * lean and the two passes separable; the SINGLE resolved-view walk
 * ({@link resolveContext}) lives in the trigger and returns BOTH the leaf history
 * and the per-depth contiguous summary-ref runs, so utilization + leaf selection
 * + condense selection all read ONE `getContextItems`/`getMessages`/`getSummaries`
 * snapshot (the CR-01/CR-02 "one resolved view is source of truth" invariant).
 *
 * Three load-bearing contracts (mirroring {@link maybeRunLeafPass}):
 *   1. NON-FATAL: a summarizer / store failure must NEVER fail the live turn —
 *      the whole body is wrapped in one try/catch → WARN (errorKind `dependency`)
 *      and returns; the awaiting call site simply awaits a promise that never
 *      rejects (T-130-07). The condense summarizer's own deterministic Level-3
 *      truncation is the in-pass degrade; a store failure is the outer degrade.
 *   2. AGENT-SIDE TOKENS: the before-size is the STORED `Σ child.tokenCount` (each
 *      child summary's persisted `tokenCount`); the persisted condensed
 *      `tokenCount` is the condense summarizer's `tokenCount`. The store NEVER
 *      computes tokens (the 127 contract).
 *   3. INJECTED CLOCK: the condensed `createdAt` comes from the supplied `now`,
 *      never the ambient wall-clock global (the globals gate; AGENTS.md §2.2).
 *
 * Pitfall 3 (contiguity) is enforced BY CONSTRUCTION: a {@link SummaryRefRun}
 * breaks at any message-ref or depth change, so {@link selectCondensableTier} can
 * only ever pick a CONTIGUOUS same-depth run, and the `[startOrdinal, endOrdinal]`
 * window is the run's own ordinals → the store range-replace cannot corrupt
 * ordering or merge a non-contiguous fanout (T-130-08).
 *
 * Bounded (T-130-06): ONE condense pass per call. 130 fires inline + synchronously
 * (mirrors the 129 leaf pass); deferred/background condensation + bounded spend +
 * a circuit breaker are Phase 132 — so the whole pass lives behind THIS one
 * function for a clean 132 swap (the SAME injected-summarizer seam as the leaf).
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope` TYPES + the agent-side condense
 * summarizer + the trigger's resolved-view walk. The concrete `createLcdStore` is
 * daemon-injected — this module NEVER imports the memory package directly. It
 * NEVER logs summary content — ids/counts/durations/level only (T-130-09).
 *
 * @module
 */

import type {
  ContextStorePort,
  ContextStoreScope,
  ComisLogger,
  ErrorKind,
  LcdSummary,
  TypedEventBus,
  ContextEngineConfig,
} from "@comis/core";
import { ContextEngineConfigSchema } from "@comis/core";
import {
  selectCondensableTier,
  summarizeCondensedChunk,
  type SummaryRefRun,
} from "../context-engine/lcd-condense.js";
import type { LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";
import { resolveContext } from "./lcd-compaction-trigger.js";

/**
 * The gating + sizing knobs for one condense pass, sourced from
 * `config.contextEngine` at the call site.
 */
export interface CondensePassOptions {
  /** Min contiguous same-depth fan-out that triggers condensation (`condensedMinFanout`, 4). */
  condensedMinFanout: number;
  /**
   * Hard minimum contiguous same-depth fan-out (`condensedMinFanoutHard`, 2) — the
   * LOWER bound that forces a condense when the soft `condensedMinFanout` has not
   * been met but context pressure is HIGH (utilization > `contextThreshold`).
   * Mirrors the leaf side's soft/hard knobs: the soft fanout governs the relaxed
   * case, the hard fanout keeps a pressured tier draining.
   */
  condensedMinFanoutHard: number;
  /**
   * Utilization fraction above which context pressure is HIGH (`contextThreshold`,
   * 0.75) — the SAME gate the leaf pass uses. At/below it the soft fanout governs;
   * above it `condensedMinFanoutHard` is allowed to force a condense.
   */
  contextThreshold: number;
  /** Condensed summary token target (`condensedTargetTokens`, 2_000) → the SDK `reserveTokens`. */
  condensedTargetTokens: number;
  /** The model's context window W (the utilization denominator + positive-window gate). */
  windowTokens: number;
}

/**
 * The most recent EXISTING summary at `depth` (for continuity) — passed to the
 * condense summarizer as `previousSummary`. Operates on the ALREADY-READ
 * oldest-first `getSummaries` snapshot from `resolveContext` (WR-01: one resolved
 * view is the source of truth — never a second store read), so the LAST
 * same-depth summary is the most recent. `undefined` when none exists yet at the
 * target depth.
 */
function previousSummaryAtDepth(summaries: LcdSummary[], depth: number): string | undefined {
  const atDepth = summaries.filter((s) => s.depth === depth);
  if (atDepth.length === 0) return undefined;
  return atDepth[atDepth.length - 1]!.content;
}

/**
 * AfterTurn condense pass: fold the DEEPEST contiguous run of summary-refs that
 * reaches the effective fanout (soft `condensedMinFanout`, or the hard
 * `condensedMinFanoutHard` under high context pressure) into one depth+1 condensed
 * summary, otherwise no-op — so the hierarchy climbs past depth 1 over successive
 * turns. Non-fatal end-to-end (mirrors {@link maybeRunLeafPass}). See the module
 * header for the full contract.
 *
 * @param store          The injected core ContextStorePort (daemon-injected concrete store).
 * @param scope          The SECURITY scope columns (conversationId/tenantId/agentId/sessionKey).
 * @param opts           The gating + sizing knobs from `config.contextEngine`.
 * @param summarizerDeps The injected summarizer + model getters (the 132 spend-governance seam). Absent ⇒ no-op.
 * @param now            Injected wall-clock ms (`deps.clock.now()`) — NEVER the ambient time global. Stamps `timestamp`.
 * @param nowFn          Injected clock CALLABLE (`deps.clock.now`) for the two pass-timing reads (O1). Absent ⇒ durationMs 0.
 * @param logger         For the completion INFO + the non-fatal WARN.
 * @param eventBus       Optional bus to emit `context:dag_compacted` on a completed pass.
 */
export async function maybeRunCondensePass(
  store: ContextStorePort,
  scope: ContextStoreScope,
  opts: CondensePassOptions,
  summarizerDeps: LeafSummarizerDeps | undefined,
  now: number,
  nowFn: (() => number) | undefined,
  logger: ComisLogger,
  eventBus?: TypedEventBus,
  onCondensed?: (summaryId: string, content: string, fallback: boolean, depth: number) => void,
): Promise<void> {
  // Gated on the summarizer deps + a positive window (a missing getter / model is
  // a clean skip, not a fault — mirrors the leaf gate).
  if (summarizerDeps === undefined) return;
  if (!Number.isFinite(opts.windowTokens) || opts.windowTokens <= 0) return;

  const conversationId = scope.conversationId;
  // O1: capture a pass-START clock read at entry (the injected clock CALLABLE —
  // NEVER Date.now()/performance.now(), the globals gate). The second read at
  // emit gives the real elapsed; a scalar-only caller degrades to 0.
  const passStart = nowFn?.() ?? now;
  try {
    // Resolve the model-facing context ONCE — the SAME walk the leaf pass uses,
    // now also returning the per-depth contiguous summary-ref runs + the
    // `getSummaries` snapshot (CR-01/CR-02 + WR-01: one resolved view is the
    // source of truth). The condense selection reads `summaryRunsByDepth`; taint
    // rides the selected children; `previousSummary` rides `summaries` — NO
    // second `getSummaries` call observes a possibly-diverged later snapshot.
    // R4 (132-03): resolveContext reads agent + tenant scoped (WR-02) via `scope`.
    const { summaryRunsByDepth, summaries, resolvedTokens } = resolveContext(store, scope);

    // Context pressure = resolved-view tokens / W — the SAME utilization the leaf
    // gate computes (CR-02). Above `contextThreshold` the condense selector drops to
    // the HARD fanout so a pressured tier still drains; at/below it the soft fanout
    // governs. The deepest qualifying run is selected so the hierarchy climbs past
    // depth 1 (depth-1→depth-2 fires once enough contiguous depth-1 summaries exist).
    const pressureHigh = resolvedTokens / opts.windowTokens > opts.contextThreshold;
    const run: SummaryRefRun | undefined = selectCondensableTier(
      summaryRunsByDepth,
      opts.condensedMinFanout,
      opts.condensedMinFanoutHard,
      pressureHigh,
    );
    if (run === undefined) return;

    // Defensive contiguity guard (the run is contiguous by construction, but keep
    // the same divergence guard shape as the leaf pass): a non-positive window is
    // a structural fault → skip + WARN rather than corrupt ordering.
    if (run.endOrdinal < run.startOrdinal) {
      logger.warn(
        {
          conversationId,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          hint: "condense run produced an inverted ordinal window; skipping the pass to avoid corrupting ordering",
          errorKind: "precondition" as ErrorKind,
        },
        "LCD condense pass skipped: ordinal-window divergence",
      );
      // Phase 160 I1: emit a content-free context:dag_degraded so the inverted-
      // window divergence persists as a health_signal row (queryable by the
      // fleet lens) instead of being a Pino-only WARN. Identifiers + reason +
      // timing only — NEVER summary content (mirrors the context:dag_compacted
      // emit below). Reuse the injected clock (the globals gate bans Date.now());
      // a scalar-only caller degrades durationMs to 0.
      eventBus?.emit("context:dag_degraded", {
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "condense_window_divergence",
        durationMs: Math.max(0, (nowFn?.() ?? now) - passStart),
        timestamp: nowFn?.() ?? now,
      });
      return;
    }

    // Derive the condensed node's metadata from the children (RESEARCH A6):
    // depth = max(child depth) + 1; taint = OR(children.taint); descendantCount /
    // time-range are recomputed STORE-SIDE from the child rows (advisory here).
    const depth = Math.max(...run.children.map((c) => c.depth)) + 1;
    const childSummaryIds = run.children.map((c) => c.summaryId);
    // taint = OR(children.taint): read taint off the SELECTED children — the
    // resolved-view `CondenseChildSummary` carries `taint` from the SAME
    // `getSummaries` snapshot the run was selected from (WR-01). A second
    // `getSummaries` call could observe a diverged later snapshot (the pass goes
    // deferred/async in Phase 132) and silently mis-propagate the trust boundary.
    // A tainted child taints the condensed parent (T-130; enforcement is Phase 132).
    const taint = run.children.some((c) => c.taint);

    // Summarize the child CONTENT via the 3-level escalation (non-fatal inside —
    // always returns a result). The before-size is the STORED Σ child tokenCount.
    // `previousSummary` reads the SAME resolved snapshot (WR-01) — not a re-query.
    const previousSummary = previousSummaryAtDepth(summaries, depth);
    const result = await summarizeCondensedChunk(run.children, summarizerDeps, {
      reserveTokens: opts.condensedTargetTokens,
      previousSummary,
      depth, // SUM-01: thread computed depth so d1/d2/d3+ prompt styles actually fire
    });

    // Persist + link + range-replace at the run's EXACT [startOrdinal, endOrdinal]
    // SUMMARY-ref window — one atomic store transaction (C2). The store recomputes
    // descendantCount + time-range from the child summary rows; depth/taint/
    // fallback/tokenCount/content come from here (the agent-side authority).
    // Capture the summaryId returned by appendCondensedSummary for the onCondensed
    // callback (Phase 172-02: the distillation hook seam).
    const summaryId = store.appendCondensedSummary({
      scope,
      content: result.content,
      tokenCount: result.tokenCount,
      // Advisory only — the store RECOMPUTES descendantCount (= Σ child
      // descendantCount) + time-range (min/max child earliest/latest) from the
      // child summary rows (the store is the authority, Plan 01). 0 / `now` are
      // placeholders the store ignores.
      descendantCount: 0,
      earliestAt: now,
      latestAt: now,
      fileIds: [],
      fallback: result.fallback,
      taint,
      createdAt: now,
      startOrdinal: run.startOrdinal,
      endOrdinal: run.endOrdinal,
      childSummaryIds,
      depth,
    });

    // Phase 172-02: fire the optional distillation hook immediately after the
    // condensed summary is persisted. Non-fatal — errors from the hook MUST NOT
    // propagate into the condense pass's own error handling (T-130-07).
    try {
      onCondensed?.(summaryId, result.content, result.fallback, depth);
    } catch (hookErr) {
      logger.warn(
        {
          err: hookErr instanceof Error ? hookErr.message : String(hookErr),
          conversationId,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          hint: "onCondensed callback threw — distillation hook error is non-fatal; condense pass is unaffected",
          errorKind: "dependency" as ErrorKind,
        },
        "onCondensed hook error (non-fatal)",
      );
    }

    // O1 (Phase 133): real pass-timing — a SECOND injected-clock read at emit
    // minus the pass-entry `passStart`. The injected clock is the only time
    // source (the ambient wall-clock global is banned); a scalar-only caller
    // (no `nowFn`) degrades to 0 (passStart === now). Clamped non-negative.
    const durationMs = Math.max(0, (nowFn?.() ?? now) - passStart);
    // Emit the existing compaction event with the REAL condensation metrics (the
    // leaf pass hardcodes condensedSummariesCreated:0 / maxDepthReached:0 — the
    // condense pass fills them). Counts only — never content.
    eventBus?.emit("context:dag_compacted", {
      conversationId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      leafSummariesCreated: 0,
      condensedSummariesCreated: 1,
      maxDepthReached: depth,
      totalSummariesCreated: 1,
      durationMs,
      timestamp: now,
    });

    // Completion INFO (§2.7): ids/counts/level/durations only — NEVER content.
    logger.info(
      {
        step: "lcd-condense",
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        childCount: run.children.length,
        depth,
        escalationLevel: result.level,
        fallback: result.fallback,
        durationMs,
      },
      "LCD condensed summary persisted",
    );
  } catch (err) {
    // Non-fatal (T-130-07): any failure degrades to a WARN + return — the live
    // turn is unaffected (mirror maybeRunLeafPass). errorKind `dependency` (a
    // summarizer/store failure is an external-dependency fault).
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        hint: "LCD condense pass failed; the turn is unaffected — check the summarizer model/key and LCD store connectivity",
        errorKind: "dependency" as ErrorKind,
      },
      "LCD condense pass failed (non-fatal)",
    );
  }
}

/**
 * The minimal inputs the afterTurn call site threads into
 * {@link runCondensePassAfterTurn}. Mirrors `RunLeafPassAfterTurnParams`.
 */
export interface RunCondensePassAfterTurnParams {
  /** The injected core ContextStorePort (the same store the leaf pass wrote to). */
  store: ContextStorePort;
  /** The SECURITY scope built once for the afterTurn ingest (reused verbatim). */
  scope: ContextStoreScope;
  /** `config.contextEngine` (may be undefined — defaulted via the schema here). */
  contextEngine: ContextEngineConfig | undefined;
  /**
   * Getter for the condense summarizer deps. REUSES the SAME `LeafSummarizerDeps`
   * the leaf pass uses (the `summarize` seam summarizes whatever messages it is
   * given — a leaf chunk OR a concatenated summary-of-summaries), so the call site
   * threads the existing `getSummarizerDeps`; no new daemon dep. ABSENT ⇒ the
   * condense pass is gated off cleanly (no trigger, no summary).
   */
  getCondenseSummarizerDeps: (() => LeafSummarizerDeps) | undefined;
  /** SUMW-02: the turn's budget window — `computeTokenBudgetForProfile().windowTokens`
   *  = min(reconciled contextWindow, capability class cap), captured at the executor
   *  BEFORE any dispose (a plain number — dispose-safe on the deferred C4 path). The
   *  utilization + pressureHigh denominator: one window truth with assembly +
   *  preflight. REQUIRED — an optional-with-fallback would silently restore the
   *  configured-window denominator (the DIST-01 4×-late-arming bug class). */
  budgetWindowTokens: number;
  /** Injected wall-clock ms (`deps.clock.now()`) — never the ambient time global. Stamps `timestamp`. */
  now: number;
  /** Injected clock CALLABLE (`deps.clock.now`) for the O1 two-read pass timing. Absent ⇒ durationMs 0. */
  nowFn?: () => number;
  /** For the trigger's completion INFO + non-fatal WARN. */
  logger: ComisLogger;
  /** Optional bus for the `context:dag_compacted` emit on a completed pass. */
  eventBus?: TypedEventBus;
  /**
   * Optional callback fired immediately after store.appendCondensedSummary returns.
   * Receives the new summaryId, content, fallback flag, and depth.
   * Phase 172-02 (DIST-01): this is the distillation hook seam — the runner fires
   * after each condensed summary is persisted.
   *
   * Non-fatal: callers MUST NOT depend on this callback throwing — if it throws,
   * the condense pass wraps it in its own try/catch and logs a WARN. Lower
   * blast radius than changing maybeRunCondensePass's return type.
   */
  onCondensed?: (summaryId: string, content: string, fallback: boolean, depth: number) => void;
}

/**
 * Thin afterTurn call-site wiring for the condense pass: resolve the condense
 * summarizer deps, gate on their presence, build {@link CondensePassOptions} from
 * `config.contextEngine` (defaulted via `ContextEngineConfigSchema`) with
 * `windowTokens` taken from the threaded per-turn `budgetWindowTokens` (SUMW-02 —
 * the SAME budget window the assembler + preflight use, NOT the session model's
 * configured window), then delegate to {@link maybeRunCondensePass}. Clones
 * `runLeafPassAfterTurn`.
 *
 * This is the single call `executor-post-execution.ts` adds AFTER
 * `runLeafPassAfterTurn` inside its existing `if (deps.contextStore)` block — so a
 * turn that just created the Nth leaf can immediately fold it. Non-fatal end to
 * end: {@link maybeRunCondensePass} never rejects.
 *
 * @param params - the minimal afterTurn inputs (see {@link RunCondensePassAfterTurnParams}).
 */
export async function runCondensePassAfterTurn(params: RunCondensePassAfterTurnParams): Promise<void> {
  const { store, scope, contextEngine, getCondenseSummarizerDeps, budgetWindowTokens, now, nowFn, logger, eventBus, onCondensed } = params;
  // Gate: no summarizer-deps getter ⇒ the condense pass is off (clean skip).
  if (getCondenseSummarizerDeps === undefined) return;
  const summarizerDeps = getCondenseSummarizerDeps();
  if (summarizerDeps === undefined) return;

  // Default the config the same way the leaf pass does: an absent contextEngine
  // block resolves to the schema defaults (condensedMinFanout 4,
  // condensedTargetTokens 2_000).
  const cfg = contextEngine ?? ContextEngineConfigSchema.parse({});

  await maybeRunCondensePass(
    store,
    scope,
    {
      condensedMinFanout: cfg.condensedMinFanout,
      condensedMinFanoutHard: cfg.condensedMinFanoutHard,
      contextThreshold: cfg.contextThreshold,
      condensedTargetTokens: cfg.condensedTargetTokens,
      // SUMW-02: the utilization + pressureHigh denominator W is the threaded
      // per-turn budget window (min(reconciled contextWindow, class cap)) —
      // never the summarizer snapshot's configured window, which kept the hard
      // fanout from ever firing on capped small models (DIST-01). The
      // maybeRunCondensePass finite-positive gate is unchanged.
      windowTokens: budgetWindowTokens,
    },
    summarizerDeps,
    now,
    nowFn,
    logger,
    eventBus,
    // Phase 172-02: thread the onCondensed distillation hook seam through to
    // maybeRunCondensePass. When present, fires with (summaryId, content, fallback,
    // depth) immediately after store.appendCondensedSummary returns.
    onCondensed,
  );
}
