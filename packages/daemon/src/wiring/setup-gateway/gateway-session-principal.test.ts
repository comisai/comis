// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveGatewayTurnIdentity } from "./gateway-session-principal.js";

describe("gateway session principal binding", () => {
  it("isolates authenticated clients with delimiter-safe canonical principals", () => {
    const selected = { userId: "untrusted-user", channelId: "shared", peerId: "thread-a" };
    const first = resolveGatewayTurnIdentity({
      tenantId: "tenant-a",
      agentId: "agent-a",
      clientId: "client-a",
      sessionKey: selected,
    });
    const second = resolveGatewayTurnIdentity({
      tenantId: "tenant-a",
      agentId: "agent-a",
      clientId: "client-b",
      sessionKey: selected,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.displaySessionKey.userId).toMatch(/^gateway-[a-f0-9]{64}$/);
    expect(second.value.displaySessionKey.userId).toMatch(/^gateway-[a-f0-9]{64}$/);
    expect(first.value.displaySessionKey.userId).not.toBe(second.value.displaySessionKey.userId);
    expect(first.value.turnScope.endpoint.conversationId).toBe('["shared","thread-a"]');
    expect(first.value.displaySessionKey.agentId).toBe("agent-a");
  });

  it("ignores caller-selected user identity while preserving explicit agent authority", () => {
    const resolved = resolveGatewayTurnIdentity({
      tenantId: "tenant-a",
      agentId: "specialist",
      sessionKey: { userId: "forged-user", channelId: "shared" },
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.displaySessionKey).toMatchObject({
      tenantId: "tenant-a",
      agentId: "specialist",
      userId: "gateway-anonymous",
      peerId: "gateway-anonymous",
    });
    expect(resolved.value.displaySessionKey.userId).not.toBe("forged-user");
  });
});
