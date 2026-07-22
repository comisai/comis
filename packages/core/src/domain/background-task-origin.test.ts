// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createConversationRef, type ResolvedTurnScope } from "./conversation-scope.js";
import { BackgroundTaskOriginSchema } from "./background-task-origin.js";

const TURN_SCOPE: ResolvedTurnScope = {
  conversation: {
    tenantId: "tenant-1",
    agentId: "agent-1",
    partition: { kind: "agent" },
  },
  principal: { principalId: "principal-1" },
  endpoint: {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-1",
    conversationKind: "direct",
  },
};

const reference = createConversationRef(TURN_SCOPE.conversation);
if (!reference.ok) throw reference.error;

function makeOrigin(overrides: Record<string, unknown> = {}) {
  return {
    turnScope: TURN_SCOPE,
    conversationRef: reference.value,
    deliveryOrigin: {
      channelType: "echo",
      channelId: "conversation-1",
      userId: "principal-1",
      tenantId: "tenant-1",
    },
    traceId: "abc-123",
    backgroundHopCount: 0,
    ...overrides,
  };
}

describe("BackgroundTaskOriginSchema", () => {
  it("accepts a coherent resolved origin", () => {
    expect(BackgroundTaskOriginSchema.parse(makeOrigin())).toEqual(makeOrigin());
  });

  it("accepts a nullable trace identifier", () => {
    expect(BackgroundTaskOriginSchema.parse(makeOrigin({ traceId: null })).traceId).toBeNull();
  });

  it("defaults the background hop count to zero", () => {
    const { backgroundHopCount: _backgroundHopCount, ...origin } = makeOrigin();
    expect(BackgroundTaskOriginSchema.parse(origin).backgroundHopCount).toBe(0);
  });

  it("accepts a positive integer background hop count", () => {
    expect(BackgroundTaskOriginSchema.parse(makeOrigin({ backgroundHopCount: 2 })).backgroundHopCount).toBe(2);
  });

  it("rejects a negative background hop count", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({ backgroundHopCount: -1 }))).toThrow();
  });

  it("rejects a fractional background hop count", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({ backgroundHopCount: 1.5 }))).toThrow();
  });

  it("rejects missing resolved authority", () => {
    expect(() => BackgroundTaskOriginSchema.parse({ traceId: null })).toThrow();
  });

  it("rejects a conversation reference for a different scope", () => {
    const other = createConversationRef({
      tenantId: "tenant-1",
      agentId: "agent-2",
      partition: { kind: "agent" },
    });
    if (!other.ok) throw other.error;
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({ conversationRef: other.value }))).toThrow();
  });

  it("rejects a delivery origin that conflicts with turn authority", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "conversation-1",
        userId: "principal-1",
        tenantId: "tenant-1",
      },
    }))).toThrow();
  });

  it("rejects delivery conversation ids that differ from the resolved endpoint", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({
      deliveryOrigin: {
        channelType: "echo",
        channelId: "conversation-other",
        userId: "principal-1",
        tenantId: "tenant-1",
      },
    }))).toThrow();
  });

  it("rejects delivery principals that differ from the authenticated principal", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({
      deliveryOrigin: {
        channelType: "echo",
        channelId: "conversation-1",
        userId: "principal-other",
        tenantId: "tenant-1",
      },
    }))).toThrow();
  });

  it("rejects delivery threads that differ from the resolved endpoint", () => {
    expect(() => BackgroundTaskOriginSchema.parse(makeOrigin({
      deliveryOrigin: {
        channelType: "echo",
        channelId: "conversation-1",
        userId: "principal-1",
        threadId: "thread-other",
        tenantId: "tenant-1",
      },
    }))).toThrow();
  });
});
