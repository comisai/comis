import type { MemoryConfig, SessionKey } from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCompactionService, type Summarizer, type CompactionService } from "./compaction.js";
import { initSchema } from "./schema.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

// ── Helpers ────────────────────────────────────────────────────────────

const testConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

const testKey: SessionKey = {
  tenantId: "default",
  userId: "user-1",
  channelId: "telegram",
};

const testKey2: SessionKey = {
  tenantId: "default",
  userId: "user-2",
  channelId: "discord",
};

/** Simple summarizer that just concatenates messages and returns fixed facts. */
const mockSummarizer: Summarizer = async (messages: unknown[]) => ({
  summary: `Summary of ${messages.length} messages`,
  facts: ["fact-1", "fact-2"],
});

/** Summarizer that returns no facts. */
const noFactsSummarizer: Summarizer = async (messages: unknown[]) => ({
  summary: `Summary of ${messages.length} messages`,
  facts: [],
});

/** Summarizer that tracks how many times it was called. */
function trackingSummarizer(): Summarizer & { callCount: number } {
  const fn = async (messages: unknown[]) => {
    fn.callCount++;
    return {
      summary: `Summary of ${messages.length} messages`,
      facts: ["tracked-fact"],
    };
  };
  fn.callCount = 0;
  return fn;
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe("createCompactionService", () => {
  let db: Database.Database;
  let adapter: SqliteMemoryAdapter;
  let sessionStore: SessionStore;
  let compactionService: CompactionService;

  beforeEach(() => {
    // Use the adapter's internal DB for everything (single :memory: connection)
    adapter = new SqliteMemoryAdapter(testConfig);
    db = adapter.getDb();
    sessionStore = createSessionStore(db);
    compactionService = createCompactionService(db, sessionStore, adapter, mockSummarizer);
  });

  afterEach(() => {
    adapter.close();
  });

  // ── Stale session detection ──────────────────────────────────────

  it("compacts sessions idle for longer than minIdleMs", async () => {
    // Save a session and manually set its updatedAt to the past
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    // Set updatedAt to 5 hours ago
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      fiveHoursAgo,
      "default:user-1:telegram",
    );

    const result = await compactionService.compact({ minIdleMs: 4 * 60 * 60 * 1000 });

    expect(result.sessionsCompacted).toBe(1);
    expect(result.compactedKeys).toContain("default:user-1:telegram");
  });

  it("does NOT compact active sessions (within idle threshold)", async () => {
    // Save a session that was recently updated (within minIdleMs)
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);

    const result = await compactionService.compact({ minIdleMs: 4 * 60 * 60 * 1000 });

    expect(result.sessionsCompacted).toBe(0);
    expect(result.compactedKeys).toHaveLength(0);
  });

  it("skips sessions with no messages", async () => {
    sessionStore.save(testKey, []);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result.sessionsCompacted).toBe(0);
  });

  // ── Episodic memory creation ─────────────────────────────────────

  it("creates episodic memory from stale session summary", async () => {
    sessionStore.save(testKey, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result.episodicCreated).toBe(1);

    // Verify the episodic memory is in the database
    const episodic = db
      .prepare("SELECT * FROM memories WHERE memory_type = 'episodic'")
      .all() as Array<{ content: string; source_who: string }>;

    expect(episodic).toHaveLength(1);
    expect(episodic[0]!.content).toBe("Summary of 2 messages");
    expect(episodic[0]!.source_who).toBe("compaction");
  });

  // ── Semantic fact extraction ─────────────────────────────────────

  it("creates semantic memories from extracted facts", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result.factsExtracted).toBe(2);

    const facts = db
      .prepare("SELECT content FROM memories WHERE memory_type = 'semantic' AND tags LIKE '%fact%'")
      .all() as Array<{ content: string }>;

    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.content)).toContain("fact-1");
    expect(facts.map((f) => f.content)).toContain("fact-2");
  });

  it("handles summarizer returning no facts", async () => {
    const service = createCompactionService(db, sessionStore, adapter, noFactsSummarizer);

    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await service.compact({ minIdleMs: 1000 });

    expect(result.episodicCreated).toBe(1);
    expect(result.factsExtracted).toBe(0);
  });

  // ── Archive creation ─────────────────────────────────────────────

  it("archives original messages before deletion", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    sessionStore.save(testKey, messages);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    await compactionService.compact({ minIdleMs: 1000 });

    const archives = db.prepare("SELECT * FROM archives").all() as Array<{
      session_key: string;
      messages: string;
      archived_at: number;
      expires_at: number;
    }>;

    expect(archives).toHaveLength(1);
    expect(archives[0]!.session_key).toBe("default:user-1:telegram");
    expect(JSON.parse(archives[0]!.messages)).toEqual(messages);
    expect(archives[0]!.expires_at).toBeGreaterThan(archives[0]!.archived_at);
  });

  it("archives respect configurable retention period", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const customRetention = 3 * 24 * 60 * 60 * 1000; // 3 days
    await compactionService.compact({
      minIdleMs: 1000,
      archiveRetentionMs: customRetention,
    });

    const archive = db.prepare("SELECT * FROM archives").get() as {
      archived_at: number;
      expires_at: number;
    };

    const actualRetention = archive.expires_at - archive.archived_at;
    expect(actualRetention).toBe(customRetention);
  });

  // ── Session deletion ─────────────────────────────────────────────

  it("deletes the session after compaction", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    await compactionService.compact({ minIdleMs: 1000 });

    const session = sessionStore.load(testKey);
    expect(session).toBeUndefined();
  });

  // ── Multiple sessions ────────────────────────────────────────────

  it("compacts multiple stale sessions in one run", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello from user 1" }]);
    sessionStore.save(testKey2, [{ role: "user", content: "hello from user 2" }]);

    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ?").run(longAgo);

    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result.sessionsCompacted).toBe(2);
    expect(result.episodicCreated).toBe(2);
    expect(result.factsExtracted).toBe(4); // 2 facts per session
  });

  it("only compacts stale sessions, leaves active ones alone", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "stale" }]);
    sessionStore.save(testKey2, [{ role: "user", content: "active" }]);

    // Only make testKey stale
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result.sessionsCompacted).toBe(1);
    expect(result.compactedKeys).toContain("default:user-1:telegram");

    // Active session should still exist
    const activeSession = sessionStore.load(testKey2);
    expect(activeSession).toBeDefined();
  });

  // ── Pluggable summarizer ─────────────────────────────────────────

  it("calls the pluggable summarizer with session messages", async () => {
    const tracker = trackingSummarizer();
    const service = createCompactionService(db, sessionStore, adapter, tracker);

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ];
    sessionStore.save(testKey, messages);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    await service.compact({ minIdleMs: 1000 });

    expect(tracker.callCount).toBe(1);
  });

  // ── Tenant scoping ──────────────────────────────────────────────

  it("respects tenantId option for scoped compaction", async () => {
    const key1: SessionKey = { tenantId: "tenant-a", userId: "u1", channelId: "ch1" };
    const key2: SessionKey = { tenantId: "tenant-b", userId: "u2", channelId: "ch2" };

    sessionStore.save(key1, [{ role: "user", content: "hello" }]);
    sessionStore.save(key2, [{ role: "user", content: "world" }]);

    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ?").run(longAgo);

    const result = await compactionService.compact({
      minIdleMs: 1000,
      tenantId: "tenant-a",
    });

    expect(result.sessionsCompacted).toBe(1);
    expect(result.compactedKeys[0]).toContain("tenant-a");

    // tenant-b session should still exist
    const tenantBSession = sessionStore.load(key2);
    expect(tenantBSession).toBeDefined();
  });

  // ── purgeArchives ────────────────────────────────────────────────

  it("purgeArchives removes expired archives", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    // Compact with very short retention so archive expires immediately
    await compactionService.compact({
      minIdleMs: 1000,
      archiveRetentionMs: 1, // 1ms retention
    });

    // Verify archive exists
    const beforePurge = db.prepare("SELECT COUNT(*) as cnt FROM archives").get() as {
      cnt: number;
    };
    expect(beforePurge.cnt).toBe(1);

    // Wait a tick to ensure expiry
    await new Promise((r) => setTimeout(r, 10));

    const purged = compactionService.purgeArchives();
    expect(purged).toBe(1);

    const afterPurge = db.prepare("SELECT COUNT(*) as cnt FROM archives").get() as {
      cnt: number;
    };
    expect(afterPurge.cnt).toBe(0);
  });

  it("purgeArchives does not remove non-expired archives", async () => {
    sessionStore.save(testKey, [{ role: "user", content: "hello" }]);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    // Compact with long retention
    await compactionService.compact({
      minIdleMs: 1000,
      archiveRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const purged = compactionService.purgeArchives();
    expect(purged).toBe(0);

    const archiveCount = db.prepare("SELECT COUNT(*) as cnt FROM archives").get() as {
      cnt: number;
    };
    expect(archiveCount.cnt).toBe(1);
  });

  it("purgeArchives returns 0 when no archives exist", () => {
    const purged = compactionService.purgeArchives();
    expect(purged).toBe(0);
  });

  // ── Empty session edge case ────────────────────────────────────

  it("handles compaction with empty sessions (0 messages) without calling summarizer", async () => {
    // Create a tracking summarizer that should never be called
    const tracker = trackingSummarizer();
    const service = createCompactionService(db, sessionStore, adapter, tracker);

    // Save a session with 0 messages and make it stale
    sessionStore.save(testKey, []);
    const longAgo = Date.now() - 10 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?").run(
      longAgo,
      "default:user-1:telegram",
    );

    const result = await service.compact({ minIdleMs: 1000 });

    // Verify compaction completed successfully (no crash)
    expect(result.sessionsCompacted).toBe(0);
    expect(result.episodicCreated).toBe(0);
    expect(result.factsExtracted).toBe(0);
    expect(result.compactedKeys).toHaveLength(0);

    // Summarizer should never have been called for an empty session
    expect(tracker.callCount).toBe(0);

    // No episodic or semantic memories should have been created
    const episodic = db
      .prepare("SELECT * FROM memories WHERE memory_type = 'episodic'")
      .all();
    expect(episodic).toHaveLength(0);

    const semantic = db
      .prepare("SELECT * FROM memories WHERE memory_type = 'semantic' AND tags LIKE '%fact%'")
      .all();
    expect(semantic).toHaveLength(0);
  });

  // ── Return value ─────────────────────────────────────────────────

  it("returns empty result when no sessions are stale", async () => {
    const result = await compactionService.compact({ minIdleMs: 1000 });

    expect(result).toEqual({
      sessionsCompacted: 0,
      episodicCreated: 0,
      factsExtracted: 0,
      compactedKeys: [],
    });
  });
});
