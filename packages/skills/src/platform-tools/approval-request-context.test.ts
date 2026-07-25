// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  createConversationRef,
  createDeliveryOrigin,
  runWithContext,
  type RequestContext,
  type ResolvedTurnScope,
} from "@comis/core";
import { resolveApprovalRequestContext } from "./approval-request-context.js";

const TURN_ENDPOINT = {
  channelType: "telegram",
  channelInstanceId: "telegram-account",
  conversationId: "chat-1",
  threadId: "thread-1",
  conversationKind: "direct" as const,
};

const TURN_SCOPE: ResolvedTurnScope = {
  conversation: {
    tenantId: "default",
    agentId: "resolved-agent",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: TURN_ENDPOINT,
      principalId: "principal-human-user",
    },
  },
  principal: { principalId: "principal-human-user" },
  endpoint: TURN_ENDPOINT,
};

const conversationRef = createConversationRef(TURN_SCOPE.conversation);
if (!conversationRef.ok) throw conversationRef.error;

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "human-user",
    agentId: "resolved-agent",
    sessionKey: "default:agent:resolved-agent:human-user:chat-1:thread:thread-1",
    turnScope: TURN_SCOPE,
    traceId: "40000000-0000-4000-8000-000000000004",
    startedAt: 1,
    trustLevel: "admin",
    channelType: "telegram",
    deliveryOrigin: createDeliveryOrigin({
      tenantId: "default",
      userId: "human-user",
      channelType: "telegram",
      channelId: "chat-1",
      threadId: "thread-1",
    }),
    ...overrides,
  };
}

describe("resolveApprovalRequestContext", () => {
  it("returns the resolved agent identity instead of the user identity", () => {
    const result = runWithContext(makeContext(), resolveApprovalRequestContext);

    expect(result).toEqual({
      ok: true,
      value: {
        tenantId: "default",
        agentId: "resolved-agent",
        conversationRef: conversationRef.value,
        resolvingPrincipalId: "principal-human-user",
        trustLevel: "admin",
        callbackOwner: {
          tenantId: "default",
          userId: "human-user",
          channelType: "telegram",
          channelKey: "chat-1",
          threadId: "thread-1",
        },
      },
    });
  });

  it("fails closed outside a resolved request scope", () => {
    const result = resolveApprovalRequestContext();

    expect(result.ok).toBe(false);
  });

  it("fails closed when the request scope has no resolved agent", () => {
    const context = makeContext();
    delete context.agentId;

    const result = runWithContext(context, resolveApprovalRequestContext);

    expect(result.ok).toBe(false);
  });

  it("fails closed when the locked delivery origin is absent", () => {
    const context = makeContext();
    delete context.deliveryOrigin;

    const result = runWithContext(context, resolveApprovalRequestContext);

    expect(result.ok).toBe(false);
  });

  it("fails closed when delivery origin was not frozen by the request boundary", () => {
    const context = makeContext({
      deliveryOrigin: {
        tenantId: "default",
        userId: "human-user",
        channelType: "telegram",
        channelId: "chat-1",
        threadId: "thread-1",
      },
    });

    const result = runWithContext(context, resolveApprovalRequestContext);

    expect(result.ok).toBe(false);
  });

  it("fails closed when the resolved endpoint thread differs from the locked delivery origin", () => {
    const result = runWithContext(
      makeContext({
        turnScope: {
          ...TURN_SCOPE,
          endpoint: { ...TURN_SCOPE.endpoint, threadId: "other-thread" },
        },
      }),
      resolveApprovalRequestContext,
    );

    expect(result.ok).toBe(false);
  });
});
