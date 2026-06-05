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
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // A leaf summary was persisted.
    const summaries = store.getSummaries(CONVERSATION_ID);
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

  it("range-replaces context_items at the EXACT first-covered-message ordinal (C3 regression guard)", async () => {
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // Snapshot the pre-pass context_items: a 1:1 message-ref per message, dense
    // ordinals 0..39. The leaf covers the oldest contiguous prefix starting at
    // ordinal 0, so the summary-ref MUST land at ordinal 0 (the first covered
    // message-ref's ordinal == startOrdinal).
    const before = store.getContextItems(CONVERSATION_ID);
    expect(before.length).toBe(40);
    expect(before.every((it) => it.refKind === "message")).toBe(true);
    expect(before[0]!.ordinal).toBe(0);

    await maybeRunLeafPass(
      store,
      SCOPE,
      opts({ windowTokens: 1_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const after = store.getContextItems(CONVERSATION_ID);
    const summaries = store.getSummaries(CONVERSATION_ID);
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
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const summaries = store.getSummaries(CONVERSATION_ID);
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
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    expect(store.getSummaries(CONVERSATION_ID).length).toBe(0);
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
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    expect(store.getSummaries(CONVERSATION_ID).length).toBe(0);
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
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    expect(store.getSummaries(CONVERSATION_ID).length).toBe(0);
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

  it("creates a SECOND distinct leaf summary on a second over-threshold pass (CR-01)", async () => {
    // 40 msgs × 100 tok = 4000 tok; window 1000 → utilization 4.0. The fresh tail
    // (8 STEPS ≈ msgs 25..39 = 1500 tok) ALONE exceeds the 750-tok threshold, so
    // even after collapsing ALL out-of-tail history the resolved view stays over
    // threshold → a correct trigger keeps firing. leafChunkTokens 300 caps each
    // pass to ~3 messages, so two passes collapse two DISTINCT oldest chunks.
    seedHistory(store, 40, 100);
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const summarize = shortSummarizer();
    const deps = makeSummarizerDeps(summarize, logger);
    const passOpts = opts({ windowTokens: 1_000, leafChunkTokens: 300, freshTailTurns: 8 });

    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, logger as unknown as LeafSummarizerDeps["logger"], bus);
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, logger as unknown as LeafSummarizerDeps["logger"], bus);

    // TWO distinct leaf summaries, covering two DIFFERENT (non-overlapping) chunks.
    const summaries = store.getSummaries(CONVERSATION_ID);
    expect(summaries.length).toBe(2);
    expect(summaries[0]!.summaryId).not.toBe(summaries[1]!.summaryId);

    // Two summary-refs now sit at the oldest end of the context view, in order,
    // and the message-ref count dropped by the two chunks' worth of coverage.
    const items = store.getContextItems(CONVERSATION_ID);
    const summaryRefs = items.filter((it) => it.refKind === "summary");
    expect(summaryRefs.length).toBe(2);
    const totalCovered = summaries.reduce((acc, s) => acc + s.descendantCount, 0);
    const messageRefs = items.filter((it) => it.refKind === "message").length;
    expect(messageRefs).toBe(40 - totalCovered);

    // No ordinal-window divergence WARN — the second pass resolved cleanly.
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
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, logger as unknown as LeafSummarizerDeps["logger"], bus);
    expect(store.getSummaries(CONVERSATION_ID).length).toBe(1);
    const callsAfterPass1 = (summarize as ReturnType<typeof vi.fn>).mock.calls.length;
    const compactedAfterPass1 = emits.filter((e) => e.event === "context:dag_compacted").length;

    // Pass 2 must be INERT: the resolved view now fits under threshold.
    await maybeRunLeafPass(store, SCOPE, passOpts, deps, FIXED_NOW, logger as unknown as LeafSummarizerDeps["logger"], bus);

    // Still exactly one summary — no third was created, and pass 2 did not even
    // reach the summarizer or emit another compaction event.
    expect(store.getSummaries(CONVERSATION_ID).length).toBe(1);
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
