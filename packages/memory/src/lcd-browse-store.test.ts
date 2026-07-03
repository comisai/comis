// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createLcdBrowseStore — the read-only operator-browse adapter
 * implementing ContextBrowsePort over the LCD lossless store.
 *
 * The operator Context DAG browser needs to enumerate the distinct
 * conversations an agent owns; ContextStorePort has no such read (every method
 * is scoped to a single fully-specified conversation). createLcdBrowseStore adds
 * the agent+tenant-scoped `listConversations` query WITHOUT widening the
 * write-path ContextStorePort (which dozens of agent/skills stubs implement).
 *
 * R4: listConversations filters by agent_id AND tenant_id, so two agents that
 * legitimately share one conversation_id never see each other's conversations.
 */
import {
  type AppendMessageInput,
  type ContextStoreScope,
  type LcdMessagePart,
} from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import { createLcdStore } from "./lcd-store.js";
import { createLcdBrowseStore } from "./lcd-browse-store.js";

function textParts(text: string): LcdMessagePart[] {
  return [{ kind: "text", metadata: { raw: { type: "text", text }, rawType: "text" } }];
}

function appendInput(scope: ContextStoreScope, seq: number, createdAt: number): AppendMessageInput {
  return { scope, seq, role: "user", tokenCount: 3, createdAt, parts: textParts("hello") };
}

describe("createLcdBrowseStore.listConversations", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;
  let browse: ReturnType<typeof createLcdBrowseStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
    browse = createLcdBrowseStore(db);
  });

  it("lists distinct conversations for one agent with message-count and time bounds", () => {
    const scopeC1: ContextStoreScope = { conversationId: "conv-1", tenantId: "tenant_a", agentId: "agent_a", sessionKey: "conv-1" };
    const scopeC2: ContextStoreScope = { conversationId: "conv-2", tenantId: "tenant_a", agentId: "agent_a", sessionKey: "conv-2" };
    store.append(appendInput(scopeC1, 0, 1000));
    store.append(appendInput(scopeC1, 1, 2000));
    store.append(appendInput(scopeC2, 0, 5000));

    const result = browse.listConversations({ tenantId: "tenant_a", agentId: "agent_a" }, { limit: 100, offset: 0 });

    // Two distinct conversations, most-recently-updated first (conv-2 latest=5000).
    expect(result.total).toBe(2);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]!.conversationId).toBe("conv-2");
    expect(result.conversations[1]!.conversationId).toBe("conv-1");

    const c1 = result.conversations.find((c) => c.conversationId === "conv-1")!;
    expect(c1.tenantId).toBe("tenant_a");
    expect(c1.agentId).toBe("agent_a");
    expect(c1.messageCount).toBe(2);
    expect(c1.createdAt).toBe(1000); // min created_at
    expect(c1.updatedAt).toBe(2000); // max created_at
  });

  it("isolates conversations per agent so a shared conversation_id never leaks across agents", () => {
    // Same conversation_id + tenant + session, DIFFERENT agentId.
    const scopeA: ContextStoreScope = { conversationId: "conv-shared", tenantId: "tenant_s", agentId: "agent-a", sessionKey: "conv-shared" };
    const scopeB: ContextStoreScope = { conversationId: "conv-shared", tenantId: "tenant_s", agentId: "agent-b", sessionKey: "conv-shared" };
    store.append(appendInput(scopeA, 0, 1000));
    store.append(appendInput(scopeB, 0, 2000));

    const forA = browse.listConversations({ tenantId: "tenant_s", agentId: "agent-a" }, { limit: 100, offset: 0 });
    const forB = browse.listConversations({ tenantId: "tenant_s", agentId: "agent-b" }, { limit: 100, offset: 0 });

    expect(forA.total).toBe(1);
    expect(forA.conversations[0]!.agentId).toBe("agent-a");
    expect(forA.conversations[0]!.messageCount).toBe(1);
    expect(forB.total).toBe(1);
    expect(forB.conversations[0]!.agentId).toBe("agent-b");
  });

  it("does not leak another tenant's conversations under the same agent id", () => {
    const scopeT1: ContextStoreScope = { conversationId: "conv-x", tenantId: "tenant_1", agentId: "agent_a", sessionKey: "conv-x" };
    const scopeT2: ContextStoreScope = { conversationId: "conv-y", tenantId: "tenant_2", agentId: "agent_a", sessionKey: "conv-y" };
    store.append(appendInput(scopeT1, 0, 1000));
    store.append(appendInput(scopeT2, 0, 2000));

    const forT1 = browse.listConversations({ tenantId: "tenant_1", agentId: "agent_a" }, { limit: 100, offset: 0 });
    expect(forT1.total).toBe(1);
    expect(forT1.conversations[0]!.conversationId).toBe("conv-x");
  });

  it("paginates with limit and offset while reporting the full total", () => {
    for (let i = 0; i < 5; i++) {
      const scope: ContextStoreScope = { conversationId: `conv-${i}`, tenantId: "tenant_a", agentId: "agent_a", sessionKey: `conv-${i}` };
      store.append(appendInput(scope, 0, 1000 + i * 1000));
    }

    const page1 = browse.listConversations({ tenantId: "tenant_a", agentId: "agent_a" }, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.conversations).toHaveLength(2);
    // Most recent first: conv-4 (5000), conv-3 (4000).
    expect(page1.conversations[0]!.conversationId).toBe("conv-4");

    const page3 = browse.listConversations({ tenantId: "tenant_a", agentId: "agent_a" }, { limit: 2, offset: 4 });
    expect(page3.total).toBe(5);
    expect(page3.conversations).toHaveLength(1); // only conv-0 remains on the last page
    expect(page3.conversations[0]!.conversationId).toBe("conv-0");
  });

  it("returns an empty result for an agent with no conversations", () => {
    const result = browse.listConversations({ tenantId: "tenant_a", agentId: "ghost" }, { limit: 100, offset: 0 });
    expect(result.total).toBe(0);
    expect(result.conversations).toEqual([]);
  });
});
