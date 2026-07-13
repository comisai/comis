// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the LCD-merged review session source: in DAG mode
 * the daemon session store is near-empty, so the
 * nightly memory-review extraction was a silent no-op — zero entities /
 * causal edges on a live daemon with days of conversations. The adapter
 * presents the union of the daemon store and the LCD store through the view
 * `runMemoryReview` consumes.
 */

import { describe, it, expect, vi } from "vitest";
import { buildReviewSessionSource } from "./review-session-source.js";
import type { ReviewSessionEntry } from "./review-session-source.js";

const TENANT = "default";
const AGENT = "default";

function storeEntry(sessionKey: string, messageCount: number): ReviewSessionEntry {
  return {
    sessionKey,
    tenantId: TENANT,
    userId: "u",
    channelId: "c",
    metadata: null,
    createdAt: 1,
    updatedAt: 2,
    messageCount,
  };
}

function lcdConversation(sessionKey: string, messageCount: number) {
  return {
    conversationId: sessionKey,
    tenantId: TENANT,
    agentId: AGENT,
    sessionKey,
    title: null,
    createdAt: 10,
    updatedAt: 20,
    messageCount,
  };
}

function lcdTextMessage(role: "user" | "assistant" | "toolResult", text: string, seq: number) {
  return {
    id: `m${seq}`,
    conversationId: "k",
    seq,
    role,
    tokenCount: 1,
    createdAt: 100 + seq,
    parts: [
      { kind: "text" as const, metadata: { raw: { type: "text", text } } },
      { kind: "tool_use" as const, metadata: { raw: { type: "toolCall" } } },
    ],
  };
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    sessionStore: {
      listDetailed: vi.fn().mockReturnValue([] as ReviewSessionEntry[]),
      loadByFormattedKey: vi.fn().mockReturnValue(undefined),
    },
    agentId: AGENT,
    tenantId: TENANT,
    ...over,
  };
}

describe("the nightly review sees DAG conversations, not just the near-empty daemon store", () => {
  it("lists LCD conversations the daemon store has never heard of", () => {
    const deps = makeDeps({
      lcdStore: { getMessages: vi.fn().mockReturnValue([]) },
      contextBrowse: {
        listConversations: vi.fn().mockReturnValue({
          conversations: [lcdConversation("default:openai-api:openai", 38)],
          total: 1,
        }),
      },
    });

    const entries = buildReviewSessionSource(deps as never).listDetailed(TENANT);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionKey: "default:openai-api:openai",
      userId: "openai-api",
      channelId: "openai",
      messageCount: 38,
    });
  });

  it("prefers the richer row when both stores know the session — the minMessages gate sees the real size", () => {
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue([storeEntry("t:u:c", 2)]),
        loadByFormattedKey: vi.fn(),
      },
      lcdStore: { getMessages: vi.fn().mockReturnValue([]) },
      contextBrowse: {
        listConversations: vi.fn().mockReturnValue({
          conversations: [lcdConversation("t:u:c", 40)],
          total: 1,
        }),
      },
    });

    const entries = buildReviewSessionSource(deps as never).listDetailed();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.messageCount).toBe(40);
  });

  it("loads LCD messages as {role, content} text — tool parts and non-conversational roles dropped", () => {
    const getMessages = vi.fn().mockReturnValue([
      lcdTextMessage("user", "my dog is Biscuit", 1),
      lcdTextMessage("toolResult", "tool noise", 2),
      lcdTextMessage("assistant", "noted!", 3),
    ]);
    const deps = makeDeps({
      lcdStore: { getMessages },
      contextBrowse: { listConversations: vi.fn().mockReturnValue({ conversations: [], total: 0 }) },
    });

    const data = buildReviewSessionSource(deps as never).loadByFormattedKey("t:u:c");

    expect(getMessages).toHaveBeenCalledWith({ conversationId: "t:u:c", tenantId: TENANT, agentId: AGENT, sessionKey: "t:u:c" });
    expect(data!.messages).toEqual([
      // `createdAt` (the LCD row timestamp) rides through so the reflection
      // skill-source builder can window a session's rows PER TURN.
      { role: "user", content: "my dog is Biscuit", createdAt: 101 },
      { role: "assistant", content: "noted!", createdAt: 103 },
    ]);
  });

  it("the daemon store wins when it actually has the transcript (pipeline mode unchanged)", () => {
    const fromStore = { messages: [{ role: "user", content: "hi" }], metadata: {}, createdAt: 1, updatedAt: 2 };
    const getMessages = vi.fn();
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue([]),
        loadByFormattedKey: vi.fn().mockReturnValue(fromStore),
      },
      lcdStore: { getMessages },
      contextBrowse: { listConversations: vi.fn().mockReturnValue({ conversations: [], total: 0 }) },
    });

    const data = buildReviewSessionSource(deps as never).loadByFormattedKey("t:u:c");

    expect(data).toBe(fromStore);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("absent LCD deps degrade to the daemon view unchanged (byte-identical pipeline deployments)", () => {
    const base = [storeEntry("t:u:c", 7)];
    const deps = makeDeps({
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(base),
        loadByFormattedKey: vi.fn().mockReturnValue(undefined),
      },
    });

    const source = buildReviewSessionSource(deps as never);

    expect(source.listDetailed()).toEqual(base);
    expect(source.loadByFormattedKey("t:u:c")).toBeUndefined();
  });
});
