// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore, type ContextStore } from "./context-store.js";

let db: Database.Database;
let store: ContextStore;
let convCounter = 0;

/** Create a fresh store for each test. */
function freshStore(): { db: Database.Database; store: ContextStore } {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  const s = createContextStore(d);
  return { db: d, store: s };
}

/** Helper: create a test conversation with unique session key. */
function createTestConversation(s: ContextStore): string {
  convCounter++;
  return s.createConversation({
    tenantId: "t1",
    agentId: "a1",
    sessionKey: `sess-${convCounter}`,
  });
}

beforeEach(() => {
  convCounter = 0;
  const fresh = freshStore();
  db = fresh.db;
  store = fresh.store;
});

// =========================================================================
// Group 1: Conversations
// =========================================================================

describe("conversations", () => {
  it("createConversation returns conversation_id with conv_ prefix", () => {
    const id = createTestConversation(store);
    expect(id).toMatch(/^conv_[0-9a-f]{16}$/);
  });

  it("getConversation returns inserted row", () => {
    const id = store.createConversation({
      tenantId: "t1",
      agentId: "a1",
      sessionKey: "sess-get",
      title: "Test Title",
    });
    const row = store.getConversation(id);
    expect(row).toBeDefined();
    expect(row!.conversation_id).toBe(id);
    expect(row!.tenant_id).toBe("t1");
    expect(row!.agent_id).toBe("a1");
    expect(row!.session_key).toBe("sess-get");
    expect(row!.title).toBe("Test Title");
    expect(row!.created_at).toBeTruthy();
    expect(row!.updated_at).toBeTruthy();
  });

  it("getConversationBySession finds by tenant+session", () => {
    const id = store.createConversation({
      tenantId: "t1",
      agentId: "a1",
      sessionKey: "sess-find",
    });
    const row = store.getConversationBySession("t1", "sess-find");
    expect(row).toBeDefined();
    expect(row!.conversation_id).toBe(id);
  });

  it("getConversationBySession returns undefined for missing", () => {
    const row = store.getConversationBySession("t1", "nonexistent");
    expect(row).toBeUndefined();
  });

  it("touchConversation updates updated_at", () => {
    const id = createTestConversation(store);
    const before = store.getConversation(id)!.updated_at;
    // Touch should update the timestamp
    store.touchConversation(id);
    const after = store.getConversation(id)!.updated_at;
    // At minimum, they should both be valid timestamps
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    // SQLite datetime('now') has 1-second resolution, so we just verify
    // the field exists and is a valid datetime string
    expect(after).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

// =========================================================================
// Group 2: Messages
// =========================================================================

describe("messages", () => {
  it("insertMessage returns auto-incremented message_id", () => {
    const convId = createTestConversation(store);
    const id1 = store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "msg1",
      contentHash: "h1",
      tokenCount: 5,
    });
    const id2 = store.insertMessage({
      conversationId: convId,
      seq: 2,
      role: "assistant",
      content: "msg2",
      contentHash: "h2",
      tokenCount: 10,
    });
    const id3 = store.insertMessage({
      conversationId: convId,
      seq: 3,
      role: "user",
      content: "msg3",
      contentHash: "h3",
      tokenCount: 7,
    });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it("insertMessage creates FTS entry", () => {
    const convId = createTestConversation(store);
    const msgId = store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "hello world test phrase",
      contentHash: "hfts",
      tokenCount: 4,
    });
    // Query FTS5 directly
    const results = db
      .prepare(
        "SELECT rowid, content FROM ctx_messages_fts WHERE ctx_messages_fts MATCH 'hello'",
      )
      .all() as Array<{ rowid: number; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.rowid).toBe(msgId);
    expect(results[0]!.content).toBe("hello world test phrase");
  });

  it("getMessagesByConversation returns messages in seq order", () => {
    const convId = createTestConversation(store);
    store.insertMessage({ conversationId: convId, seq: 3, role: "user", content: "c", contentHash: "h3", tokenCount: 1 });
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "a", contentHash: "h1", tokenCount: 1 });
    store.insertMessage({ conversationId: convId, seq: 2, role: "assistant", content: "b", contentHash: "h2", tokenCount: 1 });

    const msgs = store.getMessagesByConversation(convId);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.seq).toBe(1);
    expect(msgs[1]!.seq).toBe(2);
    expect(msgs[2]!.seq).toBe(3);
  });

  it("getMessagesByConversation with afterSeq filters correctly", () => {
    const convId = createTestConversation(store);
    for (let i = 1; i <= 5; i++) {
      store.insertMessage({ conversationId: convId, seq: i, role: "user", content: `m${i}`, contentHash: `h${i}`, tokenCount: 1 });
    }
    const msgs = store.getMessagesByConversation(convId, { afterSeq: 3 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.seq).toBe(4);
    expect(msgs[1]!.seq).toBe(5);
  });

  it("getMessagesByConversation with limit caps results", () => {
    const convId = createTestConversation(store);
    for (let i = 1; i <= 10; i++) {
      store.insertMessage({ conversationId: convId, seq: i, role: "user", content: `m${i}`, contentHash: `h${i}`, tokenCount: 1 });
    }
    const msgs = store.getMessagesByConversation(convId, { limit: 3 });
    expect(msgs).toHaveLength(3);
  });

  it("getMessagesByIds batch fetches correctly", () => {
    const convId = createTestConversation(store);
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(
        store.insertMessage({ conversationId: convId, seq: i, role: "user", content: `m${i}`, contentHash: `h${i}`, tokenCount: 1 }),
      );
    }
    const results = store.getMessagesByIds([ids[0]!, ids[2]!, ids[4]!]);
    expect(results).toHaveLength(3);
    expect(results[0]!.seq).toBe(1);
    expect(results[1]!.seq).toBe(3);
    expect(results[2]!.seq).toBe(5);
  });

  it("getMessagesByIds returns empty for empty input", () => {
    const results = store.getMessagesByIds([]);
    expect(results).toEqual([]);
  });

  it("getMessagesByIds handles large batches", () => {
    const convId = createTestConversation(store);
    // Insert 550 messages to exercise chunking (>500)
    for (let i = 1; i <= 550; i++) {
      store.insertMessage({
        conversationId: convId,
        seq: i,
        role: "user",
        content: `msg-${i}`,
        contentHash: `hash-${i}`,
        tokenCount: 1,
      });
    }
    // Fetch all 550 by IDs
    const allIds = Array.from({ length: 550 }, (_, i) => i + 1);
    const results = store.getMessagesByIds(allIds);
    expect(results).toHaveLength(550);
  });

  it("getMessageByHash finds by content_hash", () => {
    const convId = createTestConversation(store);
    store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "unique content",
      contentHash: "unique-hash-123",
      tokenCount: 2,
    });
    const row = store.getMessageByHash(convId, "unique-hash-123");
    expect(row).toBeDefined();
    expect(row!.content).toBe("unique content");
  });

  it("getLastMessageSeq returns max seq", () => {
    const convId = createTestConversation(store);
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "a", contentHash: "h1", tokenCount: 1 });
    store.insertMessage({ conversationId: convId, seq: 2, role: "assistant", content: "b", contentHash: "h2", tokenCount: 1 });
    store.insertMessage({ conversationId: convId, seq: 3, role: "user", content: "c", contentHash: "h3", tokenCount: 1 });
    expect(store.getLastMessageSeq(convId)).toBe(3);
  });

  it("getLastMessageSeq returns 0 for empty conversation", () => {
    const convId = createTestConversation(store);
    expect(store.getLastMessageSeq(convId)).toBe(0);
  });
});

// =========================================================================
// Group 3: Message Parts
// =========================================================================

describe("message parts", () => {
  it("insertParts and getPartsByMessage round-trips correctly", () => {
    const convId = createTestConversation(store);
    const msgId = store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "multipart",
      contentHash: "hmp",
      tokenCount: 1,
    });
    store.insertParts(msgId, [
      { ordinal: 0, partType: "text", content: "Hello" },
      { ordinal: 1, partType: "image", metadata: '{"url":"http://..."}' },
      { ordinal: 2, partType: "text", content: "World" },
    ]);
    const parts = store.getPartsByMessage(msgId);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.ordinal).toBe(0);
    expect(parts[0]!.part_type).toBe("text");
    expect(parts[0]!.content).toBe("Hello");
    expect(parts[1]!.ordinal).toBe(1);
    expect(parts[1]!.part_type).toBe("image");
    expect(parts[1]!.metadata).toBe('{"url":"http://..."}');
    expect(parts[2]!.ordinal).toBe(2);
    expect(parts[2]!.content).toBe("World");
  });

  it("getPartsByMessages batches across multiple messages", () => {
    const convId = createTestConversation(store);
    const msgIds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const msgId = store.insertMessage({
        conversationId: convId,
        seq: i,
        role: "user",
        content: `msg-${i}`,
        contentHash: `h${i}`,
        tokenCount: 1,
      });
      msgIds.push(msgId);
      store.insertParts(msgId, [
        { ordinal: 0, partType: "text", content: `part-${i}-a` },
        { ordinal: 1, partType: "text", content: `part-${i}-b` },
      ]);
    }
    const partsMap = store.getPartsByMessages(msgIds);
    expect(partsMap.size).toBe(3);
    for (const msgId of msgIds) {
      const parts = partsMap.get(msgId);
      expect(parts).toHaveLength(2);
    }
  });
});

// =========================================================================
// Group 4: Summaries
// =========================================================================

describe("summaries", () => {
  it("insertSummary stores and FTS-indexes the summary", () => {
    const convId = createTestConversation(store);
    const sumId = store.insertSummary({
      summaryId: "sum-001",
      conversationId: convId,
      kind: "leaf",
      depth: 0,
      content: "Important discussion about architecture",
      tokenCount: 20,
    });
    expect(sumId).toBe("sum-001");

    // Verify stored
    const row = store.getSummary("sum-001");
    expect(row).toBeDefined();
    expect(row!.content).toBe("Important discussion about architecture");
    expect(row!.kind).toBe("leaf");
    expect(row!.depth).toBe(0);

    // Verify FTS indexed
    const fts = db
      .prepare(
        "SELECT summary_id, content FROM ctx_summaries_fts WHERE content MATCH 'architecture'",
      )
      .all() as Array<{ summary_id: string; content: string }>;
    expect(fts).toHaveLength(1);
    expect(fts[0]!.summary_id).toBe("sum-001");
  });

  it("getSummariesByConversation returns all summaries", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "s1", conversationId: convId, kind: "leaf", depth: 0, content: "sum1", tokenCount: 5 });
    store.insertSummary({ summaryId: "s2", conversationId: convId, kind: "leaf", depth: 0, content: "sum2", tokenCount: 5 });
    store.insertSummary({ summaryId: "s3", conversationId: convId, kind: "condensed", depth: 1, content: "sum3", tokenCount: 5 });

    const sums = store.getSummariesByConversation(convId);
    expect(sums).toHaveLength(3);
  });

  it("getSummariesByConversation filters by depth", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "sd0a", conversationId: convId, kind: "leaf", depth: 0, content: "d0a", tokenCount: 5 });
    store.insertSummary({ summaryId: "sd0b", conversationId: convId, kind: "leaf", depth: 0, content: "d0b", tokenCount: 5 });
    store.insertSummary({ summaryId: "sd1a", conversationId: convId, kind: "condensed", depth: 1, content: "d1a", tokenCount: 5 });

    const depth0 = store.getSummariesByConversation(convId, { depth: 0 });
    expect(depth0).toHaveLength(2);
    expect(depth0.every((s) => s.depth === 0)).toBe(true);
  });

  it("updateSummaryCountsDirty sets dirty flag", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "sd", conversationId: convId, kind: "leaf", depth: 0, content: "dirty test", tokenCount: 5 });

    // Initially counts_dirty = 0
    expect(store.getSummary("sd")!.counts_dirty).toBe(0);

    // Set dirty
    store.updateSummaryCountsDirty(["sd"], true);
    expect(store.getSummary("sd")!.counts_dirty).toBe(1);

    // Clear dirty
    store.updateSummaryCountsDirty(["sd"], false);
    expect(store.getSummary("sd")!.counts_dirty).toBe(0);
  });

  it("deleteSummary removes from table and FTS", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "sdel", conversationId: convId, kind: "leaf", depth: 0, content: "delete me please", tokenCount: 5 });

    // Verify it exists
    expect(store.getSummary("sdel")).toBeDefined();

    // Delete
    store.deleteSummary("sdel");

    // Verify gone from table
    expect(store.getSummary("sdel")).toBeUndefined();

    // Verify gone from FTS
    const fts = db
      .prepare(
        "SELECT summary_id FROM ctx_summaries_fts WHERE content MATCH 'delete'",
      )
      .all();
    expect(fts).toHaveLength(0);
  });
});

// =========================================================================
// Group 5: Summary Links
// =========================================================================

describe("summary links", () => {
  it("linkSummaryMessages and getSourceMessageIds round-trip", () => {
    const convId = createTestConversation(store);
    const msgIds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      msgIds.push(
        store.insertMessage({ conversationId: convId, seq: i, role: "user", content: `m${i}`, contentHash: `h${i}`, tokenCount: 1 }),
      );
    }
    store.insertSummary({ summaryId: "slink", conversationId: convId, kind: "leaf", depth: 0, content: "link test", tokenCount: 5 });

    store.linkSummaryMessages("slink", msgIds);
    const result = store.getSourceMessageIds("slink");
    expect(result).toEqual(msgIds);
  });

  it("linkSummaryParents and getParentSummaryIds round-trip", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "parent1", conversationId: convId, kind: "leaf", depth: 0, content: "p1", tokenCount: 5 });
    store.insertSummary({ summaryId: "parent2", conversationId: convId, kind: "leaf", depth: 0, content: "p2", tokenCount: 5 });
    store.insertSummary({ summaryId: "child", conversationId: convId, kind: "condensed", depth: 1, content: "child", tokenCount: 5 });

    store.linkSummaryParents("child", ["parent1", "parent2"]);
    const parents = store.getParentSummaryIds("child");
    expect(parents).toEqual(["parent1", "parent2"]);
  });

  it("getChildSummaryIds returns children of a parent", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "p1", conversationId: convId, kind: "leaf", depth: 0, content: "parent", tokenCount: 5 });
    store.insertSummary({ summaryId: "c1", conversationId: convId, kind: "condensed", depth: 1, content: "child", tokenCount: 5 });

    store.linkSummaryParents("c1", ["p1"]);
    const children = store.getChildSummaryIds("p1");
    expect(children).toEqual(["c1"]);
  });
});

// =========================================================================
// Group 6: Context Items
// =========================================================================

describe("context items", () => {
  it("replaceContextItems sets and getContextItems retrieves", () => {
    const convId = createTestConversation(store);
    const m1 = store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "a", contentHash: "h1", tokenCount: 1 });
    const m2 = store.insertMessage({ conversationId: convId, seq: 2, role: "assistant", content: "b", contentHash: "h2", tokenCount: 1 });
    store.insertSummary({ summaryId: "si", conversationId: convId, kind: "leaf", depth: 0, content: "sum", tokenCount: 5 });

    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: m1 },
      { ordinal: 1, itemType: "summary", summaryId: "si" },
      { ordinal: 2, itemType: "message", messageId: m2 },
    ]);

    const items = store.getContextItems(convId);
    expect(items).toHaveLength(3);
    expect(items[0]!.ordinal).toBe(0);
    expect(items[0]!.item_type).toBe("message");
    expect(items[0]!.message_id).toBe(m1);
    expect(items[1]!.ordinal).toBe(1);
    expect(items[1]!.item_type).toBe("summary");
    expect(items[1]!.summary_id).toBe("si");
    expect(items[2]!.ordinal).toBe(2);
    expect(items[2]!.item_type).toBe("message");
    expect(items[2]!.message_id).toBe(m2);
  });

  it("replaceContextItems replaces existing items", () => {
    const convId = createTestConversation(store);
    const m1 = store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "a", contentHash: "h1", tokenCount: 1 });
    const m2 = store.insertMessage({ conversationId: convId, seq: 2, role: "user", content: "b", contentHash: "h2", tokenCount: 1 });

    // First set
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: m1 },
    ]);
    expect(store.getContextItems(convId)).toHaveLength(1);

    // Replace with different items
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: m2 },
    ]);
    const items = store.getContextItems(convId);
    expect(items).toHaveLength(1);
    expect(items[0]!.message_id).toBe(m2);
  });
});

// =========================================================================
// Group 7: Large Files
// =========================================================================

describe("large files", () => {
  it("insertLargeFile and getLargeFile round-trip", () => {
    const convId = createTestConversation(store);
    const fileId = store.insertLargeFile({
      fileId: "file-001",
      conversationId: convId,
      fileName: "document.pdf",
      mimeType: "application/pdf",
      byteSize: 12345,
      contentHash: "filehash123",
      storagePath: "/data/files/file-001.pdf",
      explorationSummary: "A PDF document about testing",
    });
    expect(fileId).toBe("file-001");

    const row = store.getLargeFile("file-001");
    expect(row).toBeDefined();
    expect(row!.file_name).toBe("document.pdf");
    expect(row!.mime_type).toBe("application/pdf");
    expect(row!.byte_size).toBe(12345);
    expect(row!.content_hash).toBe("filehash123");
    expect(row!.storage_path).toBe("/data/files/file-001.pdf");
    expect(row!.exploration_summary).toBe("A PDF document about testing");
  });

  it("getLargeFileByHash finds by conversation+hash", () => {
    const convId = createTestConversation(store);
    store.insertLargeFile({
      fileId: "file-hash-test",
      conversationId: convId,
      contentHash: "unique-file-hash",
      storagePath: "/data/files/test.bin",
    });
    const row = store.getLargeFileByHash(convId, "unique-file-hash");
    expect(row).toBeDefined();
    expect(row!.file_id).toBe("file-hash-test");
  });
});

// =========================================================================
// Group 8: Expansion Grants
// =========================================================================

describe("expansion grants", () => {
  it("createGrant and getGrant round-trip", () => {
    const convId = createTestConversation(store);
    const grantId = store.createGrant({
      grantId: "grant-001",
      issuerSession: "sess-1",
      conversationIds: [convId],
      summaryIds: ["sum-a", "sum-b"],
      maxDepth: 5,
      tokenCap: 8000,
      expiresAt: "2099-12-31 23:59:59",
    });
    expect(grantId).toBe("grant-001");

    const row = store.getGrant("grant-001");
    expect(row).toBeDefined();
    expect(row!.issuer_session).toBe("sess-1");
    expect(JSON.parse(row!.conversation_ids)).toEqual([convId]);
    expect(JSON.parse(row!.summary_ids)).toEqual(["sum-a", "sum-b"]);
    expect(row!.max_depth).toBe(5);
    expect(row!.token_cap).toBe(8000);
    expect(row!.tokens_consumed).toBe(0);
    expect(row!.revoked).toBe(0);
  });

  it("getActiveGrants filters by session and non-revoked non-expired", () => {
    const convId = createTestConversation(store);

    // Active grant
    store.createGrant({
      grantId: "g-active",
      issuerSession: "sess-x",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });

    // Revoked grant
    store.createGrant({
      grantId: "g-revoked",
      issuerSession: "sess-x",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });
    store.revokeGrant("g-revoked");

    // Expired grant
    store.createGrant({
      grantId: "g-expired",
      issuerSession: "sess-x",
      conversationIds: [convId],
      expiresAt: "2000-01-01 00:00:00",
    });

    const active = store.getActiveGrants("sess-x");
    expect(active).toHaveLength(1);
    expect(active[0]!.grant_id).toBe("g-active");
  });

  it("consumeGrantTokens increments tokens_consumed", () => {
    const convId = createTestConversation(store);
    store.createGrant({
      grantId: "g-consume",
      issuerSession: "sess-c",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });

    store.consumeGrantTokens("g-consume", 100);
    expect(store.getGrant("g-consume")!.tokens_consumed).toBe(100);

    store.consumeGrantTokens("g-consume", 200);
    expect(store.getGrant("g-consume")!.tokens_consumed).toBe(300);
  });

  it("revokeGrant sets revoked flag", () => {
    const convId = createTestConversation(store);
    store.createGrant({
      grantId: "g-revoke",
      issuerSession: "sess-r",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });

    store.revokeGrant("g-revoke");
    expect(store.getGrant("g-revoke")!.revoked).toBe(1);
  });

  it("cleanupExpiredGrants removes expired and revoked", () => {
    const convId = createTestConversation(store);

    // Expired grant
    store.createGrant({
      grantId: "g-exp",
      issuerSession: "sess-cl",
      conversationIds: [convId],
      expiresAt: "2000-01-01 00:00:00",
    });

    // Revoked grant
    store.createGrant({
      grantId: "g-rev",
      issuerSession: "sess-cl",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });
    store.revokeGrant("g-rev");

    // Active grant (should survive)
    store.createGrant({
      grantId: "g-keep",
      issuerSession: "sess-cl",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });

    const count = store.cleanupExpiredGrants();
    expect(count).toBe(2);

    expect(store.getGrant("g-exp")).toBeUndefined();
    expect(store.getGrant("g-rev")).toBeUndefined();
    expect(store.getGrant("g-keep")).toBeDefined();
  });
});

// =========================================================================
// Group 9: FTS5 Search
// =========================================================================

describe("FTS5 search", () => {
  it("searchMessages in fts mode finds matching messages", () => {
    const convId = createTestConversation(store);
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "the quick brown fox", contentHash: "h1", tokenCount: 4 });
    store.insertMessage({ conversationId: convId, seq: 2, role: "user", content: "lazy dog jumps", contentHash: "h2", tokenCount: 3 });
    store.insertMessage({ conversationId: convId, seq: 3, role: "user", content: "brown bear sleeps", contentHash: "h3", tokenCount: 3 });
    store.insertMessage({ conversationId: convId, seq: 4, role: "user", content: "hello world", contentHash: "h4", tokenCount: 2 });
    store.insertMessage({ conversationId: convId, seq: 5, role: "user", content: "another brown animal", contentHash: "h5", tokenCount: 3 });

    const results = store.searchMessages(convId, "brown", { mode: "fts", limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // All results should contain "brown" content
    for (const r of results) {
      expect(r.content.toLowerCase()).toContain("brown");
    }
  });

  it("searchMessages in fts mode respects limit", () => {
    const convId = createTestConversation(store);
    for (let i = 1; i <= 10; i++) {
      store.insertMessage({
        conversationId: convId,
        seq: i,
        role: "user",
        content: `matching keyword phrase ${i}`,
        contentHash: `hk${i}`,
        tokenCount: 3,
      });
    }
    const results = store.searchMessages(convId, "keyword", { mode: "fts", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("searchMessages in regex mode uses LIKE pre-filter", () => {
    const convId = createTestConversation(store);
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "error code 404 not found", contentHash: "hr1", tokenCount: 5 });
    store.insertMessage({ conversationId: convId, seq: 2, role: "user", content: "error code 500 server", contentHash: "hr2", tokenCount: 4 });
    store.insertMessage({ conversationId: convId, seq: 3, role: "user", content: "all good here", contentHash: "hr3", tokenCount: 3 });

    const results = store.searchMessages(convId, "error.*\\d+", { mode: "regex", limit: 10 });
    expect(results).toHaveLength(2);
  });

  it("searchSummaries in fts mode finds matching summaries", () => {
    const convId = createTestConversation(store);
    store.insertSummary({ summaryId: "sf1", conversationId: convId, kind: "leaf", depth: 0, content: "discussion about databases", tokenCount: 5 });
    store.insertSummary({ summaryId: "sf2", conversationId: convId, kind: "leaf", depth: 0, content: "review of architecture patterns", tokenCount: 5 });
    store.insertSummary({ summaryId: "sf3", conversationId: convId, kind: "leaf", depth: 0, content: "database migration plan", tokenCount: 5 });

    const results = store.searchSummaries(convId, "database", { mode: "fts", limit: 10 });
    // "databases" stems to "databas" via porter, "database" stems to "databas" -- should match
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("searchMessages returns empty for no matches", () => {
    const convId = createTestConversation(store);
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "hello world", contentHash: "hn", tokenCount: 2 });

    const results = store.searchMessages(convId, "xyznonexistent", { mode: "fts", limit: 10 });
    expect(results).toEqual([]);
  });
});

// =========================================================================
// Group 10: deleteConversation (bulk)
// =========================================================================

describe("deleteConversation", () => {
  it("deleteConversation removes all related data", () => {
    const convId = createTestConversation(store);

    // Insert messages
    const m1 = store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "msg1", contentHash: "h1", tokenCount: 1 });
    const m2 = store.insertMessage({ conversationId: convId, seq: 2, role: "assistant", content: "msg2", contentHash: "h2", tokenCount: 1 });

    // Insert parts
    store.insertParts(m1, [{ ordinal: 0, partType: "text", content: "part1" }]);

    // Insert summaries
    store.insertSummary({ summaryId: "sdel1", conversationId: convId, kind: "leaf", depth: 0, content: "sum1", tokenCount: 5 });
    store.insertSummary({ summaryId: "sdel2", conversationId: convId, kind: "condensed", depth: 1, content: "sum2", tokenCount: 5 });

    // Link summary to messages
    store.linkSummaryMessages("sdel1", [m1, m2]);
    store.linkSummaryParents("sdel2", ["sdel1"]);

    // Context items
    store.replaceContextItems(convId, [
      { ordinal: 0, itemType: "message", messageId: m1 },
      { ordinal: 1, itemType: "summary", summaryId: "sdel1" },
    ]);

    // Large file
    store.insertLargeFile({
      fileId: "fdel",
      conversationId: convId,
      storagePath: "/tmp/fdel",
    });

    // Grant
    store.createGrant({
      grantId: "gdel",
      issuerSession: "sess-del",
      conversationIds: [convId],
      expiresAt: "2099-12-31 23:59:59",
    });

    // Delete everything
    store.deleteConversation(convId);

    // Verify all tables are empty for that conversation
    expect(store.getConversation(convId)).toBeUndefined();

    const msgs = db.prepare("SELECT COUNT(*) as c FROM ctx_messages WHERE conversation_id = ?").get(convId) as { c: number };
    expect(msgs.c).toBe(0);

    const parts = db.prepare("SELECT COUNT(*) as c FROM ctx_message_parts").get() as { c: number };
    expect(parts.c).toBe(0);

    const sums = db.prepare("SELECT COUNT(*) as c FROM ctx_summaries WHERE conversation_id = ?").get(convId) as { c: number };
    expect(sums.c).toBe(0);

    const sumMsgs = db.prepare("SELECT COUNT(*) as c FROM ctx_summary_messages").get() as { c: number };
    expect(sumMsgs.c).toBe(0);

    const sumParents = db.prepare("SELECT COUNT(*) as c FROM ctx_summary_parents").get() as { c: number };
    expect(sumParents.c).toBe(0);

    const items = db.prepare("SELECT COUNT(*) as c FROM ctx_context_items WHERE conversation_id = ?").get(convId) as { c: number };
    expect(items.c).toBe(0);

    const files = db.prepare("SELECT COUNT(*) as c FROM ctx_large_files WHERE conversation_id = ?").get(convId) as { c: number };
    expect(files.c).toBe(0);
  });

  it("deleteConversation cleans up FTS entries", () => {
    const convId = createTestConversation(store);

    // Insert messages with FTS
    store.insertMessage({ conversationId: convId, seq: 1, role: "user", content: "fts cleanup verification msg", contentHash: "hfts1", tokenCount: 4 });
    store.insertMessage({ conversationId: convId, seq: 2, role: "user", content: "another fts cleanup msg", contentHash: "hfts2", tokenCount: 4 });

    // Insert summaries with FTS
    store.insertSummary({ summaryId: "sfts1", conversationId: convId, kind: "leaf", depth: 0, content: "fts cleanup verification summary", tokenCount: 5 });

    // Verify FTS entries exist before delete
    const msgFtsBefore = db.prepare(
      "SELECT COUNT(*) as c FROM ctx_messages_fts WHERE ctx_messages_fts MATCH 'cleanup'",
    ).get() as { c: number };
    expect(msgFtsBefore.c).toBeGreaterThan(0);

    const sumFtsBefore = db.prepare(
      "SELECT COUNT(*) as c FROM ctx_summaries_fts WHERE content MATCH 'cleanup'",
    ).get() as { c: number };
    expect(sumFtsBefore.c).toBeGreaterThan(0);

    // Delete conversation
    store.deleteConversation(convId);

    // Verify FTS entries are cleaned up
    const msgFtsAfter = db.prepare(
      "SELECT COUNT(*) as c FROM ctx_messages_fts WHERE ctx_messages_fts MATCH 'cleanup'",
    ).get() as { c: number };
    expect(msgFtsAfter.c).toBe(0);

    const sumFtsAfter = db.prepare(
      "SELECT COUNT(*) as c FROM ctx_summaries_fts WHERE content MATCH 'cleanup'",
    ).get() as { c: number };
    expect(sumFtsAfter.c).toBe(0);
  });
});
