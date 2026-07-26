// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  resolveGatewayTurnIdentity,
  resolveWebhookTurnIdentity,
} from "./gateway-session-principal.js";

describe("webhook session principal binding", () => {
  it("isolates conversations per rendered session key while binding the principal to the mapping", () => {
    // Per-subject isolation: two rendered keys (two work items) → two conversations,
    // so concurrent drives never share a partition or read each other's history.
    const first = resolveWebhookTurnIdentity({
      tenantId: "tenant-a",
      agentId: "agent-a",
      mappingId: "azdo-poll",
      renderedSessionKey: "azdo:12816",
    });
    const second = resolveWebhookTurnIdentity({
      tenantId: "tenant-a",
      agentId: "agent-a",
      mappingId: "azdo-poll",
      renderedSessionKey: "azdo:12817",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.turnScope.endpoint.conversationId).not.toBe(
      second.value.turnScope.endpoint.conversationId,
    );
    // Same mapping ⇒ same principal: the authority is the operator's config, not the subject.
    expect(first.value.displaySessionKey.userId).toBe(second.value.displaySessionKey.userId);
    expect(first.value.displaySessionKey.userId).toMatch(/^webhook-[a-f0-9]{64}$/);
    expect(first.value.displaySessionKey.agentId).toBe("agent-a");
  });

  it("keeps a delimiter-bearing rendered key intact inside the conversation identity", () => {
    // A sessionKey template renders PAYLOAD data, which can contain the ":" session-key
    // delimiter. JSON-encoding it means a crafted payload cannot split the identity and
    // impersonate another conversation.
    const resolved = resolveWebhookTurnIdentity({
      tenantId: "tenant-a",
      agentId: "agent-a",
      mappingId: "m1",
      renderedSessionKey: 'azdo:1:peer:forged"]',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.turnScope.endpoint.conversationId).toBe(
      JSON.stringify(['azdo:1:peer:forged"]']),
    );
    expect(resolved.value.displaySessionKey.userId).toMatch(/^webhook-[a-f0-9]{64}$/);
  });

  it("separates mappings from each other and from the gateway principal namespace", () => {
    const a = resolveWebhookTurnIdentity({
      tenantId: "t", agentId: "a", mappingId: "m1", renderedSessionKey: "s",
    });
    const b = resolveWebhookTurnIdentity({
      tenantId: "t", agentId: "a", mappingId: "m2", renderedSessionKey: "s",
    });
    const unmapped = resolveWebhookTurnIdentity({
      tenantId: "t", agentId: "a", renderedSessionKey: "s",
    });

    expect(a.ok && b.ok && unmapped.ok).toBe(true);
    if (!a.ok || !b.ok || !unmapped.ok) return;
    expect(a.value.displaySessionKey.userId).not.toBe(b.value.displaySessionKey.userId);
    expect(unmapped.value.displaySessionKey.userId).toMatch(/^webhook-[a-f0-9]{64}$/);
    // The "webhook-" prefix keeps webhook principals disjoint from "gateway-" ones,
    // so an operator reading a session key always knows which surface opened it.
    expect(a.value.displaySessionKey.userId.startsWith("webhook-")).toBe(true);
  });
});

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
