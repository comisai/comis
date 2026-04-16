/**
 * Tests for DAG assembler: fetch context items, fresh tail boundary,
 * XML summary wrapping, recall guidance injection, relevance-ranked
 * budget selection, mixed content, and ordering.
 *
 * Uses :memory: SQLite databases with createContextStore() for real store
 * operations. Follows the same pattern as dag-compaction.test.ts.
 *
 * DAG Assembly & Annotation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import { createHash } from "node:crypto";
import { createDagAssemblerLayer } from "./dag-assembler.js";
import type { DagAssemblerDeps, DagAssemblerConfig, TokenBudget } from "./types.js";
import { RECALL_GUIDANCE, XML_WRAPPER_OVERHEAD_TOKENS } from "./constants.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let store: ContextStore;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as DagAssemblerDeps["logger"];

const defaultBudget: TokenBudget = {
  windowTokens: 100_000,
  systemTokens: 5_000,
  outputReserveTokens: 4_096,
  safetyMarginTokens: 2_048,
  contextRotBufferTokens: 25_000,
  availableHistoryTokens: 50_000,
};

beforeEach(() => {
  db = new Database(":memory:");
  store = createContextStore(db);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConv(): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "agent-1",
    sessionKey: "session-1",
  });
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Insert a test message and return its message_id.
 */
function insertTestMessage(
  st: ContextStore,
  conversationId: string,
  seq: number,
  role: string,
  content: string,
  opts?: { toolName?: string; toolCallId?: string },
): number {
  return st.insertMessage({
    conversationId,
    seq,
    role,
    content,
    contentHash: contentHash(content + seq),
    tokenCount: estimateTokens(content),
    toolName: opts?.toolName,
    toolCallId: opts?.toolCallId,
  });
}

/**
 * Insert a test summary and add it as a context item.
 */
function insertTestSummary(
  st: ContextStore,
  conversationId: string,
  ordinal: number,
  content: string,
  depth: number,
  opts?: {
    descendantCount?: number;
    sourceTokenCount?: number;
    earliestAt?: string;
    latestAt?: string;
  },
): string {
  const summaryId = `sum_test_${ordinal}_${Date.now()}`;
  st.insertSummary({
    summaryId,
    conversationId,
    kind: depth === 0 ? "leaf" : "condensed",
    depth,
    content,
    tokenCount: estimateTokens(content),
    earliestAt: opts?.earliestAt,
    latestAt: opts?.latestAt,
    sourceTokenCount: opts?.sourceTokenCount ?? estimateTokens(content) * 5,
  });
  return summaryId;
}

function makeAssemblerConfig(overrides?: Partial<DagAssemblerConfig>): DagAssemblerConfig {
  return {
    freshTailTurns: 2,
    availableHistoryTokens: 50_000,
    ...overrides,
  };
}

function makeAssemblerDeps(convId: string): DagAssemblerDeps {
  return {
    store,
    logger: mockLogger,
    conversationId: convId,
    estimateTokens,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getTextFromMessage(msg: any): string {
  if (Array.isArray(msg.content) && msg.content[0]?.text) {
    return msg.content[0].text;
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDagAssemblerLayer", () => {
  it("returns input messages when no context items exist (empty case)", async () => {
    const convId = createConv();
    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig(),
      makeAssemblerDeps(convId),
    );

    const inputMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ] as any[];

    const result = await assembler.apply(inputMessages, defaultBudget);
    expect(result).toBe(inputMessages); // exact same reference (pass-through)
  });

  it("resolves message context items into AgentMessage array", async () => {
    const convId = createConv();

    // Insert 5 messages
    const msgIds: number[] = [];
    const roles = ["user", "assistant", "user", "assistant", "user"];
    for (let i = 0; i < 5; i++) {
      const content = `Message ${i + 1} content`;
      const mid = insertTestMessage(store, convId, i + 1, roles[i]!, content);
      msgIds.push(mid);
    }

    // Set all as context items
    store.replaceContextItems(convId, msgIds.map((mid, i) => ({
      ordinal: i,
      itemType: "message" as const,
      messageId: mid,
    })));

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: 100_000 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // First message is recall guidance + 5 messages
    expect(result.length).toBe(6);
    expect(getTextFromMessage(result[0])).toContain("context DAG");

    // Verify roles match
    expect(result[1]!.role).toBe("user");
    expect(result[2]!.role).toBe("assistant");
    expect(result[3]!.role).toBe("user");
    expect(result[4]!.role).toBe("assistant");
    expect(result[5]!.role).toBe("user");
  });

  it("applies fresh tail boundary protecting recent turns", async () => {
    const convId = createConv();

    // Insert 20 messages (10 user-assistant turns)
    const msgIds: number[] = [];
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const content = `Turn ${Math.floor(i / 2) + 1} ${role} message with padding text to consume tokens`;
      const mid = insertTestMessage(store, convId, i + 1, role, content);
      msgIds.push(mid);
    }

    store.replaceContextItems(convId, msgIds.map((mid, i) => ({
      ordinal: i,
      itemType: "message" as const,
      messageId: mid,
    })));

    // freshTailTurns=2, very tight budget that cannot hold all messages
    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 2, availableHistoryTokens: 200 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // Fresh tail (last 2 user turns) must appear
    // With 10 user turns and freshTailTurns=2, last 2 user messages + their assistant responses protected
    // Verify result contains messages from the tail
    const texts = result.map(m => getTextFromMessage(m));
    const hasTurn10 = texts.some(t => t.includes("Turn 10"));
    const hasTurn9 = texts.some(t => t.includes("Turn 9"));
    expect(hasTurn10).toBe(true);
    expect(hasTurn9).toBe(true);
  });

  it("wraps summaries in XML with depth and source metadata", async () => {
    const convId = createConv();

    const sum1 = insertTestSummary(store, convId, 0, "Summary of early conversation", 0, {
      earliestAt: "2026-03-15T01:00:00Z",
      latestAt: "2026-03-15T02:00:00Z",
      sourceTokenCount: 500,
    });
    const sum2 = insertTestSummary(store, convId, 1, "Summary of later conversation", 1, {
      earliestAt: "2026-03-15T03:00:00Z",
      latestAt: "2026-03-15T04:00:00Z",
      sourceTokenCount: 1000,
    });

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "summary", summaryId: sum1 },
      { ordinal: 1, itemType: "summary", summaryId: sum2 },
    ]);

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: 100_000 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // First is recall guidance, then summaries
    expect(result.length).toBe(3);

    // Check XML wrapping
    const sum1Text = getTextFromMessage(result[1]);
    expect(sum1Text).toContain("<context_summary");
    expect(sum1Text).toContain(`id="${sum1}"`);
    expect(sum1Text).toContain('depth="0"');
    expect(sum1Text).toContain('from="2026-03-15T01:00:00Z"');
    expect(sum1Text).toContain('to="2026-03-15T02:00:00Z"');
    expect(sum1Text).toContain("</context_summary>");

    const sum2Text = getTextFromMessage(result[2]);
    expect(sum2Text).toContain(`id="${sum2}"`);
    expect(sum2Text).toContain('depth="1"');
  });

  it("injects recall tool guidance as first message", async () => {
    const convId = createConv();

    // Insert a message and a summary
    const mid = insertTestMessage(store, convId, 1, "user", "Hello world");
    const sid = insertTestSummary(store, convId, 0, "Summary content", 0);

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "summary", summaryId: sid },
      { ordinal: 1, itemType: "message", messageId: mid },
    ]);

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: 100_000 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // First message is recall guidance
    expect(result[0]!.role).toBe("user");
    expect(getTextFromMessage(result[0])).toBe(RECALL_GUIDANCE);
  });

  it("selects within token budget using relevance scoring", async () => {
    const convId = createConv();

    // High-density summary: small token count, high source_token_count (high compression ratio)
    const sumHigh = insertTestSummary(store, convId, 0, "High density compact summary.", 0, {
      sourceTokenCount: 5000, // 5000 source tokens compressed to ~8 tokens
    });
    // Low-density summary: large token count, low source_token_count
    const sumLow = insertTestSummary(store, convId, 1,
      "Low density summary with lots and lots and lots and lots and lots and lots of verbose text that takes many tokens",
      0,
      { sourceTokenCount: 50 },
    );
    // Medium-density summary
    const sumMed = insertTestSummary(store, convId, 2, "Medium density summary with moderate content.", 0, {
      sourceTokenCount: 500,
    });

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "summary", summaryId: sumHigh },
      { ordinal: 1, itemType: "summary", summaryId: sumLow },
      { ordinal: 2, itemType: "summary", summaryId: sumMed },
    ]);

    // Budget that can hold 2 of 3 summaries but not all 3
    const highTokens = estimateTokens("High density compact summary.") + XML_WRAPPER_OVERHEAD_TOKENS;
    const medTokens = estimateTokens("Medium density summary with moderate content.") + XML_WRAPPER_OVERHEAD_TOKENS;
    // Set budget to hold exactly highTokens + medTokens
    const tightBudget = highTokens + medTokens + 5; // small margin

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: tightBudget }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // Should have recall guidance + 2 selected summaries
    expect(result.length).toBe(3);

    // Verify the low-density summary was evicted
    const allTexts = result.map(m => getTextFromMessage(m));
    const hasHighDensity = allTexts.some(t => t.includes("High density compact"));
    expect(hasHighDensity).toBe(true);

    // Low density should be evicted (lowest score)
    const hasLowDensity = allTexts.some(t => t.includes("Low density summary"));
    expect(hasLowDensity).toBe(false);
  });

  it("handles mixed summaries and messages with budget enforcement", async () => {
    const convId = createConv();

    // Insert messages
    const mid1 = insertTestMessage(store, convId, 1, "user", "First user message");
    const mid2 = insertTestMessage(store, convId, 2, "assistant", "First assistant response");

    // Insert summary
    const sid = insertTestSummary(store, convId, 0, "Summary of earlier conversation", 0, {
      sourceTokenCount: 1000,
    });

    // More messages
    const mid3 = insertTestMessage(store, convId, 3, "user", "Second user message");
    const mid4 = insertTestMessage(store, convId, 4, "assistant", "Second assistant response");

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "summary", summaryId: sid },
      { ordinal: 1, itemType: "message", messageId: mid1 },
      { ordinal: 2, itemType: "message", messageId: mid2 },
      { ordinal: 3, itemType: "message", messageId: mid3 },
      { ordinal: 4, itemType: "message", messageId: mid4 },
    ]);

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 1, availableHistoryTokens: 100_000 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // Should have recall guidance + at least some items
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Should contain both messages and XML-wrapped summaries
    const allTexts = result.map(m => getTextFromMessage(m));
    const hasSummary = allTexts.some(t => t.includes("<context_summary"));
    const hasMessage = allTexts.some(t => t.includes("user message") || t.includes("assistant response"));
    expect(hasSummary).toBe(true);
    expect(hasMessage).toBe(true);
  });

  it("accounts for XML wrapper overhead in budget (pitfall prevention)", async () => {
    const convId = createConv();

    // Create summaries where token count is close to budget
    // Each summary is ~50 tokens of content, with 40 tokens XML overhead = ~90 tokens each
    const summaries: string[] = [];
    for (let i = 0; i < 5; i++) {
      const content = `Summary ${i}: ` + "x".repeat(196); // ~50 tokens each
      const sid = insertTestSummary(store, convId, i, content, 0, {
        sourceTokenCount: 1000,
      });
      summaries.push(sid);
    }

    store.replaceContextItems(convId, summaries.map((sid, i) => ({
      ordinal: i,
      itemType: "summary" as const,
      summaryId: sid,
    })));

    // Budget that fits 2 summaries with XML overhead but not 3
    // Each summary: ~50 tokens content + 40 XML overhead = 90 tokens
    // Budget for 2: 180 tokens
    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: 185 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // recall guidance + at most 2 summaries
    // (5 summaries at 90 each = 450 tokens, budget = 185 -> 2 fit)
    expect(result.length).toBeLessThanOrEqual(3); // recall + 2 summaries
    expect(result.length).toBeGreaterThanOrEqual(2); // recall + at least 1
  });

  it("preserves conversation order after relevance selection", async () => {
    const convId = createConv();

    // Insert messages with varying content sizes (varying scores)
    const msgIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const content = `Message ${i + 1} in sequence`;
      const mid = insertTestMessage(store, convId, i + 1, role, content);
      msgIds.push(mid);
    }

    store.replaceContextItems(convId, msgIds.map((mid, i) => ({
      ordinal: i,
      itemType: "message" as const,
      messageId: mid,
    })));

    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig({ freshTailTurns: 0, availableHistoryTokens: 100_000 }),
      makeAssemblerDeps(convId),
    );

    const result = await assembler.apply([], defaultBudget);

    // Skip recall guidance (index 0), check remaining are in ordinal order
    const messageTexts = result.slice(1).map(m => getTextFromMessage(m));
    for (let i = 1; i < messageTexts.length; i++) {
      // Extract message number from text
      const prevMatch = messageTexts[i - 1]!.match(/Message (\d+)/);
      const currMatch = messageTexts[i]!.match(/Message (\d+)/);
      if (prevMatch && currMatch) {
        expect(Number(currMatch[1])).toBeGreaterThan(Number(prevMatch[1]));
      }
    }
  });

  it("has name 'dag-assembler'", () => {
    const convId = createConv();
    const assembler = createDagAssemblerLayer(
      makeAssemblerConfig(),
      makeAssemblerDeps(convId),
    );
    expect(assembler.name).toBe("dag-assembler");
  });
});
