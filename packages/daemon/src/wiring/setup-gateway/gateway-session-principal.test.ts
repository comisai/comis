// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { err, ok } from "@comis/shared";
import {
  gatewaySessionOwnershipError,
  resolveGatewaySessionKey,
} from "./gateway-session-principal.js";

describe("gateway session principal binding", () => {
  it("isolates authenticated clients while preserving the selected conversation peer", () => {
    const selected = { userId: "untrusted-user", channelId: "shared", peerId: "thread-a" };
    const first = resolveGatewaySessionKey({
      tenantId: "tenant-a",
      clientId: "client-a",
      sessionKey: selected,
    });
    const second = resolveGatewaySessionKey({
      tenantId: "tenant-a",
      clientId: "client-b",
      sessionKey: selected,
    });

    expect(first.userId).toMatch(/^gateway-[a-f0-9]{64}$/);
    expect(second.userId).toMatch(/^gateway-[a-f0-9]{64}$/);
    expect(first.userId).not.toBe(second.userId);
    expect(first).toMatchObject({ channelId: "shared", peerId: "thread-a" });
  });

  it("rejects unverifiable, cross-agent, and cross-client stored ownership", () => {
    expect(gatewaySessionOwnershipError(err(new Error("read failed")), "agent-a", "client-a")?.message)
      .toMatch(/could not be verified/i);
    expect(gatewaySessionOwnershipError(
      ok({ metadata: { agentId: "agent-b", gatewayClientId: "client-a" } }),
      "agent-a",
      "client-a",
    )?.message).toMatch(/different agent/i);
    expect(gatewaySessionOwnershipError(
      ok({ metadata: { agentId: "agent-a", gatewayClientId: "client-b" } }),
      "agent-a",
      "client-a",
    )?.message).toMatch(/different gateway client/i);
  });
});
