import { type SessionKey, formatSessionKey } from "@comis/core";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import { createSessionStore, MAX_SESSION_BYTES, type SessionStore } from "./session-store.js";

describe("createSessionStore", () => {
  let db: Database.Database;
  let store: SessionStore;

  const testKey: SessionKey = {
    tenantId: "default",
    userId: "user-1",
    channelId: "telegram",
  };

  const otherKey: SessionKey = {
    tenantId: "default",
    userId: "user-2",
    channelId: "discord",
  };

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createSessionStore(db);
  });

  it("save and load roundtrip -- messages array preserved exactly", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    store.save(testKey, messages);
    const loaded = store.load(testKey);

    expect(loaded).toBeDefined();
    expect(loaded!.messages).toEqual(messages);
  });

  it("save with metadata -- metadata object preserved", () => {
    const messages = [{ role: "user", content: "test" }];
    const metadata = { model: "gpt-4", temperature: 0.7, tags: ["debug"] };

    store.save(testKey, messages, metadata);
    const loaded = store.load(testKey);

    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual(metadata);
  });

  it("load returns undefined for non-existent session", () => {
    const result = store.load({
      tenantId: "default",
      userId: "nobody",
      channelId: "nowhere",
    });

    expect(result).toBeUndefined();
  });

  it("save overwrites existing session (upsert) -- messages updated", () => {
    const original = [{ role: "user", content: "first" }];
    const updated = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ];

    store.save(testKey, original);
    store.save(testKey, updated);

    const loaded = store.load(testKey);
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toEqual(updated);
  });

  it("save preserves createdAt on update (only updatedAt changes)", () => {
    store.save(testKey, [{ msg: "first" }]);
    const first = store.load(testKey)!;

    // Small delay to ensure different timestamps
    const createdAt = first.createdAt;

    // Manually set a known created_at in the past for deterministic testing
    db.prepare(
      "UPDATE sessions SET created_at = 1000, updated_at = 1000 WHERE session_key = ?",
    ).run("default:user-1:telegram");

    store.save(testKey, [{ msg: "second" }]);
    const second = store.load(testKey)!;

    // createdAt should stay at 1000 (the original ON CONFLICT preserves it)
    expect(second.createdAt).toBe(1000);
    // updatedAt should be fresh (not 1000)
    expect(second.updatedAt).toBeGreaterThan(1000);
  });

  it("list returns sessions ordered by updatedAt DESC", () => {
    // Insert with explicit timestamps for deterministic ordering
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('s1', 'default', 'u1', 'ch1', '[]', 1000, 1000, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('s2', 'default', 'u2', 'ch2', '[]', 2000, 3000, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('s3', 'default', 'u3', 'ch3', '[]', 1500, 2000, '{}')`,
    ).run();

    const list = store.list();

    expect(list).toHaveLength(3);
    expect(list[0]!.sessionKey).toBe("s2"); // updatedAt 3000
    expect(list[1]!.sessionKey).toBe("s3"); // updatedAt 2000
    expect(list[2]!.sessionKey).toBe("s1"); // updatedAt 1000
  });

  it("list with tenantId filter returns only matching sessions", () => {
    const tenantAKey: SessionKey = { tenantId: "tenant-a", userId: "u1", channelId: "ch1" };
    const tenantBKey: SessionKey = { tenantId: "tenant-b", userId: "u2", channelId: "ch2" };

    store.save(tenantAKey, [{ msg: "a" }]);
    store.save(tenantBKey, [{ msg: "b" }]);

    const filtered = store.list("tenant-a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sessionKey).toContain("tenant-a");
  });

  it("delete removes session and returns true", () => {
    store.save(testKey, [{ msg: "test" }]);

    const deleted = store.delete(testKey);
    expect(deleted).toBe(true);

    const loaded = store.load(testKey);
    expect(loaded).toBeUndefined();
  });

  it("delete returns false for non-existent session", () => {
    const deleted = store.delete({
      tenantId: "default",
      userId: "nonexistent",
      channelId: "none",
    });

    expect(deleted).toBe(false);
  });

  it("deleteStale removes sessions older than threshold", () => {
    // Insert sessions with specific updatedAt timestamps
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('old-session', 'default', 'u1', 'ch1', '[]', 1000, 1000, '{}')`,
    ).run();

    store.save(testKey, [{ msg: "fresh" }]); // This will have a current timestamp

    // Delete sessions older than 1 hour (the old session at timestamp 1000ms will be deleted)
    const deleted = store.deleteStale(60 * 60 * 1000);

    expect(deleted).toBe(1);

    // Fresh session should survive
    const loaded = store.load(testKey);
    expect(loaded).toBeDefined();
  });

  it("deleteStale returns count of deleted sessions", () => {
    // Insert multiple old sessions
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('old1', 'default', 'u1', 'ch1', '[]', 100, 100, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
       VALUES ('old2', 'default', 'u2', 'ch2', '[]', 200, 200, '{}')`,
    ).run();

    const deleted = store.deleteStale(60 * 60 * 1000);
    expect(deleted).toBe(2);
  });

  it("session survives db close/reopen cycle (file-backed)", () => {
    const dbPath = join(tmpdir(), `comis-test-${randomUUID()}.db`);

    // Create and populate
    const fileDb = new Database(dbPath);
    initSchema(fileDb, 1536);
    const fileStore = createSessionStore(fileDb);

    const messages = [
      { role: "user", content: "persist me" },
      { role: "assistant", content: "I will be remembered" },
    ];

    fileStore.save(testKey, messages, { persistent: true });
    fileDb.close();

    // Reopen and verify
    const reopened = new Database(dbPath);
    initSchema(reopened, 1536); // Safe to call again (idempotent)
    const reopenedStore = createSessionStore(reopened);

    const loaded = reopenedStore.load(testKey);
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toEqual(messages);
    expect(loaded!.metadata).toEqual({ persistent: true });

    reopened.close();

    // Cleanup
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(dbPath);
      unlinkSync(dbPath + "-wal");
      unlinkSync(dbPath + "-shm");
    } catch {
      // Ignore cleanup errors
    }
  });

  it("multiple sessions with different keys are independent", () => {
    const msgs1 = [{ msg: "session 1" }];
    const msgs2 = [{ msg: "session 2" }];

    store.save(testKey, msgs1);
    store.save(otherKey, msgs2);

    const loaded1 = store.load(testKey);
    const loaded2 = store.load(otherKey);

    expect(loaded1!.messages).toEqual(msgs1);
    expect(loaded2!.messages).toEqual(msgs2);
  });

  it("empty messages array is valid (new session with no history)", () => {
    store.save(testKey, []);

    const loaded = store.load(testKey);
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toEqual([]);
  });

  it("default metadata is empty object when not provided", () => {
    store.save(testKey, [{ msg: "test" }]);

    const loaded = store.load(testKey);
    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual({});
  });

  describe("loadByFormattedKey", () => {
    it("loads session by formatted key string", () => {
      const key: SessionKey = { tenantId: "default", userId: "u1", channelId: "c1" };
      store.save(key, [{ role: "user", content: "hello" }], { foo: "bar" });
      const formatted = formatSessionKey(key);
      const data = store.loadByFormattedKey(formatted);
      expect(data).toBeDefined();
      expect(data!.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(data!.metadata).toEqual({ foo: "bar" });
    });

    it("returns undefined for non-existent key", () => {
      expect(store.loadByFormattedKey("nonexistent:key:string")).toBeUndefined();
    });
  });

  // ── session size limits ────────────────────────────────────────

  describe("session size limits", () => {
    it("saves session with small messages successfully", () => {
      const messages = [{ role: "user", content: "hello" }];
      expect(() => store.save(testKey, messages)).not.toThrow();

      const loaded = store.load(testKey);
      expect(loaded).toBeDefined();
      expect(loaded!.messages).toEqual(messages);
    });

    it("throws when messages JSON exceeds 10MB", () => {
      // Create a message array that exceeds 10MB when serialized
      const largeContent = "x".repeat(11 * 1024 * 1024); // 11MB string
      const messages = [{ role: "user", content: largeContent }];

      expect(() => store.save(testKey, messages)).toThrow(
        /Session data exceeds maximum size/,
      );
      expect(() => store.save(testKey, messages)).toThrow(/10MB limit/);
    });

    it("saves session right at the limit", () => {
      // Create messages that are close to but under 10MB
      // MAX_SESSION_BYTES = 10 * 1024 * 1024 = 10485760
      // We need messages + metadata JSON to be <= 10485760 bytes
      // JSON overhead: {"role":"user","content":"..."} -> ~30 bytes + content
      // Outer array: [...]  -> ~2 bytes
      // metadata: {} -> 2 bytes
      const targetContentSize = MAX_SESSION_BYTES - 100; // leave room for JSON overhead + metadata
      const content = "a".repeat(targetContentSize);
      const messages = [{ content }];

      expect(() => store.save(testKey, messages)).not.toThrow();
    });

    it("MAX_SESSION_BYTES is 10MB", () => {
      expect(MAX_SESSION_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe("listDetailed", () => {
    it("returns detailed session entries with metadata", () => {
      const key1: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
      const key2: SessionKey = { tenantId: "t1", userId: "u2", channelId: "c2" };
      store.save(key1, [], { parentSessionKey: "some-parent" });
      store.save(key2, [], {});

      const entries = store.listDetailed("t1");
      expect(entries).toHaveLength(2);
      // Most recent first
      const subAgent = entries.find(e => e.metadata.parentSessionKey !== undefined);
      expect(subAgent).toBeDefined();
      expect(subAgent!.userId).toBe("u1");
      expect(subAgent!.metadata.parentSessionKey).toBe("some-parent");
    });

    it("filters by tenantId", () => {
      const key1: SessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
      const key2: SessionKey = { tenantId: "t2", userId: "u2", channelId: "c2" };
      store.save(key1, []);
      store.save(key2, []);

      expect(store.listDetailed("t1")).toHaveLength(1);
      expect(store.listDetailed("t2")).toHaveLength(1);
      expect(store.listDetailed()).toHaveLength(2);
    });
  });
});
