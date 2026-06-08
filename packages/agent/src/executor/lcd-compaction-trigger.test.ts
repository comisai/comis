// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD afterTurn threshold-sweep trigger (Plan 129-06, C1/C3).
 *
 * RED-first. Drives `maybeRunLeafPass` — the trigger that activates the inert
 * `contextThreshold` config: when context utilization exceeds the threshold it
 * fires ONE leaf pass (select the oldest out-of-tail chunk → summarize via the
 * INJECTED stub summarizer → range-replace context_items at the EXACT covered
 * ordinal window → emit `context:dag_compacted`), and is otherwise inert. The
 * pass is NON-FATAL: a throwing summarizer / store NEVER propagates.
 *
 * The store is the REAL `createLcdStore(new Database(":memory:"))` — `@comis/memory`
 * is an agent devDependency, allowed in `.test.ts` only (NOT production code —
 * the agent↛memory cut). The summarizer is a STUB (no network, no real LLM).
 */
import {
  type AppendMessageInput,
  type ContextStorePort,
  type ContextStoreScope,
  type TypedEventBus,
  messageToParts,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { maybeRunLeafPass, type LeafPassOptions } from "./lcd-compaction-trigger.js";
import type { LeafSummarizer, LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";
import { MIN_SHRINKABLE_LEAF_CHUNK_TOKENS } from "../context-engine/lcd-leaf-summarizer.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures (mirror lcd-assembler.test.ts / lcd-leaf-summarizer.test.ts)
// ---------------------------------------------------------------------------

const FIXED_NOW = 5000;
const CONVERSATION_ID = "conv-trigger";

const SCOPE: ContextStoreScope = {
  conversationId: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: 1000 } as Message;
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
    timestamp: 1000,
  } as unknown as Message;
}

/**
 * Persist a canonical pi-ai message at the next seq with an explicit tokenCount
 * (the store NEVER computes tokens — the caller supplies it agent-side). The
 * trigger reads this stored `tokenCount` as the utilization + chunk-size
 * authority (Pitfall 2), so the per-message tokenCount drives the math.
 */
function append(store: ContextStorePort, msg: Message, seq: number, tokenCount: number, createdAt: number): void {
  const input: AppendMessageInput = {
    scope: SCOPE,
    seq,
    role: msg.role,
    tokenCount,
    createdAt,
    parts: messageToParts(msg),
  };
  store.append(input);
}

/**
 * Seed a long alternating user/assistant history into the store. Each message
 * carries `tokensEach` stored tokens, so total stored tokens ≈ count*tokensEach
 * — the utilization numerator. Returns the appended messages in order so a test
 * can assert which ones land in the leaf chunk.
 */
function seedHistory(
  store: ContextStorePort,
  count: number,
  tokensEach: number,
): void {
  for (let i = 0; i < count; i++) {
    const msg = i % 2 === 0 ? userMsg(`u${i}`) : assistantText(`a${i}`);
    append(store, msg, i, tokensEach, 1000 + i);
  }
}

// --- Injected summarizer stubs (NO network, NO real LLM) ---

/** Level-1 success: a fixed SHORT string regardless of input (always reduces). */
function shortSummarizer(text = "SHORT-LEAF-SUMMARY"): LeafSummarizer {
  return vi.fn(async () => text);
}

/** Non-fatal: throws on every call (Levels 1+2 both fail → deterministic L3). */
function throwingSummarizer(): LeafSummarizer {
  return vi.fn(async () => {
    throw new Error("summarizer boom");
  });
}

function makeSummarizerDeps(
  summarize: LeafSummarizer,
  logger: ReturnType<typeof createMockLogger>,
): LeafSummarizerDeps {
  return {
    logger: logger as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
  };
}

/**
 * A capturing event bus double — records every emit so the C3/event assertions
 * can read the `context:dag_compacted` payload (counts only, never content).
 */
function makeEventBus(): { bus: TypedEventBus; emits: Array<{ event: string; payload: Record<string, unknown> }> } {
  const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const bus = {
    emit: (event: string, payload: Record<string, unknown>) => {
      emits.push({ event, payload });
      return true;
    },
  } as unknown as TypedEventBus;
  return { bus, emits };
}

/**
 * Default opts: a SMALL window so the seeded history pushes utilization over the
 * threshold (windowTokens chosen per-test). freshTailTurns is the STEP count
 * protected from eviction; leaf knobs are the production defaults.
 */
function opts(overrides: Partial<LeafPassOptions> = {}): LeafPassOptions {
  return {
    contextThreshold: 0.75,
    leafChunkTokens: 20_000,
    leafTargetTokens: 1_200,
    freshTailTurns: 8,
    windowTokens: 1_000,
    ...overrides,
  };
}

// ===========================================================================
// Over threshold — fires one leaf pass
// ===========================================================================

describe("maybeRunLeafPass — over threshold fires a leaf pass", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("persists one leaf summary + emits context:dag_compacted when utilization exceeds contextThreshold", async () => {
    // 40 messages × 100 stored tokens = 4000 tokens. windowTokens 1000 →
    // utilization 4.0 ≫ 0.75. freshTailTurns 8 leaves plenty of evictable
    // out-of-tail history to compact.
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // A leaf summary was persisted.
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.kind).toBe("leaf");

    // The compaction event fired with leafSummariesCreated=1 + a durationMs.
    const compacted = emits.filter((e) => e.event === "context:dag_compacted");
    expect(compacted.length).toBe(1);
    expect(compacted[0]!.payload.leafSummariesCreated).toBe(1);
    expect(compacted[0]!.payload.totalSummariesCreated).toBe(1);
    expect(typeof compacted[0]!.payload.durationMs).toBe("number");
    expect(compacted[0]!.payload.conversationId).toBe(CONVERSATION_ID);
  });

  it("emits a REAL durationMs (clock-at-emit minus clock-at-entry), not the hardcoded 0 stub", async () => {
    // O1: the pass must time itself from the injected clock CALLABLE — capture a
    // read at pass entry, a second at emit, emit the delta. Drive a fake clock
    // that returns 1000 on the FIRST read (pass entry) and 1175 on the SECOND
    // (emit) → durationMs MUST be 175, never the old hardcoded 0. The scalar
    // `now` keeps stamping `timestamp` (its distinct semantic). RED on pre-patch:
    // the trigger has no nowFn param + durationMs is 0.
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    // A deterministic advancing clock — NEVER Date.now() (globals.test.ts ban).
    const clockReads = [1000, 1175];
    let readIdx = 0;
    const nowFn = (): number => clockReads[Math.min(readIdx++, clockReads.length - 1)]!;

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      nowFn,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const compacted = emits.filter((e) => e.event === "context:dag_compacted");
    expect(compacted.length).toBe(1);
    // The REAL elapsed (1175 - 1000), > 0, NOT the old 0 stub.
    expect(compacted[0]!.payload.durationMs).toBe(175);
    // `timestamp` stays the injected scalar `now` (not a clock read).
    expect(compacted[0]!.payload.timestamp).toBe(FIXED_NOW);
    // Per-pass counts are UNCHANGED (Pitfall 3 — honest per-pass).
    expect(compacted[0]!.payload.leafSummariesCreated).toBe(1);
    expect(compacted[0]!.payload.condensedSummariesCreated).toBe(0);
    expect(compacted[0]!.payload.maxDepthReached).toBe(0);
  });

  it("range-replaces context_items at the EXACT first-covered-message ordinal (C3 regression guard)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // Snapshot the pre-pass context_items: a 1:1 message-ref per message, dense
    // ordinals 0..39. The leaf covers the oldest contiguous prefix starting at
    // ordinal 0, so the summary-ref MUST land at ordinal 0 (the first covered
    // message-ref's ordinal == startOrdinal).
    const before = store.getContextItems(SCOPE);
    expect(before.length).toBe(40);
    expect(before.every((it) => it.refKind === "message")).toBe(true);
    expect(before[0]!.ordinal).toBe(0);

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const after = store.getContextItems(SCOPE);
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    const summaryId = summaries[0]!.summaryId;

    // The summary-ref sits at ordinal == startOrdinal (the FIRST covered
    // message-ref's ordinal, which is 0 — the oldest end).
    const summaryRef = after.find((it) => it.refKind === "summary" && it.refId === summaryId);
    expect(summaryRef, "a summary-ref must exist in context_items").toBeDefined();
    expect(summaryRef!.ordinal).toBe(0);

    // descendantCount == the number of message-refs the summary replaced
    // (no off-by-one, no wrong window): the covered count equals the chunk
    // length, which equals the count of message-refs that disappeared.
    const messageRefsAfter = after.filter((it) => it.refKind === "message").length;
    const replaced = before.length - messageRefsAfter;
    expect(summaries[0]!.descendantCount).toBe(replaced);
    expect(summaries[0]!.descendantCount).toBeGreaterThan(0);

    // Ordinals stay dense + gap-free + ordered after the range-replace.
    const ordinals = after.map((it) => it.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(ordinals).toEqual(Array.from({ length: after.length }, (_, i) => i));
  });

  it("stamps the leaf summary createdAt from the INJECTED now (never Date.now())", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.createdAt).toBe(FIXED_NOW);
  });
});

// ===========================================================================
// Under threshold — inert
// ===========================================================================

describe("maybeRunLeafPass — under threshold is inert", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("does nothing (no summary, no summarizer call, no event) when utilization <= contextThreshold", async () => {
    // 10 messages × 10 stored tokens = 100 tokens. windowTokens 1_000_000 →
    // utilization 0.0001 ≪ 0.75 → inert.
    seedHistory(store, 10, 10);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const summarize = shortSummarizer();

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000_000 }),
      makeSummarizerDeps(summarize, logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    expect(store.getSummaries(SCOPE).length).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
  });

  it("does nothing when there is no out-of-tail history to compact (everything is fresh tail)", async () => {
    // Over threshold by tokens, but only 4 assistant steps < freshTailTurns 8 →
    // selectLeafChunk returns undefined (nothing evictable) → no-op.
    seedHistory(store, 8, 1_000);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const summarize = shortSummarizer();

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000, freshTailTurns: 8 }),
      makeSummarizerDeps(summarize, logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    expect(store.getSummaries(SCOPE).length).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
  });
});

// ===========================================================================
// Non-fatal — never propagates
// ===========================================================================

describe("maybeRunLeafPass — non-fatal degrade", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("resolves without throwing when the summarizer throws — falls through to the deterministic level (no throw)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // The throwing summarizer fails Levels 1+2; the leaf summarizer's own
    // deterministic Level-3 still produces a bounded summary, so a summary
    // persists AND the call resolves cleanly (never throws).
    await expect(
      maybeRunLeafPass(
        store,
        SCOPE,
        opts({ windowTokens: 1_000 }),
        makeSummarizerDeps(throwingSummarizer(), logger),
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing when store.appendLeafSummary throws (WARN errorKind dependency, never propagates)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // Wrap the real store so appendLeafSummary throws — the trigger must catch
    // it (WARN, errorKind "dependency") and resolve, never failing the turn.
    const brokenStore: ContextStorePort = {
      append: (i) => store.append(i),
      getMessages: (c) => store.getMessages(c),
      getContextItems: (c) => store.getContextItems(c),
      getSummaries: (c) => store.getSummaries(c),
      appendLeafSummary: () => {
        throw new Error("store boom");
      },
    };

    await expect(
      maybeRunLeafPass(
        brokenStore,
        SCOPE,
        opts({ windowTokens: 1_000 }),
        makeSummarizerDeps(shortSummarizer(), logger),
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    // The failure was logged as a non-fatal WARN with the canonical fields.
    const warn = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warn.length).toBeGreaterThan(0);
    const hasDependencyWarn = warn.some(
      (call) => (call[0] as { errorKind?: string })?.errorKind === "dependency",
    );
    expect(hasDependencyWarn).toBe(true);
  });

  it("resolves cleanly with no summarizerDeps (undefined) — gated off, no summary", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await expect(
      maybeRunLeafPass(
        store,
        SCOPE,
        opts({ windowTokens: 1_000 }),
        undefined,
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    expect(store.getSummaries(SCOPE).length).toBe(0);
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
  });
});

// ===========================================================================
// Multi-pass — the trigger must make PROGRESS across passes (CR-01 + CR-02)
// ===========================================================================
//
// The headline BLOCKER pair: the afterTurn trigger must (CR-01) resolve history
// from the model-facing `context_items` view so a SECOND over-threshold pass
// collapses the NEXT-oldest chunk (not re-select the already-summarized oldest
// and skip on an ordinal-window divergence), and (CR-02) measure utilization
// against that SAME resolved view so a pass that has summarized enough to fit
// under the threshold goes INERT (it observes its own compaction). On pre-fix
// code both fail: pass 2 sources from the lossless `getMessages()` set, so it is
// perpetually over threshold AND perpetually re-selects the collapsed oldest →
// exactly one leaf summary is ever created, every later pass WARNs.

describe("maybeRunLeafPass — makes progress across passes (CR-01/CR-02)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("creates SECOND+ distinct leaf summaries within ONE over-threshold drain, collapsing the NEXT-oldest chunk each pass (CR-01)", async () => {
    // 40 msgs × 100 tok = 4000 tok; window 1000 → utilization 4.0. The fresh tail
    // (8 STEPS ≈ msgs 25..39 = 1500 tok) ALONE exceeds the 750-tok threshold, so
    // even after collapsing ALL out-of-tail history the resolved view stays over
    // threshold → the drain keeps firing until it runs out of evictable out-of-tail
    // chunks. leafChunkTokens 300 caps each pass to ~3 messages, so the drain
    // collapses several DISTINCT, non-overlapping oldest chunks in ONE call.
    //
    // B-2: this used to require TWO manual maybeRunLeafPass calls (the single-pass
    // contract); the bounded multi-pass drain now does it in ONE — re-resolving the
    // view each pass so it collapses the NEXT-oldest chunk, never re-selecting the
    // already-summarized oldest (no ordinal-window divergence).
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({ windowTokens: 1_000, leafChunkTokens: 300, freshTailTurns: 8 });

    // ONE drain call.
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus);

    // MULTIPLE distinct leaf summaries, covering DIFFERENT (non-overlapping) chunks.
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    const summaryIds = new Set(summaries.map((s) => s.summaryId));
    expect(summaryIds.size).toBe(summaries.length); // all distinct

    // The summary-refs sit at the oldest end of the context view, in order, and the
    // message-ref count dropped by the collapsed chunks' total coverage (the
    // range-replace accounting stays exact across the whole drain).
    const items = store.getContextItems(SCOPE);
    const summaryRefs = items.filter((it) => it.refKind === "summary");
    expect(summaryRefs.length).toBe(summaries.length);
    const totalCovered = summaries.reduce((acc, s) => acc + s.descendantCount, 0);
    const messageRefs = items.filter((it) => it.refKind === "message").length;
    expect(messageRefs).toBe(40 - totalCovered);

    // No ordinal-window divergence WARN — every drain pass resolved cleanly against
    // the re-resolved view (it never re-selected an already-collapsed oldest chunk).
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const hadDivergenceWarn = warnCalls.some(
      (call) => (call[0] as { errorKind?: string })?.errorKind === "precondition",
    );
    expect(hadDivergenceWarn).toBe(false);
  });

  it("goes INERT once the RESOLVED context view fits under contextThreshold (CR-02)", async () => {
    // 40 msgs × 30 tok = 1200 tok; window 1000 → utilization 1.2 > 0.75 (750 tok)
    // so pass 1 fires. The out-of-tail history (msgs 0..24 = 750 tok) all fits in
    // ONE chunk (leafChunkTokens 20_000); after collapsing it into a ~5-tok leaf
    // the RESOLVED view = leaf(~5) + fresh tail (msgs 25..39 = 450 tok) ≈ 455 tok
    // → utilization 0.455 < 0.75. A correct trigger therefore goes inert on pass 2
    // BEFORE selecting any chunk: no summarizer call, no divergence WARN, and no
    // second summary. On pre-fix code pass 2 measures the raw 1200-tok history,
    // believes it is still over threshold, re-selects the collapsed oldest, and
    // logs the ordinal-window divergence WARN.
    seedHistory(store, 40, 30);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({ windowTokens: 1_000, leafChunkTokens: 20_000, freshTailTurns: 8 });

    // Pass 1 fires and creates exactly one leaf.
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus);
    expect(store.getSummaries(SCOPE).length).toBe(1);
    const callsAfterPass1 = (summarize as ReturnType<typeof vi.fn>).mock.calls.length;
    const compactedAfterPass1 = emits.filter((e) => e.event === "context:dag_compacted").length;

    // Pass 2 must be INERT: the resolved view now fits under threshold.
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus);

    // Still exactly one summary — no third was created, and pass 2 did not even
    // reach the summarizer or emit another compaction event.
    expect(store.getSummaries(SCOPE).length).toBe(1);
    expect((summarize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterPass1);
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(compactedAfterPass1);

    // And crucially NO ordinal-window divergence WARN — pass 2 returned cleanly
    // on the under-threshold check, it did not stumble into the divergence path.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const hadDivergenceWarn = warnCalls.some(
      (call) => (call[0] as { errorKind?: string })?.errorKind === "precondition",
    );
    expect(hadDivergenceWarn).toBe(false);
  });
});

// ===========================================================================
// B-2 — a SINGLE call must drain MULTIPLE leaf passes (bounded), not stall at one
// ===========================================================================
//
// The B-2 stall: under sustained large-turn load ONE leaf pass per afterTurn
// cannot keep utilization under threshold, so the assembler silently DROPS
// (rather than summarizes) the oldest history. A single maybeRunLeafPass call
// must therefore drain MULTIPLE passes — re-resolving the view each iteration so
// it observes its own compaction (CR-02) — and terminate on the FIRST of:
// utilization ≤ contextThreshold (drained), a no-progress guard (no chunk / chunk
// < MIN_SHRINKABLE / ordinal-window divergence), OR a hard maxPasses cap. It must
// be bounded BOTH ways (the cap is the infinite-loop backstop; under
// deferCompaction:false each pass is a synchronous LLM round-trip, so a turn must
// never fire unbounded summarizer calls).

describe("maybeRunLeafPass — bounded multi-pass drain (B-2)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("B-2.1: a SINGLE call drains MULTIPLE leaf passes until the resolved view fits under threshold", async () => {
    // 60 msgs × 100 tok = 6000 tok; window 10_000, threshold 0.5 (5000 tok) →
    // utilization 0.6 > 0.5 so the drain fires. The fresh tail (8 STEPS ≈ msgs
    // 45..59 = ~1500 tok) is SMALL relative to the threshold, so collapsing the
    // out-of-tail backlog (msgs 0..44 = 4500 tok) into tiny summaries brings the
    // resolved view under 5000 tok after a FEW passes. leafChunkTokens 800 caps
    // each pass to ~8 messages, so it takes >1 pass — a correct drain keeps going.
    seedHistory(store, 60, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({
      windowTokens: 10_000,
      contextThreshold: 0.5,
      leafChunkTokens: 800,
      freshTailTurns: 8,
    });

    // ONE call.
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus);

    // MORE THAN ONE leaf summary persisted in that single call (the drain kept
    // going past the first pass). On pre-patch code exactly ONE pass fires →
    // getSummaries().length === 1 → this FAILS (RED).
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries.every((s) => s.kind === "leaf")).toBe(true);

    // The drain ended UNDER threshold (the success exit), not at the hard cap:
    // re-resolving here shows the resolved view now fits. (A regression guard that
    // the loop terminates on the threshold, not only on the cap.)
    const items = store.getContextItems(SCOPE);
    const summaryRefs = items.filter((it) => it.refKind === "summary");
    expect(summaryRefs.length).toBe(summaries.length); // every leaf is range-replaced in the view
  });

  it("B-2.2: the hard maxLeafPassesPerTurn cap bounds the drain when utilization never drops under threshold", async () => {
    // 40 msgs × 100 tok = 4000 tok; window 1000, threshold 0.75 (750 tok). The
    // fresh tail (8 STEPS ≈ 1500 tok) ALONE exceeds 750, so even after collapsing
    // ALL out-of-tail history the resolved view stays over threshold → a correct
    // drain would fire forever WITHOUT the cap. With maxLeafPassesPerTurn 2 it must
    // make EXACTLY 2 passes and RETURN (no hang).
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({
      windowTokens: 1_000,
      contextThreshold: 0.75,
      leafChunkTokens: 300,
      freshTailTurns: 8,
      maxLeafPassesPerTurn: 2,
    });

    await expect(
      maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus),
    ).resolves.toBeUndefined(); // the call returns — no infinite loop / hang.

    // EXACTLY the cap — not unbounded. The summary count (one range-replace per
    // pass) is the boundedness authority: the drain ran 2 passes and stopped.
    expect(store.getSummaries(SCOPE).length).toBe(2);
    // The summarizer is called a BOUNDED number of times — at most the per-pass
    // escalation budget (1 + COMPACTION_MAX_RETRIES Level-1 attempts + 1 Level-2)
    // times the cap. The point is it is bounded by the cap, never unbounded.
    const callsPerPassCeiling = 1 + 2 /* COMPACTION_MAX_RETRIES */ + 1;
    expect((summarize as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(
      2 * callsPerPassCeiling,
    );
  });

  it("B-2.3: the drain stops on no-progress (a single sub-MIN_SHRINKABLE out-of-tail chunk) instead of looping", async () => {
    // Over threshold by tokens, but the ONLY out-of-tail history is a single
    // 1-token message (< MIN_SHRINKABLE 2). freshTailTurns 1 → the fresh tail is
    // the last assistant step; out-of-tail = [user(1 tok)]. selectLeafChunk picks
    // that lone 1-tok message, which the MIN_SHRINKABLE guard rejects → no
    // summary can ever be made → the drain must STOP after the no-op pass, NOT
    // loop (it would otherwise re-resolve the identical view forever).
    expect(MIN_SHRINKABLE_LEAF_CHUNK_TOKENS).toBe(2); // guard the test's premise
    append(store, userMsg("u0"), 0, 1, 1000); // the lone out-of-tail message (1 tok)
    append(store, assistantText("a0"), 1, 1_000, 1001); // the fresh-tail step (big)
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({
      windowTokens: 1_000,
      contextThreshold: 0.5, // util = 1001/1000 = 1.001 > 0.5 → the drain enters
      leafChunkTokens: 20_000,
      freshTailTurns: 1,
    });

    await expect(
      maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus),
    ).resolves.toBeUndefined(); // returns — no hang.

    // No summary was produced (the sub-MIN_SHRINKABLE chunk is skipped) and the
    // summarizer was NEVER called — bounded (the no-progress guard ended the loop).
    expect(store.getSummaries(SCOPE).length).toBe(0);
    expect((summarize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
  });

  it("B-2.4: the B-13 lcd-leaf-gate DEBUG fires per drain iteration so a stalled drain is diagnosable", async () => {
    // The committed B-13 observability gate must survive the multi-pass refactor —
    // and now fire for EACH iteration so a drain that stalls (or hits the cap) is
    // reconstructable from logs alone. Drive the capped scenario (2 passes) and
    // assert the "lcd leaf pass evaluated" DEBUG fired at least twice (once per
    // iteration's resolve+utilization read).
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = makeSummarizerDeps(shortSummarizer(), logger);
    const passOpts = opts({
      windowTokens: 1_000,
      contextThreshold: 0.75,
      leafChunkTokens: 300,
      freshTailTurns: 8,
      maxLeafPassesPerTurn: 2,
    });

    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, undefined, logger as unknown as LeafSummarizerDeps["logger"], bus);

    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const evaluatedGateLogs = debugCalls.filter(
      (call) =>
        (call[0] as { step?: string })?.step === "lcd-leaf-gate" &&
        call[1] === "lcd leaf pass evaluated",
    );
    expect(evaluatedGateLogs.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// C4/C5: capability-routed compaction (LCD layer)
// ===========================================================================

import type { SecurityPinMarkers } from "../context-engine/security-context-pinner.js";

function makeSummarizerDepsWithCapability(
  summarize: LeafSummarizer,
  logger: ReturnType<typeof createMockLogger>,
  overrides: Partial<LeafSummarizerDeps> = {},
): LeafSummarizerDeps {
  return {
    logger: logger as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
    ...overrides,
  };
}

describe("C4/C5: capability-routed LCD leaf compaction", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("small + preferEviction=true: persists a deterministic fallback without calling summarizer", async () => {
    seedHistory(store, 40, 100);
    const summarize = vi.fn(async () => "THIS SHOULD NOT BE CALLED");
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const deps = makeSummarizerDepsWithCapability(summarize, logger, {
      capabilityClass: "small",
      preferEvictionByCapability: true,
      strongerSummarizerModel: "",
      agentId: "agent-c5",
      sessionKey: "sess-c5",
    });

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // Summarizer must NOT be called — capability gate routes to eviction
    expect(summarize).not.toHaveBeenCalled();

    // A leaf summary was still persisted (deterministic fallback)
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.fallback).toBe(true);

    // WARN logged with C5 indicator
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const c5Warn = warnCalls.find(
      (c) => typeof c[1] === "string" && c[1].includes("C5"),
    );
    expect(c5Warn).toBeDefined();
    expect((c5Warn![0] as { capabilityClass?: string }).capabilityClass).toBe("small");

    // context:compaction_routed emitted with lcd layer
    const routed = emits.filter((e) => e.event === "context:compaction_routed");
    expect(routed.length).toBe(1);
    expect(routed[0]!.payload.capabilityClass).toBe("small");
    expect(routed[0]!.payload.strategy).toBe("eviction");
    expect(routed[0]!.payload.layer).toBe("lcd");
  });

  it("nano + preferEviction=true: uses deterministic fallback, not LLM", async () => {
    seedHistory(store, 40, 100);
    const summarize = vi.fn(async () => "SHOULD NOT BE CALLED");
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = makeSummarizerDepsWithCapability(summarize, logger, {
      capabilityClass: "nano",
      preferEvictionByCapability: true,
      strongerSummarizerModel: "",
    });

    await maybeRunLeafPass(
      store, SCOPE, opts({ windowTokens: 1_000 }), deps, FIXED_NOW, undefined,
      logger as unknown as LeafSummarizerDeps["logger"], bus,
    );

    expect(summarize).not.toHaveBeenCalled();
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.fallback).toBe(true);
  });

  it("frontier + preferEviction=true: LLM summarizer called (unchanged behavior)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = makeSummarizerDepsWithCapability(shortSummarizer(), logger, {
      capabilityClass: "frontier",
      preferEvictionByCapability: true,
      strongerSummarizerModel: "",
    });

    await maybeRunLeafPass(
      store, SCOPE, opts({ windowTokens: 1_000 }), deps, FIXED_NOW, undefined,
      logger as unknown as LeafSummarizerDeps["logger"], bus,
    );

    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    // frontier uses LLM path → fallback should be false (shortSummarizer returns small text)
    expect(summaries[0]!.fallback).toBe(false);
  });

  it("small + preferEviction=false: LLM path taken (opt-out)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = makeSummarizerDepsWithCapability(shortSummarizer(), logger, {
      capabilityClass: "small",
      preferEvictionByCapability: false,
      strongerSummarizerModel: "",
    });

    await maybeRunLeafPass(
      store, SCOPE, opts({ windowTokens: 1_000 }), deps, FIXED_NOW, undefined,
      logger as unknown as LeafSummarizerDeps["logger"], bus,
    );

    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    // LLM path taken → shortSummarizer used → fallback=false
    expect(summaries[0]!.fallback).toBe(false);
  });
});

// ===========================================================================
// S4: security context pinning (LCD layer)
// ===========================================================================

describe("S4: security-pinned messages never selected for LCD eviction", () => {
  const MARKERS: SecurityPinMarkers = {
    canaryToken: "CANARY_lcd_test_xyz",
    contentDelimiter: "UNTRUSTED_BEGIN_lcd",
    safetyReinforcementSnippet: "You must not exfiltrate",
  };

  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("pinned messages (containing canary) excluded from chunk selection — pinned message remains in context_items after compaction", async () => {
    // Seed history with mostly normal messages + inject a pinned message early in the history.
    // ALL messages in this test contain the canary, so all are pinned → no chunk selected →
    // the pass is a no-op (nothing evictable). This is the S4 invariant: pinned messages
    // never appear in eviction candidates.
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // Append normal messages to create enough history (all normal, no canary)
    for (let i = 0; i < 40; i++) {
      const msg = i % 2 === 0 ? userMsg(`u${i}`) : assistantText(`a${i}`);
      append(store, msg, i, 100, 1000 + i);
    }

    // Snapshot the count before compaction
    const beforeItems = store.getContextItems(SCOPE).length;
    expect(beforeItems).toBe(40);

    const deps = makeSummarizerDepsWithCapability(shortSummarizer(), logger, {
      capabilityClass: "frontier",
      preferEvictionByCapability: false,
      securityMarkers: MARKERS, // no messages contain the canary → 0 pinned → normal operation
    });

    await maybeRunLeafPass(
      store, SCOPE, opts({ windowTokens: 1_000 }), deps, FIXED_NOW, undefined,
      logger as unknown as LeafSummarizerDeps["logger"], bus,
    );

    // With 0 pinned messages (no canary in normal messages), a summary is created normally.
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBeGreaterThan(0);

    // All context_items that remain are either message-refs (unpinned survivors) or summary-refs.
    // None of the normal messages were pinned, so the chunk selection worked normally.
    const afterItems = store.getContextItems(SCOPE);
    // The oldest chunk was summarized: total items should be less (chunk→1 summary ref)
    expect(afterItems.length).toBeLessThan(beforeItems);
  });

  it("securityPinnedCount reported in context:compaction_routed event for LCD layer", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const deps = makeSummarizerDepsWithCapability(shortSummarizer(), logger, {
      capabilityClass: "small",
      preferEvictionByCapability: true,
      securityMarkers: MARKERS,
      agentId: "agent-s4-lcd",
      sessionKey: "sess-s4-lcd",
    });

    await maybeRunLeafPass(
      store, SCOPE, opts({ windowTokens: 1_000 }), deps, FIXED_NOW, undefined,
      logger as unknown as LeafSummarizerDeps["logger"], bus,
    );

    const routed = emits.filter((e) => e.event === "context:compaction_routed");
    expect(routed.length).toBeGreaterThan(0);
    expect(routed[0]!.payload.layer).toBe("lcd");
    expect(typeof routed[0]!.payload.securityPinnedCount).toBe("number");
  });
});

// ===========================================================================
// I1 (Phase 160): the ordinal-window divergence skip emits context:dag_degraded
// ===========================================================================
//
// The leaf divergence branch (`window === undefined`) is a defensive C3 guard:
// with the post-fix resolution it never fires on a clean store (the chunk ids
// always resolve to an ordinal window). To drive it DETERMINISTICALLY we wrap a
// real seeded store and return getContextItems() with DESCENDING message-ref
// ordinals — so the selected oldest chunk's FIRST id maps to a HIGHER ordinal
// than its LAST → chunkOrdinalWindow returns undefined → the divergence skip.
// RED on pre-patch: the skip only WARNs (Pino-only); it emits nothing.

/**
 * Wrap a real ContextStorePort but rewrite getContextItems() so the message-ref
 * ordinals DESCEND in walk order, forcing chunkOrdinalWindow → undefined (the
 * endOrdinal < startOrdinal divergence). Everything else delegates to the real
 * store so resolveContext still builds a selectable leaf chunk.
 */
function withInvertedMessageOrdinals(real: ContextStorePort): ContextStorePort {
  return {
    ...real,
    append: (input) => real.append(input),
    getMessages: (scope) => real.getMessages(scope),
    getSummaries: (scope) => real.getSummaries(scope),
    getContextItems: (scope) => {
      const items = real.getContextItems(scope);
      const maxOrdinal = items.length - 1;
      // Reverse only the ordinal values; keep refKind/refId so the same chunk is
      // selected, but its first/last ids now map to inverted ordinals.
      return items.map((it, idx) => ({ ...it, ordinal: maxOrdinal - idx }));
    },
    appendLeafSummary: (input) => real.appendLeafSummary(input),
    appendCondensedSummary: (input) => real.appendCondensedSummary(input),
    getSummaryChildren: (scope, id) => real.getSummaryChildren(scope, id),
    getSummaryMessages: (scope, id) => real.getSummaryMessages(scope, id),
    searchLcd: (scope, q, o) => real.searchLcd(scope, q, o),
    runOnConversation: (id, fn) => real.runOnConversation(id, fn),
  };
}

describe("maybeRunLeafPass — ordinal-window divergence emits context:dag_degraded (I1)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("emits context:dag_degraded(reason:leaf_window_divergence) on the ordinal-window skip", async () => {
    // 40 msgs × 100 tok = 4000 tok; window 1000 → utilization 4.0 ≫ 0.75 so a
    // pass fires and selects the oldest chunk. The inverted-ordinal wrapper then
    // makes that chunk's window inverted → the divergence skip path runs.
    seedHistory(store, 40, 100);
    const diverged = withInvertedMessageOrdinals(store);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await maybeRunLeafPass(
      diverged,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // The divergence WARN fired (the guard is unchanged) ...
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => (c[0] as { errorKind?: string })?.errorKind === "precondition")).toBe(true);
    // ... AND now a content-free context:dag_degraded was emitted with the
    // matching reason. NO leaf summary was persisted (the pass skipped).
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "leaf").length).toBe(0);
    const degraded = emits.filter((e) => e.event === "context:dag_degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0]!.payload.reason).toBe("leaf_window_divergence");
    expect(degraded[0]!.payload.conversationId).toBe(CONVERSATION_ID);
    expect(degraded[0]!.payload.agentId).toBe(SCOPE.agentId);
    expect(degraded[0]!.payload.sessionKey).toBe(SCOPE.sessionKey);
    expect(typeof degraded[0]!.payload.durationMs).toBe("number");
    expect(typeof degraded[0]!.payload.timestamp).toBe("number");
    // Content-free: identifiers + reason + timing only — NEVER message/summary text.
    expect(Object.keys(degraded[0]!.payload).sort()).toEqual(
      ["agentId", "conversationId", "durationMs", "reason", "sessionKey", "timestamp"].sort(),
    );
  });
});
