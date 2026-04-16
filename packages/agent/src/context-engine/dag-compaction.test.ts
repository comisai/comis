/**
 * Tests for DAG compaction algorithms: leaf pass, condensed pass, three-tier
 * escalation, fresh tail boundary, sentence truncation, and depth prompts.
 *
 * Uses :memory: SQLite databases with createContextStore() for real store
 * operations. Follows the same pattern as llm-compaction.test.ts.
 *
 * DAG Compaction Engine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import { createHash } from "node:crypto";
import {
  resolveFreshTailBoundary,
  truncateAtSentenceBoundary,
  getDepthPrompt,
  summarizeWithEscalation,
  runLeafPass,
  runCondensedPass,
} from "./dag-compaction.js";
import type { CompactionDeps } from "./types.js";

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

const mockDeps: CompactionDeps = {
  store: undefined as unknown as ContextStore,
  logger: mockLogger,
  generateSummary: mockGenerateSummary as unknown as CompactionDeps["generateSummary"],
  getModel: mockGetModel,
  estimateTokens: mockEstimateTokens,
};

beforeEach(() => {
  db = new Database(":memory:");
  store = createContextStore(db);
  mockDeps.store = store;
  vi.clearAllMocks();
  mockGenerateSummary.mockResolvedValue("Mock summary of conversation content.");
  mockGetModel.mockReturnValue({
    model: { id: "haiku", provider: "anthropic" },
    getApiKey: async () => "test-key",
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Insert test messages into the store for a conversation.
 * Returns the conversation ID.
 */
function insertTestMessages(
  st: ContextStore,
  convId: string,
  count: number,
  startSeq = 1,
): void {
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `${role === "user" ? "Question" : "Answer"} number ${seq}. This is a test message with enough content to be meaningful for summarization purposes.`;
    st.insertMessage({
      conversationId: convId,
      seq,
      role,
      content,
      contentHash: contentHash(content + seq),
      tokenCount: 100,
    });
  }
}

/**
 * Create a conversation and return its ID.
 */
function createConv(): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "agent-1",
    sessionKey: "session-1",
  });
}

// ---------------------------------------------------------------------------
// 1. resolveFreshTailBoundary
// ---------------------------------------------------------------------------

describe("resolveFreshTailBoundary", () => {
  it("returns 0 when fewer turns than threshold", () => {
    const messages = [
      { seq: 1, role: "user" },
      { seq: 2, role: "assistant" },
      { seq: 3, role: "user" },
      { seq: 4, role: "assistant" },
      { seq: 5, role: "user" },
    ];
    // 3 user turns, threshold is 10 -> protect everything
    const boundary = resolveFreshTailBoundary(messages, 10);
    expect(boundary).toBe(0);
  });

  it("counts user messages as turn boundaries", () => {
    // 20 messages: 10 user turns, 10 assistant turns
    const messages: Array<{ seq: number; role: string }> = [];
    for (let i = 1; i <= 20; i++) {
      messages.push({ seq: i, role: i % 2 === 1 ? "user" : "assistant" });
    }
    // freshTailTurns=3 -> protect last 3 user turns (seq 15, 17, 19 and their responses)
    const boundary = resolveFreshTailBoundary(messages, 3);
    // Third user from end is at seq 15
    expect(boundary).toBe(15);
  });

  it("handles tool-heavy turns correctly", () => {
    // Simulate turns with multiple assistant+tool_result between user messages
    const messages = [
      { seq: 1, role: "user" },
      { seq: 2, role: "assistant" },
      { seq: 3, role: "tool_result" },
      { seq: 4, role: "assistant" },
      { seq: 5, role: "tool_result" },
      { seq: 6, role: "assistant" },
      { seq: 7, role: "user" },
      { seq: 8, role: "assistant" },
      { seq: 9, role: "tool_result" },
      { seq: 10, role: "assistant" },
      { seq: 11, role: "user" },
      { seq: 12, role: "assistant" },
    ];
    // 3 user turns, freshTailTurns=2 -> protects last 2 user turns
    const boundary = resolveFreshTailBoundary(messages, 2);
    // Second user from end is at seq 7
    expect(boundary).toBe(7);
  });

  it("returns Infinity when protectedTurns=0", () => {
    const messages = [
      { seq: 1, role: "user" },
      { seq: 2, role: "assistant" },
    ];
    const boundary = resolveFreshTailBoundary(messages, 0);
    expect(boundary).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// 2. truncateAtSentenceBoundary
// ---------------------------------------------------------------------------

describe("truncateAtSentenceBoundary", () => {
  it("returns text unchanged when within limit", () => {
    const text = "Short text.";
    const result = truncateAtSentenceBoundary(text, 1000);
    expect(result).toBe(text);
  });

  it("truncates at last sentence boundary before maxChars", () => {
    const text = "First sentence. Second sentence. Third sentence that goes on.";
    // maxChars=35 -> should truncate after "Second sentence. "
    const result = truncateAtSentenceBoundary(text, 35);
    expect(result).toContain("First sentence. Second sentence.");
    expect(result).toContain("[Truncated from ~");
    expect(result).not.toContain("Third sentence");
  });

  it("hard-cuts when no sentence boundary found", () => {
    const text = "Averylongtextwithoutanysentenceboundariesatallnoperiodsexclamationsorquestions";
    const result = truncateAtSentenceBoundary(text, 30);
    // Should hard-cut at 30 chars and append truncation notice
    expect(result).toContain("[Truncated from ~");
    expect(result.indexOf("[Truncated")).toBeGreaterThan(0);
  });

  it("appends truncation notice with token estimate", () => {
    const text = "First sentence. " + "x".repeat(500);
    const result = truncateAtSentenceBoundary(text, 20);
    // Token estimate: Math.ceil(text.length / 3.5) -- CHARS_PER_TOKEN_RATIO = 3.5
    const expectedTokens = Math.ceil(text.length / 3.5);
    expect(result).toContain(`[Truncated from ~${expectedTokens} tokens]`);
  });

  it("handles edge case of single sentence", () => {
    const text = "A single sentence that is very very long and exceeds the limit by a lot of characters.";
    const result = truncateAtSentenceBoundary(text, 30);
    // No sentence boundary within 30 chars -> hard-cut
    expect(result).toContain("[Truncated from ~");
  });
});

// ---------------------------------------------------------------------------
// 3. getDepthPrompt
// ---------------------------------------------------------------------------

describe("getDepthPrompt", () => {
  it("returns d0 prompts for depth 0", () => {
    const prompt = getDepthPrompt(0, "normal");
    expect(prompt).toContain("operational");
  });

  it("returns d1 prompts for depth 1", () => {
    const prompt = getDepthPrompt(1, "normal");
    expect(prompt.toLowerCase()).toContain("session");
  });

  it("returns d2 prompts for depth 2", () => {
    const prompt = getDepthPrompt(2, "normal");
    expect(prompt.toLowerCase()).toContain("phase");
  });

  it("returns d3+ prompts for depth >= 3", () => {
    const prompt = getDepthPrompt(3, "normal");
    expect(prompt.toLowerCase()).toContain("project");
  });

  it("caps at depth 3 for very high depths", () => {
    const promptD3 = getDepthPrompt(3, "normal");
    const promptD10 = getDepthPrompt(10, "normal");
    expect(promptD10).toBe(promptD3);
  });
});

// ---------------------------------------------------------------------------
// 4. summarizeWithEscalation
// ---------------------------------------------------------------------------

describe("summarizeWithEscalation", () => {
  it("uses Tier 1 (normal) when summary fits target", async () => {
    mockGenerateSummary.mockResolvedValueOnce("Short summary.");
    const result = await summarizeWithEscalation(
      "Some content to summarize.",
      0,
      { targetTokens: 100 },
      mockDeps,
    );
    expect(result.tier).toBe("normal");
    expect(result.content).toBe("Short summary.");
  });

  it("escalates to Tier 2 (aggressive) when Tier 1 exceeds tolerance", async () => {
    // Tier 1: long result -> token count exceeds 100 * 1.5 = 150
    mockGenerateSummary
      .mockResolvedValueOnce("x".repeat(1000)) // ~250 tokens -> exceeds 150
      .mockResolvedValueOnce("Short aggressive."); // Tier 2: short
    const result = await summarizeWithEscalation(
      "Source content.",
      0,
      { targetTokens: 100 },
      mockDeps,
    );
    expect(result.tier).toBe("aggressive");
    expect(result.content).toBe("Short aggressive.");
    expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
  });

  it("falls to Tier 3 (truncation) when both LLM calls fail", async () => {
    mockGenerateSummary
      .mockRejectedValueOnce(new Error("LLM error 1"))
      .mockRejectedValueOnce(new Error("LLM error 2"));
    const result = await summarizeWithEscalation(
      "Some text to truncate. Another sentence here. And one more.",
      0,
      { targetTokens: 50 },
      mockDeps,
    );
    expect(result.tier).toBe("truncation");
  });

  it("uses sentence-boundary truncation for Tier 3", async () => {
    const sourceContent = "First sentence here. Second sentence here. Third sentence here. Fourth sentence is the longest sentence ever written in a test.";
    mockGenerateSummary
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"));
    const result = await summarizeWithEscalation(
      sourceContent,
      0,
      { targetTokens: 10 }, // Very small target -> truncation will be short
      mockDeps,
    );
    expect(result.tier).toBe("truncation");
    expect(result.content).toContain("[Truncated from ~");
  });
});

// ---------------------------------------------------------------------------
// 5. runLeafPass
// ---------------------------------------------------------------------------

describe("runLeafPass", () => {
  it("groups messages into depth-0 summaries with min fanout 8", async () => {
    const convId = createConv();
    insertTestMessages(store, convId, 16);

    const result = await runLeafPass(convId, {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 0, // protect nothing -> all eligible
    }, mockDeps);

    expect(result.created).toBeGreaterThanOrEqual(1);
    expect(result.summaryIds.length).toBe(result.created);

    // Verify summaries exist in the store
    const summaries = store.getSummariesByConversation(convId, { depth: 0 });
    expect(summaries.length).toBe(result.created);
  });

  it("skips when fewer eligible messages than leafMinFanout", async () => {
    const convId = createConv();
    insertTestMessages(store, convId, 5);

    const result = await runLeafPass(convId, {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 0,
    }, mockDeps);

    expect(result.created).toBe(0);
    expect(result.reason).toBe("insufficient-messages");
  });

  it("respects fresh tail boundary", async () => {
    const convId = createConv();
    insertTestMessages(store, convId, 20);

    // freshTailTurns=4 -> last 4 user messages protected
    const result = await runLeafPass(convId, {
      leafMinFanout: 4,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 4,
    }, mockDeps);

    // Some messages should have been summarized, but not the protected tail
    if (result.created > 0) {
      // Verify the summarized messages are earlier ones, not the tail
      for (const sid of result.summaryIds) {
        const msgIds = store.getSourceMessageIds(sid);
        const msgs = store.getMessagesByIds(msgIds);
        for (const msg of msgs) {
          // The tail boundary protects recent messages
          // Since we have 10 user turns and protect 4, messages in the tail should be excluded
          expect(msg.seq).toBeLessThan(20); // At minimum, last messages are protected
        }
      }
    }
  });

  it("does not re-summarize already-summarized messages", async () => {
    const convId = createConv();
    insertTestMessages(store, convId, 16);

    const result1 = await runLeafPass(convId, {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 0,
    }, mockDeps);

    expect(result1.created).toBeGreaterThan(0);

    // Second run: same messages should be skipped
    const result2 = await runLeafPass(convId, {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 0,
    }, mockDeps);

    expect(result2.created).toBe(0);
  });

  it("writes summaries and links to store", async () => {
    const convId = createConv();
    insertTestMessages(store, convId, 16);

    const result = await runLeafPass(convId, {
      leafMinFanout: 8,
      leafChunkTokens: 2000,
      leafTargetTokens: 200,
      freshTailTurns: 0,
    }, mockDeps);

    expect(result.created).toBeGreaterThan(0);

    // Verify summaries in store
    const summaries = store.getSummariesByConversation(convId, { depth: 0 });
    expect(summaries.length).toBe(result.created);

    // Verify message links
    for (const sid of result.summaryIds) {
      const msgIds = store.getSourceMessageIds(sid);
      expect(msgIds.length).toBeGreaterThanOrEqual(8); // At least leafMinFanout
    }
  });
});

// ---------------------------------------------------------------------------
// 6. runCondensedPass
// ---------------------------------------------------------------------------

describe("runCondensedPass", () => {
  it("groups same-depth summaries into depth+1", async () => {
    const convId = createConv();

    // Manually insert 5 depth-0 summaries
    for (let i = 0; i < 5; i++) {
      store.insertSummary({
        summaryId: `sum_test_${i}`,
        conversationId: convId,
        kind: "leaf",
        depth: 0,
        content: `Summary ${i} content with enough text for testing.`,
        tokenCount: 50,
        earliestAt: new Date(Date.now() - (5 - i) * 60000).toISOString(),
        latestAt: new Date(Date.now() - (4 - i) * 60000).toISOString(),
      });
    }

    const result = await runCondensedPass(convId, 1, {
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
    }, mockDeps);

    expect(result.created).toBe(1);
    expect(result.summaryIds.length).toBe(1);

    // Verify the new summary is at depth 1
    const depth1Sums = store.getSummariesByConversation(convId, { depth: 1 });
    expect(depth1Sums.length).toBe(1);
  });

  it("skips when fewer eligible summaries than condensedMinFanout", async () => {
    const convId = createConv();

    // Only 2 depth-0 summaries, need 4
    for (let i = 0; i < 2; i++) {
      store.insertSummary({
        summaryId: `sum_few_${i}`,
        conversationId: convId,
        kind: "leaf",
        depth: 0,
        content: `Summary ${i}.`,
        tokenCount: 50,
      });
    }

    const result = await runCondensedPass(convId, 1, {
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
    }, mockDeps);

    expect(result.created).toBe(0);
    expect(result.reason).toBe("insufficient-summaries");
  });

  it("does not re-condense already-condensed summaries", async () => {
    const convId = createConv();

    // Insert 5 depth-0 summaries
    for (let i = 0; i < 5; i++) {
      store.insertSummary({
        summaryId: `sum_rc_${i}`,
        conversationId: convId,
        kind: "leaf",
        depth: 0,
        content: `Summary ${i} for re-condensation test.`,
        tokenCount: 50,
        earliestAt: new Date(Date.now() - (5 - i) * 60000).toISOString(),
        latestAt: new Date(Date.now() - (4 - i) * 60000).toISOString(),
      });
    }

    // First condensed pass
    const result1 = await runCondensedPass(convId, 1, {
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
    }, mockDeps);
    expect(result1.created).toBe(1);

    // Second condensed pass: those depth-0 summaries are now condensed
    const result2 = await runCondensedPass(convId, 1, {
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
    }, mockDeps);
    expect(result2.created).toBe(0);
  });

  it("links parents correctly", async () => {
    const convId = createConv();

    // Insert 4 depth-0 summaries
    const parentIds = [];
    for (let i = 0; i < 4; i++) {
      const sid = `sum_parent_${i}`;
      store.insertSummary({
        summaryId: sid,
        conversationId: convId,
        kind: "leaf",
        depth: 0,
        content: `Parent summary ${i}.`,
        tokenCount: 50,
        earliestAt: new Date(Date.now() - (4 - i) * 60000).toISOString(),
        latestAt: new Date(Date.now() - (3 - i) * 60000).toISOString(),
      });
      parentIds.push(sid);
    }

    const result = await runCondensedPass(convId, 1, {
      condensedMinFanout: 4,
      condensedTargetTokens: 200,
    }, mockDeps);

    expect(result.created).toBe(1);

    // Verify parent links: the new summary should link to all 4 depth-0 summaries
    const childSummaryId = result.summaryIds[0];
    const linkedParentIds = store.getParentSummaryIds(childSummaryId);
    expect(linkedParentIds).toEqual(parentIds);
  });
});
