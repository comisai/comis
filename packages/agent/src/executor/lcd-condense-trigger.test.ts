// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD afterTurn CONDENSE pass (Phase 130, C2 — Plan 02 Task 2).
 *
 * RED-first. Drives `maybeRunCondensePass` — the mirror of `maybeRunLeafPass`
 * that folds a contiguous run of ≥`condensedMinFanout` same-depth summary-refs
 * into one depth+1 condensed summary (select the shallowest contiguous run →
 * summarize the child content via the INJECTED stub → `appendCondensedSummary`
 * over the run's [startOrdinal,endOrdinal] window → emit `context:dag_compacted`
 * with the REAL `condensedSummariesCreated:1` + `maxDepthReached:depth+1`), and
 * is otherwise a no-op. The pass is NON-FATAL: a throwing summarizer / store
 * NEVER propagates.
 *
 * The store is the REAL `createLcdStore(new Database(":memory:"))` — `@comis/memory`
 * is an agent devDependency, allowed in `.test.ts` only (the agent↛memory cut).
 * The summarizer is a STUB (no network, no real LLM).
 */
import {
  type AppendMessageInput,
  type ContextStorePort,
  type ContextStoreScope,
  type LcdContextItem,
  type TypedEventBus,
  messageToParts,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { maybeRunCondensePass, type CondensePassOptions } from "./lcd-condense-trigger.js";
import type { LeafSummarizer, LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";
import { CONDENSED_FALLBACK_SUMMARY_MARKER } from "../context-engine/constants.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = 7000;
const CONVERSATION_ID = "conv-condense";

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

/** Seed `count` alternating user/assistant messages, each `tokensEach` tokens. */
function seedHistory(store: ContextStorePort, count: number, tokensEach: number): void {
  for (let i = 0; i < count; i++) {
    const msg = i % 2 === 0 ? userMsg(`u${i}`) : assistantText(`a${i}`);
    append(store, msg, i, tokensEach, 1000 + i);
  }
}

/**
 * Collapse the FIRST `width` surviving MESSAGE-refs (by current ordinal order)
 * into ONE depth-0 leaf summary via `appendLeafSummary`. Reads the CURRENT
 * `context_items` so successive calls collapse successive contiguous windows.
 * Returns the new leaf's summaryId.
 */
function collapseLeaf(
  store: ContextStorePort,
  fromOrdinalAfter: number,
  width: number,
  summaryTokens: number,
): string {
  const items = store.getContextItems(SCOPE);
  const msgRefs = items.filter((it) => it.refKind === "message" && it.ordinal > fromOrdinalAfter);
  const windowRefs = msgRefs.slice(0, width);
  const startOrdinal = windowRefs[0]!.ordinal;
  const endOrdinal = windowRefs[windowRefs.length - 1]!.ordinal;
  return store.appendLeafSummary({
    scope: SCOPE,
    tokenCount: summaryTokens,
    content: `LEAF over ${width} msgs [${startOrdinal}..${endOrdinal}]`,
    descendantCount: width,
    earliestAt: 1000 + startOrdinal,
    latestAt: 1000 + endOrdinal,
    fileIds: [],
    fallback: false,
    taint: false,
    createdAt: FIXED_NOW,
    startOrdinal,
    endOrdinal,
  });
}

/**
 * Seed `n` CONTIGUOUS depth-0 leaf summaries at the oldest end. Each leaf
 * collapses `width` message-refs; because each collapse range-replaces a window
 * with one summary-ref at its startOrdinal and the next collapse takes the next
 * surviving message-refs, the result is `n` adjacent summary-refs (ordinals
 * 0..n-1) followed by the surviving tail message-refs.
 */
function seedContiguousLeaves(store: ContextStorePort, n: number, width: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // After the i-th collapse, ordinal i holds a summary-ref; the next message
    // window begins just after it. Collapsing the FIRST surviving message-refs
    // (ordinal > i-1 ⇒ all message-refs, the oldest of which sits right after the
    // i existing summary-refs) keeps the new summary-ref adjacent to its siblings.
    ids.push(collapseLeaf(store, i - 1, width, 5));
  }
  return ids;
}

// --- Injected summarizer stubs (NO network, NO real LLM) ---

function shortSummarizer(text = "CONDENSED-SUMMARY"): LeafSummarizer {
  return vi.fn(async () => text);
}

/** Oversized: fixed string far larger than any stored Σ → forces Level-3 floor. */
function oversizedSummarizer(): LeafSummarizer {
  return vi.fn(async () => "BLOAT ".repeat(8_000));
}

function throwingSummarizer(): LeafSummarizer {
  return vi.fn(async () => {
    throw new Error("condense summarizer boom");
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

function condenseOpts(overrides: Partial<CondensePassOptions> = {}): CondensePassOptions {
  return {
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    contextThreshold: 0.75,
    condensedTargetTokens: 2_000,
    windowTokens: 200_000,
    ...overrides,
  };
}

function summaryRefs(items: LcdContextItem[]): LcdContextItem[] {
  return items.filter((it) => it.refKind === "summary");
}

// ===========================================================================
// No-op below fanout
// ===========================================================================

describe("maybeRunCondensePass — no-op below fanout", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("does nothing (no condensed summary, no event, no summarizer call) when fewer than condensedMinFanout contiguous same-depth summaries exist", async () => {
    seedHistory(store, 40, 100);
    // Only 3 contiguous leaf summaries < condensedMinFanout 4.
    seedContiguousLeaves(store, 3, 4);
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "leaf").length).toBe(3);

    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const summarize = shortSummarizer();

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(summarize, logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // No condensed summary was created, no event fired, the summarizer was never called.
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length).toBe(0);
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Condenses at fanout + emits the real event
// ===========================================================================

describe("maybeRunCondensePass — condenses at fanout and emits the real compaction event", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("folds exactly condensedMinFanout contiguous depth-0 leaves into ONE depth-1 condensed summary + emits condensedSummariesCreated:1, maxDepthReached:1", async () => {
    seedHistory(store, 40, 100);
    const childIds = seedContiguousLeaves(store, 4, 4); // 4 contiguous depth-0 leaves
    expect(childIds.length).toBe(4);

    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // Exactly one depth-1 condensed summary now exists.
    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    expect(condensed[0]!.depth).toBe(1);
    // descendantCount = Σ child descendantCount (each leaf covered 4 msgs → 16).
    expect(condensed[0]!.descendantCount).toBe(16);
    // createdAt comes from the injected now (never Date.now()).
    expect(condensed[0]!.createdAt).toBe(FIXED_NOW);

    // The compaction event fired with the REAL condensed metrics (not the leaf's 0).
    const compacted = emits.filter((e) => e.event === "context:dag_compacted");
    expect(compacted.length).toBe(1);
    expect(compacted[0]!.payload.condensedSummariesCreated).toBe(1);
    expect(compacted[0]!.payload.leafSummariesCreated).toBe(0);
    expect(compacted[0]!.payload.maxDepthReached).toBe(1);
    expect(compacted[0]!.payload.totalSummariesCreated).toBe(1);
    expect(compacted[0]!.payload.conversationId).toBe(CONVERSATION_ID);

    // The four child leaves are range-replaced by ONE condensed summary-ref at the
    // oldest end; ordinals stay dense + gap-free + ordered.
    const items = store.getContextItems(SCOPE);
    const sRefs = summaryRefs(items);
    expect(sRefs.length).toBe(1);
    expect(sRefs[0]!.refId).toBe(condensed[0]!.summaryId);
    expect(sRefs[0]!.ordinal).toBe(0);
    const ordinals = items.map((it) => it.ordinal);
    expect(ordinals).toEqual(Array.from({ length: items.length }, (_, i) => i));
  });

  it("emits a REAL durationMs (clock-at-emit minus clock-at-entry), not the hardcoded 0 stub; maxDepthReached stays depth", async () => {
    // O1: identical fix to the leaf trigger — time the condense pass from the
    // injected clock CALLABLE. A fake clock returns 2000 then 2090 → durationMs
    // MUST be 90, never 0. RED on pre-patch (no nowFn param + durationMs is 0).
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const clockReads = [2000, 2090];
    let readIdx = 0;
    const nowFn = (): number => clockReads[Math.min(readIdx++, clockReads.length - 1)]!;

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      nowFn,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const compacted = emits.filter((e) => e.event === "context:dag_compacted");
    expect(compacted.length).toBe(1);
    // The REAL elapsed (2090 - 2000), > 0, NOT the old 0 stub.
    expect(compacted[0]!.payload.durationMs).toBe(90);
    // `timestamp` stays the injected scalar `now`.
    expect(compacted[0]!.payload.timestamp).toBe(FIXED_NOW);
    // Per-pass counts UNCHANGED; maxDepthReached is the REAL depth (1), not 0 (Pitfall 3).
    expect(compacted[0]!.payload.condensedSummariesCreated).toBe(1);
    expect(compacted[0]!.payload.leafSummariesCreated).toBe(0);
    expect(compacted[0]!.payload.maxDepthReached).toBe(1);
  });

  it("links the child leaf summaries via lcd_summary_parents (losslessness ledger)", async () => {
    seedHistory(store, 40, 100);
    const childIds = seedContiguousLeaves(store, 4, 4);

    const logger = createMockLogger();
    const { bus } = makeEventBus();
    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    const parentId = condensed[0]!.summaryId;

    // The edge table links the condensed parent to all four child leaf ids.
    const rows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ? ORDER BY child_summary_id")
      .all(parentId) as Array<{ child_summary_id: string }>;
    const linkedChildren = rows.map((r) => r.child_summary_id).sort();
    expect(linkedChildren).toEqual([...childIds].sort());
  });
});

// ===========================================================================
// Pitfall 3 — non-contiguous fanout is NEVER condensed across a message-ref
// ===========================================================================

describe("maybeRunCondensePass — contiguity (Pitfall 3)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("with a [s0(d0) m1 s2 s3 s4(d0)] layout and condensedMinFanout=4, condenses ONLY the contiguous run that reaches fanout — NEVER s0 across the surviving message-ref", async () => {
    // Build: collapse the oldest 3 msgs into s0 (ordinal 0). Leave the next
    // surviving message-ref in place (the separator m1). Then collapse the NEXT
    // FOUR message-runs into four adjacent leaves s2,s3,s4,s5 (a contiguous run
    // of 4 after the separator).
    seedHistory(store, 40, 100);

    // s0: collapse the first 3 message-refs (ordinals 0..2 → summary-ref at 0).
    collapseLeaf(store, -1, 3, 5);
    // Now ordinal 0 = s0, ordinal 1 = the surviving separator message-ref m1.
    // Collapse the next 4 windows of 3 message-refs each, each starting AFTER the
    // separator at ordinal 1, producing s2..s5 contiguous at ordinals 2..5.
    for (let k = 0; k < 4; k++) {
      collapseLeaf(store, 1 + k, 3, 5);
    }

    const items = store.getContextItems(SCOPE);
    // Sanity on the constructed layout: s0 at 0, a message-ref at 1, then ≥4
    // contiguous summary-refs from ordinal 2.
    expect(items[0]!.refKind).toBe("summary");
    expect(items[1]!.refKind).toBe("message");
    const contiguousAfterSep = [];
    for (let i = 2; i < items.length && items[i]!.refKind === "summary"; i++) {
      contiguousAfterSep.push(items[i]!);
    }
    expect(contiguousAfterSep.length).toBeGreaterThanOrEqual(4);
    const leafCountBefore = store.getSummaries(SCOPE).filter((s) => s.kind === "leaf").length;

    const logger = createMockLogger();
    const { bus } = makeEventBus();
    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // One condensed summary was created — covering the CONTIGUOUS trailing run.
    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    const parentId = condensed[0]!.summaryId;

    // CRITICAL: s0 is NEVER a child of the condensed summary (it sits before the
    // surviving separator message-ref — a different, non-contiguous run).
    const childRows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ?")
      .all(parentId) as Array<{ child_summary_id: string }>;
    const childIds = new Set(childRows.map((r) => r.child_summary_id));
    // Exactly the 4 contiguous-run leaves were linked (none from before the separator).
    expect(childIds.size).toBe(4);

    // The separator message-ref STILL survives (the condensed run never spanned it),
    // and s0 still exists as a leaf in context_items.
    const after = store.getContextItems(SCOPE);
    expect(after[0]!.refKind).toBe("summary"); // s0 untouched at the oldest end
    expect(after[0]!.refId).not.toBe(parentId);
    expect(after.some((it) => it.refKind === "message")).toBe(true); // the separator survives
    // Leaf count is unchanged by the condense pass (children are NEVER deleted —
    // FK RESTRICT losslessness): leaves before == leaves after.
    const leafCountAfter = store.getSummaries(SCOPE).filter((s) => s.kind === "leaf").length;
    expect(leafCountAfter).toBe(leafCountBefore);
  });
});

// ===========================================================================
// Non-fatal — never propagates
// ===========================================================================

describe("maybeRunCondensePass — non-fatal degrade", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("resolves without throwing when the summarizer throws — falls through to the deterministic Level-3 floor (a condensed summary persists, no throw)", async () => {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    await expect(
      maybeRunCondensePass(
        store,
        SCOPE,
        condenseOpts({ condensedMinFanout: 4 }),
        makeSummarizerDeps(throwingSummarizer(), logger),
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    // The deterministic Level-3 floor still produced a bounded condensed summary.
    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    expect(condensed[0]!.fallback).toBe(true);
    expect(condensed[0]!.content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)).toBe(true);
  });

  it("resolves without throwing when store.appendCondensedSummary throws (WARN errorKind dependency, never propagates)", async () => {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4);
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    // Wrap the real store so appendCondensedSummary throws.
    const brokenStore: ContextStorePort = {
      append: (i) => store.append(i),
      getMessages: (c) => store.getMessages(c),
      getContextItems: (c) => store.getContextItems(c),
      getSummaries: (c) => store.getSummaries(c),
      appendLeafSummary: (i) => store.appendLeafSummary(i),
      appendCondensedSummary: () => {
        throw new Error("store boom");
      },
    };

    await expect(
      maybeRunCondensePass(
        brokenStore,
        SCOPE,
        condenseOpts({ condensedMinFanout: 4 }),
        makeSummarizerDeps(shortSummarizer(), logger),
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    const warn = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warn.length).toBeGreaterThan(0);
    const hasDependencyWarn = warn.some(
      (call) => (call[0] as { errorKind?: string })?.errorKind === "dependency",
    );
    expect(hasDependencyWarn).toBe(true);
  });

  it("resolves cleanly with no summarizerDeps (undefined) — gated off, no condensed summary", async () => {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await expect(
      maybeRunCondensePass(
        store,
        SCOPE,
        condenseOpts({ condensedMinFanout: 4 }),
        undefined,
        FIXED_NOW,
        undefined, // nowFn — scalar-only caller (durationMs degrades to 0)
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined();

    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length).toBe(0);
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
  });
});

// ===========================================================================
// WR-01 — "one resolved view is source of truth": taint + previousSummary must
// come from the SAME single snapshot the children were selected from, NOT from
// later independent getSummaries re-reads. (The pass is documented to become
// deferred/async in Phase 132, so a store mutation between reads must not let a
// diverged snapshot silently mis-propagate taint or break continuity.)
// ===========================================================================

describe("maybeRunCondensePass — single resolved snapshot is the source of truth (WR-01)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /**
   * Wrap the real store so `getSummaries` returns a DIFFERENT view on the FIRST
   * call (the `resolveContext` selection snapshot) than on every later call: the
   * first call flags every child summary as `taint: true`, later calls strip it.
   * A correct pass reads taint off the selected children (the snapshot) → persists
   * `taint: true`; the buggy re-read path reads a later untainted snapshot →
   * persists `taint: false`. Also counts the calls to lock in one summaries read.
   */
  function divergingTaintStore(): { wrapped: ContextStorePort; getSummariesCalls: () => number } {
    let calls = 0;
    const wrapped: ContextStorePort = {
      append: (i) => store.append(i),
      getMessages: (c) => store.getMessages(c),
      getContextItems: (c) => store.getContextItems(c),
      appendLeafSummary: (i) => store.appendLeafSummary(i),
      appendCondensedSummary: (i) => store.appendCondensedSummary(i),
      getSummaries: (c) => {
        calls += 1;
        const rows = store.getSummaries(c);
        // ONLY the first read (the resolveContext selection snapshot) is tainted.
        if (calls === 1) return rows.map((s) => ({ ...s, taint: true }));
        return rows.map((s) => ({ ...s, taint: false }));
      },
    };
    return { wrapped, getSummariesCalls: () => calls };
  }

  it("propagates taint from the SELECTION snapshot (taint=OR(children)) even when a later getSummaries read diverges", async () => {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4); // 4 contiguous depth-0 leaves

    const { wrapped } = divergingTaintStore();
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    await maybeRunCondensePass(
      wrapped,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // The condensed summary inherits taint from the children IN THE SELECTION
    // SNAPSHOT (taint=true), not from the later diverged read (taint=false).
    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    expect(condensed[0]!.taint).toBe(true);
  });

  it("reads the conversation summaries exactly ONCE per pass (no taint/previousSummary re-query)", async () => {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 4, 4);

    const { wrapped, getSummariesCalls } = divergingTaintStore();
    const logger = createMockLogger();
    const { bus } = makeEventBus();

    await maybeRunCondensePass(
      wrapped,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined, // nowFn — scalar-only caller (durationMs degrades to 0; timed separately in the O1 test)
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // A condensing pass resolves ONE getSummaries snapshot; taint + previousSummary
    // ride that snapshot. Additional reads reintroduce the two-sources-of-truth bug.
    expect(getSummariesCalls()).toBe(1);
  });
});

// ===========================================================================
// FIX 5 — deep tiering (depth-1 → depth-2) + condensedMinFanoutHard under pressure
// ===========================================================================

describe("maybeRunCondensePass — deep tiering and hard-fanout (FIX 5)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Run ONE condense pass with the given options (short summarizer, no event bus needed). */
  async function runPass(opts: Partial<CondensePassOptions>): Promise<void> {
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts(opts),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );
  }

  /**
   * Collapse the FIRST `width` surviving depth-0 leaf summary-refs (ordinal >
   * `fromOrdinalAfter`) into ONE depth-1 condensed summary-ref via
   * `appendCondensedSummary`. Mirrors {@link collapseLeaf} but over summary-refs, so
   * successive calls produce ADJACENT depth-1 refs (a contiguous depth-1 run).
   */
  function collapseCondensed(fromOrdinalAfter: number, width: number): string {
    const items = store.getContextItems(SCOPE);
    const summaries = store.getSummaries(SCOPE);
    const depthById = new Map(summaries.map((s) => [s.summaryId, s.depth]));
    const leafRefs = items.filter(
      (it) => it.refKind === "summary" && it.ordinal > fromOrdinalAfter && depthById.get(it.refId) === 0,
    );
    const windowRefs = leafRefs.slice(0, width);
    const startOrdinal = windowRefs[0]!.ordinal;
    const endOrdinal = windowRefs[windowRefs.length - 1]!.ordinal;
    return store.appendCondensedSummary({
      scope: SCOPE,
      tokenCount: 5,
      content: `DEPTH1 over ${width} leaves [${startOrdinal}..${endOrdinal}]`,
      descendantCount: width,
      earliestAt: 1000 + startOrdinal,
      latestAt: 1000 + endOrdinal,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: FIXED_NOW,
      startOrdinal,
      endOrdinal,
      childSummaryIds: windowRefs.map((r) => r.refId),
      depth: 1,
    });
  }

  it("folds the DEEPEST qualifying tier so depth-1→depth-2 fires even when a depth-0 run ALSO qualifies", async () => {
    // Seed 32 contiguous depth-0 leaves. Pre-fold the OLDEST 16 into FOUR contiguous
    // depth-1 condensed summaries (4 leaves each), leaving the other 16 as depth-0
    // leaf-refs. The resolved view is now [4× depth-1 run][16× depth-0 run] — TWO
    // runs, BOTH ≥ condensedMinFanout (4). The pass must fold the DEEPER (depth-1)
    // run into a depth-2 summary. Pre-patch the selector picks the SHALLOWEST run
    // (depth-0), so it folds leaves into yet another depth-1 and NO depth-2 ever
    // appears (max depth stuck at 1 — the bug).
    seedHistory(store, 160, 100);
    seedContiguousLeaves(store, 32, 4);
    for (let i = 0; i < 4; i++) collapseCondensed(i - 1, 4); // 4 adjacent depth-1 refs at the oldest end

    const itemsBefore = store.getContextItems(SCOPE);
    const depthOf = (refId: string): number | undefined => store.getSummaries(SCOPE).find((x) => x.summaryId === refId)?.depth;
    const depth1Before = itemsBefore.filter((it) => it.refKind === "summary" && depthOf(it.refId) === 1).length;
    const depth0Before = itemsBefore.filter((it) => it.refKind === "summary" && depthOf(it.refId) === 0).length;
    expect(depth1Before).toBe(4); // a contiguous depth-1 run ≥ fanout
    expect(depth0Before).toBeGreaterThanOrEqual(4); // a contiguous depth-0 run ALSO ≥ fanout

    await runPass({ condensedMinFanout: 4 });

    const summaries = store.getSummaries(SCOPE);
    const maxDepth = Math.max(...summaries.map((s) => s.depth));
    expect(maxDepth).toBeGreaterThanOrEqual(2);
    // A genuine depth-2 condensed summary now exists (the depth-1 run was folded,
    // NOT the shallower depth-0 run).
    expect(summaries.some((s) => s.kind === "condensed" && s.depth === 2)).toBe(true);
  });

  it("condenses a sub-soft-fanout depth-0 run under HIGH pressure via condensedMinFanoutHard", async () => {
    // 2 contiguous depth-0 leaves: below the soft fanout (4) but at the hard bound
    // (2). The resolved view is engineered ABOVE contextThreshold so pressure is
    // HIGH → the hard bound forces a condense the soft fanout alone would skip.
    // Pre-patch `condensedMinFanoutHard` is dead config (never consumed), so NO
    // condensed summary is produced.
    seedHistory(store, 6, 100);
    seedContiguousLeaves(store, 2, 1); // 2 contiguous depth-0 leaves, each tokenCount 5

    // windowTokens tiny so resolved/window utilization exceeds contextThreshold.
    await runPass({
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      contextThreshold: 0.5,
      windowTokens: 20,
    });

    const condensed = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed");
    expect(condensed.length).toBe(1);
    expect(condensed[0]!.depth).toBe(1);
  });

  it("does NOT condense a sub-soft-fanout run when pressure is LOW (hard bound only fires under pressure)", async () => {
    // Same 2-leaf layout, but a HUGE window → utilization well below contextThreshold
    // → pressure LOW → the hard bound does NOT fire, the soft fanout governs, no-op.
    seedHistory(store, 6, 100);
    seedContiguousLeaves(store, 2, 1);

    await runPass({
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      contextThreshold: 0.75,
      windowTokens: 1_000_000,
    });

    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length).toBe(0);
  });
});

// ===========================================================================
// I1 (Phase 160): the inverted-window divergence skip emits context:dag_degraded
// ===========================================================================
//
// The condense divergence branch (`run.endOrdinal < run.startOrdinal`) is a
// defensive contiguity guard — the run is contiguous by construction so it never
// inverts on a clean store. To drive it DETERMINISTICALLY we wrap a real seeded
// store and return getContextItems() with the SUMMARY-ref ordinals inverted (the
// first selected child maps to a HIGHER ordinal than the last) so the selected
// run's window inverts. RED on pre-patch: the skip only WARNs; it emits nothing.

/**
 * Wrap a real ContextStorePort but rewrite getContextItems() so the SUMMARY-ref
 * ordinals DESCEND in walk order, forcing the selected SummaryRefRun to have
 * endOrdinal < startOrdinal (the inverted-window divergence). Message-ref
 * ordinals are left ascending so leaf selection is unaffected; everything else
 * delegates to the real store so a fanout-sized same-depth run is still selected.
 */
function withInvertedSummaryOrdinals(real: ContextStorePort): ContextStorePort {
  return {
    ...real,
    append: (input) => real.append(input),
    getMessages: (scope) => real.getMessages(scope),
    getSummaries: (scope) => real.getSummaries(scope),
    getContextItems: (scope) => {
      const items = real.getContextItems(scope);
      const summaryOrdinals = items
        .filter((it) => it.refKind === "summary")
        .map((it) => it.ordinal);
      const maxSummaryOrdinal = Math.max(...summaryOrdinals, 0);
      const minSummaryOrdinal = Math.min(...summaryOrdinals, 0);
      // Reflect each summary-ref ordinal within the summary-ref ordinal span so the
      // contiguous same-depth run is selected in walk order but its first child now
      // sits at a HIGHER ordinal than its last → endOrdinal < startOrdinal.
      return items.map((it) =>
        it.refKind === "summary"
          ? { ...it, ordinal: maxSummaryOrdinal + minSummaryOrdinal - it.ordinal }
          : it,
      );
    },
    appendLeafSummary: (input) => real.appendLeafSummary(input),
    appendCondensedSummary: (input) => real.appendCondensedSummary(input),
    getSummaryChildren: (scope, id) => real.getSummaryChildren(scope, id),
    getSummaryMessages: (scope, id) => real.getSummaryMessages(scope, id),
    searchLcd: (scope, q, o) => real.searchLcd(scope, q, o),
    runOnConversation: (id, fn) => real.runOnConversation(id, fn),
  };
}

describe("maybeRunCondensePass — inverted-window divergence emits context:dag_degraded (I1)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("emits context:dag_degraded(reason:condense_window_divergence) on the inverted-window skip", async () => {
    // Seed enough contiguous depth-0 leaves to exceed the soft fanout (4) so a
    // run is SELECTED, then invert its window via the wrapper to drive the skip.
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 5, 4);
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "leaf").length).toBe(5);

    const diverged = withInvertedSummaryOrdinals(store);
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();

    await maybeRunCondensePass(
      diverged,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
      makeSummarizerDeps(shortSummarizer(), logger),
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // The divergence WARN fired (the guard is unchanged) ...
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => (c[0] as { errorKind?: string })?.errorKind === "precondition")).toBe(true);
    // ... AND no condensed summary was persisted (the pass skipped) ...
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length).toBe(0);
    // ... AND a content-free context:dag_degraded was emitted with the matching reason.
    const degraded = emits.filter((e) => e.event === "context:dag_degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0]!.payload.reason).toBe("condense_window_divergence");
    expect(degraded[0]!.payload.conversationId).toBe(CONVERSATION_ID);
    expect(degraded[0]!.payload.agentId).toBe(SCOPE.agentId);
    expect(degraded[0]!.payload.sessionKey).toBe(SCOPE.sessionKey);
    expect(typeof degraded[0]!.payload.durationMs).toBe("number");
    expect(typeof degraded[0]!.payload.timestamp).toBe("number");
    // Content-free: identifiers + reason + timing only.
    expect(Object.keys(degraded[0]!.payload).sort()).toEqual(
      ["agentId", "conversationId", "durationMs", "reason", "sessionKey", "timestamp"].sort(),
    );
  });
});
