// SPDX-License-Identifier: Apache-2.0
/**
 * LCD condensation unit (Phase 130, C2) — the depth>0 summary-of-summaries.
 *
 * The SIBLING of `lcd-leaf-summarizer.ts`. Where the leaf pass condenses a
 * contiguous run of raw MESSAGES into a depth-0 leaf, this module condenses a
 * contiguous run of same-depth SUMMARIES into one coarser depth+1 condensed
 * summary — turning the single-tier LCD compaction into a multi-tier zoomable
 * hierarchy. Two pure-ish responsibilities, both proven by a STUB summarizer
 * (no network):
 *
 *  1. {@link selectCondensableTier} — given the per-depth CONTIGUOUS summary-ref
 *     runs the trigger's resolved-view walk produces, return the DEEPEST depth
 *     whose contiguous run length ≥ the EFFECTIVE fanout (the soft
 *     `condensedMinFanout`, dropping to the hard `condensedMinFanoutHard` under
 *     high context pressure; ties broken by the OLDEST run = lowest `startOrdinal`).
 *     DEEPEST (not shallowest) is what lets the hierarchy climb past depth 1:
 *     depth-0 folds until a tier of contiguous depth-1 summaries reaches fanout,
 *     then THAT tier folds into depth-2, and so on. Returns `undefined` when no
 *     depth meets the effective fanout (the pass is a no-op). A run split by a
 *     message-ref is TWO separate runs (Pitfall 3): only a single contiguous run
 *     of length ≥ fanout qualifies — so the selected window can never span a
 *     non-contiguous fanout.
 *
 *  2. {@link summarizeCondensedChunk} — run the SAME mandatory 3-level escalation
 *     contract as `summarizeLeafChunk` (normal → aggressive → deterministic
 *     truncation), but with two differences: (a) the before-size is the STORED
 *     `Σ children.tokenCount` (NEVER a re-estimate of the concatenation — Pitfall
 *     2/5: the stored counts include F3 thinking the child leaves budgeted), and
 *     (b) the summarizer input is the child `content` strings (fed as ONE pseudo
 *     `user` message so the injected seam summarizes summaries-of-summaries). The
 *     produced `tokenCount` is ALWAYS strictly < `Σ children.tokenCount` (the
 *     escalation invariant) — an oversized/throwing summarizer falls through to a
 *     bounded, marker-prefixed Level-3 floor that re-uses the leaf's proven
 *     estimator-measured truncation loop (the WR-01/IN-03 fix: the BOUND is the
 *     token estimator itself, not a hand-derived chars-per-token ratio).
 *
 * The LLM summarizer is INJECTED via the SAME {@link LeafSummarizerDeps} seam the
 * leaf pass uses (the `summarize` function summarizes whatever messages it is
 * given — a leaf chunk OR a single concatenated summary-of-summaries), so Phase
 * 132 swaps spend governance / a circuit breaker in ONE place for both tiers and
 * the trigger threads no new daemon dependency.
 *
 * Architecture cut (agent↛memory): this file imports ONLY agent-side modules +
 * the SDK + core TYPES; it NEVER imports `@comis/memory` (the build cut, Pitfall
 * 7). It NEVER logs child `content` or the produced summary `content` — ids,
 * counts, level, and durations only (AGENTS.md §2.2; T-130-09). It reads NO wall
 * clock of its own — timestamps are derived purely upstream from the child rows.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import {
  COMPACTION_MAX_RETRIES,
  CONDENSED_FALLBACK_TARGET_TOKENS,
  CONDENSED_FALLBACK_SUMMARY_MARKER,
} from "./constants.js";
import {
  computeShrinkBounds,
  type LeafSummarizer,
  type LeafSummarizeOptions,
  type LeafSummarizerDeps,
} from "./lcd-leaf-summarizer.js";
import {
  estimateMessageTokens,
  estimateMessageChars,
} from "../safety/token-estimator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The injected condensation summarizer seam. Structurally IDENTICAL to
 * {@link LeafSummarizer} (the function summarizes whatever `AgentMessage[]` it is
 * handed — for condensation that is ONE pseudo-`user` message concatenating the
 * child summary content). Aliased (not re-declared) so the trigger can pass the
 * SAME `LeafSummarizerDeps` for both the leaf and condense passes (the Phase-132
 * spend-governance swap point is shared).
 */
export type CondenseSummarizer = LeafSummarizer;

/**
 * One selectable child summary in a condensable tier. Carries its stored token
 * authority (`tokenCount` — the before-size summand, NEVER re-estimated), its
 * `depth` (for the `depth = max(child)+1` derivation), its stable `summaryId`
 * (the `lcd_summary_parents` link + the child set), its `content` (the
 * summarizer input), its `context_items` `ordinal` (the contiguous window), and
 * its `taint` flag (the untrusted-content bit propagated to the condensed parent
 * as `taint = OR(children)`).
 */
export interface CondenseChildSummary {
  /** Stable summary id (the LCD `lcd_summaries.summaryId`) — linked as a child. */
  summaryId: string;
  /** The summary's `context_items` ordinal (the contiguous-run window authority). */
  ordinal: number;
  /** The summary's depth (0 for a leaf; >0 for a prior condensed). */
  depth: number;
  /** The summary plaintext (the summarizer input; NEVER logged). */
  content: string;
  /** Pre-computed stored token count (the before-size summand; NEVER re-estimated). */
  tokenCount: number;
  /**
   * Untrusted-content flag — propagated to the condensed parent (`taint = OR`).
   * Carried on the unit from the SINGLE resolved-view `getSummaries` snapshot so
   * the trigger derives `taint` WITHOUT a second store read (WR-01: the one
   * resolved view is the source of truth — a later, possibly-diverged snapshot
   * must never re-decide taint propagation).
   */
  taint: boolean;
}

/**
 * One CONTIGUOUS same-depth run of summary-refs in the resolved `context_items`
 * view. A run BREAKS at any message-ref or at a depth change, so every run is a
 * single contiguous window `[startOrdinal, endOrdinal]` — the structural Pitfall-3
 * guard (a non-contiguous fanout can never form one run).
 */
export interface SummaryRefRun {
  /** The shared depth of every child in this run. */
  depth: number;
  /** The contiguous child summaries, oldest-first (ascending ordinal). */
  children: CondenseChildSummary[];
  /** The `context_items` ordinal of the FIRST child (the window start). */
  startOrdinal: number;
  /** The `context_items` ordinal of the LAST child (the window end). */
  endOrdinal: number;
}

/**
 * Result of a condensation pass. Mirrors `LeafSummaryResult`'s escalation fields
 * (the coverage metadata is recomputed store-side from the child rows, so it is
 * NOT carried here — only the escalation outcome the caller persists).
 */
export interface CondenseSummaryResult {
  /** The condensed summary text (a plain string; the assembler wraps it). */
  content: string;
  /** Which escalation level produced the summary. */
  level: 1 | 2 | 3;
  /** True only for the deterministic Level-3 truncation (carries the marker). */
  fallback: boolean;
  /** Token count of the produced summary (always < Σ child tokenCount). */
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

/**
 * Select the DEEPEST contiguous same-depth run whose length ≥ the EFFECTIVE
 * fanout, so the hierarchy actually grows past depth 1. The effective fanout is
 * the soft `condensedMinFanout` normally, dropping to the hard
 * `condensedMinFanoutHard` lower bound when context pressure is HIGH
 * (`pressureHigh`) — mirroring the leaf side's soft/hard knobs. Ties (multiple
 * qualifying runs at the same deepest depth — a Pitfall-3 layout where one depth
 * has several disjoint runs) break by the OLDEST run (lowest `startOrdinal`).
 * Returns `undefined` when no run meets the effective fanout (the pass is a no-op).
 *
 * DEEPEST, not shallowest (the FIX): selecting the shallowest always re-folded the
 * depth-0 leaves a turn keeps producing, so an accumulated contiguous run of
 * depth-1 summaries was never folded into depth-2 — max depth stuck at 1 forever.
 * Preferring the deepest QUALIFYING run means depth-0 keeps folding until a tier of
 * ≥fanout contiguous depth-1 summaries exists, at which point THAT tier (now the
 * deepest qualifying run) folds into depth-2, and so on — a bounded, monotone climb
 * (each pass either deepens the tree or drains a tier; never both, never a loop).
 *
 * Because every {@link SummaryRefRun} is contiguous by construction (the
 * resolved-view walk breaks a run at any message-ref or depth change), the
 * returned run's `[startOrdinal, endOrdinal]` is always a contiguous
 * `context_items` window — a non-contiguous fanout can NEVER be selected
 * (Pitfall 3 / T-130-08).
 *
 * @param runs - the per-depth contiguous summary-ref runs from the resolved view
 * @param condensedMinFanout - the SOFT minimum run length (relaxed-pressure trigger)
 * @param condensedMinFanoutHard - the HARD minimum run length (forced under pressure)
 * @param pressureHigh - true ⇒ utilization > contextThreshold ⇒ use the hard fanout
 * @returns the deepest oldest qualifying run, or `undefined`
 */
export function selectCondensableTier(
  runs: SummaryRefRun[],
  condensedMinFanout: number,
  condensedMinFanoutHard: number,
  pressureHigh: boolean,
): SummaryRefRun | undefined {
  // Under HIGH pressure the hard (lower) bound forces a condense the soft fanout
  // would skip; otherwise the soft fanout governs. Clamp to ≥1 defensively (the
  // schema floors both at 2, but a degenerate 0 must never select an empty run).
  const effectiveFanout = Math.max(1, pressureHigh ? condensedMinFanoutHard : condensedMinFanout);
  let best: SummaryRefRun | undefined;
  for (const run of runs) {
    if (run.children.length < effectiveFanout) continue;
    if (best === undefined) {
      best = run;
      continue;
    }
    // DEEPEST depth wins; tie → the oldest run (lowest startOrdinal).
    if (run.depth > best.depth) best = run;
    else if (run.depth === best.depth && run.startOrdinal < best.startOrdinal) best = run;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3-level escalation (mirrors summarizeLeafChunk)
// ---------------------------------------------------------------------------

/**
 * Condense a contiguous run of child summaries via the mandatory 3-level
 * escalation. ALWAYS returns a summary whose token count is STRICTLY LESS than
 * the run's `Σ children.tokenCount` (the C2 escalation invariant) — accepting an
 * LLM summary only when it actually reduces, and otherwise falling through to the
 * deterministic, bounded Level-3 truncation.
 *
 * Unlike `summarizeLeafChunk`, the summarizer input is the child `content`
 * strings concatenated into ONE pseudo-`user` message (a summary OF summaries)
 * and the before-size is the STORED `Σ children.tokenCount` — NEVER a re-estimate
 * of the concatenation (Pitfall 2/5: the stored counts include the F3 thinking
 * the child leaves budgeted at their own write time).
 *
 * B-4 (260605-ney): the EFFECTIVE summarize target is bounded below the run's
 * rendered shrink ceiling ({@link computeShrinkBounds}) so the model is never asked
 * to write more than it compresses (the spurious-floor fix mirrored from the leaf),
 * and the accept-test ceiling is the RENDERED 4:1 measure — self-consistent with
 * the candidate's units. The STORED `Σ children.tokenCount` stays the budget /
 * floor authority: the deterministic Level-3 floor must still beat it.
 *
 * @param children - the contiguous child summaries (stored tokenCounts + content)
 * @param deps - the injected summarizer + model getters + logger (shared with leaf)
 * @param opts - reserveTokens (= condensedTargetTokens) + optional previousSummary
 * @returns the condensed summary + escalation level + token count
 */
export async function summarizeCondensedChunk(
  children: CondenseChildSummary[],
  deps: LeafSummarizerDeps,
  opts: { reserveTokens: number; previousSummary?: string; depth?: number },
): Promise<CondenseSummaryResult> {
  // Before-size authority: the STORED per-child tokenCounts (Pitfall 2/5) — NOT a
  // re-estimate of the concatenation (which would exclude the F3 thinking the
  // child leaves counted, under-stating the chunk and risking a non-shrinking
  // "reduction" that is actually larger than the real covered tokens). This stays
  // the BUDGET / floor authority — the deterministic Level-3 floor still beats it.
  const beforeTokens = children.reduce((acc, c) => acc + c.tokenCount, 0);
  // The ONE pseudo-message the injected summarizer sees: the child summary
  // content strings, clearly separated. A summary OF summaries.
  const pseudoMessage = buildCondenseInput(children);

  // B-4 (260605-ney): self-consistent shrink bounds from the run's RENDERED chars
  // (the one concatenated pseudo-message — already prose). The accept ceiling is
  // measured the SAME way the candidate is (4:1), and the EFFECTIVE target is
  // bounded below the run so the summarizer is never asked to write more than it
  // compresses (the dominant fix mirrored from the leaf tier).
  const renderedChars = estimateMessageChars(pseudoMessage as unknown as Message);
  const { shrinkCeilingTokens, effectiveReserveTokens } = computeShrinkBounds(
    renderedChars,
    opts.reserveTokens,
  );

  // --- Level 1: full summarization, up to 1 + COMPACTION_MAX_RETRIES attempts.
  //     Accept ONLY when the summary is strictly smaller than the rendered-4:1
  //     ceiling (self-consistent units), with the EFFECTIVE bounded target.
  const maxAttempts = 1 + COMPACTION_MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const accepted = await tryCondenseLevel(
      deps,
      pseudoMessage,
      { reserveTokens: effectiveReserveTokens, previousSummary: opts.previousSummary, depth: opts.depth },
      shrinkCeilingTokens,
      attempt,
    );
    if (accepted !== undefined) {
      return { content: accepted.content, level: 1, fallback: false, tokenCount: accepted.tokenCount };
    }
  }

  // --- Level 2: aggressive — one best-effort terser retry over the SAME input
  //     (there is no oversized-message filter at the condense tier: the input is
  //     already one concatenated summary, not a set of separable messages — a
  //     terser instruction is the only aggressive lever).
  deps.logger.debug(
    {
      step: "lcd-condense-escalate",
      level: 2,
      childCount: children.length,
      hint: "level-1 condensed summary did not reduce; retrying aggressive (terser)",
    },
    "lcd condense escalation",
  );
  const aggressive = await tryCondenseLevel(
    deps,
    pseudoMessage,
    { reserveTokens: effectiveReserveTokens, previousSummary: opts.previousSummary, aggressive: true, depth: opts.depth },
    shrinkCeilingTokens,
    maxAttempts,
  );
  if (aggressive !== undefined) {
    return { content: aggressive.content, level: 2, fallback: false, tokenCount: aggressive.tokenCount };
  }

  // --- Level 3: deterministic bounded truncation (the guaranteed terminator).
  const content = buildDeterministicCondensedFallback(children.length, beforeTokens);
  const tokenCount = estimateMessageTokens({ role: "user", content } as Message);
  deps.logger.debug(
    {
      step: "lcd-condense-escalate",
      level: 3,
      childCount: children.length,
      fallback: true,
      hint: "both LLM levels failed to reduce; using deterministic bounded truncation",
    },
    "lcd condense escalation",
  );
  return { content, level: 3, fallback: true, tokenCount };
}

/**
 * Build the ONE pseudo-`user` message the injected summarizer condenses: the
 * child summary content strings, clearly separated by a delimiter so the model
 * sees distinct source summaries. The role is `user` (matching how the assembler
 * wraps a summary-ref as a user-role text message and how `estimateMessageTokens`
 * judges the output).
 */
function buildCondenseInput(children: CondenseChildSummary[]): AgentMessage {
  const content = children.map((c) => c.content).join("\n\n---\n\n");
  return { role: "user", content } as unknown as AgentMessage;
}

/**
 * Attempt one condensation summarizer call and accept it ONLY when the produced
 * summary is strictly smaller (in tokens) than `shrinkCeilingTokens` — the run's
 * RENDERED 4:1 measure (B-4, 260605-ney), so the candidate (a 4:1-prose user
 * string) and the ceiling are like-for-like units. Non-fatal: a throwing
 * summarizer is caught (WARN, errorKind `dependency`) and reported as "not
 * accepted" so the ladder escalates rather than failing. Mirrors `tryLevel` in
 * `lcd-leaf-summarizer.ts` verbatim in shape.
 */
async function tryCondenseLevel(
  deps: LeafSummarizerDeps,
  pseudoMessage: AgentMessage,
  opts: LeafSummarizeOptions,
  shrinkCeilingTokens: number,
  attempt: number,
): Promise<{ content: string; tokenCount: number } | undefined> {
  try {
    const summary = await deps.summarize([pseudoMessage], opts);
    const tokenCount = estimateMessageTokens({ role: "user", content: summary } as Message);
    if (tokenCount < shrinkCeilingTokens) return { content: summary, tokenCount };
    // Non-reduction → escalate.
    deps.logger.debug(
      {
        step: "lcd-condense-escalate",
        attempt,
        hint: "condensed summary not smaller than the summed child tokens; escalating",
      },
      "lcd condense escalation",
    );
    return undefined;
  } catch (err) {
    deps.logger.warn(
      {
        err,
        attempt,
        errorKind: "dependency" as const,
        hint: "condense summarizer call failed; escalating to the next level",
      },
      "lcd condense summarizer failed",
    );
    return undefined;
  }
}

/**
 * Build the deterministic Level-3 condensed summary: a count-only note prefixed
 * with `CONDENSED_FALLBACK_SUMMARY_MARKER`, bounded strictly below BOTH the Σ
 * child tokenCount it replaces AND `CONDENSED_FALLBACK_TARGET_TOKENS`. This is the
 * guaranteed terminator — it NEVER exceeds the summed children and NEVER calls an
 * LLM.
 *
 * The bound is the token ESTIMATOR ITSELF, not a hand-derived chars-per-token
 * ceiling (the WR-01 / IN-03 fix — copied from `buildDeterministicFallback` in
 * `lcd-leaf-summarizer.ts:476-507`): truncate the note in a loop that re-measures
 * with `estimateMessageTokens` until it is strictly below the ceiling. The marker
 * survives intact for any normal-size run; only a sub-marker run truncates it
 * (and a run too small to ever shrink is unreachable here — the trigger gates on
 * `condensedMinFanout` ≥ 2 child summaries, so `beforeTokens` is always ≥ 2).
 *
 * @param childCount - number of child summaries condensed (recorded in the note)
 * @param beforeTokens - the run's Σ child tokenCount (the strict ceiling to beat)
 * @returns a bounded, marker-prefixed summary string strictly smaller than the run
 */
function buildDeterministicCondensedFallback(childCount: number, beforeTokens: number): string {
  const note =
    `${CONDENSED_FALLBACK_SUMMARY_MARKER} ${childCount} summaries ` +
    `(~${beforeTokens} tokens) were condensed without an LLM summary; ` +
    `their detail is preserved losslessly in the underlying summaries and message store.`;

  // The strict ceiling: strictly below the summed children AND at/below the
  // fallback target. The run-too-small case (maxTokens < 1) is gated by the
  // trigger's fanout; clamp defensively so this never returns a non-shrinking note.
  const maxTokens = Math.min(beforeTokens - 1, CONDENSED_FALLBACK_TARGET_TOKENS);
  if (maxTokens < 1) return ""; // unreachable in practice (caller gates); empty is strictly smaller.

  // Measure with the SAME estimator the result is judged by (a user-role string).
  const tokensOf = (content: string): number =>
    estimateMessageTokens({ role: "user", content } as Message);

  if (tokensOf(note) <= maxTokens) return note;

  // Truncate keeping the marker at the head, re-measuring with the estimator each
  // step (the estimator is the bound, not a fixed ratio). estimateMessageTokens is
  // monotonic in a user string's length, so stepping the length down by the
  // over-by amount converges in a handful of iterations and terminates at the
  // empty string at worst.
  let len = note.length;
  while (len > 0 && tokensOf(note.slice(0, len)) > maxTokens) {
    const over = tokensOf(note.slice(0, len)) - maxTokens;
    len = Math.max(0, len - Math.max(1, over * 4));
  }
  return note.slice(0, len);
}

// ---------------------------------------------------------------------------
// Production summarizer (the SDK generateSummary seam)
// ---------------------------------------------------------------------------

/**
 * Build the condensation-specific summarization instructions appended to the
 * SDK's base prompt via `customInstructions`. A condensed summary is a summary OF
 * summaries — MORE abstract than a leaf: it merges overlapping facts across the
 * child summaries while keeping load-bearing ids/decisions/outcomes, and (like the
 * leaf) it must NOT invent facts not present in the children. Returns the
 * instruction string. Mirrors `buildLeafSummaryInstructions` in shape.
 */
function buildCondenseInstructions(aggressive: boolean): string {
  const base =
    "Summarize the SUMMARIES above into a single, more abstract summary. " +
    "These are already-condensed summaries of earlier conversation — merge " +
    "overlapping facts, deduplicate, and keep only the load-bearing details: " +
    "file paths, ids, decisions made, tool outcomes (success/failure), and open " +
    "questions. Do NOT invent facts not present in the summaries above. Write " +
    "prose, not a section template.";
  return aggressive
    ? base + " Be as terse as possible while keeping the load-bearing facts."
    : base;
}

/**
 * Construct the PRODUCTION {@link CondenseSummarizer} — the seam that wraps the
 * SDK `generateSummary` for the condense tier. Clones `buildLeafSummarizeFn`
 * (`lcd-leaf-summarizer.ts:576-604`) verbatim, swapping ONLY the instructions
 * builder; the `generateSummary` 8-arg call shape is unchanged (`previousSummary`
 * is the 8th param). Phase 132 swaps THIS factory's output for a spend-governed /
 * circuit-broken variant — the same single seam as the leaf.
 *
 * B-5 twin (260605-ney): `generateSummary` needs a REAL pi-ai `Model<any>` (with
 * the provider-client runtime it invokes), NOT the 4-field
 * {@link CompactionModelSnapshot} (which lacks that runtime and throws at call
 * time). The primary path resolves `deps.getRealModel()` — the executor-resolved
 * `resolvedModel` threaded via the shared `LeafSummarizerDeps`, IDENTICAL to
 * `buildLeafSummarizeFn` — never the snapshot. The override path is unchanged (the
 * operation chain already supplies a real Model).
 *
 * @param deps - the real-model getter + optional override (the logger is unused
 *   here; the ladder owns the WARN on a throw — this factory just performs the call).
 * @returns a CondenseSummarizer bound to the resolved model + key.
 */
export function buildCondenseSummarizeFn(
  deps: Pick<LeafSummarizerDeps, "getRealModel" | "getApiKey" | "overrideModel">,
): CondenseSummarizer {
  return async (messages: AgentMessage[], opts: LeafSummarizeOptions): Promise<string> => {
    // B-5: resolve a REAL Model<any> for generateSummary — prefer the cheaper
    // override's real Model when present; else the PRIMARY real model (the
    // executor-resolved `resolvedModel`, via deps.getRealModel). The bare 4-field
    // CompactionModelSnapshot is NEVER passed to generateSummary (it lacks the
    // provider-client runtime the SDK invokes and throws at call time).
    const model: unknown = deps.overrideModel?.model ?? deps.getRealModel();
    const apiKey = deps.overrideModel
      ? await deps.overrideModel.getApiKey()
      : await deps.getApiKey();
    const instructions = buildCondenseInstructions(opts.aggressive ?? false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK generateSummary takes an opaque Model<any>
    return generateSummary(
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model as any,
      opts.reserveTokens,
      apiKey,
      undefined, // headers
      undefined, // signal
      instructions,
      opts.previousSummary, // 8th param: prior condensed content for continuity
    );
  };
}
