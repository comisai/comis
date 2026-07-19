// SPDX-License-Identifier: Apache-2.0
import type { ConversationScope } from "@comis/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "./schema.js";
import { createSessionStore } from "./session-store.js";

function makeScope(agentId: string): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "account_a",
        conversationId: "conversation_a",
        threadId: "thread_a",
        conversationKind: "shared",
      },
    },
  };
}

describe("session store conversation authority", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  afterEach(() => {
    db.close();
  });

  it("two agents on one conversation coordinate keep separate session histories", () => {
    const store = createSessionStore(db);
    const agentA = makeScope("agent_a");
    const agentB = makeScope("agent_b");

    const savedA = store.save(agentA, [{ role: "user", content: "agent a" }]);
    const savedB = store.save(agentB, [{ role: "user", content: "agent b" }]);

    expect(savedA.ok).toBe(true);
    expect(savedB.ok).toBe(true);
    const loadedA = store.load(agentA);
    const loadedB = store.load(agentB);
    expect(loadedA.ok && loadedA.value?.messages).toEqual([{ role: "user", content: "agent a" }]);
    expect(loadedB.ok && loadedB.value?.messages).toEqual([{ role: "user", content: "agent b" }]);
  });

  it("session point lookups predicate on tenant agent and conversation ref", () => {
    const store = createSessionStore(db);
    const scope = makeScope("agent_a");
    expect(store.save(scope, [{ role: "user", content: "private" }]).ok).toBe(true);

    const row = db.prepare(
      "SELECT tenant_id, agent_id, conversation_ref FROM sessions",
    ).get() as { tenant_id: string; agent_id: string; conversation_ref: string };
    expect(row.tenant_id).toBe(scope.tenantId);
    expect(row.agent_id).toBe(scope.agentId);
    expect(row.conversation_ref).toMatch(/^cv_[A-Za-z0-9_-]{43}$/);
    expect(store.load(makeScope("agent_b")).ok).toBe(true);
    const other = store.load(makeScope("agent_b"));
    expect(other.ok && other.value).toBeUndefined();
  });

  it("a ref collision with mismatched stored scope returns an internal error", () => {
    const store = createSessionStore(db);
    const scope = makeScope("agent_a");
    expect(store.save(scope, []).ok).toBe(true);

    db.prepare("UPDATE sessions SET canonical_scope = ?").run(JSON.stringify(makeScope("agent_b")));
    const loaded = store.load(scope);

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.errorKind).toBe("internal");
  });
});
