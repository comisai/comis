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
import { maybeRunCondensePass, runCondensePassAfterTurn, type CondensePassOptions } from "./lcd-condense-trigger.js";
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

// ===========================================================================
// SUMW-02 (Phase 178): condense trigger denominator = budget window
// ===========================================================================
//
// Mirror of the leaf-side SUMW-02 block (see lcd-compaction-trigger.test.ts for
// the full DIST-01 incident narrative). The condense-specific consequence: the
// pressureHigh gate (resolvedTokens / windowTokens > contextThreshold) decides
// whether the HARD fanout (condensedMinFanoutHard, 2) may force a condense the
// soft fanout (condensedMinFanout, 4) would skip. With the legacy denominator
// (the session model's CONFIGURED window, 131_072 in DIST-01) a capability-
// capped small model under REAL pressure (26K stored vs a 32_000 budget window)
// computed utilization 0.198 → pressure LOW → a contiguous run of 3 summaries
// sat un-condensed forever — condensation looked "intermittent" live.
//
// These tests drive the afterTurn wrapper (runCondensePassAfterTurn) — the seam
// where the denominator lives. C1 is RED on pre-patch code; C2 (frontier parity
// pin) passes pre+post BY DESIGN (no cap binds → budgetWindowTokens ==
// getModel().contextWindow — I3 byte-identical). C1 also asserts the 172-02
// onCondensed distillation seam fires with the NEW summaryId, so the threading
// change can never silently drop the hook (T-178-04).

describe("SUMW-02: condense trigger denominator = budget window", () => {
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

  /**
   * Collapse the FIRST `width` surviving depth-0 leaf summary-refs (ordinal >
   * `fromOrdinalAfter`) into ONE depth-1 condensed summary-ref (mirrors the
   * FIX 5 helper) so successive calls produce ADJACENT depth-1 refs.
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

  /**
   * The DIST-01 condense layout: EXACTLY 3 contiguous depth-1 summary-refs
   * (≥ hard fanout 2, < soft fanout 4) followed by 26 raw messages totalling
   * ~26K resolved tokens. Construction: 38 msgs × 1_000; collapse the oldest
   * 12 into 6 contiguous depth-0 leaves (tokenCount 5 each); fold pairs of
   * leaves into 3 adjacent depth-1 condensed refs (tokenCount 5 each).
   * Resolved view = 3×5 (depth-1 refs) + 26×1_000 (raw) = 26_015 tokens.
   */
  function seedDist01CondenseLayout(): void {
    seedHistory(store, 38, 1_000);
    seedContiguousLeaves(store, 6, 2);
    for (let i = 0; i < 3; i++) collapseCondensed(i - 1, 2);
    // Sanity on the constructed layout: a single contiguous depth-1 run of 3.
    const items = store.getContextItems(SCOPE);
    const depthById = new Map(store.getSummaries(SCOPE).map((s) => [s.summaryId, s.depth]));
    const d1Run = items.filter((it) => it.refKind === "summary" && depthById.get(it.refId) === 1);
    expect(d1Run.length).toBe(3);
    expect(d1Run.map((it) => it.ordinal)).toEqual([0, 1, 2]);
  }

  it("SUMW-02-C1 (DIST-01): pressureHigh ratios against the BUDGET window — the hard fanout (2) forces a condense the soft fanout (4) would skip", async () => {
    // Pre-patch: pressure = 26_015 / getModel().contextWindow (131_072) = 0.198
    //   ≤ 0.75 → pressure LOW → soft fanout 4 governs → the run of 3 is skipped
    //   → NO depth-2 condensed summary → FAILS (RED).
    // Post-patch: pressure = 26_015 / budgetWindowTokens (32_000) = 0.813
    //   > 0.75 → pressure HIGH → hard fanout 2 → the run of 3 condenses into ONE
    //   depth-2 summary AND the 172-02 onCondensed distillation hook fires with
    //   its summaryId.
    seedDist01CondenseLayout();
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = depsWithConfiguredWindow(131_072, logger);
    const onCondensedCalls: Array<{ summaryId: string; depth: number }> = [];

    await runCondensePassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined, // schema defaults: soft 4 / hard 2 / threshold 0.75
      getCondenseSummarizerDeps: () => deps,
      budgetWindowTokens: 32_000, // the turn's budget window: min(131_072, class cap 32_000)
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
      eventBus: bus,
      onCondensed: (summaryId, _content, _fallback, depth) => {
        onCondensedCalls.push({ summaryId, depth });
      },
    });

    // ONE depth-2 condensed summary persisted (the 3 depth-1 children folded).
    const depth2 = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2);
    expect(depth2.length).toBe(1);
    // The 172-02 distillation seam fired with the NEW summary's id (T-178-04).
    expect(onCondensedCalls.length).toBe(1);
    expect(onCondensedCalls[0]!.summaryId).toBe(depth2[0]!.summaryId);
    expect(onCondensedCalls[0]!.depth).toBe(2);
  });

  it("SUMW-02-C2 (frontier parity pin): equal budget and configured window (no cap binds) — pressure LOW, soft fanout governs, the 3-run is skipped", async () => {
    // I3: window == budgetWindowTokens == 200_000 → pressure = 26_015 / 200_000
    // = 0.13 ≤ 0.75 → pressure LOW → soft fanout 4 → the run of 3 is skipped —
    // byte-identical to the legacy read (passes pre+post BY DESIGN).
    seedDist01CondenseLayout();
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = depsWithConfiguredWindow(200_000, logger);
    const onCondensedCalls: string[] = [];

    await runCondensePassAfterTurn({
      store,
      scope: SCOPE,
      contextEngine: undefined,
      getCondenseSummarizerDeps: () => deps,
      budgetWindowTokens: 200_000, // == getModel().contextWindow — the no-cap condition
      now: FIXED_NOW,
      nowFn: undefined,
      logger: logger as unknown as LeafSummarizerDeps["logger"],
      eventBus: bus,
      onCondensed: (summaryId) => {
        onCondensedCalls.push(summaryId);
      },
    });

    // No depth-2 condensed summary, no distillation hook — identical to legacy.
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2).length).toBe(0);
    expect(onCondensedCalls.length).toBe(0);
  });
});

// ===========================================================================
// SUMW-01 (Phase 178): condense prefix clamp — run input ≤ resolved summarizer window
// ===========================================================================
//
// The condense half of the span invariant ("for all compaction calls, inputTokens
// ≤ resolved summarizer effectiveWindow"): selectCondensableTier picks by fanout
// ONLY — Σ child tokenCount is unbounded relative to the summarizer (4+ children ×
// up to 1_200 tokens + a 2_000 target can exceed an 8K override). The clamp
// (inside maybeRunCondensePass, after run selection + the inverted-ordinal guard)
// prefix-trims the selected run to the LONGEST child prefix whose Σ tokenCount
// fits summarizerWindow − condensedTargetTokens − SUMMARIZER_PROMPT_OVERHEAD_TOKENS,
// keyed to the RESOLVED summarizer (resolveSummarizerWindowTokens — the 178-02
// contract). Ordinal integrity (T-178-10): a prefix of a contiguous run stays
// contiguous, so [startOrdinal, children[keep-1].ordinal] remains a valid
// range-replace window and the trimmed children survive UN-CONDENSED in
// context_items for a later pass. keep < 2 → honest DEBUG skip (a 1-child
// condense is meaningless re-summarization; T-178-12 — observable, never silent).
//
// Arithmetic (overhead 2_048, target 2_000): child budget = W − 2_000 − 2_048.
//   - C1 (RED): W=8_000 → budget 3_952; 4 children × 1_200 → keep 3
//     (3_600 ≤ 3_952 < 4_800). Pre-patch: all 4 condensed.
//   - C2 (skip-honesty): W=4_500 → budget 452 < first child 1_200 → keep 0 < 2
//     → NO condense, store unchanged, no throw. RED pre-patch.
//   - C3 (no-op pin, I3): W=200_000 → all 4 condensed — legacy behavior.

describe("SUMW-01: condense prefix clamp", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /**
   * Collapse the FIRST `width` surviving depth-0 leaf summary-refs (ordinal >
   * `fromOrdinalAfter`) into ONE depth-1 condensed ref with an EXPLICIT
   * tokenCount (mirrors the FIX-5/SUMW-02 helpers, parameterized tokenCount —
   * the clamp's prefix walk sums these stored counts).
   */
  function collapseCondensedWithTokens(
    fromOrdinalAfter: number,
    width: number,
    tokenCount: number,
  ): string {
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
      tokenCount,
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

  /**
   * The clamp layout: 4 CONTIGUOUS depth-1 condensed refs at ordinals 0..3,
   * tokenCount 1_200 each (Σ 4_800), followed by the surviving raw messages.
   * The soft fanout (4) is met, so the run is selected WITHOUT any pressure
   * dependency (opts windowTokens 200_000 → pressure LOW → soft fanout governs).
   * Returns the 4 depth-1 ids in run (oldest-first) order.
   */
  function seedFourDepth1Children(): string[] {
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 8, 2); // 8 contiguous depth-0 leaves (tokenCount 5 each)
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(collapseCondensedWithTokens(i - 1, 2, 1_200));
    // Sanity on the constructed layout: ONE contiguous depth-1 run of 4 at 0..3.
    const items = store.getContextItems(SCOPE);
    const depthById = new Map(store.getSummaries(SCOPE).map((s) => [s.summaryId, s.depth]));
    const d1 = items.filter((it) => it.refKind === "summary" && depthById.get(it.refId) === 1);
    expect(d1.length).toBe(4);
    expect(d1.map((it) => it.ordinal)).toEqual([0, 1, 2, 3]);
    return ids;
  }

  /** Deps with an `operationModels.compaction`-style override summarizer window. */
  function depsWithOverrideWindow(
    overrideWindow: number,
    summarize: LeafSummarizer,
    logger: ReturnType<typeof createMockLogger>,
  ): LeafSummarizerDeps {
    return {
      ...makeSummarizerDeps(summarize, logger),
      overrideModel: { model: { contextWindow: overrideWindow }, getApiKey: async () => "k" },
      // The PRIMARY real model — a clamp wrongly keyed here (131_072) or to
      // getModel()'s 200_000 would keep all 4 children (Pitfall 2 regression).
      getRealModel: () => ({ contextWindow: 131_072 }),
    };
  }

  it("SUMW-01-C1 (prefix-trim): an 8K summarizer condenses ONLY the 3-child prefix; the 4th child survives un-condensed for a later pass", async () => {
    // Child budget = 8_000 − 2_000 − 2_048 = 3_952 → keep 3 (3_600 ≤ 3_952 <
    // 4_800). Pre-patch: all 4 children condensed (childSummaryIds length 4, the
    // 4th ref absorbed by the range-replace) → FAILS (RED).
    const childIds = seedFourDepth1Children();
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = depsWithOverrideWindow(8_000, shortSummarizer(), logger);

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // ONE depth-2 condensed summary persisted over the kept prefix.
    const depth2 = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2);
    expect(depth2.length).toBe(1);
    const parentId = depth2[0]!.summaryId;

    // childSummaryIds == the FIRST 3 seeded depth-1 ids (the kept prefix) — the
    // 4th is NOT linked.
    const rows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ?")
      .all(parentId) as Array<{ child_summary_id: string }>;
    expect(rows.map((r) => r.child_summary_id).sort()).toEqual([...childIds.slice(0, 3)].sort());

    // endOrdinal == the 3rd child's ordinal (2): the range-replace consumed
    // ordinals 0..2 ONLY → the depth-2 ref sits at ordinal 0 with the 4th depth-1
    // ref IMMEDIATELY after it — alive in context_items, available for a later
    // pass (T-178-10 ordinal integrity).
    const items = store.getContextItems(SCOPE);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(parentId);
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(childIds[3]);
    // The 4th child row is still an un-condensed depth-1 summary in the store.
    const fourth = store.getSummaries(SCOPE).find((s) => s.summaryId === childIds[3]);
    expect(fourth).toBeDefined();
    expect(fourth!.depth).toBe(1);
  });

  it("INT-W1 (flagship): a served-bound PRIMARY summarizer (configured 131_072 / served 8_000, NO override) prefix-trims the condense run to the SERVED window", async () => {
    // The milestone integration WARNING 1 scenario on the condense half:
    // summarizer = the primary model on a provider serving 8_000 against a
    // configured 131_072. Resolved window must be min(131_072, 8_000) = 8_000
    // → child budget = 8_000 − 2_000 − 2_048 = 3_952 → keep 3 of the 4 ×
    // 1_200-token children (the SUMW-01-C1 arithmetic, now bound by SERVED).
    // Pre-INT-W1 the helper returned the configured 131_072 → all 4 children
    // (4_800 tokens) were concatenated for a provider serving 8K (RED: 4
    // children condensed). primaryServedWindow is the executor-reconcile-gated
    // windowProvenance.served (WR-02: it binds exactly the getRealModel model).
    const childIds = seedFourDepth1Children();
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps: LeafSummarizerDeps = {
      ...makeSummarizerDeps(shortSummarizer(), logger),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      primaryServedWindow: 8_000,
    };

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // ONE depth-2 condensed summary persisted over the served-clamped 3-child
    // prefix; the 4th child survives un-condensed for a later pass.
    const depth2 = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2);
    expect(depth2.length).toBe(1);
    const rows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ?")
      .all(depth2[0]!.summaryId) as Array<{ child_summary_id: string }>;
    expect(rows.map((r) => r.child_summary_id).sort()).toEqual([...childIds.slice(0, 3)].sort());
  });

  it("SUMW-01-C2 (skip-honesty): a summarizer too small for even a 2-child prefix skips the condense cleanly — store unchanged, no throw", async () => {
    // W=4_500 → child budget 4_500 − 2_000 − 2_048 = 452 < the first child's
    // 1_200 → keep 0 < 2 → honest skip (DEBUG only — T-178-12). Pre-patch: all 4
    // condensed → a depth-2 summary appears → FAILS (RED).
    seedFourDepth1Children();
    const itemsBefore = store.getContextItems(SCOPE);
    const summarize = shortSummarizer();
    const logger = createMockLogger();
    const { bus, emits } = makeEventBus();
    const deps = depsWithOverrideWindow(4_500, summarize, logger);

    await expect(
      maybeRunCondensePass(
        store,
        SCOPE,
        condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
        deps,
        FIXED_NOW,
        undefined,
        logger as unknown as LeafSummarizerDeps["logger"],
        bus,
      ),
    ).resolves.toBeUndefined(); // no throw — a clean infeasible skip

    // No condense happened: no depth-2 summary, no summarizer call, no compaction
    // event, context_items byte-identical.
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2).length).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(emits.filter((e) => e.event === "context:dag_compacted").length).toBe(0);
    expect(store.getContextItems(SCOPE)).toEqual(itemsBefore);
  });

  it("SUMW-01-C3 (no-op pin, I3): a large-window summarizer condenses ALL 4 children — legacy behavior byte-identical", async () => {
    // W=200_000 → child budget 195_952 ≥ Σ 4_800 → no trim (effectiveRun === run):
    // all 4 children condense; endOrdinal = the 4th child's ordinal (the whole
    // [0..3] window range-replaced). Passes pre- AND post-patch BY DESIGN.
    const childIds = seedFourDepth1Children();
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = depsWithOverrideWindow(200_000, shortSummarizer(), logger);

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    const depth2 = store.getSummaries(SCOPE).filter((s) => s.kind === "condensed" && s.depth === 2);
    expect(depth2.length).toBe(1);
    const rows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ?")
      .all(depth2[0]!.summaryId) as Array<{ child_summary_id: string }>;
    expect(rows.map((r) => r.child_summary_id).sort()).toEqual([...childIds].sort());
    // The WHOLE run [0..3] was range-replaced: the depth-2 ref at ordinal 0 with
    // NO surviving depth-1 refs in context_items.
    const items = store.getContextItems(SCOPE);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(depth2[0]!.summaryId);
    const depthById = new Map(store.getSummaries(SCOPE).map((s) => [s.summaryId, s.depth]));
    expect(items.filter((it) => it.refKind === "summary" && depthById.get(it.refId) === 1).length).toBe(0);
  });

  it("IN-01: a bad windowTokens gate-skip leaves a DEBUG breadcrumb — the condense pass never silently disarms", async () => {
    // The leaf gate logs `reason: "bad-window"` on the same condition; the
    // condense gate returned with NO trace — the exact "silently disarm" class
    // the phase invariant forbids. Identifiers + numbers only (I7).
    const logger = createMockLogger();
    const deps = makeSummarizerDeps(shortSummarizer(), logger);

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ windowTokens: 0 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
    );

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ step: "lcd-condense-gate", reason: "bad-window", windowTokens: 0 }),
      "lcd condense pass gate skip",
    );
  });

  it("WR-03: a target-depth previousSummary shrinks the child budget — the trim accounts the ACTUAL threaded prompt contents", async () => {
    // The flat 2_048 overhead covers only the instruction TEMPLATE; the
    // threaded previousSummary at the target depth is ~condensedTargetTokens-
    // sized — feeding both against the flat reserve overflowed near-exactly-
    // filled windows. Layout: 12 leaves → 6 depth-1 children (1_200 each);
    // the FIRST 2 condense into a pre-existing depth-2 whose CONTENT is
    // 8_000 chars ≈ 2_000 tokens (what previousSummaryAtDepth(…, 2) threads
    // into the NEXT depth-2 condense prompt); the remaining 4 depth-1s form
    // ONE contiguous run.
    seedHistory(store, 40, 100);
    seedContiguousLeaves(store, 12, 2);
    const d1ids: string[] = [];
    for (let i = 0; i < 6; i++) d1ids.push(collapseCondensedWithTokens(i - 1, 2, 1_200));
    // Collapse the first 2 depth-1 refs into the pre-existing depth-2 prev.
    const itemsNow = store.getContextItems(SCOPE);
    const depthByIdNow = new Map(store.getSummaries(SCOPE).map((s) => [s.summaryId, s.depth]));
    const d1refs = itemsNow.filter((it) => it.refKind === "summary" && depthByIdNow.get(it.refId) === 1);
    const prevId = store.appendCondensedSummary({
      scope: SCOPE,
      tokenCount: 2_000,
      content: "X".repeat(8_000), // estimateMessageTokens: 8_000 / 4 = 2_000
      descendantCount: 2,
      earliestAt: 1_000,
      latestAt: 1_001,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: FIXED_NOW,
      startOrdinal: d1refs[0]!.ordinal,
      endOrdinal: d1refs[1]!.ordinal,
      childSummaryIds: [d1refs[0]!.refId, d1refs[1]!.refId],
      depth: 2,
    });
    const logger = createMockLogger();
    const { bus } = makeEventBus();
    const deps = depsWithOverrideWindow(9_000, shortSummarizer(), logger);

    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4, windowTokens: 200_000 }),
      deps,
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );

    // Child budget = 9_000 − 2_000 (target) − 2_048 (template) − 2_000
    // (previousSummary) = 2_952 → keep 2 (2_400 ≤ 2_952 < 3_600). Pre-fix the
    // budget ignored the previousSummary (4_952 → all 4 kept): children +
    // target + template + prev = 4_800 + 2_000 + 2_048 + 2_000 = 10_848 >
    // 9_000 — the provider-overflow class SUMW-01 exists to eliminate.
    const newDepth2 = store
      .getSummaries(SCOPE)
      .filter((s) => s.kind === "condensed" && s.depth === 2 && s.summaryId !== prevId);
    expect(newDepth2.length).toBe(1);
    const rows = db
      .prepare("SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ?")
      .all(newDepth2[0]!.summaryId) as Array<{ child_summary_id: string }>;
    expect(rows.map((r) => r.child_summary_id).sort()).toEqual([d1ids[2], d1ids[3]].sort());
  });
});

// ===========================================================================
// OBS-01 (Phase 180-08): summary_language_mismatch at the dag CONDENSE site
// ===========================================================================
//
// The requirement's four-row matrix at the condense site (depth = run.depth + 1).
// The condense SOURCE is the children summaries' concatenated CONTENT (the
// summarizer INPUT); the SUMMARY is the injected condense summarizer's output.
// RED on pre-patch: maybeRunCondensePass emits NO summary_language_mismatch. All
// Hebrew glyphs are built from String.fromCodePoint (WR-01).
describe("maybeRunCondensePass — summary_language_mismatch (OBS-01, condense depth)", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  const HEBREW_WORD = String.fromCodePoint(0x05e1, 0x05e4, 0x05e8); // ספר
  const HEBREW_SUMMARY = `${HEBREW_WORD} ${HEBREW_WORD}`;
  const ENGLISH_SUMMARY = "the user discussed books and reading";

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /**
   * Seed `n` contiguous depth-0 leaves whose CONTENT is `leafContent` — the
   * condense source. Mirrors seedContiguousLeaves but parametrizes the content.
   */
  function seedLeavesWithContent(n: number, width: number, leafContent: string): void {
    for (let i = 0; i < n; i++) {
      const items = store.getContextItems(SCOPE);
      const msgRefs = items.filter((it) => it.refKind === "message" && it.ordinal > i - 1);
      const windowRefs = msgRefs.slice(0, width);
      const startOrdinal = windowRefs[0]!.ordinal;
      const endOrdinal = windowRefs[windowRefs.length - 1]!.ordinal;
      store.appendLeafSummary({
        scope: SCOPE,
        tokenCount: 5,
        content: leafContent,
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
  }

  async function runCondense(summaryText: string, bus: TypedEventBus): Promise<void> {
    const logger = createMockLogger();
    await maybeRunCondensePass(
      store,
      SCOPE,
      condenseOpts({ condensedMinFanout: 4 }),
      makeSummarizerDeps(shortSummarizer(summaryText), logger),
      FIXED_NOW,
      undefined,
      logger as unknown as LeafSummarizerDeps["logger"],
      bus,
    );
  }

  it("FIRES on Hebrew children → English condensed summary with { sourceScript: hebrew, summaryScript: latin, depth: 1 }", async () => {
    seedHistory(store, 40, 100);
    seedLeavesWithContent(4, 4, HEBREW_WORD); // 4 contiguous Hebrew-content leaves
    const { bus, emits } = makeEventBus();
    await runCondense(ENGLISH_SUMMARY, bus);

    const mism = emits.filter((e) => e.event === "context:summary_language_mismatch");
    expect(mism.length).toBe(1);
    expect(mism[0]!.payload.sourceScript).toBe("hebrew");
    expect(mism[0]!.payload.summaryScript).toBe("latin");
    expect(mism[0]!.payload.depth).toBe(1); // condense depth = leaf depth 0 + 1
    expect(mism[0]!.payload.agentId).toBe("agent_a");
    expect(mism[0]!.payload.sessionKey).toBe("sess-a");
  });

  it("is SILENT on Hebrew children → Hebrew condensed summary", async () => {
    seedHistory(store, 40, 100);
    seedLeavesWithContent(4, 4, HEBREW_WORD);
    const { bus, emits } = makeEventBus();
    await runCondense(HEBREW_SUMMARY, bus);
    expect(emits.filter((e) => e.event === "context:summary_language_mismatch").length).toBe(0);
  });

  it("is SILENT on Latin children → Latin condensed summary", async () => {
    seedHistory(store, 40, 100);
    seedLeavesWithContent(4, 4, "books and reading discussion");
    const { bus, emits } = makeEventBus();
    await runCondense(ENGLISH_SUMMARY, bus);
    expect(emits.filter((e) => e.event === "context:summary_language_mismatch").length).toBe(0);
  });

  it("is SILENT on code-heavy children (latin-dominant under 0.3) → English condensed summary", async () => {
    seedHistory(store, 40, 100);
    const codeHeavy = `const handler = (req) => { return { ok: true, n: 42 }; }; // ${HEBREW_WORD}`;
    seedLeavesWithContent(4, 4, codeHeavy);
    const { bus, emits } = makeEventBus();
    await runCondense(ENGLISH_SUMMARY, bus);
    expect(emits.filter((e) => e.event === "context:summary_language_mismatch").length).toBe(0);
  });

  it("never fails the condense pass when the mismatch subscriber throws (guarded emit)", async () => {
    seedHistory(store, 40, 100);
    seedLeavesWithContent(4, 4, HEBREW_WORD);
    const throwingBus = {
      emit: (event: string) => {
        if (event === "context:summary_language_mismatch") throw new Error("subscriber boom");
        return true;
      },
    } as unknown as TypedEventBus;
    await runCondense(ENGLISH_SUMMARY, throwingBus);
    // The condensed summary is still persisted (the pass completed).
    expect(store.getSummaries(SCOPE).filter((s) => s.kind === "condensed").length).toBe(1);
  });

  it("never leaks the summary or source body into the mismatch payload", async () => {
    seedHistory(store, 40, 100);
    // Source = pure Hebrew (so the mismatch fires); the unique English marker
    // lives ONLY in the summary. The payload must contain neither body.
    seedLeavesWithContent(4, 4, `${HEBREW_WORD} ${HEBREW_WORD} ${HEBREW_WORD}`);
    const uniqueSummary = "UNIQUE-SUMMARY-english-probe books and reading";
    const { bus, emits } = makeEventBus();
    await runCondense(uniqueSummary, bus);
    const mism = emits.filter((e) => e.event === "context:summary_language_mismatch");
    expect(mism.length).toBe(1);
    const blob = JSON.stringify(mism[0]!.payload);
    expect(blob).not.toContain("UNIQUE-SUMMARY");
    expect(blob).not.toContain(HEBREW_WORD);
  });
});
