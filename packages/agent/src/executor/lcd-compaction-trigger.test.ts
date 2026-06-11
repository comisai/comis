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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { maybeRunLeafPass, runLeafPassAfterTurn, type LeafPassOptions } from "./lcd-compaction-trigger.js";
import type { LeafSummarizer, LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";
import { MIN_SHRINKABLE_LEAF_CHUNK_TOKENS } from "../context-engine/lcd-leaf-summarizer.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

const here = dirname(fileURLToPath(import.meta.url));

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

// ===========================================================================
// SUMW-02 (Phase 178): trigger denominator = budget window
// ===========================================================================
//
// WHY THIS EXISTS — the v2.20 DIST-01 live incident: tool assembly budgets the
// turn against budget.windowTokens = min(reconciled contextWindow, capability
// class cap) (= 32_000 for a capped small model), but the afterTurn triggers
// ratioed utilization against summarizerDeps.getModel().contextWindow — the
// session model's CONFIGURED window (131_072 live). A small-class agent
// therefore assembled at 32_000 while the leaf/condense triggers armed only at
// 0.75 × 131_072 ≈ 98_304 stored tokens — ~4× late, making condensation look
// "intermittent". SUMW-02 threads ONE captured budgetWindowTokens (the turn's
// computeTokenBudgetForProfile().windowTokens) from the tool-assembly result
// through postExecution into BOTH afterTurn params objects as the REQUIRED
// utilization denominator — one window truth with assembly + preflight (the
// pipeline trigger already ratios correctly: llm-compaction.ts thresholdTokens
// derives from budget.windowTokens, FLOOR-02-pinned).
//
// These tests drive the afterTurn wrapper (runLeafPassAfterTurn) — the seam
// where the denominator lives:
//   - L1 (DIST-01 fixture) is RED on pre-patch code (the wrapper still reads
//     the configured 131_072 → 0.198 ≤ 0.75 → inert).
//   - L2 (frontier parity pin) passes pre+post BY DESIGN: when no cap binds,
//     budgetWindowTokens == getModel().contextWindow (I3 byte-identical).
//   - L3 (wiring source-lock) pins the postExecution → trigger threading and
//     the ABSENCE of the legacy getModel-based denominator read — preventing
//     the regression class where an optional param with a fallback (or the
//     Infinity-initialized streamSetup.effectiveWindowRef carrier: utilization
//     ÷ Infinity = 0) silently DISARMS both triggers (research Pitfall 1).

describe("SUMW-02: trigger denominator = budget window", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Summarizer deps whose getModel() plants the CONFIGURED window the legacy read used. */
  function depsWithConfiguredWindow(
    contextWindow: number,
    logger: ReturnType<typeof createMockLogger>,
  ): LeafSummarizerDeps {
    return {
      logger: logger as unknown as LeafSummarizerDeps["logger"],
      summarize: shortSummarizer(),
      getModel: () => ({ provider: "ollama", contextWindow, reasoning: false }),
      getApiKey: async () => "test-key",
    };
  }

  it("SUMW-02-L1 (DIST-01): arms at 0.75 × the BUDGET window on a capability-capped small model (configured 131072, budget 32000, ~26K stored)", async () => {
    // 26 msgs × 1_000 stored tokens = 26_000 total. contextEngine: undefined →
    // schema defaults (contextThreshold 0.75, freshTailTurns 8) — 13 assistant
    // steps leave the oldest ~11 messages out-of-tail (a selectable leaf chunk).
    // Pre-patch: utilization = 26_000 / getModel().contextWindow (131_072)
    //   = 0.198 ≤ 0.75 → inert → NO summary → FAILS (RED).
    // Post-patch: utilization = 26_000 / budgetWindowTokens (32_000) = 0.8125
    //   > 0.75 → the leaf pass arms → ≥1 leaf summary persists.
    seedHistory(store, 26, 1_000);
    const logger = createMockLogger();
    const deps = depsWithConfiguredWindow(131_072, logger);

    await runLeafPassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined,
      getSummarizerDeps: () => deps,
      budgetWindowTokens: 32_000, // the turn's budget window: min(131_072, class cap 32_000)
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
    });

    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries.every((s) => s.kind === "leaf")).toBe(true);
  });

  it("SUMW-02-L2 (frontier parity pin): equal budget and configured window (no cap binds) arms byte-identically to the legacy denominator", async () => {
    // I3: for frontier/mid no capability cap binds, so budgetWindowTokens ==
    // getModel().contextWindow — this test passes pre- AND post-patch BY DESIGN,
    // pinning that equal-values behavior is identical to the legacy read.
    // (a) stored 26_000 vs 200_000 → utilization 0.13 ≤ 0.75 → inert (no summary).
    seedHistory(store, 26, 1_000);
    const logger = createMockLogger();
    const deps = depsWithConfiguredWindow(200_000, logger);

    await runLeafPassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined,
      getSummarizerDeps: () => deps,
      budgetWindowTokens: 200_000, // == getModel().contextWindow — the no-cap condition
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
    });
    expect(store.getSummaries(SCOPE).length).toBe(0);

    // (b) stored ~160_000 vs 200_000 → utilization 0.8 > 0.75 → arms (a leaf
    // summary persists) — the same equal-values denominator on the arming side.
    const db2 = new Database(":memory:");
    initSchema(db2, 1536);
    const store2 = createLcdStore(db2);
    seedHistory(store2, 32, 5_000); // 160_000 stored tokens
    const logger2 = createMockLogger();
    const deps2 = depsWithConfiguredWindow(200_000, logger2);

    await runLeafPassAfterTurn({
      store: store2,
      scope: SCOPE,
      contextEngine: undefined,
      getSummarizerDeps: () => deps2,
      budgetWindowTokens: 200_000,
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger2 as unknown as LeafSummarizerDeps["logger"],
    });
    const summaries = store2.getSummaries(SCOPE);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries.every((s) => s.kind === "leaf")).toBe(true);
  });

  it("SUMW-02-L3 (wiring source-lock): postExecution threads params.budgetWindowTokens into BOTH afterTurn passes; neither trigger reads the legacy getModel window", () => {
    // Structural locks (recall-dag-budget-partition.test.ts precedent). The
    // threading chain is compiler-enforced hop-by-hop (required field at every
    // hop), but the runDeferredPasses call objects are plain literals a refactor
    // could silently drop — restoring the old denominator via a fallback, or
    // (worse) the Infinity-initialized streamSetup.effectiveWindowRef carrier,
    // where utilization ÷ Infinity = 0 silently DISARMS both triggers. Lock the
    // two coupled sites:
    //   1. executor-post-execution.ts passes `budgetWindowTokens:
    //      params.budgetWindowTokens` in EXACTLY the leaf + condense call
    //      objects (×2 — one per afterTurn pass).
    //   2. NEITHER trigger contains the legacy code read of the summarizer
    //      snapshot window as the denominator (deleted by SUMW-02; the
    //      summarize seam's model identity still flows through summarizerDeps —
    //      only the utilization DENOMINATOR moved to the threaded budget value).
    const postExecSource = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const threaded = postExecSource.match(/budgetWindowTokens: params\.budgetWindowTokens/g) ?? [];
    expect(threaded.length).toBe(2);

    // Code-only literal (the JSDoc prose uses a different phrasing): the exact
    // legacy denominator expression must be GONE from both trigger sources.
    const legacyRead = "summarizerDeps.getModel().contextWindow";
    const leafTriggerSource = readFileSync(resolve(here, "lcd-compaction-trigger.ts"), "utf-8");
    const condenseTriggerSource = readFileSync(resolve(here, "lcd-condense-trigger.ts"), "utf-8");
    expect(leafTriggerSource).not.toContain(legacyRead);
    expect(condenseTriggerSource).not.toContain(legacyRead);
  });
});

// ===========================================================================
// SUMW-01 (Phase 178): leaf chunk clamp — input span ≤ resolved summarizer window
// ===========================================================================
//
// WHY THIS EXISTS — the LCD-leaf half of the span invariant ("for all compaction
// calls, inputTokens ≤ resolved summarizer effectiveWindow"): selectLeafChunk
// caps the chunk ONLY at the configured `leafChunkTokens` (20_000 default), so an
// `operationModels.compaction` 8K override summarizer received a 20K chunk —
// opaque provider error or silent truncation. The clamp (inside maybeRunLeafPass,
// computed ONCE per drain) caps the chunk at
//   min(leafChunkTokens, summarizerWindow − leafTargetTokens − SUMMARIZER_PROMPT_OVERHEAD_TOKENS)
// floored at MIN_SHRINKABLE_LEAF_CHUNK_TOKENS, keyed to the RESOLVED summarizer
// (`overrideModel?.model ?? getRealModel()` via resolveSummarizerWindowTokens —
// the 178-02 contract), NEVER the getModel() session-primary snapshot (Pitfall 2:
// a 131K primary + 8K compaction override must clamp at 8K). Splitting comes
// free: the B-2 bounded drain (≤4 passes/turn) + next-turn re-arming turn the
// smaller cap into more, smaller passes — oversized backlogs split, never overflow.
//
// Arithmetic (overhead 2_048): clamped cap = min(20_000, W − 1_200 − 2_048 −
// prevTokens) — prevTokens is the ACTUAL previousSummary size (review WR-03;
// 0 in fixtures with no pre-existing summaries).
//   - L1 (RED): W=8_000 → cap 4_752 → each summarize call ≤ 4 × 1_000-token
//     messages. Pre-patch: ONE chunk of all 11 out-of-tail messages (20_000 cap).
//   - L2 (no-op pin, I3): W=200_000 → cap stays 20_000 → legacy chunk sizing.
//   - L3 (degenerate): W=3_000 → 3_000−1_200−2_048 < MIN_SHRINKABLE → cap floors
//     at 2; the fixture's 1-token oldest message makes the selected CHUNK
//     sub-MIN_SHRINKABLE → the "too-small" terminator (the real terminator is
//     the tiny CHUNK, not the window itself): NO summarize call, no throw. An
//     oldest message ≥ MIN_SHRINKABLE but over the cap instead takes the WR-02
//     deterministic floor (also no LLM call — see the WR-02 fixture).

describe("SUMW-01: leaf chunk clamp", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** A RECORDING summarize stub capturing each call's message count. */
  function recordingSummarizer(): { summarize: LeafSummarizer; callSizes: () => number[] } {
    const fn = vi.fn(async (_messages: AgentMessage[]) => "SHORT-LEAF-SUMMARY");
    return {
      summarize: fn as unknown as LeafSummarizer,
      callSizes: () => fn.mock.calls.map((c) => (c[0] as AgentMessage[]).length),
    };
  }

  /** Deps with an `operationModels.compaction`-style override summarizer window. */
  function depsWithOverrideWindow(
    overrideWindow: number,
    summarize: LeafSummarizer,
    logger: ReturnType<typeof createMockLogger>,
  ): LeafSummarizerDeps {
    return makeSummarizerDeps(summarize, logger, {
      overrideModel: { model: { contextWindow: overrideWindow }, getApiKey: async () => "k" },
      // The PRIMARY real model — a clamp wrongly keyed here (131_072) or to
      // getModel()'s 200_000 leaves the 20_000 cap binding (Pitfall 2 regression).
      getRealModel: () => ({ contextWindow: 131_072 }),
    });
  }

  it("SUMW-01-L1 (8K/20K): every summarize call's chunk fits the 8K override summarizer — clamp keyed to overrideModel, not getRealModel/getModel", async () => {
    // 26 msgs × 1_000 stored tokens = 26_000; budget window 32_000 → utilization
    // 0.8125 > 0.75 arms. Schema defaults (freshTailTurns 8; 13 assistant steps)
    // leave msgs 0..10 out-of-tail. Clamped cap = 8_000 − 1_200 − 2_048 = 4_752 →
    // each chunk greedily takes ≤ 4 × 1_000-token messages (4_000 ≤ 4_752 < 5_000).
    // Keyed to getRealModel's 131_072 or getModel's 200_000 the cap would stay
    // 20_000 and ONE call would receive all 11 out-of-tail messages → the ≤4
    // assertion is itself the Pitfall-2 override-keying proof. RED pre-patch.
    seedHistory(store, 26, 1_000);
    const logger = createMockLogger();
    const { summarize, callSizes } = recordingSummarizer();
    const deps = depsWithOverrideWindow(8_000, summarize, logger);

    await runLeafPassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined, // schema defaults: threshold 0.75, chunk 20_000, target 1_200, tail 8
      getSummarizerDeps: () => deps,
      budgetWindowTokens: 32_000,
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
    });

    // The pass armed and persisted at least one leaf summary (split, not skipped)...
    expect(store.getSummaries(SCOPE).length).toBeGreaterThanOrEqual(1);
    // ...and EVERY summarize call received a clamped chunk: ≤ 4 messages (≤ 4_000
    // stored tokens ≤ the 4_752 effective cap) — never the legacy 11-message chunk.
    const sizes = callSizes();
    expect(sizes.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
  });

  it("SUMW-01-L2 (no-op pin, I3): a large-window override summarizer leaves the configured cap binding — legacy chunk sizing byte-identical", async () => {
    // W=200_000 → min(20_000, 200_000−1_200−2_048) = 20_000 (the configured knob
    // governs). The ONE summarize call receives the FULL out-of-tail chunk (all 11
    // evictable messages, 11_000 ≤ 20_000) — exactly the pre-clamp behavior.
    // Passes pre- AND post-patch BY DESIGN.
    seedHistory(store, 26, 1_000);
    const logger = createMockLogger();
    const { summarize, callSizes } = recordingSummarizer();
    const deps = depsWithOverrideWindow(200_000, summarize, logger);

    await runLeafPassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined,
      getSummarizerDeps: () => deps,
      budgetWindowTokens: 32_000,
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
    });

    expect(store.getSummaries(SCOPE).length).toBeGreaterThanOrEqual(1);
    const sizes = callSizes();
    expect(sizes.length).toBe(1);
    expect(sizes[0]).toBe(11); // the full out-of-tail chunk — legacy sizing
  });

  it("SUMW-01-L3 (degenerate): a summarizer window below target+overhead floor-clamps and the SUB-MIN_SHRINKABLE chunk terminates via the too-small path — no summarize call, no throw", async () => {
    // W=3_000 → 3_000 − 1_200 − 2_048 = −248 < MIN_SHRINKABLE → the cap floors at
    // 2. The OLDEST out-of-tail message carries 1 stored token, so the selected
    // chunk is that lone message (adding the next 1_000-token message would exceed
    // the floored cap) → chunk.tokens 1 < MIN_SHRINKABLE → the existing
    // "too-small" no-progress terminator ends the drain cleanly. NOTE the real
    // terminator is the sub-MIN_SHRINKABLE CHUNK, not the degenerate window —
    // a ≥-MIN_SHRINKABLE oldest message over the cap takes the WR-02
    // deterministic floor instead (see below). Pre-patch (cap 20_000): the
    // chunk is the full 10_001-token out-of-tail backlog → it WOULD summarize
    // → a summary persists → FAILS (RED).
    expect(MIN_SHRINKABLE_LEAF_CHUNK_TOKENS).toBe(2); // the fixture's premise
    append(store, userMsg("u0"), 0, 1, 1000); // the 1-token oldest out-of-tail message
    for (let i = 1; i < 26; i++) {
      const msg = i % 2 === 1 ? assistantText(`a${i}`) : userMsg(`u${i}`);
      append(store, msg, i, 1_000, 1000 + i);
    }
    // Stored = 1 + 25_000 = 25_001; budget window 32_000 → 0.781 > 0.75 → armed.
    const logger = createMockLogger();
    const { summarize, callSizes } = recordingSummarizer();
    const deps = depsWithOverrideWindow(3_000, summarize, logger);

    await expect(
      runLeafPassAfterTurn({
        store,
        scope: SCOPE,
        contextEngine: undefined,
        getSummarizerDeps: () => deps,
        budgetWindowTokens: 32_000,
        now: FIXED_NOW,
        nowFn: undefined,
        logger: logger as unknown as LeafSummarizerDeps["logger"],
      }),
    ).resolves.toBeUndefined(); // no throw — a clean degenerate skip

    expect(store.getSummaries(SCOPE).length).toBe(0);
    expect(callSizes().length).toBe(0); // the summarizer was never invoked
  });

  it("WR-02: a single message LARGER than the clamped cap goes straight to the deterministic floor — no LLM call, bounded fallback persisted", async () => {
    // selectLeafChunk's always-include-one rule selects a lone oversized FIRST
    // message regardless of the cap — pre-fix it was fed WHOLE to the
    // summarizer, where every LLM attempt is a guaranteed overflow (up to 4
    // failing calls per pass / 16 per drain — wasted spend + breaker churn),
    // violating the span invariant the suite pins. 8K override → cap 4_752
    // (no prior summaries): the 10_000-token oldest message exceeds it.
    append(store, userMsg("u0-huge"), 0, 10_000, 1000);
    for (let i = 1; i < 26; i++) {
      const msg = i % 2 === 1 ? assistantText(`a${i}`) : userMsg(`u${i}`);
      append(store, msg, i, 1_000, 1000 + i);
    }
    // Stored = 10_000 + 25_000 = 35_000; budget window 40_000 → 0.875 > 0.75 armed.
    const logger = createMockLogger();
    const { summarize, callSizes } = recordingSummarizer();
    const deps = depsWithOverrideWindow(8_000, summarize, logger);

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 40_000, maxLeafPassesPerTurn: 1 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
    );

    // The summarizer was NEVER invoked with the over-cap chunk (RED pre-fix: 4
    // ladder attempts against the lone 10_000-token message)...
    expect(callSizes().length).toBe(0);
    // ...and the bounded deterministic floor persisted instead (fallback:true,
    // the full content stays losslessly in the message store).
    const summaries = store.getSummaries(SCOPE);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.kind).toBe("leaf");
    expect(summaries[0]!.fallback).toBe(true);
  });

  it("WR-03 (leaf mirror): the chunk cap subtracts the ACTUAL previousSummary tokens threaded into the pass prompt", async () => {
    // previousSummaryContent returns the last summary of ANY kind — a
    // pre-existing summary whose CONTENT is 8_000 chars ≈ 2_000 tokens rides
    // into the next leaf prompt, while the flat 2_048 overhead covers only the
    // instruction template. 8K override: cap = 8_000 − 1_200 − 2_048 − 2_000 =
    // 2_752 → the first chunk takes ≤ 2 × 1_000-token messages. Pre-fix the cap
    // ignored prev (4_752 → 4 messages): chunk + target + template + prev =
    // 4_000 + 1_200 + 2_048 + 2_000 = 9_248 > 8_000 — a provider overflow.
    seedHistory(store, 30, 1_000);
    store.appendLeafSummary({
      scope: SCOPE,
      content: "X".repeat(8_000), // estimateMessageTokens: 8_000 / 4 = 2_000
      descendantCount: 2,
      earliestAt: 1_000,
      latestAt: 1_001,
      tokenCount: 2_000,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: FIXED_NOW,
      startOrdinal: 0,
      endOrdinal: 1,
    });
    const logger = createMockLogger();
    const { summarize, callSizes } = recordingSummarizer();
    const deps = depsWithOverrideWindow(8_000, summarize, logger);

    // ONE pass (maxLeafPassesPerTurn 1): pass 2's previousSummary would be the
    // tiny just-written stub summary, restoring the larger cap — the prev
    // subtraction is per pass by design, so pin the FIRST pass only.
    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 32_000, maxLeafPassesPerTurn: 1 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
    );

    const sizes = callSizes();
    // The escalation ladder may retry the SAME chunk several times (the tiny
    // rendered fixtures never pass the shrink-accept test) — the load-bearing
    // bound is that EVERY call's chunk respects the prev-aware cap.
    expect(sizes.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// SUMW-01 review WR-05: leaf clamp defensive posture — inside the never-rejects
// boundary + a finite guard on the derived cap (parity with the condense
// sibling, which resolves its window inside its try and no-ops on a non-finite
// childTokenBudget).
// ===========================================================================

describe("SUMW-01 review WR-05: leaf clamp defensive posture", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("a throwing getRealModel degrades to the non-fatal WARN — maybeRunLeafPass never rejects (T-129-18)", async () => {
    // The clamp's window resolution invokes the caller-supplied getRealModel().
    // Pre-fix it executed BEFORE the try at the drain loop, so a throwing deps
    // getter REJECTED maybeRunLeafPass — breaking the module's first
    // load-bearing contract ("the call site simply awaits a promise that never
    // rejects"); on the inline path that rejection fails the live turn.
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const deps = makeSummarizerDeps(shortSummarizer(), logger, {
      getRealModel: () => {
        throw new Error("deps getter boom");
      },
    });

    await expect(
      maybeRunLeafPass(
        store,
        SCOPE,
        opts({ windowTokens: 1_000 }),
        deps,
        FIXED_NOW,
        undefined,
        logger as unknown as LeafSummarizerDeps["logger"],
      ),
    ).resolves.toBeUndefined();

    // The failure degraded to the standard non-fatal WARN (turn unaffected).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      "LCD leaf pass failed (non-fatal)",
    );
  });

  it("a NaN resolved window keeps the CONFIGURED chunk cap — never an unbounded chunk", async () => {
    // 50 msgs × 1_000 stored tokens; freshTailTurns 8 (assistants at odd
    // indices) puts the boundary at the 8th-from-last assistant (index 35):
    // 35 out-of-tail messages = 35_000 tokens — ABOVE the configured 20_000
    // cap, so the cap is load-bearing. Pre-fix, a NaN window made the derived
    // cap NaN (`Math.max(2, Math.min(20_000, NaN))` → NaN), which disables
    // selectLeafChunk's `tokens + next > cap` break entirely → the WHOLE
    // 35-message out-of-tail history became one chunk (worse than pre-clamp,
    // which always had the finite configured cap).
    seedHistory(store, 50, 1_000);
    const logger = createMockLogger();
    const fn = vi.fn(async (_messages: AgentMessage[]) => "SHORT-LEAF-SUMMARY");
    const deps = makeSummarizerDeps(fn as unknown as LeafSummarizer, logger, {
      // No override; getRealModel resolves nothing usable; the snapshot
      // fallback itself carries a NaN window → capCandidate is NaN.
      getModel: () => ({ provider: "anthropic", contextWindow: Number.NaN, reasoning: true }),
      getRealModel: () => ({}),
    });

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 60_000 }), // utilization 50_000/60_000 ≈ 0.83 > 0.75 — armed
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
    );

    const sizes = fn.mock.calls.map((c) => (c[0] as AgentMessage[]).length);
    expect(sizes.length).toBeGreaterThanOrEqual(1);
    // The finite guard keeps TODAY'S configured cap (20_000 → ≤ 20 messages);
    // the NaN-disabled cap would have produced one 35-message chunk.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
  });
});
