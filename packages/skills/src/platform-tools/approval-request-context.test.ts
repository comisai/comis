// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createDeliveryOrigin, runWithContext, type RequestContext } from "@comis/core";
import { resolveApprovalRequestContext } from "./approval-request-context.js";

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "human-user",
    agentId: "resolved-agent",
    sessionKey: "default:human-user:chat-1:thread:thread-1",
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
        agentId: "resolved-agent",
        sessionKey: "default:human-user:chat-1:thread:thread-1",
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

  it("fails closed when the session thread differs from the locked delivery origin", () => {
    const result = runWithContext(
      makeContext({ sessionKey: "default:human-user:chat-1:thread:other-thread" }),
      resolveApprovalRequestContext,
    );

    expect(result.ok).toBe(false);
  });
});
