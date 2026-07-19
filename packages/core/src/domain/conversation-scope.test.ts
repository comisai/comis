// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConversationRefSchema,
  ConversationLocatorSchema,
  ResolvedTurnScopeSchema,
  createConversationRef,
  encodeConversationScope,
  type ChannelEndpoint,
  type ConversationScope,
} from "./conversation-scope.js";

const endpoint: ChannelEndpoint = {
  channelType: "telegram",
  channelInstanceId: "account_a",
  conversationId: "chat_a",
  conversationKind: "direct",
};

function ref(scope: ConversationScope): string {
  const result = createConversationRef(scope);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("conversation scope authority encoding", () => {
  it("distinct near-miss scopes never share a conversation ref", () => {
    const scopes: ConversationScope[] = [
      { tenantId: "a:b", agentId: "c", partition: { kind: "agent" } },
      { tenantId: "a", agentId: "b:c", partition: { kind: "agent" } },
      { tenantId: "a", agentId: "b", partition: { kind: "principal", principalId: "c" } },
      { tenantId: "a", agentId: "b", partition: { kind: "channel-principal", channelType: "c", principalId: "d" } },
      { tenantId: "a", agentId: "b", partition: { kind: "endpoint-conversation", endpoint } },
      {
        tenantId: "a",
        agentId: "b",
        partition: {
          kind: "endpoint-conversation",
          endpoint: { ...endpoint, channelInstanceId: endpoint.conversationId, conversationId: endpoint.channelInstanceId },
        },
      },
      {
        tenantId: "a",
        agentId: "b",
        partition: {
          kind: "endpoint-conversation",
          endpoint: { ...endpoint, threadId: "thread_a" },
        },
      },
    ];

    expect(new Set(scopes.map(ref)).size).toBe(scopes.length);
    expect(createConversationRef({
      tenantId: "a",
      agentId: "b",
      partition: { kind: "endpoint-conversation", endpoint: { ...endpoint, threadId: "" } },
    })).toMatchObject({ ok: false });
  });

  it("conversation ref round-trips deterministically for one canonical encoding", () => {
    const scope: ConversationScope = {
      tenantId: "tenant_a",
      agentId: "agent_a",
      partition: { kind: "endpoint-conversation-principal", endpoint, principalId: "principal_a" },
    };
    const encodedA = encodeConversationScope(scope);
    const encodedB = encodeConversationScope(structuredClone(scope));
    expect(encodedA).toEqual(encodedB);
    expect(ref(scope)).toBe(ref(structuredClone(scope)));
  });

  it("conversation ref is produced only by schema parse never by cast", () => {
    const source = readFileSync(new URL("./conversation-scope.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bas\s+ConversationRef\b/);
    expect(ConversationRefSchema.safeParse(ref({
      tenantId: "tenant_a",
      agentId: "agent_a",
      partition: { kind: "agent" },
    })).success).toBe(true);
  });

  it("conversation locator rejects a reference derived from another scope", () => {
    const scope: ConversationScope = {
      tenantId: "tenant_a",
      agentId: "agent_a",
      partition: { kind: "agent" },
    };
    const otherScope: ConversationScope = {
      tenantId: "tenant_a",
      agentId: "agent_b",
      partition: { kind: "agent" },
    };
    expect(ConversationLocatorSchema.safeParse({
      conversationScope: scope,
      conversationRef: ref(otherScope),
    }).success).toBe(false);
  });

  it("resolved turn scope rejects a partition principal differing from the authenticated principal", () => {
    const result = ResolvedTurnScopeSchema.safeParse({
      conversation: {
        tenantId: "tenant_a",
        agentId: "agent_a",
        partition: { kind: "principal", principalId: "principal_b" },
      },
      principal: { principalId: "principal_a" },
      endpoint,
    });
    expect(result.success).toBe(false);
  });

  it("resolved turn scope rejects an endpoint partition differing from the thread-narrowed endpoint", () => {
    const result = ResolvedTurnScopeSchema.safeParse({
      conversation: {
        tenantId: "tenant_a",
        agentId: "agent_a",
        partition: {
          kind: "endpoint-conversation",
          endpoint: { ...endpoint, channelType: "discord", threadId: "other_thread" },
        },
      },
      principal: { principalId: "principal_a" },
      endpoint: { ...endpoint, threadId: "thread_a" },
    });
    expect(result.success).toBe(false);
  });
});
