// SPDX-License-Identifier: Apache-2.0
import {
  createConversationRef,
  type ConversationScope,
  type SessionStorePort,
} from "@comis/core";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import { createSessionStore, MAX_SESSION_BYTES } from "./session-store.js";

function makeScope(
  tenantId = "default",
  agentId = "agent-1",
  principalId = "user-1",
): ConversationScope {
  return { tenantId, agentId, partition: { kind: "principal", principalId } };
}

function resultValue<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("createSessionStore", () => {
  let db: Database.Database;
  let store: SessionStorePort;

  const testScope = makeScope();
  const otherScope = makeScope("default", "agent-1", "user-2");

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createSessionStore(db);
  });

  it("save and load roundtrip preserves messages exactly", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    resultValue(store.save(testScope, messages));
    expect(resultValue(store.load(testScope))?.messages).toEqual(messages);
  });

  it("save and load roundtrip preserves metadata exactly", () => {
    const metadata = { model: "test-model", temperature: 0.7, tags: ["debug"] };
    resultValue(store.save(testScope, [{ role: "user", content: "test" }], metadata));
    expect(resultValue(store.load(testScope))?.metadata).toEqual(metadata);
  });

  it("load returns an empty optional result for an unknown canonical scope", () => {
    expect(resultValue(store.load(makeScope("default", "agent-1", "nobody")))).toBeUndefined();
  });

  it("save updates messages while preserving the original creation timestamp", () => {
    resultValue(store.save(testScope, [{ content: "first" }]));
    const reference = resultValue(createConversationRef(testScope));
    db.prepare(
      "UPDATE sessions SET created_at = 1000, updated_at = 1000 WHERE tenant_id = ? AND agent_id = ? AND conversation_ref = ?",
    ).run(testScope.tenantId, testScope.agentId, reference);

    resultValue(store.save(testScope, [{ content: "second" }]));
    const loaded = resultValue(store.load(testScope));
    expect(loaded?.messages).toEqual([{ content: "second" }]);
    expect(loaded?.createdAt).toBe(1000);
    expect(loaded?.updatedAt).toBeGreaterThan(1000);
  });

  it("list orders canonical sessions by descending update timestamp", () => {
    const oldest = makeScope("default", "agent-1", "oldest");
    const newest = makeScope("default", "agent-1", "newest");
    resultValue(store.save(oldest, []));
    resultValue(store.save(newest, []));
    db.prepare("UPDATE sessions SET updated_at = 1000 WHERE conversation_ref = ?")
      .run(resultValue(createConversationRef(oldest)));
    db.prepare("UPDATE sessions SET updated_at = 3000 WHERE conversation_ref = ?")
      .run(resultValue(createConversationRef(newest)));

    const listed = resultValue(store.list({ tenantId: "default", agentId: "agent-1" }));
    expect(listed.map((entry) => entry.conversationRef)).toEqual([
      resultValue(createConversationRef(newest)),
      resultValue(createConversationRef(oldest)),
    ]);
  });

  it("list requires exact tenant and agent query authority", () => {
    resultValue(store.save(makeScope("tenant-a", "agent-a", "user-a"), []));
    resultValue(store.save(makeScope("tenant-a", "agent-b", "user-b"), []));
    resultValue(store.save(makeScope("tenant-b", "agent-a", "user-c"), []));

    expect(resultValue(store.list({ tenantId: "tenant-a", agentId: "agent-a" }))).toHaveLength(1);
  });

  it("delete removes the exact canonical session and reports success", () => {
    resultValue(store.save(testScope, [{ content: "test" }]));
    expect(resultValue(store.delete(testScope))).toBe(true);
    expect(resultValue(store.load(testScope))).toBeUndefined();
  });

  it("delete reports false for an unknown canonical session", () => {
    expect(resultValue(store.delete(makeScope("default", "agent-1", "missing")))).toBe(false);
  });

  it("deleteByRef remains constrained by tenant and agent query authority", () => {
    resultValue(store.save(testScope, []));
    const reference = resultValue(createConversationRef(testScope));
    expect(resultValue(store.deleteByRef({ tenantId: "default", agentId: "foreign" }, reference))).toBe(false);
    expect(resultValue(store.load(testScope))).toBeDefined();
  });

  it("deleteStale removes only old sessions in the requested authority partition", () => {
    const oldScope = makeScope("default", "agent-1", "old");
    const foreignScope = makeScope("default", "agent-2", "foreign");
    resultValue(store.save(oldScope, []));
    resultValue(store.save(testScope, []));
    resultValue(store.save(foreignScope, []));
    db.prepare("UPDATE sessions SET updated_at = 1000 WHERE conversation_ref IN (?, ?)")
      .run(resultValue(createConversationRef(oldScope)), resultValue(createConversationRef(foreignScope)));

    expect(resultValue(store.deleteStale({ tenantId: "default", agentId: "agent-1" }, 60 * 60 * 1000))).toBe(1);
    expect(resultValue(store.load(testScope))).toBeDefined();
    expect(resultValue(store.load(foreignScope))).toBeDefined();
  });

  it("session data survives a file-backed close and reopen cycle", { timeout: 20_000 }, () => {
    const dbPath = join(tmpdir(), `comis-test-${randomUUID()}.db`);
    const fileDb = new Database(dbPath);
    initSchema(fileDb, 1536);
    const fileStore = createSessionStore(fileDb);
    const messages = [{ role: "user", content: "persist me" }];
    resultValue(fileStore.save(testScope, messages, { persistent: true }));
    fileDb.close();

    const reopened = new Database(dbPath);
    initSchema(reopened, 1536);
    const loaded = resultValue(createSessionStore(reopened).load(testScope));
    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.metadata).toEqual({ persistent: true });
    reopened.close();

    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("different canonical partitions remain independent", () => {
    resultValue(store.save(testScope, [{ content: "one" }]));
    resultValue(store.save(otherScope, [{ content: "two" }]));
    expect(resultValue(store.load(testScope))?.messages).toEqual([{ content: "one" }]);
    expect(resultValue(store.load(otherScope))?.messages).toEqual([{ content: "two" }]);
  });

  it("empty messages and omitted metadata remain valid", () => {
    resultValue(store.save(testScope, []));
    const loaded = resultValue(store.load(testScope));
    expect(loaded?.messages).toEqual([]);
    expect(loaded?.metadata).toEqual({});
  });

  it("loadByRef resolves an exact canonical reference under query authority", () => {
    resultValue(store.save(testScope, [{ content: "hello" }], { foo: "bar" }));
    const reference = resultValue(createConversationRef(testScope));
    const loaded = resultValue(store.loadByRef(
      { tenantId: testScope.tenantId, agentId: testScope.agentId },
      reference,
    ));
    expect(loaded?.metadata).toEqual({ foo: "bar" });
  });

  it("session size validation returns an error without writing oversized data", () => {
    const messages = [{ content: "x".repeat(11 * 1024 * 1024) }];
    const saved = store.save(testScope, messages);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.message).toMatch(/byte limit/i);
    expect(resultValue(store.load(testScope))).toBeUndefined();
  });

  it("session data just below the byte limit is accepted", () => {
    const content = "a".repeat(MAX_SESSION_BYTES - 100);
    expect(store.save(testScope, [{ content }]).ok).toBe(true);
  });

  it("the exported session byte limit remains ten binary megabytes", () => {
    expect(MAX_SESSION_BYTES).toBe(10 * 1024 * 1024);
  });

  it("listDetailed returns canonical scope metadata and message counts", () => {
    resultValue(store.save(testScope, [{ content: "one" }], { parent: "root" }));
    const entries = resultValue(store.listDetailed({ tenantId: "default", agentId: "agent-1" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.conversationScope).toEqual(testScope);
    expect(entries[0]?.metadata).toEqual({ parent: "root" });
    expect(entries[0]?.messageCount).toBe(1);
  });
});
