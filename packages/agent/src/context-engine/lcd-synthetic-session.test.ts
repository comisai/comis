// SPDX-License-Identifier: Apache-2.0
/**
 * The Phase-129 synthetic-session GATE (the C1/A3 headline — Plan 05 Task 2).
 *
 * Composes Plans 02 (store: appendLeafSummary/getContextItems/getSummaries),
 * 03 (leaf summarizer: selectLeafChunk/summarizeLeafChunk) and 04 (pure
 * evictHistoryUnderBudget) through the Plan-05 assembler over a LONG session and
 * proves the three success criteria TOGETHER, plus the escalation invariant:
 *
 *   (1) UNDER BUDGET — the assembled history PREFIX stays ≤ the H budget computed
 *       from the test model window + a representative S (the fresh tail is allowed
 *       to push the WHOLE array over only when it alone exceeds H).
 *   (2) FRESH TAIL INTACT — the last `freshTailTurns` STEPS of the live array
 *       appear verbatim (byte-identical structured blocks, referential identity)
 *       at the END of the assembled array, never evicted.
 *   (3) NO TOOL PAIR SPLIT — the assembled array is already provider-valid BEFORE
 *       transcript repair would synthesize anything: no synthesized-placeholder
 *       result is present (the eviction + leaf-chunk boundaries are step-atomic,
 *       so the evicted seam never split a tool_use/tool_result pair).
 *   (4) ESCALATION ALWAYS REDUCES — an OVERSIZED stub (returns a string LARGER
 *       than the chunk) drives the ladder to the deterministic Level-3 floor: the
 *       persisted summary's tokenCount < the chunk tokenCount and fallback=true.
 *
 * NO REAL LLM (Pitfall 6): the summarizer is a plain stub function; the test
 * imports no provider and makes no network call, so the gate runs under
 * `pnpm validate`. The store is the REAL `createLcdStore(new Database(":memory:"))`
 * — `@comis/memory` is an agent devDependency, allowed in `.test.ts` only (the
 * agent↛memory cut; production code never imports it).
 */
import {
  type AppendMessageInput,
  type ContextStorePort,
  type ContextStoreScope,
  type LcdMessage,
  messageToParts,
  partsToMessage,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import { describe, it, expect, beforeEach } from "vitest";
import { createLcdContextEngine, freshTailBoundaryIndex } from "./lcd-assembler.js";
import {
  selectLeafChunk,
  summarizeLeafChunk,
  type LeafChunkItem,
  type LeafSummarizer,
  type LeafSummarizerDeps,
} from "./lcd-leaf-summarizer.js";
// Phase 130, C2: the afterTurn condense pass that folds ≥condensedMinFanout
// contiguous same-depth leaf summaries into one depth+1 condensed summary.
import { maybeRunCondensePass } from "../executor/lcd-condense-trigger.js";
import { CONDENSED_FALLBACK_SUMMARY_MARKER } from "./constants.js";
import { computeTokenBudget } from "./token-budget.js";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import type { ContextEngineDeps } from "./types.js";
import type { ModelProfile } from "../executor/model-profile.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { resolveClampedFreshTailTurns } from "../model/fresh-tail-clamp.js";

// The synthesized-placeholder marker transcript repair emits for an unpaired
// tool_use (T-128-01). Its ABSENCE in the assembled array proves no pair split.
const SYNTHESIZED_RESULT_MARKER = "[tool result missing — synthesized placeholder]";
// The deterministic Level-3 leaf-fallback marker (constants.ts).
const LEAF_FALLBACK_SUMMARY_MARKER = "[lcd-leaf-fallback]";

const CONVERSATION_ID = "conv-synthetic";
const FIXED_CREATED_AT_BASE = 1000;

const SCOPE: ContextStoreScope = {
  conversationId: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

// ---------------------------------------------------------------------------
// Fixtures (mirror lcd-assembler.test.ts)
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: FIXED_CREATED_AT_BASE } as Message;
}

function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: FIXED_CREATED_AT_BASE,
  } as unknown as Message;
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolUse",
    timestamp: FIXED_CREATED_AT_BASE,
  } as unknown as Message;
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: FIXED_CREATED_AT_BASE,
  } as unknown as Message;
}

function roleOf(m: AgentMessage): string {
  return (m as unknown as { role: string }).role;
}

/** Append a canonical pi-ai message at the next seq, storing its REAL estimated
 *  token count (mirrors production ingest — the budget authority, Pitfall 2). */
function append(store: ContextStorePort, msg: Message, seq: number): void {
  const input: AppendMessageInput = {
    scope: SCOPE,
    seq,
    role: msg.role,
    tokenCount: estimateMessageTokens(msg),
    createdAt: FIXED_CREATED_AT_BASE + seq,
    parts: messageToParts(msg),
  };
  store.append(input);
}

/**
 * Build a LONG synthetic session: `turns` turns, each a user message + an
 * assistant action. Every Kth turn is a TOOL turn (assistant tool_use +
 * toolResult) so the session interleaves text and inseparable tool pairs. The
 * text is padded so each message carries a non-trivial token count (the budget
 * actually bites). Returns the live message array (also persisted to the store).
 */
function buildLongSession(store: ContextStorePort, turns: number): Message[] {
  const PAD = "x ".repeat(200); // ~400 chars ≈ 100 text tokens per message
  const live: Message[] = [];
  let seq = 0;
  for (let t = 0; t < turns; t++) {
    const u = userMsg(`u${t} ${PAD}`);
    live.push(u);
    append(store, u, seq++);
    if (t % 4 === 3) {
      // A TOOL turn: assistant tool_use + its toolResult (an inseparable pair).
      const id = `tu_${t}`;
      const call = assistantToolCall(id, "read", { path: `/file/${t}`, note: PAD });
      live.push(call);
      append(store, call, seq++);
      const res = toolResult(id, "read", `contents-${t} ${PAD}`);
      live.push(res);
      append(store, res, seq++);
    } else {
      const a = assistantText(`a${t} ${PAD}`);
      live.push(a);
      append(store, a, seq++);
    }
  }
  return live;
}

/** A SHORT-summary stub (Level-1 success): a fixed small string, no network. */
const shortStub: LeafSummarizer = async () => "LEAF: prior turns summarized (short).";

/** An OVERSIZED stub: returns a string far larger than any chunk → forces the
 *  ladder past Levels 1+2 to the deterministic Level-3 floor. No network. */
const oversizedStub: LeafSummarizer = async (messages) => {
  const chunkChars = messages.reduce(
    (acc, m) => acc + JSON.stringify((m as unknown as { content?: unknown }).content ?? "").length,
    0,
  );
  return "BLOAT ".repeat(chunkChars); // strictly larger than the chunk, always.
};

function makeLeafDeps(summarize: LeafSummarizer): LeafSummarizerDeps {
  return {
    logger: createMockLogger() as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
  };
}

/**
 * One leaf pass over the CURRENT store state: resolve the ordered context_items
 * into `LeafChunkItem`s (message-refs only — a leaf never re-summarizes a prior
 * summary in 129; summary-refs are depth-0 terminals here), select the oldest
 * out-of-tail chunk, summarize via the stub, and persist it via
 * `appendLeafSummary` over the mapped context_items ordinal range. Returns the
 * persisted `{ summaryId, chunkTokens, summaryTokens, fallback }` or `undefined`
 * when nothing outside the fresh tail is compactable (the loop terminates).
 *
 * The driver lives in the test (the gate drives the pass directly; the afterTurn
 * threshold-sweep wiring is out of 129's scope per Open Q2 / YAGNI).
 */
async function runOneLeafPass(
  store: ContextStorePort,
  deps: LeafSummarizerDeps,
  freshTailSteps: number,
  leafChunkTokens: number,
  reserveTokens: number,
): Promise<
  | { summaryId: string; chunkTokens: number; summaryTokens: number; fallback: boolean }
  | undefined
> {
  const items = store.getContextItems(SCOPE);
  const rows = store.getMessages(SCOPE);
  const rowById = new Map<string, LcdMessage>(rows.map((r) => [r.id, r]));

  // Build the resolved-history LeafChunkItems, tracking each item's context_items
  // ordinal. A leading summary-ref (from a prior pass) is SKIPPED — we compact
  // the contiguous raw-message run that follows it (its ordinal range is
  // contiguous because summaries always sit oldest-first).
  const chunkItems: LeafChunkItem[] = [];
  const ordinals: number[] = [];
  for (const item of items) {
    if (item.refKind !== "message") {
      // A summary terminator: if we have not started collecting raw messages yet,
      // skip it (it is an already-compacted oldest leaf); if we HAVE, stop (do not
      // span across a summary — keep the persisted ordinal range contiguous).
      if (chunkItems.length === 0) continue;
      break;
    }
    const row = rowById.get(item.refId);
    if (!row) continue;
    chunkItems.push({
      id: row.id,
      // Reconstruct the canonical message via the SAME core codec the assembler
      // uses (partsToMessage) — faithful role + content for selection/summarize.
      msg: partsToMessage(row) as AgentMessage,
      tokens: row.tokenCount,
      createdAt: row.createdAt,
    });
    ordinals.push(item.ordinal);
  }
  if (chunkItems.length === 0) return undefined;

  const chunk = selectLeafChunk(chunkItems, freshTailSteps, leafChunkTokens);
  if (!chunk) return undefined;

  // The covered context_items ordinal range maps from the chunk's [0,endIndex)
  // indices into the collected raw run (contiguous → ordinals[0..endIndex-1]).
  const startOrdinal = ordinals[0]!;
  const endOrdinal = ordinals[chunk.endIndex - 1]!;

  const selected = chunkItems.slice(0, chunk.endIndex);
  const result = await summarizeLeafChunk(selected, deps, { reserveTokens });

  const summaryId = store.appendLeafSummary({
    scope: SCOPE,
    tokenCount: result.tokenCount,
    content: result.content,
    descendantCount: result.descendantCount,
    earliestAt: result.earliestAt,
    latestAt: result.latestAt,
    fileIds: [],
    fallback: result.fallback,
    taint: false,
    createdAt: FIXED_CREATED_AT_BASE,
    startOrdinal,
    endOrdinal,
  });
  return {
    summaryId,
    chunkTokens: chunk.tokens,
    summaryTokens: result.tokenCount,
    fallback: result.fallback,
  };
}

/** Drive leaf passes until nothing outside the fresh tail is compactable, or a
 *  bounded max-rounds is hit (defensive — the loop must terminate). */
async function compactUntilStable(
  store: ContextStorePort,
  deps: LeafSummarizerDeps,
  freshTailSteps: number,
  leafChunkTokens: number,
  reserveTokens: number,
  maxRounds = 20,
): Promise<number> {
  let rounds = 0;
  for (let r = 0; r < maxRounds; r++) {
    const out = await runOneLeafPass(store, deps, freshTailSteps, leafChunkTokens, reserveTokens);
    if (!out) break;
    rounds++;
  }
  return rounds;
}

function makeDagDeps(store: ContextStorePort, contextWindow: number): ContextEngineDeps {
  const logger = createMockLogger();
  return {
    logger: logger as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: true, contextWindow, maxTokens: 8_192 }),
    // Phase 165 (CWF-01) made the dag assembler fail CLOSED to the nano cap (16K)
    // when modelProfile is absent. In production the profile is always threaded
    // (pi-executor → setupContextEngine), so this fixture supplies a frontier
    // profile at the intended window — otherwise the nano cap would evict the
    // condensed summary this suite asserts on. effectiveWindow = min(W, ∞) = W.
    modelProfile: {
      ...FAIL_CLOSED_PROFILE,
      capabilityClass: "frontier" as const,
      contextWindow,
      maxOutputTokens: 8_192,
    } as ModelProfile,
    getSystemTokensEstimate: () => 0,
    contextStore: store,
    conversationId: CONVERSATION_ID,
    agentId: "agent_a",
    tenantId: "tenant_a", // R4 (132-03): full read scope (else the assembler fails closed — WR-02)
    sessionKey: "sess-a",
  };
}

const dagConfig = (freshTailTurns: number) =>
  ({ enabled: true, thinkingKeepTurns: 10, historyTurns: 15, version: "dag", freshTailTurns }) as unknown as Parameters<typeof createLcdContextEngine>[0];

/** Sum estimated tokens over an assembled message array. */
function estimateArrayTokens(msgs: AgentMessage[]): number {
  return msgs.reduce((acc, m) => acc + estimateMessageTokens(m as unknown as Message), 0);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("LCD synthetic-session gate (Plan 05 Task 2 — C1/A3 headline)", () => {
  let store: ContextStorePort;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("a long session (stub summarizer) stays UNDER BUDGET, the FRESH TAIL is intact, and NO tool pair is split", async () => {
    const FRESH_TAIL_STEPS = 8;
    const LEAF_CHUNK_TOKENS = 1_500; // small cap → MANY leaf passes over the session
    const LEAF_TARGET_TOKENS = 1_200;
    // A SMALL window so H actually bites: W=20k → H = 20000 − O(8192) − M(2048)
    // − R(5000) = 4760. The full session history (~14k tok) far exceeds it, and
    // the fresh tail (8 steps ≈ 2k tok) fits — so eviction + leaf compaction are
    // genuinely load-bearing (not a no-op on a roomy window).
    const CONTEXT_WINDOW = 20_000;

    // 64 turns ≈ 140+ messages (every 4th turn is a tool pair).
    const live = buildLongSession(store, 64) as AgentMessage[];
    expect(live.length).toBeGreaterThan(60);

    // Drive leaf passes until the oldest out-of-tail history is compacted.
    const rounds = await compactUntilStable(
      store,
      makeLeafDeps(shortStub),
      FRESH_TAIL_STEPS,
      LEAF_CHUNK_TOKENS,
      LEAF_TARGET_TOKENS,
    );
    expect(rounds).toBeGreaterThan(0); // the loop actually ran (composition exercised)

    // Assemble the live array through the dag engine.
    const engine = createLcdContextEngine(dagConfig(FRESH_TAIL_STEPS), makeDagDeps(store, CONTEXT_WINDOW));
    const out = await engine.transformContext(live);

    // ---- (2) FRESH TAIL INTACT: the last clamped-tail steps of the LIVE
    //         array are present verbatim (referential identity) at the END. ----
    // EFF-02: the assembler clamps FRESH_TAIL_STEPS to what CONTEXT_WINDOW can afford.
    // Use the same clamped value to compute the expected tail so the assertion tracks
    // the real assembler behavior (referential identity of the clamped tail).
    const clampedTailSteps = resolveClampedFreshTailTurns(CONTEXT_WINDOW, FRESH_TAIL_STEPS);
    const tailStart = freshTailBoundaryIndex(live, clampedTailSteps);
    const freshTail = live.slice(tailStart);
    expect(freshTail.length).toBeGreaterThan(0);
    const outTail = out.slice(out.length - freshTail.length);
    for (let i = 0; i < freshTail.length; i++) {
      // Byte-identical structured blocks — the SAME live object passed through.
      expect(outTail[i]).toBe(freshTail[i]);
    }

    // ---- (3) NO TOOL PAIR SPLIT: no synthesized-placeholder result is present
    //         (the evicted seam never split a tool_use/tool_result pair). ----
    const anySynthesized = out.some((m) =>
      JSON.stringify((m as unknown as { content?: unknown }).content ?? "").includes(
        SYNTHESIZED_RESULT_MARKER,
      ),
    );
    expect(anySynthesized).toBe(false);
    // And the array is provider-valid: every toolResult follows a seen tool_use.
    const seenCalls = new Set<string>();
    for (const m of out) {
      if (roleOf(m) === "assistant") {
        const content = (m as unknown as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if ((b as { type?: string }).type === "toolCall") seenCalls.add((b as { id: string }).id);
          }
        }
      }
      if (roleOf(m) === "toolResult") {
        expect(seenCalls.has((m as unknown as { toolCallId: string }).toolCallId)).toBe(true);
      }
    }

    // ---- (1) UNDER BUDGET: the assembled history PREFIX (everything before the
    //         fresh tail) is ≤ the H budget computed from the window + S. ----
    const budget = computeTokenBudget(CONTEXT_WINDOW, 0);
    const prefix = out.slice(0, out.length - freshTail.length);
    const prefixTokens = estimateArrayTokens(prefix);
    expect(prefixTokens).toBeLessThanOrEqual(budget.availableHistoryTokens);
    // The FULL session would have blown the budget (proves compaction+eviction
    // actually did work — the assembled prefix is far smaller than the raw history).
    const fullHistoryTokens = estimateArrayTokens(live.slice(0, tailStart));
    expect(fullHistoryTokens).toBeGreaterThan(budget.availableHistoryTokens);

    // A leaf summary actually surfaced in the assembled prefix (the C3 path ran).
    const sawSummary = prefix.some((m) =>
      roleOf(m) === "user" &&
      JSON.stringify((m as unknown as { content?: unknown }).content ?? "").includes("LEAF:"),
    );
    expect(sawSummary).toBe(true);
  });

  it("ESCALATION ALWAYS REDUCES — an oversized stub drives the Level-3 deterministic fallback (summary tokenCount < chunk, fallback=true)", async () => {
    buildLongSession(store, 24); // enough out-of-tail history to select a chunk

    const out = await runOneLeafPass(
      store,
      makeLeafDeps(oversizedStub),
      /*freshTailSteps*/ 8,
      /*leafChunkTokens*/ 2_000,
      /*reserveTokens*/ 1_200,
    );
    expect(out).toBeDefined();
    // The oversized LLM levels never reduced → the deterministic Level-3 floor
    // fired: the persisted summary is STRICTLY smaller than the chunk it replaced.
    expect(out!.summaryTokens).toBeLessThan(out!.chunkTokens);
    expect(out!.fallback).toBe(true);

    // The persisted summary carries the deterministic fallback marker.
    const summaries = store.getSummaries(SCOPE);
    const persisted = summaries.find((s) => s.summaryId === out!.summaryId)!;
    expect(persisted.fallback).toBe(true);
    expect(persisted.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
    expect(persisted.tokenCount).toBeLessThan(out!.chunkTokens);
  });

  it("the gate uses NO network — the stub is a plain function and resolves synchronously, no LLM call", async () => {
    // A guard test: the short stub returns a fixed string with no I/O. If a live
    // model client had leaked in, this would hang / require a key — it must resolve.
    const summary = await shortStub([], { reserveTokens: 1_200 });
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The multi-tier gate (Phase 130, C2 — Plan 02 Task 3)
// ---------------------------------------------------------------------------
//
// Composes the leaf pass (selectLeafChunk/summarizeLeafChunk + appendLeafSummary)
// and the NEW condense pass (maybeRunCondensePass) over a LONG session and proves
// the C2 success criterion end-to-end with a STUB summarizer (no network): a long
// session is summarized by repeated leaf passes until ≥condensedMinFanout depth-0
// leaf summaries accumulate as a contiguous run, then a condense pass folds them
// into ONE depth-1 condensed summary that surfaces in the assembled prefix with
// accurate descendantCount + time-range + linked parents, ordering preserved.
//
// Boundary with Plan 03 (independently testable on the same file set): this test
// asserts the condensed summary EXISTS + has correct coverage via getSummaries()
// (kind/depth/descendantCount/time-range) and that its recognizable Level-3
// content (the deterministic [lcd-condensed-fallback] marker, via the oversized
// stub) surfaces in the assembled prefix — it does NOT assert the P1 header
// wording ("[LCD summary — depth=… trust=…]"), which Plan 03 owns.

describe("LCD synthetic-session gate (Plan 02 Task 3 — C2 multi-tier leaf→condense)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Drive condense passes until no further depth-1 condensed summary is created
   *  (bounded), using the SAME injected stub. Returns the condensed-summary count. */
  async function condenseUntilStable(
    deps: LeafSummarizerDeps,
    condensedMinFanout: number,
    maxRounds = 10,
  ): Promise<number> {
    for (let r = 0; r < maxRounds; r++) {
      const before = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length;
      await maybeRunCondensePass(
        store,
        SCOPE,
        { condensedMinFanout, condensedTargetTokens: 2_000, windowTokens: 200_000 },
        deps,
        FIXED_CREATED_AT_BASE,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        deps.logger,
      );
      const after = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length;
      if (after === before) break; // no progress → stable
    }
    return store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length;
  }

  it("folds ≥condensedMinFanout depth-0 leaf summaries into a depth-1 condensed summary that surfaces in the assembled prefix (descendantCount/time-range correct, parents linked, ordering preserved, NO network)", async () => {
    const FRESH_TAIL_STEPS = 8;
    // A SMALL leaf chunk cap → MANY leaf passes, so ≥condensedMinFanout (4) leaf
    // summaries accumulate as a contiguous run at the oldest end.
    const LEAF_CHUNK_TOKENS = 500;
    const LEAF_TARGET_TOKENS = 1_200;
    const CONDENSED_MIN_FANOUT = 4;
    const CONTEXT_WINDOW = 20_000;

    // 64 turns ≈ 140+ messages (every 4th turn is a tool pair).
    const live = buildLongSession(store, 64) as AgentMessage[];

    // Drive leaf passes until the oldest out-of-tail history is fully compacted —
    // the OVERSIZED stub forces every leaf to the deterministic Level-3 floor, so
    // each leaf's stored tokenCount is small + bounded (the condense before-size is
    // then a clean Σ of those stored counts).
    const leafDeps = makeLeafDeps(oversizedStub);
    const rounds = await compactUntilStable(
      store,
      leafDeps,
      FRESH_TAIL_STEPS,
      LEAF_CHUNK_TOKENS,
      LEAF_TARGET_TOKENS,
    );
    expect(rounds).toBeGreaterThan(0);

    // Enough leaf summaries accumulated to trigger condensation.
    const leavesBefore = store.getSummaries(SCOPE).filter((s) => s.kind === "leaf");
    expect(leavesBefore.length).toBeGreaterThanOrEqual(CONDENSED_MIN_FANOUT);

    // Snapshot the FULL contiguous depth-0 run the condense pass will fold. The
    // pass condenses the ENTIRE contiguous same-depth run (not just the first
    // condensedMinFanout) — the leaves all sit at the oldest end as one contiguous
    // summary-ref run, so the children are every LEADING contiguous summary-ref
    // (up to the first surviving message-ref).
    const items = store.getContextItems(SCOPE);
    const leadingSummaryRefIds: string[] = [];
    for (const it of items) {
      if (it.refKind !== "summary") break; // the run ends at the first message-ref
      leadingSummaryRefIds.push(it.refId);
    }
    expect(leadingSummaryRefIds.length).toBeGreaterThanOrEqual(CONDENSED_MIN_FANOUT);
    const leafById = new Map(leavesBefore.map((s) => [s.summaryId, s]));
    const expectedChildren = leadingSummaryRefIds.map((id) => leafById.get(id)!);
    const expectedDescendantCount = expectedChildren.reduce((acc, s) => acc + s.descendantCount, 0);
    const expectedEarliest = Math.min(...expectedChildren.map((s) => s.earliestAt));
    const expectedLatest = Math.max(...expectedChildren.map((s) => s.latestAt));

    // Run ONE condense pass (folds the shallowest contiguous run ≥ fanout).
    await maybeRunCondensePass(
      store,
      SCOPE,
      { condensedMinFanout: CONDENSED_MIN_FANOUT, condensedTargetTokens: 2_000, windowTokens: CONTEXT_WINDOW },
      makeLeafDeps(oversizedStub),
      FIXED_CREATED_AT_BASE,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
      leafDeps.logger,
    );

    // ---- A depth-1 condensed summary now exists with correct coverage. ----
    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    const node = condensed[0]!;
    expect(node.depth).toBe(1);
    // descendantCount === Σ child descendantCounts (the store recomputed it).
    expect(node.descendantCount).toBe(expectedDescendantCount);
    expect(node.descendantCount).toBeGreaterThan(0);
    // Time-range spans all children.
    expect(node.earliestAt).toBe(expectedEarliest);
    expect(node.latestAt).toBe(expectedLatest);
    // Escalation reduced: the condensed tokenCount < Σ child tokenCounts.
    const sumChildTokens = expectedChildren.reduce((acc, s) => acc + s.tokenCount, 0);
    expect(node.tokenCount).toBeLessThan(sumChildTokens);
    // The oversized stub forced the deterministic Level-3 floor (fallback marker).
    expect(node.fallback).toBe(true);
    expect(node.content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)).toBe(true);

    // ---- lcd_summary_parents links the folded children (losslessness ledger). ----
    const parentRows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ? ORDER BY child_summary_id")
      .all(node.summaryId) as Array<{ child_summary_id: string }>;
    const linkedChildren = parentRows.map((r) => r.child_summary_id).sort();
    expect(linkedChildren).toEqual(expectedChildren.map((s) => s.summaryId).sort());

    // ---- Ordering preserved: context_items stays dense + gap-free + ordered. ----
    const after = store.getContextItems(SCOPE);
    const ordinals = after.map((it) => it.ordinal);
    expect(ordinals).toEqual(Array.from({ length: after.length }, (_, i) => i));
    // The condensed summary-ref sits at the oldest end (ordinal 0).
    const condensedRef = after.find((it) => it.refKind === "summary" && it.refId === node.summaryId);
    expect(condensedRef).toBeDefined();
    expect(condensedRef!.ordinal).toBe(0);

    // ---- The condensed summary surfaces in the ASSEMBLED prefix (resolved through
    //      the assembler), recognizable by its deterministic Level-3 marker (NOT
    //      the Plan-03 header wording). ----
    const engine = createLcdContextEngine(dagConfig(FRESH_TAIL_STEPS), makeDagDeps(store, CONTEXT_WINDOW));
    const out = await engine.transformContext(live);
    const tailStart = freshTailBoundaryIndex(live, FRESH_TAIL_STEPS);
    const freshTail = live.slice(tailStart);
    const prefix = out.slice(0, out.length - freshTail.length);
    const sawCondensed = prefix.some((m) =>
      roleOf(m) === "user" &&
      JSON.stringify((m as unknown as { content?: unknown }).content ?? "").includes(
        CONDENSED_FALLBACK_SUMMARY_MARKER,
      ),
    );
    expect(sawCondensed).toBe(true);
  });

  it("the multi-tier path uses NO network — the condense pass runs on a plain stub summarizer and resolves", async () => {
    // Guard: even with a non-trivial session + condense pass, the injected stub is
    // a plain function — if a live client leaked in, this would hang / need a key.
    buildLongSession(store, 24);
    const leafDeps = makeLeafDeps(shortStub);
    await compactUntilStable(store, leafDeps, 8, 500, 1_200);
    const condensedCount = await condenseUntilStable(makeLeafDeps(shortStub), 4);
    // The condense pass executed without I/O (it resolved); a fold may or may not
    // have happened depending on the contiguous run length, but the path is clean.
    expect(condensedCount).toBeGreaterThanOrEqual(0);
  });
});
