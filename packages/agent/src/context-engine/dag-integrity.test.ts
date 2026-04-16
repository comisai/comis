/**
 * Tests for DAG integrity checker: orphan detection, stale counts, contiguity
 * gaps, dangling refs, FTS desync, cycle detection, auto-repair, and event
 * emission.
 *
 * Uses :memory: SQLite databases with createContextStore() for real store
 * operations. Follows the same pattern as dag-compaction.test.ts.
 *
 * DAG Integrity & Wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import { createHash } from "node:crypto";
import { checkIntegrity } from "./dag-integrity.js";
import type { IntegrityCheckDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let store: ContextStore;

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as IntegrityCheckDeps["logger"];

beforeEach(() => {
  db = new Database(":memory:");
  store = createContextStore(db);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function createTestConversation(): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "agent-1",
    sessionKey: "session-1",
  });
}

function insertTestMessage(
  conversationId: string,
  seq: number,
  role: string,
  content: string,
): number {
  return store.insertMessage({
    conversationId,
    seq,
    role,
    content,
    contentHash: contentHash(content + seq),
    tokenCount: 50,
  });
}

function insertTestSummary(
  conversationId: string,
  summaryId: string,
  kind: "leaf" | "condensed",
  depth: number,
  content: string,
  tokenCount: number,
): void {
  store.insertSummary({
    summaryId,
    conversationId,
    kind,
    depth,
    content,
    tokenCount,
  });
}

function makeDeps(overrides?: Partial<IntegrityCheckDeps>): IntegrityCheckDeps {
  return {
    store,
    db,
    logger: mockLogger,
    agentId: "agent-1",
    sessionKey: "session-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orphan summary detection
// ---------------------------------------------------------------------------

describe("checkOrphanSummaries", () => {
  it("detects orphan leaf summary with no source messages", () => {
    const convId = createTestConversation();
    insertTestSummary(convId, "sum-orphan-leaf", "leaf", 0, "Summary content", 20);

    const report = checkIntegrity(makeDeps(), convId);

    const orphanIssues = report.issues.filter((i) => i.type === "orphan_summary");
    expect(orphanIssues.length).toBe(1);
    expect(orphanIssues[0].entity).toBe("sum-orphan-leaf");
    expect(orphanIssues[0].severity).toBe("auto_repaired");
  });

  it("detects orphan condensed summary with no parent summaries", () => {
    const convId = createTestConversation();
    insertTestSummary(convId, "sum-orphan-condensed", "condensed", 1, "Condensed content", 30);

    const report = checkIntegrity(makeDeps(), convId);

    const orphanIssues = report.issues.filter((i) => i.type === "orphan_summary");
    expect(orphanIssues.length).toBe(1);
    expect(orphanIssues[0].entity).toBe("sum-orphan-condensed");
  });

  it("no issues for properly linked summaries", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello world");
    insertTestSummary(convId, "sum-good", "leaf", 0, "Good summary", 20);
    store.linkSummaryMessages("sum-good", [msgId]);

    const report = checkIntegrity(makeDeps(), convId);

    const orphanIssues = report.issues.filter((i) => i.type === "orphan_summary");
    expect(orphanIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stale counts detection
// ---------------------------------------------------------------------------

describe("checkStaleCounts", () => {
  it("detects summaries with counts_dirty flag", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");
    insertTestSummary(convId, "sum-dirty", "leaf", 0, "Summary", 20);
    store.linkSummaryMessages("sum-dirty", [msgId]);

    // Set counts_dirty = 1 via raw SQL
    db.prepare("UPDATE ctx_summaries SET counts_dirty = 1 WHERE summary_id = ?").run("sum-dirty");

    const report = checkIntegrity(makeDeps(), convId);

    const staleIssues = report.issues.filter((i) => i.type === "stale_counts");
    expect(staleIssues.length).toBe(1);
    expect(staleIssues[0].entity).toBe("sum-dirty");
  });

  it("no issues when all summaries are clean", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");
    insertTestSummary(convId, "sum-clean", "leaf", 0, "Summary", 20);
    store.linkSummaryMessages("sum-clean", [msgId]);

    const report = checkIntegrity(makeDeps(), convId);

    const staleIssues = report.issues.filter((i) => i.type === "stale_counts");
    expect(staleIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Contiguity gaps
// ---------------------------------------------------------------------------

describe("checkContiguityGaps", () => {
  it("detects gap in context item ordinals", () => {
    const convId = createTestConversation();
    const msgId1 = insertTestMessage(convId, 1, "user", "Msg 1");
    const msgId2 = insertTestMessage(convId, 2, "assistant", "Msg 2");
    const msgId3 = insertTestMessage(convId, 3, "user", "Msg 3");

    // Insert items with a gap: 0, 1, 3 (missing 2)
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId1 },
      { ordinal: 1, itemType: "message", messageId: msgId2 },
      { ordinal: 3, itemType: "message", messageId: msgId3 },
    ]);

    const report = checkIntegrity(makeDeps(), convId);

    const gapIssues = report.issues.filter((i) => i.type === "contiguity_gap");
    expect(gapIssues.length).toBe(1);
  });

  it("no issues for contiguous ordinals", () => {
    const convId = createTestConversation();
    const msgId1 = insertTestMessage(convId, 1, "user", "Msg 1");
    const msgId2 = insertTestMessage(convId, 2, "assistant", "Msg 2");

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId1 },
      { ordinal: 1, itemType: "message", messageId: msgId2 },
    ]);

    const report = checkIntegrity(makeDeps(), convId);

    const gapIssues = report.issues.filter((i) => i.type === "contiguity_gap");
    expect(gapIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dangling refs
// ---------------------------------------------------------------------------

describe("checkDanglingRefs", () => {
  it("detects context item referencing deleted message", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Real message");

    // Temporarily disable FK enforcement to simulate post-crash dangling state
    db.pragma("foreign_keys = OFF");
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId },
      { ordinal: 1, itemType: "message", messageId: 99999 },
    ]);
    db.pragma("foreign_keys = ON");

    const report = checkIntegrity(makeDeps(), convId);

    const danglingIssues = report.issues.filter((i) => i.type === "dangling_ref");
    expect(danglingIssues.length).toBe(1);
    expect(danglingIssues[0].entity).toBe("99999");
  });

  it("detects context item referencing deleted summary", () => {
    const convId = createTestConversation();

    // Temporarily disable FK enforcement to simulate post-crash dangling state
    db.pragma("foreign_keys = OFF");
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "summary", summaryId: "sum-nonexistent" },
    ]);
    db.pragma("foreign_keys = ON");

    const report = checkIntegrity(makeDeps(), convId);

    const danglingIssues = report.issues.filter((i) => i.type === "dangling_ref");
    expect(danglingIssues.length).toBe(1);
    expect(danglingIssues[0].entity).toBe("sum-nonexistent");
  });

  it("no issues when all refs are valid", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Valid message");
    insertTestSummary(convId, "sum-valid", "leaf", 0, "Valid summary", 20);
    store.linkSummaryMessages("sum-valid", [msgId]);

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId },
      { ordinal: 1, itemType: "summary", summaryId: "sum-valid" },
    ]);

    const report = checkIntegrity(makeDeps(), convId);

    const danglingIssues = report.issues.filter((i) => i.type === "dangling_ref");
    expect(danglingIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FTS desync
// ---------------------------------------------------------------------------

describe("checkFtsDesync", () => {
  it("detects FTS desync for messages", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Test message for FTS");

    // Manually delete FTS entry to create desync
    db.prepare("DELETE FROM ctx_messages_fts WHERE rowid = ?").run(msgId);

    const report = checkIntegrity(makeDeps(), convId);

    const ftsIssues = report.issues.filter((i) => i.type === "fts_desync");
    expect(ftsIssues.some((i) => i.detail.includes("Messages FTS"))).toBe(true);
  });

  it("detects FTS desync for summaries", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");
    insertTestSummary(convId, "sum-fts", "leaf", 0, "Summary for FTS test", 20);
    store.linkSummaryMessages("sum-fts", [msgId]);

    // Manually delete FTS entry
    db.prepare("DELETE FROM ctx_summaries_fts WHERE summary_id = ?").run("sum-fts");

    const report = checkIntegrity(makeDeps(), convId);

    const ftsIssues = report.issues.filter((i) => i.type === "fts_desync");
    expect(ftsIssues.some((i) => i.detail.includes("Summaries FTS"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("checkCycles", () => {
  it("detects cycle in summary parent links", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");

    // Create summaries A, B, C with a cycle: A -> B -> C -> A (via parent links)
    insertTestSummary(convId, "sum-A", "leaf", 0, "Summary A", 20);
    insertTestSummary(convId, "sum-B", "condensed", 1, "Summary B", 20);
    insertTestSummary(convId, "sum-C", "condensed", 2, "Summary C", 20);

    // Link sum-A to a message so it's not flagged as orphan
    store.linkSummaryMessages("sum-A", [msgId]);

    // Create cycle: sum-B has parent sum-A, sum-C has parent sum-B, sum-A has parent sum-C
    store.linkSummaryParents("sum-B", ["sum-A"]);
    store.linkSummaryParents("sum-C", ["sum-B"]);
    store.linkSummaryParents("sum-A", ["sum-C"]);

    const report = checkIntegrity(makeDeps(), convId);

    const cycleIssues = report.issues.filter((i) => i.type === "cycle");
    expect(cycleIssues.length).toBeGreaterThanOrEqual(1);
    expect(cycleIssues[0].severity).toBe("error");
  });

  it("logs ERROR for cycle (not auto-repaired)", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");

    insertTestSummary(convId, "sum-X", "leaf", 0, "Summary X", 20);
    insertTestSummary(convId, "sum-Y", "condensed", 1, "Summary Y", 20);

    store.linkSummaryMessages("sum-X", [msgId]);
    store.linkSummaryParents("sum-Y", ["sum-X"]);
    store.linkSummaryParents("sum-X", ["sum-Y"]); // cycle: X -> Y -> X

    checkIntegrity(makeDeps(), convId);

    expect(mockLogger.error).toHaveBeenCalled();
    const errorCall = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(errorCall[0]).toHaveProperty("hint", "DAG integrity issue requires manual intervention");
    expect(errorCall[0]).toHaveProperty("errorKind", "data");
  });
});

// ---------------------------------------------------------------------------
// Auto-repair verification
// ---------------------------------------------------------------------------

describe("auto-repair", () => {
  it("repairs orphan summaries by deletion", () => {
    const convId = createTestConversation();
    insertTestSummary(convId, "sum-to-delete", "leaf", 0, "Orphan", 20);

    checkIntegrity(makeDeps(), convId);

    // Verify the orphan summary was deleted
    const summary = store.getSummary("sum-to-delete");
    expect(summary).toBeUndefined();
  });

  it("repairs contiguity gaps by re-sequencing", () => {
    const convId = createTestConversation();
    const msgId1 = insertTestMessage(convId, 1, "user", "Msg 1");
    const msgId2 = insertTestMessage(convId, 2, "assistant", "Msg 2");
    const msgId3 = insertTestMessage(convId, 3, "user", "Msg 3");

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId1 },
      { ordinal: 1, itemType: "message", messageId: msgId2 },
      { ordinal: 5, itemType: "message", messageId: msgId3 },
    ]);

    checkIntegrity(makeDeps(), convId);

    const items = store.getContextItems(convId);
    expect(items.length).toBe(3);
    expect(items[0].ordinal).toBe(0);
    expect(items[1].ordinal).toBe(1);
    expect(items[2].ordinal).toBe(2);
  });

  it("repairs dangling refs by removing context items", () => {
    const convId = createTestConversation();
    const validMsgId = insertTestMessage(convId, 1, "user", "Valid msg");

    // Temporarily disable FK enforcement to simulate post-crash dangling state
    db.pragma("foreign_keys = OFF");
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: validMsgId },
      { ordinal: 1, itemType: "message", messageId: 88888 },
    ]);
    db.pragma("foreign_keys = ON");

    checkIntegrity(makeDeps(), convId);

    const items = store.getContextItems(convId);
    expect(items.length).toBe(1);
    expect(items[0].message_id).toBe(validMsgId);
    expect(items[0].ordinal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe("event emission", () => {
  it("emits context:integrity event with report data", () => {
    const convId = createTestConversation();
    insertTestSummary(convId, "sum-orphan-ev", "leaf", 0, "Orphan for event test", 20);

    const mockEmit = vi.fn();
    const deps = makeDeps({
      eventBus: { emit: mockEmit },
    });

    checkIntegrity(deps, convId);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      "context:integrity",
      expect.objectContaining({
        conversationId: convId,
        agentId: "agent-1",
        sessionKey: "session-1",
        issueCount: expect.any(Number),
        repairsApplied: expect.any(Number),
        errorsLogged: 0,
        issueTypes: expect.arrayContaining(["orphan_summary"]),
        durationMs: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Clean conversation (no issues)
// ---------------------------------------------------------------------------

describe("clean conversation", () => {
  it("reports zero issues for healthy conversation", () => {
    const convId = createTestConversation();
    const msgId = insertTestMessage(convId, 1, "user", "Hello");
    insertTestSummary(convId, "sum-healthy", "leaf", 0, "Healthy summary", 20);
    store.linkSummaryMessages("sum-healthy", [msgId]);

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: msgId },
      { ordinal: 1, itemType: "summary", summaryId: "sum-healthy" },
    ]);

    const report = checkIntegrity(makeDeps(), convId);

    expect(report.issues.length).toBe(0);
    expect(report.repairsApplied).toBe(0);
    expect(report.errorsLogged).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});
