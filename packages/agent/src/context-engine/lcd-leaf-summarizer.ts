// SPDX-License-Identifier: Apache-2.0
/**
 * LCD leaf summarization unit (Phase 129, C1).
 *
 * Two pure-ish responsibilities, both proven by a STUB summarizer (no network):
 *
 *  1. {@link selectLeafChunk} — pick the OLDEST contiguous chunk OUTSIDE the
 *     fresh tail, capped at `leafChunkTokens`, then extend the boundary forward
 *     to a STEP boundary (never end on an assistant `tool_use` without its
 *     trailing `toolResult`s — the pair-safe walk mirrors
 *     `extendHeadForPairSafety` in `llm-compaction.ts`). Returns `undefined`
 *     when no evictable history exists outside the fresh tail (the pass is a
 *     no-op).
 *
 *  2. {@link summarizeLeafChunk} — run the mandatory 3-level escalation
 *     (normal → aggressive → deterministic truncation) that ALWAYS reduces
 *     tokens or falls back deterministically. The structural model is
 *     `compactWithFallback` (`llm-compaction.ts:545-607`), but C1 ADDS a
 *     per-level token-reduction assertion (LOSSLESS-CLAW §5: "If output > input,
 *     retry aggressive then truncate") and a BOUNDED Level-3 output (a count-only
 *     note prefixed with `LEAF_FALLBACK_SUMMARY_MARKER`, capped at
 *     `LEAF_FALLBACK_TARGET_TOKENS`) — the guaranteed-shrink terminator. The
 *     ladder is FINITE (Level 1 ≤ 1+COMPACTION_MAX_RETRIES attempts → Level 2 one
 *     attempt → Level 3 deterministic); it never loops without a floor.
 *
 * The LLM summarizer is INJECTED as ONE function ({@link LeafSummarizer}) so
 * Phase 132 can wrap it with spend governance / a circuit breaker by swapping a
 * single seam (the binding constraint; the Security DoS row T-129-08). 129 calls
 * it inline and non-fatally: an error at Levels 1+2 is caught (WARN, errorKind
 * `dependency`) and the pass falls through to the deterministic Level 3 — it
 * NEVER throws out of the pass.
 *
 * Architecture cut (agent↛memory): this file imports ONLY the agent-side token
 * estimators + the escalation constants; it NEVER imports `@comis/memory`. It
 * also NEVER logs `chunkMessages` content or the summary `content` — ids, counts,
 * level, and durations only (AGENTS.md §2.2; T-129-10). It reads NO wall clock of
 * its own — the leaf time-range (`earliestAt`/`latestAt`) is derived purely from
 * the injected `LeafChunkItem.createdAt` values, so there is no globals-gate
 * surface here (the caller's injected clock stamps timestamps upstream).
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import type { ComisLogger } from "@comis/core";
import {
  COMPACTION_MAX_RETRIES,
  OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  LEAF_FALLBACK_TARGET_TOKENS,
  LEAF_FALLBACK_SUMMARY_MARKER,
} from "./constants.js";
import {
  estimateMessageTokens,
  estimateMessageChars,
} from "../safety/token-estimator.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * The smallest chunk (in tokens) a leaf pass can usefully summarize. The
 * deterministic Level-3 floor must end up STRICTLY smaller than the chunk with
 * NON-EMPTY content; the smallest non-empty summary is 1 token
 * (`estimateMessageTokens` of a 1–4-char user string), so a chunk must be ≥ 2
 * tokens for any non-empty summary to be strictly smaller. A 1-token chunk is
 * already trivially tiny — there is nothing to gain — so the caller skips the
 * pass entirely (WR-01) rather than emitting a degenerate empty/larger fallback.
 */
export const MIN_SHRINKABLE_LEAF_CHUNK_TOKENS = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One message in a leaf chunk, carrying its pre-computed token count, stable id,
 * and creation timestamp. Keeping the chunk-selection input as a plain array of
 * these (rather than reaching into a store) keeps {@link selectLeafChunk} pure.
 *
 * Token authority (Pitfall 2): the caller sources `tokens` from the STORED
 * `LcdMessage.tokenCount` for store-sourced history (which counts F3 thinking)
 * and from `estimateMessageTokens` only for live/fresh-tail messages.
 */
export interface LeafChunkItem {
  /** Stable message id (the LCD `lcd_messages.id`) — covered by the leaf. */
  id: string;
  /** The reconstructed canonical message (used for summarization + role reads). */
  msg: AgentMessage;
  /** Pre-computed token count for this message (the chunk-budget authority). */
  tokens: number;
  /** Unix epoch ms the message was created (the leaf time-range authority). */
  createdAt: number;
}

/**
 * The selected leaf chunk: the oldest contiguous out-of-tail prefix, capped at
 * `leafChunkTokens` and extended to a STEP boundary.
 */
export interface LeafChunk {
  /** Inclusive start index into the history array (always 0 — the oldest end). */
  startIndex: number;
  /** Exclusive end index into the history array (the pair-safe boundary). */
  endIndex: number;
  /** The chunk's messages (for summarization), in seq order. */
  messages: AgentMessage[];
  /** Number of messages the leaf will cover (= `messages.length`). */
  descendantCount: number;
  /** Stable ids of every covered message (the leaf→message link set). */
  messageIds: string[];
  /** Minimum `createdAt` over the chunk (the leaf's earliest covered time). */
  earliestAt: number;
  /** Maximum `createdAt` over the chunk (the leaf's latest covered time). */
  latestAt: number;
  /** Summed pre-computed tokens of the chunk (the before-size authority). */
  tokens: number;
}

/**
 * Options forwarded to the injected summarizer on each call.
 */
export interface LeafSummarizeOptions {
  /** Token target for the summary (= `leafTargetTokens`, the SDK `reserveTokens`). */
  reserveTokens: number;
  /** Prior leaf summary content for continuity (the 8th `generateSummary` param). */
  previousSummary?: string;
  /** Aggressive (Level-2) hint — best-effort retry over the oversized-filtered set. */
  aggressive?: boolean;
}

/**
 * The ONE injected summarizer seam. Production (Phase 132) supplies a function
 * that wraps the SDK `generateSummary` behind spend governance + a circuit
 * breaker; unit tests inject a deterministic stub (no network). Returns the raw
 * summary string (may be too large — the ladder re-checks size and escalates).
 */
export type LeafSummarizer = (
  messages: AgentMessage[],
  opts: LeafSummarizeOptions,
) => Promise<string>;

/**
 * The minimal model-capabilities snapshot the compaction chain resolves
 * (`id`/`provider`/`contextWindow`/`reasoning`). A plain value object with NO
 * reference back to `session.agent.state` — so it can be captured once at the
 * afterTurn boundary and safely read by a DEFERRED (C4) pass that runs AFTER
 * `session.dispose()` (WR-04). `getModel()` returns this shape.
 */
export interface CompactionModelSnapshot {
  id?: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
}

/**
 * Dependencies for the leaf summarizer. Mirrors the `CompactionLayerDeps`-style
 * getters (`getModel` / `getApiKey` / `overrideModel`) so Phase 132 can reuse the
 * same resolution chain; the LLM call itself lives behind {@link LeafSummarizer}.
 */
export interface LeafSummarizerDeps {
  /** Structured logger (ids/counts/level/durations only — never content). */
  logger: ComisLogger;
  /** The injected summarizer (the 132 spend-governance seam). */
  summarize: LeafSummarizer;
  /** Getter for the current model's capabilities (for the summarizer call). */
  getModel: () => CompactionModelSnapshot;
  /** Getter for the current model's provider API key. */
  getApiKey: () => Promise<string>;
  /** Optional cheaper override model + key for the leaf pass. */
  overrideModel?: { model: unknown; getApiKey: () => Promise<string> };
}

/**
 * Result of a leaf summarization pass.
 */
export interface LeafSummaryResult {
  /** The summary text (a plain string; the assembler wraps it as a user message). */
  content: string;
  /** Which escalation level produced the summary. */
  level: 1 | 2 | 3;
  /** True only for the deterministic Level-3 truncation (carries the marker). */
  fallback: boolean;
  /** Number of covered messages. */
  descendantCount: number;
  /** Stable ids of every covered message. */
  messageIds: string[];
  /** Earliest covered `createdAt`. */
  earliestAt: number;
  /** Latest covered `createdAt`. */
  latestAt: number;
  /** Token count of the produced summary (always < the chunk token count). */
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Chunk selection
// ---------------------------------------------------------------------------

/**
 * Select the OLDEST contiguous chunk OUTSIDE the fresh tail, capped at
 * `leafChunkTokens` and extended forward to a STEP boundary so it never ends on
 * an assistant `tool_use` without its trailing `toolResult`s.
 *
 * The fresh-tail boundary is the index of the Nth-from-last assistant message
 * (a STEP = one assistant + the tool results it triggered — mirrors
 * `freshTailBoundaryIndex` in `lcd-assembler.ts`); everything before it is
 * evictable history. The chunk greedily accumulates the oldest evictable
 * messages up to the cap, then walks forward past a trailing assistant
 * `tool_use` and its `toolResult`s (never crossing the fresh-tail boundary).
 *
 * @param history - the evictable history items (seq order, oldest first)
 * @param freshTailSteps - the number of trailing STEPS protected from eviction
 * @param leafChunkTokens - the chunk token cap
 * @returns the selected chunk, or `undefined` when nothing is evictable
 */
export function selectLeafChunk(
  history: LeafChunkItem[],
  freshTailSteps: number,
  leafChunkTokens: number,
): LeafChunk | undefined {
  if (history.length === 0) return undefined;

  // The fresh-tail boundary within `history`: everything at index >= this is
  // protected. Counting assistant messages from the end mirrors
  // freshTailBoundaryIndex (a STEP = an assistant + its trailing results).
  const tailStart = freshTailBoundaryIndexOf(history, freshTailSteps);
  if (tailStart <= 0) return undefined; // nothing outside the fresh tail — no-op.

  // Greedily take the oldest contiguous prefix up to the cap. Always include at
  // least one message (so a single oversized message still gets summarized).
  let endIndex = 0;
  let tokens = 0;
  while (endIndex < tailStart) {
    const next = history[endIndex]!.tokens;
    if (endIndex > 0 && tokens + next > leafChunkTokens) break;
    tokens += next;
    endIndex++;
  }

  // Extend forward past a trailing assistant `tool_use` to its `toolResult`s so
  // the boundary never lands mid-pair — but never cross the fresh-tail boundary.
  endIndex = extendForPairSafety(history, endIndex, tailStart);

  const slice = history.slice(0, endIndex);
  const messages = slice.map((it) => it.msg);
  const messageIds = slice.map((it) => it.id);
  const createdAts = slice.map((it) => it.createdAt);
  const summed = slice.reduce((acc, it) => acc + it.tokens, 0);

  return {
    startIndex: 0,
    endIndex,
    messages,
    descendantCount: messages.length,
    messageIds,
    earliestAt: Math.min(...createdAts),
    latestAt: Math.max(...createdAts),
    tokens: summed,
  };
}

/**
 * The index in `history` where the fresh tail begins: the position of the Nth-
 * from-last assistant message (mirrors `freshTailBoundaryIndex` in the
 * assembler). Returns 0 when there are fewer than N assistant steps (everything
 * is fresh tail → nothing evictable).
 */
function freshTailBoundaryIndexOf(history: LeafChunkItem[], freshTailSteps: number): number {
  let stepsSeen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (roleOf(history[i]!.msg) === "assistant") {
      stepsSeen++;
      if (stepsSeen === freshTailSteps) return i;
    }
  }
  return 0;
}

/**
 * Walk the (exclusive) `endIndex` forward so the chunk never ends mid-pair.
 *
 * `endIndex` is exclusive, so the LAST INCLUDED message is `history[endIndex-1]`.
 * When that message is an assistant carrying a `tool_use`, its `toolResult`s sit
 * at `endIndex`, `endIndex+1`, … — pull them all in (and any further tool_use
 * the included results chain into), bounded by `limit` (the fresh-tail boundary).
 * Mirrors `extendHeadForPairSafety` in `llm-compaction.ts`, adapted to an
 * exclusive end index.
 */
function extendForPairSafety(history: LeafChunkItem[], endIndex: number, limit: number): number {
  let extended = endIndex;
  // Keep extending while the last INCLUDED message is an assistant tool_use whose
  // results have not all been pulled in yet.
  while (extended > 0 && extended < limit) {
    const lastIncluded = history[extended - 1]!.msg;
    if (roleOf(lastIncluded) === "assistant" && hasToolUse(lastIncluded)) {
      // Pull every immediately-following toolResult into the chunk.
      let advanced = false;
      while (extended < limit && roleOf(history[extended]!.msg) === "toolResult") {
        extended++;
        advanced = true;
      }
      if (advanced) continue; // re-check (the new last-included is a toolResult → loop exits).
    }
    break;
  }
  return extended;
}

/** True when an assistant message carries a `tool_use` / `toolCall` block. */
function hasToolUse(msg: AgentMessage): boolean {
  const content = (msg as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: string }).type;
    return type === "tool_use" || type === "toolCall";
  });
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}

// ---------------------------------------------------------------------------
// 3-level escalation
// ---------------------------------------------------------------------------

/**
 * Summarize a leaf chunk via the mandatory 3-level escalation. ALWAYS returns a
 * summary whose token count is STRICTLY LESS than the chunk's token count (the
 * C1 invariant) — accepting an LLM summary only when it actually reduces, and
 * otherwise falling through to the deterministic, bounded Level-3 truncation.
 *
 * @param chunkItems - the chunk's items (pre-computed tokens + ids + timestamps)
 * @param deps - the injected summarizer + model getters + logger
 * @param opts - reserveTokens (= leafTargetTokens) + optional previousSummary
 * @returns the leaf summary + escalation level + coverage metadata
 */
export async function summarizeLeafChunk(
  chunkItems: LeafChunkItem[],
  deps: LeafSummarizerDeps,
  opts: { reserveTokens: number; previousSummary?: string },
): Promise<LeafSummaryResult> {
  const messages = chunkItems.map((it) => it.msg);
  const messageIds = chunkItems.map((it) => it.id);
  const createdAts = chunkItems.map((it) => it.createdAt);
  // Before-size authority: the caller's pre-computed per-message tokens (counts
  // F3 thinking on store-sourced rows, which re-estimation would under-count).
  const chunkTokens = chunkItems.reduce((acc, it) => acc + it.tokens, 0);
  const earliestAt = createdAts.length > 0 ? Math.min(...createdAts) : 0;
  const latestAt = createdAts.length > 0 ? Math.max(...createdAts) : 0;

  const base = {
    descendantCount: chunkItems.length,
    messageIds,
    earliestAt,
    latestAt,
  };

  // --- Level 1: full summarization, up to 1 + COMPACTION_MAX_RETRIES attempts.
  //     Accept ONLY when the summary is strictly smaller than the chunk.
  const maxAttempts = 1 + COMPACTION_MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const accepted = await tryLevel(deps, messages, {
      reserveTokens: opts.reserveTokens,
      previousSummary: opts.previousSummary,
    }, chunkTokens, attempt);
    if (accepted !== undefined) {
      return { ...base, content: accepted.content, level: 1, fallback: false, tokenCount: accepted.tokenCount };
    }
  }

  // --- Level 2: aggressive — one best-effort retry. Prefer the oversized-filtered
  //     set (dropping huge messages often lets the model reduce), but when EVERY
  //     message is oversized the filter empties the set; rather than skip Level 2
  //     and drop straight to the count-only floor (WR-03), make the one aggressive
  //     attempt on the FULL (unfiltered) set. An aggressive LLM summary — even of
  //     large inputs — is strictly better context than the deterministic floor,
  //     and continuity (`previousSummary`) is forwarded either way.
  const filtered = messages.filter(
    (m) => estimateMessageChars(m as unknown as Message) < OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  );
  const level2Messages = filtered.length > 0 ? filtered : messages;
  if (level2Messages.length > 0) {
    deps.logger.debug(
      {
        step: "lcd-leaf-escalate",
        level: 2,
        descendantCount: chunkItems.length,
        oversizedFilterEmptied: filtered.length === 0,
        hint:
          filtered.length === 0
            ? "level-1 summary did not reduce and every message is oversized; retrying aggressive on the full set"
            : "level-1 summary did not reduce; retrying aggressive (oversized-filtered)",
      },
      "lcd leaf escalation",
    );
    const accepted = await tryLevel(deps, level2Messages, {
      reserveTokens: opts.reserveTokens,
      previousSummary: opts.previousSummary,
      aggressive: true,
    }, chunkTokens, maxAttempts);
    if (accepted !== undefined) {
      return { ...base, content: accepted.content, level: 2, fallback: false, tokenCount: accepted.tokenCount };
    }
  }

  // --- Level 3: deterministic bounded truncation (the guaranteed terminator).
  const content = buildDeterministicFallback(chunkItems.length, chunkTokens);
  const tokenCount = estimateMessageTokens({ role: "user", content } as Message);
  deps.logger.debug(
    {
      step: "lcd-leaf-escalate",
      level: 3,
      descendantCount: chunkItems.length,
      fallback: true,
      hint: "both LLM levels failed to reduce; using deterministic bounded truncation",
    },
    "lcd leaf escalation",
  );
  return { ...base, content, level: 3, fallback: true, tokenCount };
}

/**
 * Attempt one summarizer call and accept it ONLY when the produced summary is
 * strictly smaller (in tokens) than the chunk. Non-fatal: a throwing summarizer
 * is caught (WARN, errorKind `dependency`) and reported as "not accepted" so the
 * ladder escalates rather than failing.
 */
async function tryLevel(
  deps: LeafSummarizerDeps,
  messages: AgentMessage[],
  opts: LeafSummarizeOptions,
  chunkTokens: number,
  attempt: number,
): Promise<{ content: string; tokenCount: number } | undefined> {
  try {
    const summary = await deps.summarize(messages, opts);
    const tokenCount = estimateMessageTokens({ role: "user", content: summary } as Message);
    if (tokenCount < chunkTokens) return { content: summary, tokenCount };
    // Non-reduction → escalate (LOSSLESS-CLAW §5).
    deps.logger.debug(
      {
        step: "lcd-leaf-escalate",
        attempt,
        hint: "summary not smaller than chunk; escalating",
      },
      "lcd leaf escalation",
    );
    return undefined;
  } catch (err) {
    deps.logger.warn(
      {
        err,
        attempt,
        errorKind: "dependency" as const,
        hint: "leaf summarizer call failed; escalating to the next level",
      },
      "lcd leaf summarizer failed",
    );
    return undefined;
  }
}

/**
 * Build the deterministic Level-3 leaf summary: a count-only note prefixed with
 * `LEAF_FALLBACK_SUMMARY_MARKER`, bounded strictly below BOTH the chunk it
 * replaces AND `LEAF_FALLBACK_TARGET_TOKENS`. This is the guaranteed terminator —
 * it NEVER exceeds the chunk and NEVER calls an LLM.
 *
 * The bound is the token ESTIMATOR ITSELF, not a hand-derived chars-per-token
 * ceiling (WR-01 / IN-03): the prior code clamped chars with `CHARS_PER_TOKEN_RATIO`
 * (3.5) while the result is measured by `estimateMessageTokens` (4:1 for a
 * user-role string), and a `Math.max(MARKER.length, …)` floor overrode the clamp
 * for tiny chunks — so a 3-token chunk produced a 19-char marker = 5 tokens,
 * LARGER than the chunk. Truncating the note in a loop that re-measures with the
 * estimator until it is strictly below the chunk removes both the 3.5-vs-4
 * mismatch and the marker-floor overshoot. The marker survives intact for any
 * normal-size chunk; only a sub-marker chunk truncates it (and a chunk too small
 * to ever shrink with non-empty content is skipped by the {@link summarizeLeafChunk}
 * caller before this is reached, so `maxTokens` here is always ≥ 1).
 *
 * @param messageCount - number of chunk messages (recorded in the note)
 * @param chunkTokens - the chunk's token count (the strict ceiling to beat)
 * @returns a bounded, marker-prefixed summary string strictly smaller than the chunk
 */
function buildDeterministicFallback(messageCount: number, chunkTokens: number): string {
  const note =
    `${LEAF_FALLBACK_SUMMARY_MARKER} ${messageCount} earlier messages ` +
    `(~${chunkTokens} tokens) were truncated without an LLM summary; ` +
    `their content is preserved losslessly in the message store.`;

  // The strict ceiling: strictly below the chunk AND at/below the fallback
  // target. The chunk-too-small-to-shrink case (maxTokens < 1) is guarded by the
  // caller; clamp defensively so this never returns a non-shrinking note.
  const maxTokens = Math.min(chunkTokens - 1, LEAF_FALLBACK_TARGET_TOKENS);
  if (maxTokens < 1) return ""; // unreachable in practice (caller guards); empty is strictly smaller.

  // Measure with the SAME estimator the result is judged by (a user-role string).
  const tokensOf = (content: string): number =>
    estimateMessageTokens({ role: "user", content } as Message);

  if (tokensOf(note) <= maxTokens) return note;

  // Truncate keeping the marker at the head, re-measuring with the estimator each
  // step (the estimator is the bound, not a fixed ratio). estimateMessageTokens is
  // monotonic in a user string's length, so stepping the length down by the
  // over-by amount (≥1 char) converges in a handful of iterations and terminates
  // at worst at the empty string.
  let len = note.length;
  while (len > 0 && tokensOf(note.slice(0, len)) > maxTokens) {
    const over = tokensOf(note.slice(0, len)) - maxTokens;
    // CHARS_PER_TOKEN (4) is only a convergence STEP here — correctness comes from
    // re-measuring tokensOf in the loop condition, not from this multiplier.
    len = Math.max(0, len - Math.max(1, over * 4));
  }
  return note.slice(0, len);
}

// ---------------------------------------------------------------------------
// Production summarizer (the SDK generateSummary seam)
// ---------------------------------------------------------------------------

/**
 * Build the leaf-specific summarization instructions appended to the SDK's base
 * prompt via `customInstructions`. A leaf is a finer-grained chunk summary than a
 * full compaction — it does NOT require the 9-section compaction schema (RESEARCH
 * §Pattern 1 difference #2); it asks for a faithful, compact prose summary that
 * preserves concrete details (ids, decisions, tool outcomes) so a later
 * expansion / recall pass can rely on it. Returns the instruction string.
 */
function buildLeafSummaryInstructions(aggressive: boolean): string {
  const base =
    "Summarize the conversation chunk above into a faithful, compact summary. " +
    "Preserve concrete details that later turns may rely on: file paths, ids, " +
    "decisions made, tool calls and their outcomes (success/failure), and any " +
    "open questions. Do NOT invent facts not present in the chunk. Write prose, " +
    "not a section template.";
  return aggressive
    ? base + " Be as terse as possible while keeping the load-bearing facts."
    : base;
}

/**
 * Construct the PRODUCTION {@link LeafSummarizer} — the seam that wraps the SDK
 * `generateSummary`. Phase 132 swaps THIS factory's output for a spend-governed /
 * circuit-broken variant; 129 calls `generateSummary` directly. The override
 * model + key are used when {@link LeafSummarizerDeps.overrideModel} is present
 * (a cheaper compaction model resolved by the operation-model chain), else the
 * primary `getModel`/`getApiKey`. Mirrors `compactWithFallback`'s call shape
 * (`llm-compaction.ts:561`); the 8th param threads `previousSummary` for
 * continuity. The function may return a too-large string — the escalation ladder
 * in {@link summarizeLeafChunk} re-checks size and escalates.
 *
 * @param deps - the model getters + optional override (the logger is unused here;
 *   the ladder owns the WARN on a throw — this factory just performs the call).
 * @returns a LeafSummarizer bound to the resolved model + key.
 */
export function buildLeafSummarizeFn(
  deps: Pick<LeafSummarizerDeps, "getModel" | "getApiKey" | "overrideModel">,
): LeafSummarizer {
  return async (messages: AgentMessage[], opts: LeafSummarizeOptions): Promise<string> => {
    // Resolve the model + key: prefer the cheaper override when the operation
    // chain picked one (parity with getCompactionDeps); else the primary.
    const model: unknown = deps.overrideModel?.model ?? deps.getModel();
    const apiKey = deps.overrideModel
      ? await deps.overrideModel.getApiKey()
      : await deps.getApiKey();
    const instructions = buildLeafSummaryInstructions(opts.aggressive ?? false);
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
      opts.previousSummary, // 8th param: prior leaf content for continuity
    );
  };
}
