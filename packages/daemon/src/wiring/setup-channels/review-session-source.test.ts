// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  type ConversationRef,
  type ConversationScope,
  type SessionDetailedEntry,
} from "@comis/core";
import { ok } from "@comis/shared";
import { buildReviewSessionSource } from "./review-session-source.js";

const TENANT = "tenant-a";
const AGENT = "agent-a";
const QUERY_SCOPE = { tenantId: TENANT, agentId: AGENT };

function conversationScope(principalId: string): ConversationScope {
  return { tenantId: TENANT, agentId: AGENT, partition: { kind: "principal", principalId } };
}

function conversationRef(scope: ConversationScope): ConversationRef {
  const result = createConversationRef(scope);
  if (!result.ok) throw result.error;
  return result.value;
}

function storeEntry(scope: ConversationScope, messageCount: number): SessionDetailedEntry {
  return {
    conversationRef: conversationRef(scope),
    conversationScope: scope,
    tenantId: TENANT,
    agentId: AGENT,
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
    messageCount,
  };
}

function lcdConversation(ref: ConversationRef, sessionKey: string, messageCount: number) {
  return {
    conversationRef: ref,
    tenantId: TENANT,
    agentId: AGENT,
    sessionKey,
    title: null,
    createdAt: 10,
    updatedAt: 20,
    messageCount,
  };
}

function lcdTextMessage(role: "user" | "assistant" | "toolResult", content: string, seq: number) {
  return {
    id: `m${seq}`,
    conversationRef: `cv_${"m".repeat(43)}`,
    seq,
    role,
    tokenCount: 1,
    createdAt: 100 + seq,
    parts: [
      { kind: "text" as const, metadata: { raw: { type: "text", text: content } } },
      { kind: "tool_use" as const, metadata: { raw: { type: "toolCall" } } },
    ],
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    sessionStore: {
      listDetailed: vi.fn().mockReturnValue(ok([])),
      loadByRef: vi.fn().mockReturnValue(ok(undefined)),
    },
    ...overrides,
  };
}

describe("authority-scoped review session source", () => {
  it("lists an LCD conversation absent from the session store", () => {
    const scope = conversationScope("principal-lcd");
    const ref = conversationRef(scope);
    const deps = makeDeps({
      lcdStore: { getMessages: vi.fn().mockReturnValue([]) },
      contextBrowse: {
        listConversations: vi.fn().mockReturnValue({
          conversations: [lcdConversation(ref, "display-lcd", 38)],
          total: 1,
        }),
      },
    });

    const result = buildReviewSessionSource(deps as never).listDetailed(QUERY_SCOPE);

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toEqual([
      expect.objectContaining({
        conversationRef: ref,
        sessionKey: "display-lcd",
        tenantId: TENANT,
        agentId: AGENT,
        messageCount: 38,
      }),
    ]);
  });

  it("uses the larger LCD count for a conversation known to both stores", () => {
    const scope = conversationScope("principal-shared");
    const entry = storeEntry(scope, 2);
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok([entry])),
        loadByRef: vi.fn().mockReturnValue(ok(undefined)),
      },
      lcdStore: { getMessages: vi.fn().mockReturnValue([]) },
      contextBrowse: {
        listConversations: vi.fn().mockReturnValue({
          conversations: [lcdConversation(entry.conversationRef, "display-shared", 40)],
          total: 1,
        }),
      },
    });

    const result = buildReviewSessionSource(deps as never).listDetailed(QUERY_SCOPE);

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.messageCount).toBe(40);
    expect(result.value[0]!.principalId).toBe("principal-shared");
  });

  it("loads LCD text by explicit query scope and conversation ref", () => {
    const scope = conversationScope("principal-load");
    const ref = conversationRef(scope);
    const getMessages = vi.fn().mockReturnValue([
      lcdTextMessage("user", "my dog is Biscuit", 1),
      lcdTextMessage("toolResult", "tool noise", 2),
      lcdTextMessage("assistant", "noted!", 3),
    ]);
    const deps = makeDeps({
      lcdStore: { getMessages },
      contextBrowse: {
        listConversations: vi.fn().mockReturnValue({
          conversations: [lcdConversation(ref, "display-load", 3)],
          total: 1,
        }),
      },
    });

    const result = buildReviewSessionSource(deps as never).loadByRef(QUERY_SCOPE, ref);

    expect(getMessages).toHaveBeenCalledWith({
      conversationRef: ref,
      tenantId: TENANT,
      agentId: AGENT,
      sessionKey: "display-load",
    });
    expect(result).toEqual(ok({
      messages: [
        { role: "user", content: "my dog is Biscuit", createdAt: 101 },
        { role: "assistant", content: "noted!", createdAt: 103 },
      ],
      metadata: {},
      createdAt: 101,
      updatedAt: 103,
    }));
  });

  it("returns a populated session-store transcript without reading LCD content", () => {
    const scope = conversationScope("principal-store");
    const ref = conversationRef(scope);
    const fromStore = {
      conversationRef: ref,
      conversationScope: scope,
      messages: [{ role: "user", content: "hi" }],
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    };
    const getMessages = vi.fn();
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok([])),
        loadByRef: vi.fn().mockReturnValue(ok(fromStore)),
      },
      lcdStore: { getMessages },
      contextBrowse: { listConversations: vi.fn() },
    });

    const result = buildReviewSessionSource(deps as never).loadByRef(QUERY_SCOPE, ref);

    expect(result).toEqual(ok(fromStore));
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("projects session-store metadata without requiring LCD dependencies", () => {
    const scope = conversationScope("principal-base");
    const entry = storeEntry(scope, 7);
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok([entry])),
        loadByRef: vi.fn().mockReturnValue(ok(undefined)),
      },
    });
    const source = buildReviewSessionSource(deps as never);

    expect(source.listDetailed(QUERY_SCOPE)).toEqual(ok([{
      conversationRef: entry.conversationRef,
      sessionKey: "tenant-a:agent:agent-a:principal-base:dm:peer:principal-base",
      principalId: "principal-base",
      tenantId: TENANT,
      agentId: AGENT,
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
      messageCount: 7,
    }]));
    expect(source.loadByRef(QUERY_SCOPE, entry.conversationRef)).toEqual(ok(undefined));
  });
});
