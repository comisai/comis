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
 *       small/nano; byte-identical to `computeTokenBudget` for frontier/mid), then trim
 *       ONLY the evictable prefix (resolved history minus the items the fresh tail covers)
 *       to fit H via `evictHistoryUnderBudget` (recency, frontier/mid) OR the RETR-02
 *       margin arbiter `evictUnderArbiter` (relevance-first small/nano — fused-rank
 *       allocation with T0/S4 floors); the fresh tail is concatenated UNCONDITIONALLY
 *       (A1/A3 — always included, even when it alone exceeds H). The prefix/fresh-tail
 *       boundary is drop-free and double-free for both L>H (mid-turn, the store lags the
 *       live array — CR-01) and L<=H (a heal shrank the live array — WR-01); transcript
 *       repair (step 6) re-pairs the seam regardless.
 *  5.   NORMALIZE — assistant string content -> `[{ type: "text", text }]`
 *       (pure, non-mutating; tool blocks untouched).
 *  6.   TRANSCRIPT REPAIR — `sanitizeToolUseResultPairing` runs LAST (A2), so the
 *       provider can never receive an unpaired/out-of-order pairing even if the
 *       history/fresh-tail seam landed mid-pair.
 *
 * Keep the body THIN (Pitfall 7): the eviction logic lives in pure modules
 * (`lcd-budget-eviction.ts`, `margin-arbiter.ts` / `lcd-arbiter-seam.ts`) and the leaf
 * summarization in Plan 03's; this assembler only RESOLVES + CALLS them.
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

import { partsToMessage, systemNowMs } from "@comis/core";
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
import { resolveClampedFreshTailTurns } from "../model/fresh-tail-clamp.js";
import { computeTokenBudgetForProfile } from "./budget-capacity-cap.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";
import { runPreflightFitCheck } from "./lcd-preflight.js";
import { summaryRefToMessage } from "./lcd-summary-render.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import { evictUnderArbiter, emitEvictedEvent } from "./lcd-arbiter-seam.js";
import { computeFreshTailCapChars, boundFreshTailMessages } from "./lcd-fresh-tail-bound.js";
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
      // EFF-01: collect the refId sets from contextItems FIRST so we can issue
      // bounded IN-clause reads instead of fetching ALL rows for the scope.
      // An empty set short-circuits to [] without any DB query (zero wasted I/O).
      // These bounded `rows`/summaries are used ONLY as the resolve-time lookup
      // maps (rowById/summaryById) — every message-ref/summary-ref in contextItems
      // is in the collected id set by construction, so the maps are complete for
      // resolution. The TOTAL persisted-message count (persistedMsgCount, used by
      // the fresh-tail/eviction overlap math) is read SEPARATELY via the bounded
      // `countMessages` COUNT below — it must NOT be derived from rows.length, which
      // counts only the still-referenced subset. T-170-01-01/02: R4 scope triple is
      // always passed through to getMessagesByIds / getSummariesByIds.
      const messageRefIds = contextItems
        .filter((ci) => ci.refKind === "message")
        .map((ci) => ci.refId);
      const summaryRefIds = contextItems
        .filter((ci) => ci.refKind === "summary")
        .map((ci) => ci.refId);
      const rows: LcdMessage[] =
        readScope && messageRefIds.length > 0
          ? store.getMessagesByIds(readScope, messageRefIds)
          : [];
      const rowById = new Map<string, LcdMessage>(rows.map((row) => [row.id, row]));
      const summaryById = new Map<string, LcdSummary>(
        (readScope && summaryRefIds.length > 0
          ? store.getSummariesByIds(readScope, summaryRefIds)
          : []
        ).map((s) => [s.summaryId, s]),
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
      // EFF-02: clamp freshTailTurns to what the effective window can afford.
      // deps.modelProfile?.contextWindow is Infinity for frontier/mid — clamp never fires.
      const effectiveWindow = deps.modelProfile?.contextWindow ?? Infinity;
      const clampedFreshTailTurns = resolveClampedFreshTailTurns(
        effectiveWindow,
        config.freshTailTurns,
      );
      const tailStart = freshTailBoundaryIndex(liveMessages, clampedFreshTailTurns);
      const rawFreshTail = liveMessages.slice(tailStart);
      deps.logger.debug(
        {
          step: "lcd-fresh-tail",
          freshTailSteps: clampedFreshTailTurns,
          configuredFreshTailSteps: config.freshTailTurns,
          freshTailCount: rawFreshTail.length,
          tailStart,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd fresh tail sliced verbatim",
      );

      // 3b. FRESH-TAIL SIZE BOUNDING (B-8 + Issue-1) happens AFTER the budget
      //     is computed below — the per-message cap is derived from the turn's
      //     `availableHistoryTokens`, which only exists post-budget. See the
      //     boundFreshTailMessages call between steps 4's budget and eviction.

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
      //    WR-01 robustness: `rawOverlap` is a RAW-message count (`persistedMsgCount`,
      //    the bounded COUNT(*) total — NOT `rows.length`, which is the referenced
      //    working-set subset post EFF-01), while the slice indexes into the COLLAPSED
      //    `resolved` view (`resolved.length ≤ persistedMsgCount` once any leaf/condense
      //    pass has run).
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
      // EFF-01 (regression fix): persistedMsgCount is the TOTAL count of persisted
      // messages in scope — NOT `rows.length`. `rows` is now the BOUNDED working
      // set (message-refs only); once the oldest messages fold into summary-refs,
      // `rows.length` undercounts the total and corrupts the fresh-tail/eviction
      // overlap below (this was the lcd-synthetic-session gate failure: a broken
      // fresh tail + a mis-placed condensed summary). `countMessages` is a bounded
      // COUNT(*) — one integer, NO O(total-history) row fetch — so assembly is
      // byte-identical to the pre-EFF-01 `getMessages(readScope).length` while the
      // row fetch stays O(referenced-ids). Fail-closed: no read scope ⇒ 0.
      const persistedMsgCount = readScope ? store.countMessages(readScope) : 0;
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
        // KNOB-02 (Phase 176): executor-reconcile provenance — when present,
        // rawContextWindowTokens reports the TRUE configured window (not the
        // served value the executor overwrote contextWindow with) and
        // windowCapSource gains "served". Undefined until the executor wires
        // it (plan 176-04) ⇒ byte-identical until then.
        deps.windowProvenance,
      );

      // 3b (deferred). FRESH-TAIL SIZE BOUNDING (B-8 + Issue-1). The fresh tail
      //     ships UNCONDITIONALLY below (A1/A3) and the dag path runs NEITHER the
      //     observation masker NOR the dead-content evictor (pipeline-only), so a
      //     turn whose last steps carry a huge tool output — OR a huge user/
      //     assistant message (the Issue-1 session brick: one over-window message
      //     rides the fresh tail forever) — would overflow the model window before
      //     any budget pass sees it. Bound each oversized fresh-tail message to
      //     the H-derived per-message cap (lcd-fresh-tail-bound.ts owns the cap
      //     math + the guard mechanics and their full invariant notes).
      //     Invariant reconciliation:
      //       - A1 (verbatim) is preserved for EVERYTHING that fits: the guards are
      //         no-ops below the cap, and every message that fits passes through
      //         referentially unchanged (boundFreshTailMessages returns the same
      //         object when nothing truncated).
      //       - Masking fresh-tail content is acceptable because the LCD store
      //         keeps the full content losslessly and `ctx_expand` recovers it (the
      //         honest marker advertises this; ingestion stores the RAW message).
      //       - A2 (pairing) stays valid: this step ONLY shrinks text CONTENT — it
      //         never removes/reorders a message, never touches a `toolCallId`, and
      //         never rewrites a non-text block (toolCall blocks pass through the
      //         guard untouched) — so sanitizeToolUseResultPairing (step 6) still
      //         sees the same ids.
      //       - Role-untrusted handling (T-129-14) is untouched: roles are never
      //         changed; only text inside an existing message shrinks.
      const freshTailCapChars = computeFreshTailCapChars(budget.availableHistoryTokens);
      const { freshTail, boundedResults, boundedMessages, charsRemoved } =
        boundFreshTailMessages(rawFreshTail, freshTailCapChars);
      if (boundedResults > 0 || boundedMessages > 0) {
        // Content-free DEBUG (AGENTS.md §2.2 / the lossless-store content-free rule):
        // counts only — NEVER the message text. Closes the B-13-class silent-path gap
        // for this new branch so a bounded fresh tail is diagnosable from logs alone.
        deps.logger.debug(
          {
            step: "lcd-fresh-tail-bound",
            conversationId,
            boundedResults,
            boundedMessages,
            charsRemoved,
            capChars: freshTailCapChars,
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
          },
          "lcd fresh-tail messages bounded",
        );
      }

      // RETR-02/03/05 eviction seam (step 4 above). Frontier/mid (relevanceFirst falsy) take
      // the EXISTING recency call VERBATIM — same call, same args → referentially the
      // pre-patch AgentMessage[], BYTE-IDENTICAL (LOCKED #2; the arbiter does NOT run for
      // them). Relevance-first → the margin arbiter over the SAME availableHistoryTokens.
      const budgeted: AgentMessage[] =
        deps.relevanceFirst === true
          ? evictUnderArbiter(deps, evictable, budget.availableHistoryTokens, liveMessages, startMs).budgeted
          : evictHistoryUnderBudget(evictable, budget.availableHistoryTokens);
      const droppedCount = evictable.length - budgeted.length;
      deps.logger.debug(
        {
          step: "lcd-evict",
          budgetTokens: budget.availableHistoryTokens,
          windowTokens: budget.windowTokens,
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

      // O1: emit the content-free `context:evicted` event (parity with the pipeline engine)
      // when eviction dropped history — extracted to lcd-arbiter-seam.ts (keeps this body
      // THIN). Shared by both the recency and arbiter paths; reuses startMs (no new clock).
      emitEvictedEvent(deps, evictable, budgeted.length, startMs);

      // The fresh tail is concatenated UNCONDITIONALLY (A1/A3) — never evicted.
      const assembled = [...budgeted, ...freshTail];

      // 5. NORMALIZE assistant string content to array blocks.
      const normalized = assembled.map(normalizeAssistantContent);

      // 6. TRANSCRIPT REPAIR — the FINAL step (A2). Provider-valid pairing on
      //    ANY input: out-of-order results re-placed, unpaired calls get a marked
      //    synthesized result, orphan/duplicate results dropped.
      const repaired = sanitizeToolUseResultPairing(normalized, now());

      // Phase 166 CWF-02: pre-flight fit check — enforce assembledInputTokens ≤ effectiveWindow − outputHeadroom.
      // Security-pinned messages (T-S4) are filtered via isSecurityRelevantMessage and NEVER evicted.
      // Throws ContextExhaustionError when infeasible even at the thinking-level floor.
      // Extracted to lcd-preflight.ts to keep this file ≤ 820 lines.
      // Pass evictable (BudgetItem[]) + keptCount so the helper can recompute token sums
      // (evictHistoryUnderBudget returns AgentMessage[] which carries no token metadata).
      const assembledInputTokens = runPreflightFitCheck(
        deps,
        budget.windowTokens,
        evictable,
        budgeted.length,
        freshTail,
        (profile.reasoningStyle ?? "none") as "none" | "native",
        // W1 cap provenance: lets the exhaustion throw/WARN name the raw
        // declared window and the knob that clamped it (contextEngine.budget.*
        // or, for "served", the Ollama knobs). Fields come off the budget —
        // never re-derived. servedWindowTokens (KNOB-02) lets the double-cap
        // message name the whole chain.
        {
          rawContextWindowTokens: budget.rawContextWindowTokens,
          windowCapSource: budget.windowCapSource,
          servedWindowTokens: budget.servedWindowTokens,
        },
      );

      deps.logger.info(
        {
          step: "lcd-assemble",
          durationMs: now() - startMs,
          historyCount: budgeted.length,
          freshTailCount: freshTail.length,
          assembledCount: repaired.length,
          // W5 (obs-llm-troubleshooting): the budget equation at INFO — the live
          // incident was diagnosable only because logLevel happened to be debug
          // (the lcd-evict budget fields are DEBUG). One line per LLM call.
          windowTokens: budget.windowTokens,
          rawContextWindowTokens: budget.rawContextWindowTokens,
          windowCapSource: budget.windowCapSource,
          servedWindowTokens: budget.servedWindowTokens,
          systemTokens: budget.systemTokens,
          freshTailPreambleTokens: budget.freshTailPreambleTokens,
          availableHistoryTokens: budget.availableHistoryTokens,
          assembledInputTokens,
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
      // WR-01 (Phase 174-04): carry the durable lcd_messages.id so the DEPTH-01 relevance
      // pass (rankMiddleBandByRelevance) can match a searchLcd hit by its stable `refId`
      // (= row.id) instead of a fragile snippet substring. row.id IS the refId every hit
      // carries — so a pure tool_use/tool_result message (empty block-text render) now ranks.
      return { msg: partsToMessage(row) as AgentMessage, tokens: row.tokenCount, lcdId: row.id };
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
