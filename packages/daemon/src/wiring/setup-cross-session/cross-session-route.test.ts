// SPDX-License-Identifier: Apache-2.0
import {
  createConversationLocator,
  createDeliveryOrigin,
  type RequestContext,
} from "@comis/core";
import { describe, expect, it } from "vitest";
import { resolvePreservedCrossSessionRoute } from "./cross-session-route.js";

function conversation() {
  const result = createConversationLocator({
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "tenant-a",
    userId: "user-a",
    sessionKey: "tenant-a:agent:agent-a:user-a:chat-a:thread:thread-a",
    agentId: "agent-a",
    traceId: "10000000-0000-4000-8000-000000000001",
    startedAt: 1,
    trustLevel: "admin",
    channelType: "telegram",
    deliveryOrigin: createDeliveryOrigin({
      tenantId: "tenant-a",
      userId: "principal-a",
      channelType: "telegram",
      channelId: "chat-a",
      threadId: "thread-a",
    }),
    turnScope: {
      conversation: conversation().conversationScope,
      principal: { principalId: "principal-a" },
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "telegram-main",
        conversationId: "chat-a",
        threadId: "thread-a",
        conversationKind: "direct",
      },
    },
    ...overrides,
  };
}

const sessionKey = {
  tenantId: "tenant-a",
  userId: "user-a",
  channelId: "chat-a",
  threadId: "thread-a",
};

describe("cross-session route preservation", () => {
  it("preserves an exact resolved principal and endpoint", () => {
    const route = resolvePreservedCrossSessionRoute({
      ambientContext: context(),
      agentId: "agent-a",
      sessionKey,
      conversation: conversation(),
    });

    expect(route?.origin.userId).toBe("principal-a");
    expect(route?.turnScope.principal.principalId).toBe("principal-a");
    expect(route?.turnScope.endpoint.conversationId).toBe("chat-a");
    expect(Object.isFrozen(route?.origin)).toBe(true);
  });

  it("rejects incomplete or mismatched ambient authority", () => {
    expect(resolvePreservedCrossSessionRoute({
      ambientContext: context({ turnScope: undefined }),
      agentId: "agent-a",
      sessionKey,
      conversation: conversation(),
    })).toBeUndefined();
    expect(resolvePreservedCrossSessionRoute({
      ambientContext: context(),
      agentId: "agent-b",
      sessionKey,
      conversation: conversation(),
    })).toBeUndefined();
  });
});
