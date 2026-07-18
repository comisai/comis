// SPDX-License-Identifier: Apache-2.0
/**
 * LCD afterTurn CONDENSE pass — the mirror of the leaf pass.
 *
 * Where {@link maybeRunLeafPass} (lcd-compaction-trigger.ts) folds a contiguous
 * run of raw MESSAGES into a depth-0 leaf, this pass folds a contiguous run of
 * ≥`condensedMinFanout` same-depth SUMMARIES into one coarser depth+1 condensed
 * summary — turning the single-tier LCD compaction into a multi-tier zoomable
 * hierarchy. It runs AFTER the leaf pass at the afterTurn boundary, so a turn
 * that just created the Nth leaf can immediately fold it.
 *
 * It lives in its OWN module (not in lcd-compaction-trigger.ts) to keep that file
 * lean and the two passes separable; the SINGLE resolved-view walk
 * ({@link resolveContext}) lives in the trigger and returns BOTH the leaf history
 * and the per-depth contiguous summary-ref runs, so utilization + leaf selection
 * + condense selection all read ONE `getContextItems`/`getMessages`/`getSummaries`
 * snapshot (the "one resolved view is source of truth" invariant).
 *
 * Three load-bearing contracts (mirroring {@link maybeRunLeafPass}):
 *   1. NON-FATAL: a summarizer / store failure must NEVER fail the live turn —
 *      the whole body is wrapped in one try/catch → WARN (errorKind `dependency`)
 *      and returns; the awaiting call site simply awaits a promise that never
 *      rejects. The condense summarizer's own deterministic Level-3
 *      truncation is the in-pass degrade; a store failure is the outer degrade.
 *   2. AGENT-SIDE TOKENS: the before-size is the STORED `Σ child.tokenCount` (each
 *      child summary's persisted `tokenCount`); the persisted condensed
 *      `tokenCount` is the condense summarizer's `tokenCount`. The store NEVER
 *      computes tokens (the contract keeps core/memory estimator-free).
 *   3. INJECTED CLOCK: the condensed `createdAt` comes from the supplied `now`,
 *      never the ambient wall-clock global (the globals gate; AGENTS.md §2.2).
 *
 * Contiguity is enforced BY CONSTRUCTION: a {@link SummaryRefRun}
 * breaks at any message-ref or depth change, so {@link selectCondensableTier} can
 * only ever pick a CONTIGUOUS same-depth run, and the `[startOrdinal, endOrdinal]`
 * window is the run's own ordinals → the store range-replace cannot corrupt
 * ordering or merge a non-contiguous fanout.
 *
 * Bounded: ONE condense pass per call, fired inline + synchronously at the
 * afterTurn boundary (mirrors the leaf pass). The whole pass lives behind THIS
 * one function — the SAME injected-summarizer seam as the leaf — so
 * deferred/background scheduling or spend/breaker governance can swap in cleanly.
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope` TYPES + the agent-side condense
 * summarizer + the trigger's resolved-view walk. The concrete `createLcdStore` is
 * daemon-injected — this module NEVER imports the memory package directly. It
 * NEVER logs summary content — ids/counts/durations/level only.
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
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import {
  selectCondensableTier,
  summarizeCondensedChunk,
  type SummaryRefRun,
} from "../context-engine/lcd-condense.js";
import type { LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";
import { resolveSummarizerWindowTokens } from "../context-engine/summarizer-window.js";
import { SUMMARIZER_PROMPT_OVERHEAD_TOKENS } from "../context-engine/constants.js";
import { emitSummaryLanguageMismatch } from "../context-engine/compaction-zone-helpers.js";
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
 * oldest-first `getSummaries` snapshot from `resolveContext` (one resolved
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
 * @param summarizerDeps The injected summarizer + model getters (the spend-governance seam). Absent ⇒ no-op.
 * @param now            Injected wall-clock ms (`deps.clock.now()`) — NEVER the ambient time global. Stamps `timestamp`.
 * @param nowFn          Injected clock CALLABLE (`deps.clock.now`) for the two pass-timing reads. Absent ⇒ durationMs 0.
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
  if (!Number.isFinite(opts.windowTokens) || opts.windowTokens <= 0) {
    // Never silently disarm — leave the same one-line DEBUG
    // breadcrumb the leaf gate leaves, so a disarmed condense pass is
    // diagnosable from logs alone (invariant: no silent trigger disarm).
    logger.debug(
      { conversationId: scope.conversationId, agentId: scope.agentId, step: "lcd-condense-gate", reason: "bad-window", windowTokens: opts.windowTokens },
      "lcd condense pass gate skip",
    );
    return;
  }

  const conversationId = scope.conversationId;
  // Capture a pass-START clock read at entry (the injected clock CALLABLE —
  // NEVER Date.now()/performance.now(), the globals gate). The second read at
  // emit gives the real elapsed; a scalar-only caller degrades to 0.
  const passStart = nowFn?.() ?? now;
  try {
    // Resolve the model-facing context ONCE — the SAME walk the leaf pass uses,
    // now also returning the per-depth contiguous summary-ref runs + the
    // `getSummaries` snapshot (one resolved view is the
    // source of truth). The condense selection reads `summaryRunsByDepth`; taint
    // rides the selected children; `previousSummary` rides `summaries` — NO
    // second `getSummaries` call observes a possibly-diverged later snapshot.
    // Read isolation: resolveContext reads agent + tenant scoped via `scope`.
    const { summaryRunsByDepth, summaries, resolvedTokens } = resolveContext(store, scope);

    // Context pressure = resolved-view tokens / W — the SAME utilization the leaf
    // gate computes. Above `contextThreshold` the condense selector drops to
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
      // Emit a content-free context:dag_degraded so the inverted-
      // window divergence persists as a health_signal row (queryable by the
      // system health view) instead of being a Pino-only WARN. Identifiers + reason +
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

    // Prefix-trim the selected run to the LONGEST child prefix whose
    // Σ tokenCount fits the RESOLVED summarizer's window (override-aware via
    // resolveSummarizerWindowTokens — never the getModel() session-primary
    // snapshot) minus the condense target + prompt-template overhead + the
    // ACTUAL threaded previousSummary, so a condense pass never concatenates
    // more child tokens than the summarizer that actually runs can read.
    // Ordinal integrity: a prefix of a contiguous run stays
    // contiguous, so [startOrdinal, children[keep-1].ordinal] remains a valid
    // range-replace window and the trimmed children survive untouched in the
    // store for a later pass. The no-trim path is byte-identical
    // (effectiveRun === run); pressureHigh and selectCondensableTier are unchanged.
    const summarizerWindow = resolveSummarizerWindowTokens(summarizerDeps);
    // The target depth and its previousSummary are knowable
    // BEFORE the budget — a run's children share ONE depth by construction (a
    // SummaryRefRun breaks on any depth change), so the condensed depth is
    // run.depth + 1 regardless of how the trim lands. Subtract the ACTUAL
    // previousSummary tokens: the flat 2_048 overhead covers only the
    // instruction TEMPLATE, while previousSummary at this depth is
    // ~condensedTargetTokens-sized at defaults (2_000; the knob allows
    // 10_000) — a flat reserve alone is short by its own arithmetic and
    // overflows near-exactly-filled windows.
    const depth = run.depth + 1;
    const previousSummary = previousSummaryAtDepth(summaries, depth);
    const prevTokens = previousSummary === undefined
      ? 0
      : estimateMessageTokens({ role: "user", content: previousSummary } as Message);
    const childTokenBudget =
      summarizerWindow - opts.condensedTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prevTokens;
    let effectiveRun = run;
    if (Number.isFinite(childTokenBudget)) {
      let acc = 0;
      let keep = 0;
      for (const c of run.children) {
        if (acc + c.tokenCount > childTokenBudget) break;
        acc += c.tokenCount;
        keep++;
      }
      if (keep < run.children.length) {
        if (keep < 2) {
          // A 1-child condense is meaningless re-summarization — honest skip:
          // observable via a content-free DEBUG with both numbers,
          // never WARN spam, never a throw.
          logger.debug(
            { conversationId, agentId: scope.agentId, step: "lcd-condense-clamp", summarizerWindow, childTokenBudget, firstChildTokens: run.children[0]!.tokenCount },
            "lcd condense pass skipped: summarizer window cannot fit a 2-child run",
          );
          return;
        }
        // Deliberate: the fanout gate governs run SELECTION
        // only — a binding window trim may fold FEWER children than the soft
        // `condensedMinFanout` that selected the run (the tests pin fanout 4
        // selecting, 3 folding). Preferable to never condensing under a small
        // summarizer; the trimmed children survive for a later pass.
        effectiveRun = {
          depth: run.depth,
          children: run.children.slice(0, keep),
          startOrdinal: run.startOrdinal,
          endOrdinal: run.children[keep - 1]!.ordinal,
        };
        // Numbers only — per-pass DEBUG, never WARN (the trim is normal adaptive behavior).
        logger.debug(
          { conversationId, agentId: scope.agentId, step: "lcd-condense-clamp", summarizerWindow, childTokenBudget, keptChildren: keep, trimmedChildren: run.children.length - keep },
          "lcd condense run prefix-trimmed to the resolved summarizer window",
        );
      }
    }

    // Derive the rest of the condensed node's metadata from the KEPT children:
    // taint = OR(children.taint); descendantCount / time-range
    // are recomputed STORE-SIDE from the child rows (advisory here). depth was
    // derived above (run.depth + 1 — identical to max(child depth) + 1, since
    // the run's children share one depth by construction).
    const childSummaryIds = effectiveRun.children.map((c) => c.summaryId);
    // taint = OR(children.taint): read taint off the SELECTED children — the
    // resolved-view `CondenseChildSummary` carries `taint` from the SAME
    // `getSummaries` snapshot the run was selected from. A second
    // `getSummaries` call could observe a diverged later snapshot (the pass may
    // run deferred/async) and silently mis-propagate the trust boundary.
    // A tainted child taints the condensed parent.
    const taint = effectiveRun.children.some((c) => c.taint);

    // Summarize the child CONTENT via the 3-level escalation (non-fatal inside —
    // always returns a result). The before-size is the STORED Σ child tokenCount.
    // `previousSummary` is the SAME resolved-snapshot read the budget above
    // already accounted — never a re-query.
    const result = await summarizeCondensedChunk(effectiveRun.children, summarizerDeps, {
      reserveTokens: opts.condensedTargetTokens,
      previousSummary,
      depth, // Thread the computed depth so the d1/d2/d3+ prompt styles actually fire
    });

    // Persist + link + range-replace at the run's EXACT [startOrdinal, endOrdinal]
    // SUMMARY-ref window — one atomic store transaction. The store recomputes
    // descendantCount + time-range from the child summary rows; depth/taint/
    // fallback/tokenCount/content come from here (the agent-side authority).
    // Capture the summaryId returned by appendCondensedSummary for the onCondensed
    // callback (the distillation hook seam).
    const summaryId = store.appendCondensedSummary({
      scope,
      content: result.content,
      tokenCount: result.tokenCount,
      // Advisory only — the store RECOMPUTES descendantCount (= Σ child
      // descendantCount) + time-range (min/max child earliest/latest) from the
      // child summary rows (the store is the authority). 0 / `now` are
      // placeholders the store ignores.
      descendantCount: 0,
      earliestAt: now,
      latestAt: now,
      fileIds: [],
      fallback: result.fallback,
      taint,
      createdAt: now,
      startOrdinal: effectiveRun.startOrdinal,
      endOrdinal: effectiveRun.endOrdinal,
      childSummaryIds,
      depth,
    });

    // Fire the optional distillation hook immediately after the
    // condensed summary is persisted. Non-fatal — errors from the hook MUST NOT
    // propagate into the condense pass's own error handling.
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

    // The small-model language-mismatch detector at the condense depth — a
    // non-Latin run of children whose condensed summary came back Latin emits
    // context:summary_language_mismatch (depth = this condense depth). Source =
    // the children summaries' concatenated content (the SAME input the condense
    // summarizer saw). Visibility only — guarded, content-free, never fails the pass.
    emitSummaryLanguageMismatch(eventBus, logger, {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sourceText: effectiveRun.children.map((c) => c.content).join("\n\n"),
      summaryText: result.content,
      depth,
      nowMs: now,
    });

    // Real pass-timing — a SECOND injected-clock read at emit
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
        childCount: effectiveRun.children.length,
        depth,
        escalationLevel: result.level,
        fallback: result.fallback,
        durationMs,
      },
      "LCD condensed summary persisted",
    );
  } catch (err) {
    // Non-fatal: any failure degrades to a WARN + return — the live
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
  /** The turn's budget window — `computeTokenBudgetForProfile().windowTokens`
   *  = min(reconciled contextWindow, capability class cap), captured at the executor
   *  BEFORE any dispose (a plain number — dispose-safe on the deferred-compaction path). The
   *  utilization + pressureHigh denominator: one window truth with assembly +
   *  preflight. REQUIRED — an optional-with-fallback would silently restore the
   *  configured-window denominator, which arms ~4× late on capability-capped small models. */
  budgetWindowTokens: number;
  /** Injected wall-clock ms (`deps.clock.now()`) — never the ambient time global. Stamps `timestamp`. */
  now: number;
  /** Injected clock CALLABLE (`deps.clock.now`) for the two-read pass timing. Absent ⇒ durationMs 0. */
  nowFn?: () => number;
  /** For the trigger's completion INFO + non-fatal WARN. */
  logger: ComisLogger;
  /** Optional bus for the `context:dag_compacted` emit on a completed pass. */
  eventBus?: TypedEventBus;
  /**
   * Optional callback fired immediately after store.appendCondensedSummary returns.
   * Receives the new summaryId, content, fallback flag, and depth.
   * This is the distillation hook seam — the runner fires
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
 * `windowTokens` taken from the threaded per-turn `budgetWindowTokens` (the
 * SAME budget window the assembler + preflight use, NOT the session model's
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
      // The utilization + pressureHigh denominator W is the threaded
      // per-turn budget window (min(reconciled contextWindow, class cap)) —
      // never the summarizer snapshot's configured window, which would keep the
      // hard fanout from ever firing on capped small models. The
      // maybeRunCondensePass finite-positive gate is unchanged.
      windowTokens: budgetWindowTokens,
    },
    summarizerDeps,
    now,
    nowFn,
    logger,
    eventBus,
    // Thread the onCondensed distillation hook seam through to
    // maybeRunCondensePass. When present, fires with (summaryId, content, fallback,
    // depth) immediately after store.appendCondensedSummary returns.
    onCondensed,
  );
}
