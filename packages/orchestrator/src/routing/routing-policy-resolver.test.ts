// SPDX-License-Identifier: Apache-2.0
import type { ChannelEndpoint } from "@comis/core";
import { describe, expect, it } from "vitest";
import { resolveRoutingPolicy, type DmScopeMode } from "./routing-policy-resolver.js";

const directEndpoint: ChannelEndpoint = {
  channelType: "telegram",
  channelInstanceId: "account_a",
  conversationId: "chat_a",
  conversationKind: "direct",
};

function resolve(endpoint: ChannelEndpoint, dmScopeMode: DmScopeMode) {
  return resolveRoutingPolicy({
    tenantId: "tenant_a",
    agentId: "agent_a",
    endpoint,
    principal: { principalId: "principal_a" },
    dmScopeMode,
  });
}

describe("routing policy conversation partitions", () => {
  it("each direct-message scope mode maps to exactly one partition variant", () => {
    const cases: Array<[DmScopeMode, string]> = [
      ["main", "agent"],
      ["per-peer", "principal"],
      ["per-channel-peer", "channel-principal"],
      ["per-account-channel-peer", "endpoint-conversation-principal"],
    ];
    for (const [mode, expectedKind] of cases) {
      const result = resolve(directEndpoint, mode);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.conversation.partition.kind).toBe(expectedKind);
    }
  });

  it("shared conversations always select the endpoint-conversation partition", () => {
    for (const mode of ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"] as const) {
      const result = resolve({ ...directEndpoint, conversationKind: "shared" }, mode);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.conversation.partition.kind).toBe("endpoint-conversation");
    }
  });

  it("a thread can only narrow the endpoint partition", () => {
    const threaded = { ...directEndpoint, threadId: "thread_a" };
    const result = resolve(threaded, "per-account-channel-peer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoint).toEqual(threaded);
    expect(result.value.conversation.partition).toEqual({
      kind: "endpoint-conversation-principal",
      endpoint: threaded,
      principalId: "principal_a",
    });
  });
});
