// SPDX-License-Identifier: Apache-2.0
import type { ConversationScope } from "@comis/core";
import { createSessionStore, initSchema } from "@comis/memory";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function conversationScope(agentId: string): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      principalId: "principal_a",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "account_a",
        conversationId: "conversation_a",
        threadId: "thread_a",
        conversationKind: "direct",
      },
    },
  };
}

describe("scoped storage isolation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  afterEach(() => {
    db.close();
  });

  it("two agents on one conversation coordinate keep separate session histories in one real store", () => {
    const store = createSessionStore(db);
    const agentA = conversationScope("agent_a");
    const agentB = conversationScope("agent_b");

    expect(store.save(agentA, [{ role: "user", content: "a" }]).ok).toBe(true);
    expect(store.save(agentB, [{ role: "user", content: "b" }]).ok).toBe(true);
    const loadedA = store.load(agentA);
    const loadedB = store.load(agentB);

    expect(loadedA.ok && loadedA.value?.messages).toEqual([{ role: "user", content: "a" }]);
    expect(loadedB.ok && loadedB.value?.messages).toEqual([{ role: "user", content: "b" }]);
  });
});
