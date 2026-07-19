// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  type ConversationRef,
  type ConversationScope,
  type SessionStorePort,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createSessionLabelStore, type SessionLabelStore } from "./session-label-store.js";

interface StoredSession {
  conversationRef: ConversationRef;
  conversationScope: ConversationScope;
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function refFor(scope: ConversationScope): ConversationRef {
  const result = createConversationRef(scope);
  if (!result.ok) throw result.error;
  return result.value;
}

function makeScope(
  tenantId: string,
  principalId: string,
  conversationId: string,
  agentId = "agent_a",
): ConversationScope {
  return {
    tenantId,
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "test",
        channelInstanceId: "test-instance",
        conversationId,
        conversationKind: "direct",
      },
      principalId,
    },
  };
}

function createMockSessionStore(): SessionStorePort & {
  _sessions: Map<ConversationRef, StoredSession>;
} {
  const sessions = new Map<ConversationRef, StoredSession>();
  return {
    _sessions: sessions,
    save(scope, messages, metadata) {
      const conversationRef = refFor(scope);
      const existing = sessions.get(conversationRef);
      const now = Date.now();
      sessions.set(conversationRef, {
        conversationRef,
        conversationScope: scope,
        messages: [...messages],
        metadata: { ...(metadata ?? {}) },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return ok(undefined);
    },
    load(scope) {
      return ok(sessions.get(refFor(scope)));
    },
    loadByRef(query, conversationRef) {
      const stored = sessions.get(conversationRef);
      return ok(
        stored?.conversationScope.tenantId === query.tenantId
          && stored.conversationScope.agentId === query.agentId
          ? stored
          : undefined,
      );
    },
    list(query) {
      return ok([...sessions.values()]
        .filter((entry) => entry.conversationScope.tenantId === query.tenantId
          && entry.conversationScope.agentId === query.agentId)
        .map((entry) => ({
          conversationRef: entry.conversationRef,
          conversationScope: entry.conversationScope,
          updatedAt: entry.updatedAt,
        })));
    },
    delete(scope) {
      return ok(sessions.delete(refFor(scope)));
    },
    deleteByRef(query, conversationRef) {
      const stored = sessions.get(conversationRef);
      if (stored?.conversationScope.tenantId !== query.tenantId
        || stored.conversationScope.agentId !== query.agentId) return ok(false);
      return ok(sessions.delete(conversationRef));
    },
    deleteStale(query, maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [conversationRef, entry] of sessions) {
        if (entry.conversationScope.tenantId === query.tenantId
          && entry.conversationScope.agentId === query.agentId
          && entry.updatedAt < cutoff) {
          sessions.delete(conversationRef);
          deleted++;
        }
      }
      return ok(deleted);
    },
    listDetailed(query) {
      return ok([...sessions.values()]
        .filter((entry) => entry.conversationScope.tenantId === query.tenantId
          && entry.conversationScope.agentId === query.agentId)
        .map((entry) => ({
          conversationRef: entry.conversationRef,
          conversationScope: entry.conversationScope,
          tenantId: entry.conversationScope.tenantId,
          agentId: entry.conversationScope.agentId,
          metadata: { ...entry.metadata },
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          messageCount: entry.messages.length,
        })));
    },
  };
}

describe("createSessionLabelStore", () => {
  let mockStore: ReturnType<typeof createMockSessionStore>;
  let labelStore: SessionLabelStore;

  beforeEach(() => {
    mockStore = createMockSessionStore();
    labelStore = createSessionLabelStore(mockStore);
  });

  it("returns a stored label through the scoped result contract", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], { label: "Project Planning" });

    expect(labelStore.getLabel(scope)).toEqual(ok("Project Planning"));
  });

  it("returns no label when the session or label is absent", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], { other: "value" });

    expect(labelStore.getLabel(scope)).toEqual(ok(undefined));
    expect(labelStore.getLabel(makeScope("tenant_a", "user_a", "missing"))).toEqual(ok(undefined));
  });

  it("sets a label while preserving existing metadata", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], { customField: "keep", count: 2 });

    expect(labelStore.setLabel(scope, "Daily Standup")).toEqual(ok(undefined));
    const loaded = mockStore.load(scope);
    expect(loaded.ok && loaded.value?.metadata).toEqual({
      customField: "keep",
      count: 2,
      label: "Daily Standup",
    });
  });

  it("overwrites an existing label", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], { label: "Old Label" });

    labelStore.setLabel(scope, "New Label");

    const loaded = mockStore.load(scope);
    expect(loaded.ok && loaded.value?.metadata.label).toBe("New Label");
  });

  it("does not create a session when setting or removing an absent label", () => {
    const scope = makeScope("tenant_a", "user_a", "missing");

    expect(labelStore.setLabel(scope, "unused")).toEqual(ok(undefined));
    expect(labelStore.removeLabel(scope)).toEqual(ok(undefined));
    expect(mockStore.load(scope)).toEqual(ok(undefined));
  });

  it("removes a label while preserving other metadata", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], { label: "remove", keep: "value" });

    expect(labelStore.removeLabel(scope)).toEqual(ok(undefined));
    const loaded = mockStore.load(scope);
    expect(loaded.ok && loaded.value?.metadata).toEqual({ keep: "value" });
  });

  it("lists only labels inside the explicit tenant-agent query scope", () => {
    const first = makeScope("tenant_a", "user_a", "chat_a");
    const unlabeled = makeScope("tenant_a", "user_b", "chat_b");
    const otherAgent = makeScope("tenant_a", "user_a", "chat_a", "agent_b");
    const otherTenant = makeScope("tenant_b", "user_a", "chat_a");
    mockStore.save(first, [], { label: "Planning" });
    mockStore.save(unlabeled, [], {});
    mockStore.save(otherAgent, [], { label: "Other agent" });
    mockStore.save(otherTenant, [], { label: "Other tenant" });

    expect(labelStore.listLabeled({ tenantId: "tenant_a", agentId: "agent_a" })).toEqual(ok([
      { conversationRef: refFor(first), label: "Planning" },
    ]));
  });

  it("returns an empty scoped list when no session has a label", () => {
    const scope = makeScope("tenant_a", "user_a", "chat_a");
    mockStore.save(scope, [], {});

    expect(labelStore.listLabeled({ tenantId: "tenant_a", agentId: "agent_a" })).toEqual(ok([]));
  });
});
