// SPDX-License-Identifier: Apache-2.0
/**
 * LCD `dag`-mode assembly engine (Phase 128 A1/A2/A4 + Phase 129 C3/A3) — the
 * corrected loop fix, now resolving `context_items` and evicting under budget.
 *
 * The deleted `dag-assembler.ts` flattened every assistant `tool_use` and every
 * `tool_result` into `content: [{ type: "text", text }]`, so the model never saw
 * a provider-valid `tool_use`<->`tool_result` pairing for its own prior action
 * and re-issued the same `read` 54 times (124 s). This module is the verbatim
 * replacement wired into the `dag` branch at `context-engine.ts`:
 *
 *  1+2. HISTORY (C3) — resolve the ordered model-facing `context_items` view: a
 *       `message`-ref reconstructs verbatim via the core `partsToMessage` codec
 *       (stable ids, the round-trip the loop bug broke); a `summary`-ref injects
 *       as a plain `user`-role text message behind `summaryRefToMessage` (the ONE
 *       Phase-130 swap point — untrusted by role, never system/assistant). Each
 *       resolved message carries its token authority (the stored `tokenCount`, or
 *       the summary's, Pitfall 2) for the budget pass.
 *  2b.  COALESCE (B-19, defensive) — a maximal run of >=2 contiguous summary-refs
 *       is merged into ONE user message (headers/bodies/tokens preserved). The
 *       Anthropic API merges consecutive user turns server-side (no 400, confirmed
 *       live), but local coalescing keeps distinct summaries from being opaquely
 *       muddied by that merge and is safe for stricter Anthropic-compatible
 *       endpoints that enforce role alternation. Message-refs are untouched.
 *  3.   FRESH TAIL — the last N STEPS of the LIVE array (an assistant message
 *       plus the tool results it triggered), sliced VERBATIM as the ORIGINAL
 *       structured blocks (never reconstructed-from-text). Never evicted (A1).
 *  4.   BUDGET + EVICTION (A3) — compute H = W − S − O − M − R via the profile-aware
 *       `computeTokenBudgetForProfile` (C1: 8K-starvation fix + 256K-overfill cap for
 *       small/nano; byte-identical to `computeTokenBudget` for frontier/mid), then
 *       `evictHistoryUnderBudget` trims ONLY the
 *       evictable prefix (resolved history minus the items the fresh tail covers)
 *       to fit H; the fresh tail is concatenated UNCONDITIONALLY (A1/A3 — always
 *       included, even when it alone exceeds H). The prefix/fresh-tail boundary is
 *       drop-free and double-free for both L>H (mid-turn, the store lags the live
 *       array — CR-01) and L<=H (a heal shrank the live array — WR-01); transcript
 *       repair (step 6) re-pairs the seam regardless.
 *  5.   NORMALIZE — assistant string content -> `[{ type: "text", text }]`
 *       (pure, non-mutating; tool blocks untouched).
 *  6.   TRANSCRIPT REPAIR — `sanitizeToolUseResultPairing` runs LAST (A2), so the
 *       provider can never receive an unpaired/out-of-order pairing even if the
 *       history/fresh-tail seam landed mid-pair.
 *
 * Keep the body THIN (Pitfall 7): the eviction logic is Plan 04's pure module
 * (`lcd-budget-eviction.ts`) and the leaf summarization is Plan 03's; this
 * assembler only RESOLVES + CALLS them.
 *
 * Architecture cut (agent↛memory): this file imports ONLY the core
 * `ContextStorePort`/`LcdMessage`/`LcdContextItem`/`LcdSummary` TYPES + the core
 * `partsToMessage` runtime codec from `@comis/core`; it NEVER imports
 * `@comis/memory`. The concrete `createLcdStore` is injected by the daemon as
 * `ContextEngineDeps.contextStore`. This module is read-only — it NEVER appends
 * (that is the afterTurn ingest path, Plan 03).
 *
 * @module
 */

import { partsToMessage, scrubSecretsFromText, systemDateFrom, systemNowMs, wrapExternalContent } from "@comis/core";
import type {
  ContextStorePort,
  ContextStoreScope,
  LcdContextItem,
  LcdMessage,
  LcdSummary,
} from "@comis/core";
import type { ContextEngineConfig } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import { computeTokenBudgetForProfile } from "./budget-capacity-cap.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";
import {
  CHARS_PER_TOKEN_RATIO,
  LCD_FALLBACK_HEADER_MARKER,
  LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS,
} from "./constants.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import {
  createToolResultSizeGuard,
  type ContentBlock,
} from "../safety/tool-result-size-guard.js";
import type { ContextEngine, ContextEngineDeps } from "./types.js";

/**
 * B-8: the single shared tool-result size guard for the dag assembler's fresh-tail
 * bounding. Built ONCE at module scope (stateless factory) so each
 * `transformContext` reuses it. The default head+tail+marker config is fine; the
 * honest lossless-recovery suffix is appended to the marker via `toolHint` per call
 * (it survives `truncateIfNeeded`'s `Hint:` formatting). Reusing this factory —
 * NOT a hand-rolled truncation — satisfies the AGENTS.md don't-hand-roll rule and
 * keeps the masking identical to the pipeline microcompaction guard.
 */
const FRESH_TAIL_TOOL_RESULT_GUARD = createToolResultSizeGuard();

/**
 * Honest taint/marker suffix appended to every bounded fresh-tail tool result via
 * the guard's `toolHint`. Masking a fresh-tail tool result is acceptable ONLY
 * because the LCD store keeps the full content losslessly and `ctx_expand` recovers
 * it — parity with the deterministic-fallback note wording
 * (lcd-leaf-summarizer.ts:582). Content-free by construction (no message text).
 */
const FRESH_TAIL_BOUND_RECOVERY_HINT =
  "the full content is preserved losslessly in the LCD store and is recoverable";

/**
 * Build the `dag`-mode LCD `ContextEngine`. The caller (`createContextEngine`'s
 * `dag` branch) only invokes this when `deps.contextStore` AND
 * `deps.conversationId` are both wired, so both are asserted non-null here.
 *
 * @param config - the context engine config (reads `freshTailTurns` = the STEP count)
 * @param deps - the injected deps (`contextStore`, `conversationId`, `logger`, …)
 * @returns a `ContextEngine` whose `transformContext` runs the steps-1-6 assembly
 */
export function createLcdContextEngine(
  config: ContextEngineConfig,
  deps: ContextEngineDeps,
): ContextEngine {
  // Guaranteed present by the caller branch (context-engine.ts dag seam).
  const store = deps.contextStore as ContextStorePort;
  const conversationId = deps.conversationId as string;
  // Injected wall-clock (the daemon threads its ClockPort via setupContextEngine).
  // Production never reads the wall clock directly (the globals gate); `systemNowMs`
  // is the sanctioned system-clock wrapper for the no-injected-clock unit case.
  const now = (): number => (deps.clock ? deps.clock.now() : systemNowMs());

  // R4 (132-03): build the per-(conversation, agent, tenant) read scope ONCE.
  // FAIL CLOSED (mirrors the T-128-08 empty-column guard): if agentId or tenantId
  // is absent we CANNOT safely read (an unscoped read would leak another agent's
  // history within a shared conversation_id — WR-02), so `readScope` is undefined
  // and the assembler reads NOTHING (an empty history) rather than reading
  // conversation-wide. The session_key falls back to conversationId (the store
  // never filters on it; the 4th field is carried for shape symmetry).
  const readScope: ContextStoreScope | undefined =
    deps.agentId !== undefined && deps.agentId.length > 0 && deps.tenantId !== undefined && deps.tenantId.length > 0
      ? {
          conversationId,
          agentId: deps.agentId,
          tenantId: deps.tenantId,
          sessionKey: deps.sessionKey ?? conversationId,
        }
      : undefined;

  return {
    lastBreakpointIndex: undefined,
    lastTrimOffset: 0,
    async transformContext(liveMessages: AgentMessage[]): Promise<AgentMessage[]> {
      const startMs = now();

      // 1+2. HISTORY: resolve the ordered model-facing `context_items` view (C3)
      //      into canonical messages, each paired with its token authority.
      //      `getContextItems` returns the dense, gap-free order (lazy-seeded 1:1
      //      from `lcd_messages` on first read); a `message`-ref reconstructs
      //      verbatim via the core `partsToMessage` codec (the round-trip the loop
      //      bug broke), a `summary`-ref injects as a plain user-role text message
      //      behind `summaryRefToMessage` (the ONE 130 swap point — untrusted by
      //      role, never system/assistant; T-129-14). Token authority (Pitfall 2):
      //      a message-ref carries its STORED `tokenCount` (counts F3 thinking); a
      //      summary-ref carries the summary's `tokenCount`.
      // R4 (132-03): read ONLY with a fully-built agent+tenant scope. When the
      // scope is incomplete (`readScope` undefined) we fail closed — read nothing
      // rather than risk a cross-agent leak (WR-02 / T-132-03-04). A turn with no
      // resolvable history still ships its fresh tail below (A1), so the live turn
      // is never broken; the WARN flags the misconfiguration for an operator.
      if (readScope === undefined) {
        deps.logger.warn(
          {
            step: "lcd-resolve",
            conversationId,
            agentId: deps.agentId,
            tenantId: deps.tenantId,
            hint: "LCD dag assembly could not build a full (conversation, agent, tenant) read scope; reading no history this turn to avoid a cross-agent leak (R4/WR-02) — ensure setupContextEngine threads agentId + tenantId",
            // `as const` so the log-payload-checker TypeChecker resolves this to
            // the closed `ErrorKind` literal (a bare object-literal string widens
            // to `string` and trips the closed-union gate). AGENTS.md §2.1.
            errorKind: "precondition" as const,
          },
          "lcd assembly read scope incomplete — failing closed",
        );
      }
      const contextItems: LcdContextItem[] = readScope ? store.getContextItems(readScope) : [];
      const rows: LcdMessage[] = readScope ? store.getMessages(readScope) : [];
      const rowById = new Map<string, LcdMessage>(rows.map((row) => [row.id, row]));
      const summaryById = new Map<string, LcdSummary>(
        (readScope ? store.getSummaries(readScope) : []).map((s) => [s.summaryId, s]),
      );
      let resolved: BudgetItem[] = [];
      // Parallel to `resolved`: the ref kind of each resolved item, used by the
      // eviction seam (WR-01) to bound the fresh-tail overlap by the number of
      // TRAILING message-refs actually present so the evictable-prefix slice can
      // never cut across a summary boundary regardless of the collapse shape.
      let resolvedKinds: LcdContextItem["refKind"][] = [];
      let resolvedSummaryCount = 0;
      for (const item of contextItems) {
        const entry = resolveContextItem(item, rowById, summaryById);
        if (entry === undefined) continue; // a dangling ref (drift) is skipped, not fatal
        if (item.refKind === "summary") resolvedSummaryCount++;
        resolved.push(entry);
        resolvedKinds.push(item.refKind);
      }
      deps.logger.debug(
        {
          step: "lcd-resolve",
          conversationId,
          historyCount: resolved.length,
          messageRefs: resolved.length - resolvedSummaryCount,
          summaryRefs: resolvedSummaryCount,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd context_items resolved from store",
      );

      // 2b. COALESCE consecutive summary-refs (B-19, defensive). A maximal run of
      //     ≥2 contiguous summary-ref user messages is merged into ONE user message
      //     (their rendered texts joined with "\n\n" so each `[LCD summary …]`
      //     header + wrapped body + footer stays individually intact) with their
      //     `tokens` SUMMED (the budget math is unchanged). Done BEFORE the eviction
      //     overlap math so token accounting + ordering stay coherent; it is safe
      //     for that math because summary-refs are at the HEAD and message-refs at
      //     the TAIL, so coalescing a head/interior summary run never changes the
      //     count of TRAILING message-refs the eviction seam relies on (WR-01).
      //     Message-refs are NOT touched (they alternate with assistant turns
      //     naturally) and the role stays "user" (the T-129-14 untrusted-by-role
      //     ceiling). DEFENSIVE: the Anthropic API merges consecutive user turns
      //     server-side (no 400, confirmed live), but local coalescing keeps
      //     distinct summaries from being opaquely muddied by that server merge and
      //     is safe for stricter Anthropic-compatible endpoints that enforce
      //     alternation. Security is preserved: each summary body was already
      //     individually wrapExternalContent-wrapped with its OWN per-session random
      //     hex delimiter, so concatenation cannot weaken the taint boundary (the
      //     delimiters differ per summary; the trusted headers stay outside each
      //     wrapped region). A run of 1 is a no-op (the common single-summary head).
      const coalesced = coalesceConsecutiveSummaryRefs(resolved, resolvedKinds);
      resolved = coalesced.items;
      resolvedKinds = coalesced.kinds;

      // 3. FRESH TAIL: the last N STEPS of the LIVE array, VERBATIM (original
      //    structured blocks — never reconstructed-from-text). A1.
      const tailStart = freshTailBoundaryIndex(liveMessages, config.freshTailTurns);
      const rawFreshTail = liveMessages.slice(tailStart);
      deps.logger.debug(
        {
          step: "lcd-fresh-tail",
          freshTailSteps: config.freshTailTurns,
          freshTailCount: rawFreshTail.length,
          tailStart,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd fresh tail sliced verbatim",
      );

      // 3b. FRESH-TAIL TOOL-RESULT BOUNDING (B-8). The fresh tail ships
      //     UNCONDITIONALLY below (A1/A3) and the dag path runs NEITHER the
      //     observation masker NOR the dead-content evictor (pipeline-only), so a
      //     turn whose last steps carry a huge tool output would overflow the model
      //     window before any budget pass sees it. Bound each oversized tool RESULT
      //     to LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS via the shared
      //     createToolResultSizeGuard() (head+tail+honest marker — NOT hand-rolled).
      //     Invariant reconciliation:
      //       - A1 (verbatim) is preserved for EVERYTHING that fits: the guard is a
      //         no-op below the cap, and non-toolResult messages pass through
      //         referentially unchanged (boundFreshTailToolResults returns the same
      //         object when nothing truncated).
      //       - Masking a fresh-tail tool result is acceptable because the LCD store
      //         keeps the full content losslessly and `ctx_expand` recovers it (the
      //         honest marker advertises this).
      //       - A2 (pairing) stays valid: this step ONLY shrinks a toolResult's
      //         CONTENT — it never removes/reorders a message and never touches the
      //         `toolCallId` — so sanitizeToolUseResultPairing (step 6) still sees
      //         the same id on the (shrunk-content) toolResult.
      const { freshTail, boundedResults, charsRemoved } = boundFreshTailToolResults(
        rawFreshTail,
        LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS,
      );
      if (boundedResults > 0) {
        // Content-free DEBUG (AGENTS.md §2.2 / the lossless-store content-free rule):
        // counts only — NEVER the message text. Closes the B-13-class silent-path gap
        // for this new branch so a bounded fresh tail is diagnosable from logs alone.
        deps.logger.debug(
          {
            step: "lcd-fresh-tail-bound",
            conversationId,
            boundedResults,
            charsRemoved,
            capChars: LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS,
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
          },
          "lcd fresh-tail tool results bounded",
        );
      }

      // 4. BUDGET + EVICTION (A3) at the documented seam. Compute H from the model
      //    window (W) and the system-tokens estimate (S) via the profile-aware
      //    `computeTokenBudgetForProfile` (C1: 8K-starvation + 256K-overfill cap;
      //    byte-identical to `computeTokenBudget` for frontier/mid — Pitfall 1:
      //    never recompute W−S−O−M−R by hand),
      //    then evict the EVICTABLE PREFIX under H while the fresh tail ships
      //    UNCONDITIONALLY (A1/A3 — always included, even when the fresh tail alone
      //    exceeds H).
      //
      //    The evictable prefix is the resolved history MINUS the trailing items
      //    the fresh tail already covers. The fresh tail covers `live[tailStart..]`;
      //    the trailing `rawOverlap = max(0, persistedMsgCount − tailStart)`
      //    PERSISTED rows are the recent messages the fresh tail re-includes, and
      //    those map to RAW message-refs at the END of `context_items` (summaries
      //    collapse the OLDEST run, so the tail of the view is raw).
      //
      //    WR-01 robustness: `rawOverlap` is a RAW-message count (`rows.length`),
      //    while the slice indexes into the COLLAPSED `resolved` view
      //    (`resolved.length ≤ rows.length` once any leaf/condense pass has run).
      //    Subtracting `rawOverlap` from `resolved.length` directly is correct ONLY
      //    under the oldest-run-collapse invariant; if the fresh-tail window reaches
      //    back further than the trailing raw run (a large `freshTailTurns`, or a
      //    future non-oldest collapse), `resolved.length − rawOverlap` would slice
      //    ACROSS the head summary-ref and silently DROP the oldest history. So we
      //    bound the exclusion by `trailingMessageRefs` — the count of message-refs
      //    at the END of `resolved`, stopping at the first summary-ref — so the
      //    evictable-prefix slice can NEVER cut into a summary-ref. Under the normal
      //    invariant `rawOverlap ≤ trailingMessageRefs`, so this is byte-identical
      //    to the prior behavior; when the invariant is stressed it degrades to a
      //    benign double at the seam (transcript repair re-pairs it) rather than a
      //    silent drop.
      //
      //    Drop-free + double-free for BOTH L>H (mid-turn: the store lags the live
      //    array by the in-flight delta, so the in-flight tail rides only via
      //    `freshTail` — CR-01) and L<=H (a heal shrank the live array — WR-01).
      const persistedMsgCount = rows.length;
      const rawOverlap = Math.max(0, persistedMsgCount - tailStart);
      let trailingMessageRefs = 0;
      for (let i = resolvedKinds.length - 1; i >= 0 && resolvedKinds[i] === "message"; i--) {
        trailingMessageRefs++;
      }
      const overlapCount = Math.min(rawOverlap, trailingMessageRefs);
      const evictable = resolved.slice(0, Math.max(0, resolved.length - overlapCount));

      // I1 / WR-01: the WHOLE fresh-tail preamble block (`dynamicPreamble` +
      // `inlineMemory`, prepended into the latest user message by envelope-wrapper —
      // skills XML, MCP instructions, deferred-tools context, date/channel lines,
      // recalled memory, …, NOT just recall) rides the fresh tail and is invisible to
      // S by design (the recall-dag-budget-partition invariant). Subtract it as a
      // SEPARATE budget term so a heavier preamble (recall is a strict subset of it)
      // compacts older history harder — NEVER fold it into S. Counting the whole
      // preamble is deliberate: the fresh tail ships UNCONDITIONALLY below and is
      // reserved nowhere else, so this is the only window-headroom reservation for it
      // (measuring only recall would under-reserve H and risk a fresh-tail overflow).
      // Pass `-1` for the (defaulted) cacheFenceIndex to reach the 4th positional
      // `freshTailPreambleTokensEstimate` slot.
      const model = deps.getModel();
      const W = model.contextWindow;
      const S = deps.getSystemTokensEstimate?.() ?? 0;
      const freshTailPreambleTokens = deps.getFreshTailPreambleTokensEstimate?.() ?? 0;
      // C1 (Phase 152/165): profile-aware budget — 8K-starvation fix (effectiveO = min(O, maxOutputTokens))
      // and 256K-overfill cap for small/nano models. Frontier/mid: byte-identical to computeTokenBudget.
      // When deps.modelProfile is present: use it for both fixes (the standard C1 path).
      // When deps.modelProfile is absent: fail-closed to nano (K2) — an unthreaded profile must NOT
      // silently fall open to frontier (no cap). Apply the most-locked (nano, 16K) cap as
      // defense-in-depth and emit a loud WARN so any future missed wire is auditable — never silent.
      // Threading (Phase 165) makes this path dead code on the live dag path.
      let profile = deps.modelProfile;
      if (profile === undefined) {
        deps.logger.warn(
          {
            step: "lcd-evict",
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
            errorKind: "config" as const,
            hint: "modelProfile unthreaded — applied locked (nano) capacity cap; wire modelProfile through setupContextEngine",
          },
          "lcd assembler: modelProfile absent — failing closed to nano cap",
        );
        profile = {
          ...FAIL_CLOSED_PROFILE,
          contextWindow: W,         // use the actual model window, not the 8K sentinel
          maxOutputTokens: 8_192,   // 8K-starvation fix neutral (min(8192,8192)=8192)
        };
      }
      const budget = computeTokenBudgetForProfile(
        profile,
        S,
        freshTailPreambleTokens,
        -1,
        config.budget?.effectiveContextCapSmall,
        config.budget?.effectiveContextCapNano,
      );
      const budgeted = evictHistoryUnderBudget(evictable, budget.availableHistoryTokens);
      const droppedCount = evictable.length - budgeted.length;
      deps.logger.debug(
        {
          step: "lcd-evict",
          budgetTokens: budget.availableHistoryTokens,
          windowTokens: W,
          systemTokens: S,
          freshTailPreambleTokens,
          evictableCount: evictable.length,
          keptCount: budgeted.length,
          droppedCount,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd history evicted under budget",
      );

      // O1: emit the EXISTING `context:evicted` event from the LCD path (parity with
      // the pipeline engine's guard at context-engine.ts:663-672) when eviction
      // actually dropped history. CONTENT-FREE (AGENTS.md §2.2 / the lossless store):
      // `evictedChars` is derived ONLY from each dropped item's pre-computed `tokens`
      // field (× CHARS_PER_TOKEN_RATIO) — the message text is NEVER read or emitted.
      // Reuse the entry-clock read `startMs` for `timestamp` (no new clock read; the
      // globals gate bans ambient time). Reuse the existing event name — do NOT invent
      // a `context:lcd_evicted`.
      if (droppedCount > 0) {
        const droppedItems = evictable.slice(budgeted.length);
        const evictedChars = droppedItems.reduce(
          (sum, it) => sum + Math.round(it.tokens * CHARS_PER_TOKEN_RATIO),
          0,
        );
        deps.eventBus?.emit("context:evicted", {
          agentId: deps.agentId ?? "",
          sessionKey: deps.sessionKey ?? "",
          evictedCount: droppedCount,
          evictedChars,
          categories: { lcd_history: droppedCount },
          timestamp: startMs,
        });
      }

      // The fresh tail is concatenated UNCONDITIONALLY (A1/A3) — never evicted.
      const assembled = [...budgeted, ...freshTail];

      // 5. NORMALIZE assistant string content to array blocks.
      const normalized = assembled.map(normalizeAssistantContent);

      // 6. TRANSCRIPT REPAIR — the FINAL step (A2). Provider-valid pairing on
      //    ANY input: out-of-order results re-placed, unpaired calls get a marked
      //    synthesized result, orphan/duplicate results dropped.
      const repaired = sanitizeToolUseResultPairing(normalized, now());

      deps.logger.info(
        {
          step: "lcd-assemble",
          durationMs: now() - startMs,
          historyCount: budgeted.length,
          freshTailCount: freshTail.length,
          assembledCount: repaired.length,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd context assembled",
      );
      return repaired;
    },
  };
}

/**
 * The index in `messages` where the fresh tail begins: the position of the Nth-
 * from-last ASSISTANT message (a STEP = one assistant message + the tool results
 * it triggered, A1 — NOT user-turns). Everything at index >= the result is the
 * verbatim fresh tail. Returns 0 when the array has fewer than N assistant
 * messages (the whole array is the fresh tail).
 *
 * @param messages - the live message array
 * @param freshTailSteps - the number of trailing STEPS to keep verbatim
 * @returns the slice-start index for the fresh tail
 */
export function freshTailBoundaryIndex(messages: AgentMessage[], freshTailSteps: number): number {
  let stepsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === "assistant") {
      stepsSeen++;
      if (stepsSeen === freshTailSteps) return i; // include this assistant + everything after
    }
  }
  return 0; // fewer than N steps — the whole array is the fresh tail
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * B-8: bound oversized tool RESULTS inside the unconditional fresh tail. Pure +
 * non-mutating — for each `toolResult` message whose total text exceeds `cap`, run
 * the shared {@link createToolResultSizeGuard} (head+tail+honest marker) and return
 * a NEW message carrying the truncated content; every non-toolResult message and
 * every toolResult that fits passes through REFERENTIALLY unchanged (A1 preserved
 * for what fits). The guard's marker carries the lossless-recovery hint via
 * `toolHint`, so the model is honestly told the full content is recoverable.
 *
 * Only CONTENT shrinks here — no message is removed/reordered and the `toolCallId`
 * is never touched — so the later `sanitizeToolUseResultPairing` (A2) still re-pairs
 * the (shrunk-content) result with its `tool_use`.
 *
 * @param freshTail - the verbatim fresh-tail slice (the last N steps of the live array)
 * @param cap - the per-tool-RESULT char cap (`LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS`)
 * @returns the bounded fresh tail + counts (results bounded, chars removed) for the content-free DEBUG
 */
function boundFreshTailToolResults(
  freshTail: AgentMessage[],
  cap: number,
): { freshTail: AgentMessage[]; boundedResults: number; charsRemoved: number } {
  let boundedResults = 0;
  let charsRemoved = 0;
  const bounded = freshTail.map((m) => {
    if (roleOf(m) !== "toolResult") return m;
    const content = (m as unknown as { content?: unknown }).content;
    // A toolResult with non-array content (string shorthand / absent) cannot carry
    // an oversized text-block payload through the guard's block API — leave it
    // verbatim (A1). The guard only bounds array-of-blocks content.
    if (!Array.isArray(content)) return m;
    // The guard's `toolHint` carries the honest lossless-recovery marker suffix (not
    // the tool name — tool names are not the signal the model needs here; the
    // recoverability of the masked content is).
    const result = FRESH_TAIL_TOOL_RESULT_GUARD.truncateIfNeeded(
      content as ContentBlock[],
      cap,
      FRESH_TAIL_BOUND_RECOVERY_HINT,
    );
    if (!result.truncated) return m; // fits below the cap — byte-identical (A1).
    boundedResults++;
    charsRemoved += (result.metadata?.originalChars ?? 0) - (result.metadata?.truncatedChars ?? 0);
    // Return a NEW message with ONLY the content replaced (non-mutating, like
    // normalizeAssistantContent) — the role, toolCallId, toolName, etc. are intact.
    return { ...(m as object), content: result.content } as unknown as AgentMessage;
  });
  return { freshTail: bounded, boundedResults, charsRemoved };
}

/**
 * B-19: defensively coalesce maximal runs of ≥2 contiguous SUMMARY-ref user
 * messages into ONE user message. Pure — returns NEW `items`/`kinds` arrays
 * (same length contract: kinds stays parallel to items). For each run of ≥2
 * adjacent `"summary"` kinds, the run's rendered texts are joined with "\n\n"
 * (so each `[LCD summary …]` header + its wrapExternalContent-wrapped body + footer
 * stay individually intact + readable) and their `tokens` are SUMMED (budget math
 * unchanged); the merged item keeps `role: "user"` (the T-129-14 ceiling). A run of
 * 1 — the common single-summary head — and every message-ref pass through unchanged
 * (message-refs are never coalesced; they alternate with assistant turns).
 *
 * Security: each summary body was already individually wrapExternalContent-wrapped
 * with its OWN per-session random hex delimiter, so joining their rendered strings
 * cannot weaken the taint boundary — the delimiters differ per summary and the
 * trusted headers sit OUTSIDE each wrapped region.
 *
 * @param items - the resolved BudgetItems (summary-refs at the head, message-refs at the tail)
 * @param kinds - the parallel ref-kind array
 * @returns new `{ items, kinds }` with consecutive summary runs merged
 */
function coalesceConsecutiveSummaryRefs(
  items: BudgetItem[],
  kinds: LcdContextItem["refKind"][],
): { items: BudgetItem[]; kinds: LcdContextItem["refKind"][] } {
  const outItems: BudgetItem[] = [];
  const outKinds: LcdContextItem["refKind"][] = [];
  let i = 0;
  while (i < items.length) {
    if (kinds[i] !== "summary") {
      // A message-ref (or any non-summary) passes through verbatim.
      outItems.push(items[i]!);
      outKinds.push(kinds[i]!);
      i++;
      continue;
    }
    // Gather the maximal contiguous run of summary-refs starting at i.
    let j = i;
    while (j < items.length && kinds[j] === "summary") j++;
    const run = items.slice(i, j);
    if (run.length === 1) {
      // Run of 1 — no coalesce (the common single-summary head). Pass through.
      outItems.push(run[0]!);
    } else {
      // Merge the run into ONE user message: join rendered texts with "\n\n",
      // sum tokens. The role stays "user" (the untrusted-by-role ceiling).
      const joinedText = run.map((it) => summaryItemText(it)).join("\n\n");
      const tokens = run.reduce((sum, it) => sum + it.tokens, 0);
      outItems.push({
        msg: { role: "user", content: [{ type: "text", text: joinedText }] } as unknown as AgentMessage,
        tokens,
      });
    }
    outKinds.push("summary");
    i = j;
  }
  return { items: outItems, kinds: outKinds };
}

/**
 * Read the rendered text of a summary-ref BudgetItem (a `user` message whose
 * content is a single `{ type: "text", text }` block, as produced by
 * {@link summaryRefToMessage}). Falls back to "" for an unexpected shape so the
 * join is never `undefined` (defensive; summary-refs always render this shape).
 */
function summaryItemText(item: BudgetItem): string {
  const content = (item.msg as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b as { type?: string; text?: string }).text ?? "")
    .join("");
}

/**
 * Resolve one ordered `context_items` row into a canonical message paired with
 * its token authority (Pitfall 2), or `undefined` when the ref dangles (drift —
 * skipped, never fatal):
 *
 *  - a `"message"`-ref reconstructs verbatim via the core `partsToMessage` codec
 *    (stable ids, the round-trip the loop bug broke) and carries the row's STORED
 *    `tokenCount` (which counts the F3 thinking a re-estimate would under-count);
 *  - a `"summary"`-ref injects via {@link summaryRefToMessage} and carries the
 *    summary's pre-computed `tokenCount`.
 *
 * Closed discriminator (AGENTS.md §2.8): the `refKind` switch is exhaustive over
 * the `"message" | "summary"` union.
 */
function resolveContextItem(
  item: LcdContextItem,
  rowById: Map<string, LcdMessage>,
  summaryById: Map<string, LcdSummary>,
): BudgetItem | undefined {
  switch (item.refKind) {
    case "message": {
      const row = rowById.get(item.refId);
      if (row === undefined) return undefined; // dangling message-ref (drift) — skip.
      return { msg: partsToMessage(row) as AgentMessage, tokens: row.tokenCount };
    }
    case "summary": {
      const summary = summaryById.get(item.refId);
      if (summary === undefined) return undefined; // dangling summary-ref (drift) — skip.
      return { msg: summaryRefToMessage(summary), tokens: summary.tokenCount };
    }
    default: {
      const _exhaustive: never = item.refKind;
      return _exhaustive;
    }
  }
}

/**
 * Render a summary as an HONEST, TAINT-SAFE `user`-role message (P1) — the ONE
 * seam Phase 130 swaps from the plain text passthrough Phase 129 left here.
 *
 * The honesty markers (depth / descendant_count / ISO time-range / trust, plus
 * R2's `fallback=emergency-truncation` when `summary.fallback`) are computed from
 * the STORE ROW (`summary.depth`/`descendantCount`/`earliestAt`/`latestAt`/
 * `fallback`), NEVER parsed from `content`, and placed in the TRUSTED header +
 * footer OUTSIDE the `wrapExternalContent` untrusted region. A poisoned summary
 * body therefore cannot forge them: the per-session random hex delimiter is
 * unpredictable, and `replaceMarkers` neutralizes any injected `<<<UNTRUSTED_…>>>`
 * / `<<<END_UNTRUSTED_…>>>` marker the content tries to smuggle in (RED-proven:
 * a body forging `trust=trusted` / `fallback=emergency-truncation` + a fake
 * end-delimiter still renders the real `trust=untrusted` + the real fallback flag
 * and the forged delimiter collapses to `[[END_MARKER_SANITIZED]]`).
 *
 * Role stays `"user"` — the documented ceiling (T-129-14): a summary derived from
 * possibly-untrusted history is carried untrusted-by-role, NEVER `system`/
 * `assistant`. The body is wrapped via `wrapExternalContent` (the AGENTS.md §2.2
 * taint primitive) rather than hand-rolled XML escaping.
 *
 * The expand footer is an honest ADVERTISEMENT of WHAT was compressed (depth +
 * count + time-range); the recovery TOOLS (`ctx_*`) are Phase 131 — DECISION
 * GATE #3 / RESEARCH A4: do NOT name them here. Keep this the single resolution
 * point so future swaps touch one function.
 */
function summaryRefToMessage(summary: LcdSummary): AgentMessage {
  // `trust` is ALWAYS "untrusted" (the row is untrusted-by-derivation; the value
  // is derived, never widened to "trusted"). R2 (Phase 132): when the row's
  // `fallback` flag is set — the breaker/spend-cap bypass or the deterministic
  // Level-3 floor produced this summary with NO LLM — append the unspoofable
  // `LCD_FALLBACK_HEADER_MARKER` so the model is honestly told the summary is a
  // degraded emergency truncation. The marker lives in the TRUSTED header here,
  // OUTSIDE the `wrapExternalContent` region below, so a poisoned body can neither
  // forge it (the per-session random hex delimiter is unpredictable +
  // `replaceMarkers` sanitizes spoofed delimiters) nor strip it (only the real
  // `summary.fallback` row flag — never the content — drives it).
  const trust = "untrusted";
  const range = isoRange(summary.earliestAt, summary.latestAt);
  const fallbackMarker = summary.fallback ? `, ${LCD_FALLBACK_HEADER_MARKER}` : "";
  const header =
    `[LCD summary — depth=${summary.depth}, ` +
    `descendant_count=${summary.descendantCount}, ` +
    `${range}, trust=${trust}${fallbackMarker}]`;
  // The body is UNTRUSTED — scrub secrets, THEN wrap it. `source: "unknown"`
  // (label "External") is the generic untrusted-text source; the
  // `ExternalContentSource` union has no `lcd_summary` label and a P1 plan does not
  // edit the core security enum. The honesty markers live OUTSIDE this wrapped
  // region (the trusted header/footer), so no `includeWarning` wall is needed per
  // summary — the header + the P2 system clause carry the policy.
  //
  // Egress scrub (FIX 2c): a summary is DERIVED from a region that can legitimately
  // contain a credential (the F1 lossless store keeps the raw conversation). The
  // summary re-enters the model context every turn it is assembled, so the derived
  // body must never carry the secret verbatim — scrub this egress copy (the base
  // store stays lossless), mirroring the ctx_expand / ctx_search egress scrub.
  const safeBody = wrapExternalContent(scrubSecretsFromText(summary.content).text, {
    source: "unknown",
    includeWarning: false,
  });
  const footer =
    `Expand for details about: the ${summary.descendantCount} compressed ` +
    `message(s) at depth ${summary.depth} spanning ${range}.`;
  const text = `${header}\n${safeBody}\n${footer}`;
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/**
 * Format the inclusive `[earliestAtMs, latestAtMs]` epoch-millisecond span as an
 * ISO date range `YYYY-MM-DD..YYYY-MM-DD`, collapsing to a single `YYYY-MM-DD`
 * when both ends fall on the same day. Pure formatting of already-known values —
 * NOT a clock read — but the globals classifier flags `new Date(arg)` regardless
 * of its argument, so the conversion goes through the sanctioned-root
 * `systemDateFrom` indirection (the AGENTS.md §1 helper for `new Date(stored)`
 * display formatting; the `rag-retriever.ts` precedent).
 */
function isoRange(earliestAtMs: number, latestAtMs: number): string {
  const start = systemDateFrom(earliestAtMs).toISOString().slice(0, 10);
  const end = systemDateFrom(latestAtMs).toISOString().slice(0, 10);
  return start === end ? start : `${start}..${end}`;
}

/**
 * Step 5: if an assistant message's `content` is a string, return a NEW message
 * whose content is `[{ type: "text", text }]`; otherwise return the message
 * unchanged. Pure + non-mutating; tool blocks (array content) are never touched.
 */
function normalizeAssistantContent(m: AgentMessage): AgentMessage {
  if (roleOf(m) !== "assistant") return m;
  const content = (m as unknown as { content?: unknown }).content;
  if (typeof content !== "string") return m;
  return { ...(m as object), content: [{ type: "text", text: content }] } as unknown as AgentMessage;
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}
