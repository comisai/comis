/**
 * Tests for DAG trigger detection, lazy ancestor dirty marking,
 * descendant recomputation, and orchestrated compaction runner.
 *
 * Uses :memory: SQLite databases with createContextStore() for real store
 * operations. Follows the same pattern as dag-compaction.test.ts.
 *
 * DAG Compaction Engine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import { createHash } from "node:crypto";
import {
  shouldCompact,
  markAncestorsDirty,
  recomputeDescendantCounts,
  runDagCompaction,
} from "./dag-triggers.js";
import type { TokenBudget, CompactionDeps, DagCompactionDeps, DagCompactionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let store: ContextStore;

const mockGenerateSummary = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockGetModel = vi.fn().mockReturnValue({
  model: { id: "haiku", provider: "anthropic" },
  getApiKey: async () => "test-key",
});
const mockEstimateTokens = vi.fn((text: string) => Math.ceil(text.length / 4));
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as CompactionDeps["logger"];

let baseDeps: CompactionDeps;

beforeEach(() => {
  db = new Database(":memory:");
  store = createContextStore(db);
  vi.clearAllMocks();
  mockGenerateSummary.mockResolvedValue("Mock summary of conversation content.");
  mockGetModel.mockReturnValue({
    model: { id: "haiku", provider: "anthropic" },
    getApiKey: async () => "test-key",
  });
  baseDeps = {
    store,
    logger: mockLogger,
    generateSummary: mockGenerateSummary as unknown as CompactionDeps["generateSummary"],
    getModel: mockGetModel,
    estimateTokens: mockEstimateTokens,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function createConv(): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "agent-1",
    sessionKey: "session-1",
  });
}

function insertMessages(convId: string, count: number, tokensEach = 100): void {
  for (let i = 0; i < count; i++) {
    const seq = i + 1;
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `${role} message ${seq} with content for testing.`;
    store.insertMessage({
      conversationId: convId,
      seq,
      role,
      content,
      contentHash: contentHash(content + seq),
      tokenCount: tokensEach,
    });
  }
}

const BUDGET: TokenBudget = {
  windowTokens: 128_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 6_400,
  contextRotBufferTokens: 32_000,
  availableHistoryTokens: 2000,
};

// ---------------------------------------------------------------------------
// 1. shouldCompact
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  it("returns true when total tokens exceed threshold", () => {
    const convId = createConv();
    // 20 messages * 100 tokens = 2000 tokens
    insertMessages(convId, 20, 100);

    // threshold = 0.75 * 2000 = 1500, total = 2000 -> true
    const result = shouldCompact(store, convId, { contextThreshold: 0.75 }, BUDGET);
    expect(result).toBe(true);
  });

  it("returns false when below threshold", () => {
    const convId = createConv();
    // 10 messages * 100 tokens = 1000 tokens
    insertMessages(convId, 10, 100);

    // threshold = 0.75 * 2000 = 1500, total = 1000 -> false
    const result = shouldCompact(store, convId, { contextThreshold: 0.75 }, BUDGET);
    expect(result).toBe(false);
  });

  it("includes both messages and summaries in token count", () => {
    const convId = createConv();
    // 10 messages * 100 tokens = 1000 tokens (below threshold 1500)
    insertMessages(convId, 10, 100);

    // Without summaries: false
    expect(shouldCompact(store, convId, { contextThreshold: 0.75 }, BUDGET)).toBe(false);

    // Add a summary with 600 tokens -> total = 1600 > 1500
    store.insertSummary({
      summaryId: "sum_extra_1",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Summary content.",
      tokenCount: 600,
    });

    // Now should exceed threshold
    expect(shouldCompact(store, convId, { contextThreshold: 0.75 }, BUDGET)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. markAncestorsDirty
// ---------------------------------------------------------------------------

describe("markAncestorsDirty", () => {
  it("marks parent summaries as dirty", () => {
    const convId = createConv();

    // Create depth-0 summary
    store.insertSummary({
      summaryId: "sum_d0",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary.",
      tokenCount: 50,
    });

    // Create depth-1 summary that is parent of depth-0
    store.insertSummary({
      summaryId: "sum_d1",
      conversationId: convId,
      kind: "condensed",
      depth: 1,
      content: "Condensed summary.",
      tokenCount: 30,
    });
    store.linkSummaryParents("sum_d0", ["sum_d1"]);

    // Mark depth-0 ancestors dirty
    markAncestorsDirty(store, "sum_d0");

    // Depth-1 should now be dirty
    const d1 = store.getSummary("sum_d1");
    expect(d1!.counts_dirty).toBe(1);
  });

  it("recursively marks ancestors up the tree", () => {
    const convId = createConv();

    // 3-level chain: d0 -> d1 -> d2
    store.insertSummary({ summaryId: "sum_chain_d0", conversationId: convId, kind: "leaf", depth: 0, content: "d0.", tokenCount: 50 });
    store.insertSummary({ summaryId: "sum_chain_d1", conversationId: convId, kind: "condensed", depth: 1, content: "d1.", tokenCount: 30 });
    store.insertSummary({ summaryId: "sum_chain_d2", conversationId: convId, kind: "condensed", depth: 2, content: "d2.", tokenCount: 20 });

    store.linkSummaryParents("sum_chain_d0", ["sum_chain_d1"]);
    store.linkSummaryParents("sum_chain_d1", ["sum_chain_d2"]);

    // Mark d0 ancestors dirty -> d1 and d2 should be dirty
    markAncestorsDirty(store, "sum_chain_d0");

    expect(store.getSummary("sum_chain_d1")!.counts_dirty).toBe(1);
    expect(store.getSummary("sum_chain_d2")!.counts_dirty).toBe(1);
  });

  it("handles summaries with no parents", () => {
    const convId = createConv();
    store.insertSummary({ summaryId: "sum_orphan", conversationId: convId, kind: "leaf", depth: 0, content: "Orphan.", tokenCount: 50 });

    // Should not throw
    expect(() => markAncestorsDirty(store, "sum_orphan")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. recomputeDescendantCounts
// ---------------------------------------------------------------------------

describe("recomputeDescendantCounts", () => {
  it("counts source messages for leaf summaries", () => {
    const convId = createConv();
    insertMessages(convId, 8);

    // Create leaf summary linked to 8 messages
    store.insertSummary({ summaryId: "sum_leaf_rc", conversationId: convId, kind: "leaf", depth: 0, content: "Leaf.", tokenCount: 50 });
    const msgIds = store.getMessagesByConversation(convId).map(m => m.message_id);
    store.linkSummaryMessages("sum_leaf_rc", msgIds);

    // Mark dirty so recomputation runs
    store.updateSummaryCountsDirty(["sum_leaf_rc"], true);

    const counts = recomputeDescendantCounts(store, "sum_leaf_rc");
    expect(counts.messageCount).toBe(8);
    expect(counts.summaryCount).toBe(0);
  });

  it("aggregates counts for condensed summaries", () => {
    const convId = createConv();
    insertMessages(convId, 24);
    const allMsgs = store.getMessagesByConversation(convId);

    // Create 3 leaf summaries, each with 8 messages
    for (let i = 0; i < 3; i++) {
      const sid = `sum_agg_leaf_${i}`;
      store.insertSummary({ summaryId: sid, conversationId: convId, kind: "leaf", depth: 0, content: `Leaf ${i}.`, tokenCount: 50 });
      const chunk = allMsgs.slice(i * 8, (i + 1) * 8).map(m => m.message_id);
      store.linkSummaryMessages(sid, chunk);
      store.updateSummaryCountsDirty([sid], true);
    }

    // Create condensed summary with 3 leaf children
    store.insertSummary({ summaryId: "sum_agg_cond", conversationId: convId, kind: "condensed", depth: 1, content: "Condensed.", tokenCount: 30 });
    store.linkSummaryParents("sum_agg_leaf_0", ["sum_agg_cond"]);
    store.linkSummaryParents("sum_agg_leaf_1", ["sum_agg_cond"]);
    store.linkSummaryParents("sum_agg_leaf_2", ["sum_agg_cond"]);
    store.updateSummaryCountsDirty(["sum_agg_cond"], true);

    const counts = recomputeDescendantCounts(store, "sum_agg_cond");
    expect(counts.messageCount).toBe(24);
    expect(counts.summaryCount).toBe(3);
  });

  it("marks summary as clean after recomputation", () => {
    const convId = createConv();
    insertMessages(convId, 4);

    store.insertSummary({ summaryId: "sum_clean", conversationId: convId, kind: "leaf", depth: 0, content: "Leaf.", tokenCount: 50 });
    const msgIds = store.getMessagesByConversation(convId).map(m => m.message_id);
    store.linkSummaryMessages("sum_clean", msgIds);
    store.updateSummaryCountsDirty(["sum_clean"], true);

    expect(store.getSummary("sum_clean")!.counts_dirty).toBe(1);

    recomputeDescendantCounts(store, "sum_clean");

    expect(store.getSummary("sum_clean")!.counts_dirty).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. runDagCompaction
// ---------------------------------------------------------------------------

describe("runDagCompaction", () => {
  it("runs leaf pass and condensed passes in sequence", async () => {
    const convId = createConv();
    insertMessages(convId, 20);

    const config: DagCompactionConfig = {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      condensedMinFanout: 2,
      condensedTargetTokens: 200,
      freshTailTurns: 0,
      contextThreshold: 0.75,
      incrementalMaxDepth: 1,
    };

    const deps: DagCompactionDeps = {
      ...baseDeps,
      agentId: "agent-1",
      sessionKey: "session-1",
    };

    const result = await runDagCompaction(convId, config, deps);

    expect(result.leafResult.created).toBeGreaterThan(0);
    expect(result.totalCreated).toBeGreaterThan(0);
  });

  it("emits context:dag_compacted event", async () => {
    const convId = createConv();
    insertMessages(convId, 16);

    const mockEmit = vi.fn();

    const config: DagCompactionConfig = {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
      freshTailTurns: 0,
      contextThreshold: 0.75,
      incrementalMaxDepth: 1,
    };

    const deps: DagCompactionDeps = {
      ...baseDeps,
      agentId: "agent-test",
      sessionKey: "session-test",
      eventBus: { emit: mockEmit },
    };

    await runDagCompaction(convId, config, deps);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      "context:dag_compacted",
      expect.objectContaining({
        conversationId: convId,
        agentId: "agent-test",
        sessionKey: "session-test",
        leafSummariesCreated: expect.any(Number),
        totalSummariesCreated: expect.any(Number),
        durationMs: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );
  });

  it("skips condensed passes when incrementalMaxDepth=0", async () => {
    const convId = createConv();
    insertMessages(convId, 20);

    const config: DagCompactionConfig = {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      condensedMinFanout: 2,
      condensedTargetTokens: 200,
      freshTailTurns: 0,
      contextThreshold: 0.75,
      incrementalMaxDepth: 0, // Skip condensed
    };

    const deps: DagCompactionDeps = {
      ...baseDeps,
      agentId: "agent-1",
      sessionKey: "session-1",
    };

    const result = await runDagCompaction(convId, config, deps);

    expect(result.leafResult.created).toBeGreaterThan(0);
    expect(result.condensedResults.length).toBe(0);
  });
});
