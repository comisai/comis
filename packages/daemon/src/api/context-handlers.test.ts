// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore, type ContextStore } from "@comis/memory";
import { createContextHandlers, type ContextHandlerDeps } from "./context-handlers.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let store: ContextStore;
let convId: string;

function makeDeps(overrides?: Partial<ContextHandlerDeps>): ContextHandlerDeps {
  return {
    store,
    tenantId: "t1",
    resolveConversationId: (sessionKey: string) =>
      sessionKey === "valid-session" ? convId : undefined,
    rpcCall: vi.fn(),
    config: {
      maxRecallsPerDay: 10,
      maxExpandTokens: 8000,
      recallTimeoutMs: 120_000,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  store = createContextStore(db);
  convId = store.createConversation({
    tenantId: "t1",
    agentId: "a1",
    sessionKey: "valid-session",
  });
});

// =========================================================================
// context.search
// =========================================================================

describe("context.search handler", () => {
  it("FTS mode returns matching messages with truncated content", async () => {
    // Insert messages with FTS-indexable content
    store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "We decided to use JWT authentication for the API gateway",
      contentHash: "h1",
      tokenCount: 10,
    });
    store.insertMessage({
      conversationId: convId,
      seq: 2,
      role: "assistant",
      content: "Great choice. JWT tokens provide stateless authentication",
      contentHash: "h2",
      tokenCount: 8,
    });
    store.insertMessage({
      conversationId: convId,
      seq: 3,
      role: "user",
      content: "What about database migrations?",
      contentHash: "h3",
      tokenCount: 5,
    });

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.search"]!({
      _callerSessionKey: "valid-session",
      query: "authentication",
    }) as { results: Array<{ type: string; content: string }>; total: number };

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.type).toBe("message");
      expect(r.content.length).toBeLessThanOrEqual(500);
    }
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("scope 'summaries' returns only summaries", async () => {
    store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "discussion about deployment",
      contentHash: "hm1",
      tokenCount: 4,
    });
    store.insertSummary({
      summaryId: "sum_search01",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Summary of deployment strategy discussion",
      tokenCount: 6,
    });

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.search"]!({
      _callerSessionKey: "valid-session",
      query: "deployment",
      scope: "summaries",
    }) as { results: Array<{ type: string; id: string }>; total: number };

    for (const r of result.results) {
      expect(r.type).toBe("summary");
    }
  });

  it("scope 'messages' returns only messages", async () => {
    store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "testing the search feature",
      contentHash: "hm2",
      tokenCount: 5,
    });
    store.insertSummary({
      summaryId: "sum_search02",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Summary about testing the search feature",
      tokenCount: 6,
    });

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.search"]!({
      _callerSessionKey: "valid-session",
      query: "search",
      scope: "messages",
    }) as { results: Array<{ type: string }>; total: number };

    for (const r of result.results) {
      expect(r.type).toBe("message");
    }
  });

  it("limit is respected", async () => {
    for (let i = 1; i <= 10; i++) {
      store.insertMessage({
        conversationId: convId,
        seq: i,
        role: "user",
        content: `matching keyword phrase number ${i}`,
        contentHash: `hlim${i}`,
        tokenCount: 5,
      });
    }

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.search"]!({
      _callerSessionKey: "valid-session",
      query: "keyword",
      limit: 3,
    }) as { results: Array<unknown>; total: number };

    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it("missing conversation returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.search"]!({
        _callerSessionKey: "unknown-session",
        query: "test",
      }),
    ).rejects.toThrow("No active DAG conversation for this session");
  });

  it("truncates content to 500 chars", async () => {
    const longContent = "x".repeat(1000) + " searchable";
    store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: longContent,
      contentHash: "hlong",
      tokenCount: 200,
    });

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.search"]!({
      _callerSessionKey: "valid-session",
      query: "searchable",
      scope: "messages",
      mode: "regex",
    }) as { results: Array<{ content: string }>; total: number };

    if (result.results.length > 0) {
      expect(result.results[0]!.content.length).toBeLessThanOrEqual(500);
    }
  });
});

// =========================================================================
// context.inspect
// =========================================================================

describe("context.inspect handler", () => {
  it("summary ID returns full content and lineage", async () => {
    // Create parent and child summaries with lineage
    store.insertSummary({
      summaryId: "sum_parent01",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Parent summary about authentication decisions",
      tokenCount: 10,
      earliestAt: "2026-03-14T10:00:00Z",
      latestAt: "2026-03-14T11:00:00Z",
    });

    const m1 = store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "source message 1",
      contentHash: "hs1",
      tokenCount: 3,
    });
    const m2 = store.insertMessage({
      conversationId: convId,
      seq: 2,
      role: "assistant",
      content: "source message 2",
      contentHash: "hs2",
      tokenCount: 3,
    });

    // Link source messages
    store.linkSummaryMessages("sum_parent01", [m1, m2]);

    // Create child summary that references parent
    store.insertSummary({
      summaryId: "sum_child01",
      conversationId: convId,
      kind: "condensed",
      depth: 1,
      content: "Condensed summary of authentication",
      tokenCount: 8,
    });
    store.linkSummaryParents("sum_child01", ["sum_parent01"]);

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.inspect"]!({
      id: "sum_parent01",
    }) as Record<string, unknown>;

    expect(result.type).toBe("summary");
    expect(result.summaryId).toBe("sum_parent01");
    expect(result.content).toBe("Parent summary about authentication decisions");
    expect(result.depth).toBe(0);
    expect(result.kind).toBe("leaf");
    expect(result.tokenCount).toBe(10);
    expect(result.earliestAt).toBe("2026-03-14T10:00:00Z");
    expect(result.latestAt).toBe("2026-03-14T11:00:00Z");
    expect(result.parentIds).toEqual([]);
    expect(result.childIds).toEqual(["sum_child01"]);
    expect(result.sourceMessageCount).toBe(2);
  });

  it("file ID returns file metadata with content from disk", async () => {
    // Create a temp file on disk
    const tempDir = join(tmpdir(), "ctx-inspect-test-" + Date.now());
    mkdirSync(tempDir, { recursive: true });
    const filePath = join(tempDir, "test-report.txt");
    writeFileSync(filePath, "This is the report file content for testing.");

    try {
      store.insertLargeFile({
        fileId: "file_test01",
        conversationId: convId,
        fileName: "test-report.txt",
        mimeType: "text/plain",
        byteSize: 45,
        storagePath: filePath,
        explorationSummary: "A test report file",
      });

      const deps = makeDeps();
      const handlers = createContextHandlers(deps);

      const result = await handlers["context.inspect"]!({
        id: "file_test01",
      }) as Record<string, unknown>;

      expect(result.type).toBe("file");
      expect(result.fileId).toBe("file_test01");
      expect(result.fileName).toBe("test-report.txt");
      expect(result.mimeType).toBe("text/plain");
      expect(result.byteSize).toBe(45);
      expect(result.explorationSummary).toBe("A test report file");
      expect(result.content).toBe("This is the report file content for testing.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("file ID with missing disk file returns fallback content", async () => {
    store.insertLargeFile({
      fileId: "file_missing01",
      conversationId: convId,
      fileName: "missing.txt",
      storagePath: "/nonexistent/path/missing.txt",
    });

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.inspect"]!({
      id: "file_missing01",
    }) as Record<string, unknown>;

    expect(result.type).toBe("file");
    expect(result.content).toBe("[File content unavailable on disk]");
  });

  it("unknown ID prefix returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.inspect"]!({ id: "unknown_prefix_123" }),
    ).rejects.toThrow("Unknown ID prefix. Expected 'sum_' or 'file_', got: unknown_pr");
  });

  it("non-existent summary ID returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.inspect"]!({ id: "sum_nonexistent" }),
    ).rejects.toThrow("Summary not found: sum_nonexistent");
  });

  it("non-existent file ID returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.inspect"]!({ id: "file_nonexistent" }),
    ).rejects.toThrow("File not found: file_nonexistent");
  });

  it("missing id parameter returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.inspect"]!({}),
    ).rejects.toThrow("Missing required parameter: id");
  });

  it("file content is capped at 100k chars", async () => {
    const tempDir = join(tmpdir(), "ctx-inspect-cap-test-" + Date.now());
    mkdirSync(tempDir, { recursive: true });
    const filePath = join(tempDir, "large-file.txt");
    writeFileSync(filePath, "A".repeat(200_000));

    try {
      store.insertLargeFile({
        fileId: "file_large01",
        conversationId: convId,
        fileName: "large-file.txt",
        mimeType: "text/plain",
        byteSize: 200_000,
        storagePath: filePath,
      });

      const deps = makeDeps();
      const handlers = createContextHandlers(deps);

      const result = await handlers["context.inspect"]!({
        id: "file_large01",
      }) as Record<string, unknown>;

      expect((result.content as string).length).toBe(100_000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// context.recall
// =========================================================================

describe("context.recall handler", () => {
  it("quota exceeded returns error", async () => {
    // Create enough grants to exceed the limit (maxRecallsPerDay=10)
    for (let i = 0; i < 10; i++) {
      store.createGrant({
        grantId: `grant_quota_${i}`,
        issuerSession: "valid-session",
        conversationIds: [convId],
        maxDepth: 3,
        tokenCap: 4000,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.recall"]!({
        _callerSessionKey: "valid-session",
        prompt: "What was discussed?",
      }),
    ).rejects.toThrow("Daily recall quota exceeded (10/day)");
  });

  it("explicit summary_ids finds candidates and spawns sub-agent", async () => {
    store.insertSummary({
      summaryId: "sum_recall01",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Discussion about API authentication using JWT",
      tokenCount: 10,
    });

    const mockRpcCall = vi.fn(async () => ({ response: "The team chose JWT." }));
    const deps = makeDeps({ rpcCall: mockRpcCall });
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.recall"]!({
      _callerSessionKey: "valid-session",
      prompt: "What authentication was chosen?",
      summary_ids: ["sum_recall01"],
    }) as { answer: string; citations: string[]; grantId: string };

    expect(result.answer).toBe("The team chose JWT.");
    expect(result.citations).toEqual(["sum_recall01"]);
    expect(result.grantId).toMatch(/^grant_/);

    // Verify spawn was called with correct params
    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", expect.objectContaining({
      tool_groups: ["context_expand"],
      async: false,
      max_steps: 10,
      domain_knowledge: expect.arrayContaining([
        expect.stringContaining("EXPANSION_GRANT:"),
        expect.stringContaining("CONVERSATION:"),
        expect.stringContaining("sum_recall01"),
      ]),
    }));
  });

  it("no candidates returns 'No relevant summaries found'", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.recall"]!({
      _callerSessionKey: "valid-session",
      prompt: "What was the deployment plan?",
      query: "nonexistent_topic_xyz",
    }) as { answer: string; citations: string[] };

    expect(result.answer).toBe("No relevant summaries found for this recall query.");
    expect(result.citations).toEqual([]);
  });

  it("revokes grant in finally block even on spawn failure", async () => {
    store.insertSummary({
      summaryId: "sum_recall_err",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Some content for error test",
      tokenCount: 5,
    });

    const mockRpcCall = vi.fn(async () => {
      throw new Error("Spawn failed");
    });
    const deps = makeDeps({ rpcCall: mockRpcCall });
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.recall"]!({
        _callerSessionKey: "valid-session",
        prompt: "test error",
        summary_ids: ["sum_recall_err"],
      }),
    ).rejects.toThrow("Spawn failed");

    // Verify all grants for this session are revoked
    const activeGrants = store.getActiveGrants("valid-session");
    expect(activeGrants.length).toBe(0);
  });

  it("missing conversation returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.recall"]!({
        _callerSessionKey: "unknown-session",
        prompt: "test",
      }),
    ).rejects.toThrow("No active DAG conversation for this session");
  });
});

// =========================================================================
// context.expand
// =========================================================================

describe("context.expand handler", () => {
  function createTestGrant(overrides?: { revoked?: boolean; expired?: boolean; tokenCap?: number; tokensConsumed?: number }) {
    const grantId = "grant_expand_" + Math.random().toString(36).slice(2, 8);
    const expiresAt = overrides?.expired
      ? new Date(Date.now() - 60_000).toISOString()
      : new Date(Date.now() + 600_000).toISOString();

    store.createGrant({
      grantId,
      issuerSession: "valid-session",
      conversationIds: [convId],
      maxDepth: 3,
      tokenCap: overrides?.tokenCap ?? 4000,
      expiresAt,
    });

    if (overrides?.revoked) {
      store.revokeGrant(grantId);
    }
    if (overrides?.tokensConsumed) {
      store.consumeGrantTokens(grantId, overrides.tokensConsumed);
    }

    return grantId;
  }

  it("valid grant returns children for condensed summary", async () => {
    // Create parent summaries and a condensed child
    store.insertSummary({
      summaryId: "sum_parent_a",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "First discussion topic about deployment",
      tokenCount: 8,
    });
    store.insertSummary({
      summaryId: "sum_parent_b",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Second discussion topic about testing",
      tokenCount: 6,
    });
    store.insertSummary({
      summaryId: "sum_condensed",
      conversationId: convId,
      kind: "condensed",
      depth: 1,
      content: "Condensed overview of deployment and testing",
      tokenCount: 10,
    });
    store.linkSummaryParents("sum_condensed", ["sum_parent_a", "sum_parent_b"]);

    const grantId = createTestGrant();
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.expand"]!({
      grant_id: grantId,
      summary_id: "sum_condensed",
    }) as { summaryId: string; kind: string; children: Array<{ type: string; id: string; content: string }> };

    expect(result.summaryId).toBe("sum_condensed");
    expect(result.kind).toBe("condensed");
    expect(result.children.length).toBe(2);
    expect(result.children[0]!.type).toBe("summary");
    expect(result.children[0]!.id).toBe("sum_parent_a");
    expect(result.children[1]!.id).toBe("sum_parent_b");
  });

  it("valid grant returns source messages for leaf summary", async () => {
    const m1 = store.insertMessage({
      conversationId: convId,
      seq: 10,
      role: "user",
      content: "What about the database schema?",
      contentHash: "h_expand_1",
      tokenCount: 6,
    });
    const m2 = store.insertMessage({
      conversationId: convId,
      seq: 11,
      role: "assistant",
      content: "I recommend using PostgreSQL with these tables.",
      contentHash: "h_expand_2",
      tokenCount: 8,
    });

    store.insertSummary({
      summaryId: "sum_leaf_expand",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Database schema discussion",
      tokenCount: 5,
    });
    store.linkSummaryMessages("sum_leaf_expand", [m1, m2]);

    const grantId = createTestGrant();
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    const result = await handlers["context.expand"]!({
      grant_id: grantId,
      summary_id: "sum_leaf_expand",
    }) as { kind: string; children: Array<{ type: string; content: string }>; tokensExpanded: number };

    expect(result.kind).toBe("leaf");
    expect(result.children.length).toBe(2);
    expect(result.children[0]!.type).toBe("message");
    expect(result.children[0]!.content).toContain("database schema");
    expect(result.tokensExpanded).toBe(14); // 6 + 8
  });

  it("expired grant returns error", async () => {
    store.insertSummary({
      summaryId: "sum_expired_test",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "test",
      tokenCount: 1,
    });

    const grantId = createTestGrant({ expired: true });
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({
        grant_id: grantId,
        summary_id: "sum_expired_test",
      }),
    ).rejects.toThrow("Grant has expired");
  });

  it("revoked grant returns error", async () => {
    const grantId = createTestGrant({ revoked: true });
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({
        grant_id: grantId,
        summary_id: "sum_any",
      }),
    ).rejects.toThrow("Grant has been revoked");
  });

  it("token cap exceeded returns error", async () => {
    store.insertSummary({
      summaryId: "sum_cap_test",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "test",
      tokenCount: 1,
    });

    const grantId = createTestGrant({ tokenCap: 100, tokensConsumed: 100 });
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({
        grant_id: grantId,
        summary_id: "sum_cap_test",
      }),
    ).rejects.toThrow("Token cap reached (100/100)");
  });

  it("unknown summary returns error", async () => {
    const grantId = createTestGrant();
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({
        grant_id: grantId,
        summary_id: "sum_nonexistent_xyz",
      }),
    ).rejects.toThrow("Summary not found: sum_nonexistent_xyz");
  });

  it("unknown grant returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({
        grant_id: "grant_nonexistent",
        summary_id: "sum_any",
      }),
    ).rejects.toThrow("Grant not found");
  });

  it("missing grant_id parameter returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({ summary_id: "sum_any" }),
    ).rejects.toThrow("Missing required parameter: grant_id");
  });

  it("missing summary_id parameter returns error", async () => {
    const deps = makeDeps();
    const handlers = createContextHandlers(deps);

    await expect(
      handlers["context.expand"]!({ grant_id: "grant_any" }),
    ).rejects.toThrow("Missing required parameter: summary_id");
  });
});

// =========================================================================
// countGrantsToday
// =========================================================================

describe("countGrantsToday", () => {
  it("returns count of grants created today", () => {
    // Create some grants for today
    store.createGrant({
      grantId: "grant_today_1",
      issuerSession: "valid-session",
      conversationIds: [convId],
      maxDepth: 3,
      tokenCap: 4000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    store.createGrant({
      grantId: "grant_today_2",
      issuerSession: "valid-session",
      conversationIds: [convId],
      maxDepth: 3,
      tokenCap: 4000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Revoke one -- should still count
    store.revokeGrant("grant_today_1");

    const count = store.countGrantsToday("valid-session");
    expect(count).toBe(2); // Both count (including revoked)
  });

  it("returns 0 for session with no grants", () => {
    const count = store.countGrantsToday("no-grants-session");
    expect(count).toBe(0);
  });
});
