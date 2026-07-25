// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createMemoryRecallScope, resolveMemoryVisibility } from "./memory-scope.js";

const TURN_SCOPE = {
  conversation: {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "telegram-main",
        conversationId: "chat-a",
        conversationKind: "direct" as const,
      },
      principalId: "user-a",
    },
  },
  principal: { principalId: "user-a" },
  endpoint: {
    channelType: "telegram",
    channelInstanceId: "telegram-main",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  },
};

describe("memory visibility authority", () => {
  it("memory writes require an explicit visibility variant", () => {
    const result = resolveMemoryVisibility({ turnScope: TURN_SCOPE } as never, "learned");
    expect(result.ok).toBe(false);
  });

  it("omitted visibility never becomes agent shared", () => {
    const result = resolveMemoryVisibility({ turnScope: TURN_SCOPE } as never, "system");
    expect(result).not.toEqual({ ok: true, value: { kind: "agent-shared" } });
  });

  it("resolved conversation and principal visibility identifiers come only from the turn scope", () => {
    const conversation = resolveMemoryVisibility({ turnScope: TURN_SCOPE, visibility: { kind: "conversation" } }, "learned");
    const principal = resolveMemoryVisibility({ turnScope: TURN_SCOPE, visibility: { kind: "principal" } }, "learned");
    expect(conversation.ok && conversation.value).toMatchObject({ kind: "conversation", conversationRef: expect.stringMatching(/^cv_/) });
    expect(principal).toEqual({ ok: true, value: { kind: "principal", principalId: "user-a" } });
  });

  it("external provenance cannot exceed conversation visibility without explicit operator policy", () => {
    const denied = resolveMemoryVisibility({ turnScope: TURN_SCOPE, visibility: { kind: "agent-shared" } }, "external");
    const allowed = resolveMemoryVisibility({
      turnScope: TURN_SCOPE,
      visibility: { kind: "agent-shared" },
      operatorPermission: { kind: "operator-memory-visibility", tenantId: "tenant-a", agentId: "agent-a" },
    }, "external");
    expect(denied.ok).toBe(false);
    expect(allowed).toEqual({ ok: true, value: { kind: "agent-shared" } });
  });

  it("a mismatched operator permission cannot widen visibility", () => {
    const result = resolveMemoryVisibility({
      turnScope: TURN_SCOPE,
      visibility: { kind: "principal" },
      operatorPermission: { kind: "operator-memory-visibility", tenantId: "tenant-other", agentId: "agent-a" },
    }, "external");
    expect(result.ok).toBe(false);
  });

  it("recall scope binds conversation principal agent and the shared-lane flag", () => {
    const result = createMemoryRecallScope(TURN_SCOPE, false);
    expect(result.ok && result.value).toMatchObject({
      tenantId: "tenant-a",
      agentId: "agent-a",
      principalId: "user-a",
      includeAgentShared: false,
      conversationRef: expect.stringMatching(/^cv_/),
    });
  });
});
