// SPDX-License-Identifier: Apache-2.0
import { type ChannelPort, type NormalizedMessage, type PrincipalResolverPort } from "@comis/core";
import { err } from "@comis/shared";
import { describe, expect, it } from "vitest";
import { createFakePrincipalResolver } from "../../../../test/support/fake-principal-resolver.js";
import { resolveInboundTurnIdentity } from "./inbound-turn-identity.js";

function message(): NormalizedMessage {
  return {
    id: "message_a",
    channelType: "telegram",
    channelId: "conversation_a",
    senderId: "subject_a",
    text: "hello",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    attachments: [],
    metadata: {},
  };
}

function adapter(instanceId: string): ChannelPort {
  return {
    channelType: "telegram",
    channelId: instanceId,
  } as unknown as ChannelPort;
}

describe("inbound turn identity normalization", () => {
  it("configured channel instances produce isolated conversation authority", () => {
    const resolver = createFakePrincipalResolver();

    const first = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: adapter("account_a"),
      message: message(),
      principalResolver: resolver,
      dmScope: { mode: "per-account-channel-peer", threadIsolation: true },
    });
    const second = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: adapter("account_b"),
      message: message(),
      principalResolver: resolver,
      dmScope: { mode: "per-account-channel-peer", threadIsolation: true },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.turnScope.conversation).not.toEqual(second.value.turnScope.conversation);
  });

  it("thread normalization only narrows the authenticated endpoint when configured", () => {
    const resolver = createFakePrincipalResolver();
    const threaded = message();
    threaded.metadata.telegramThreadId = "thread_a";

    const resolved = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: adapter("account_a"),
      message: threaded,
      principalResolver: resolver,
      dmScope: { mode: "per-account-channel-peer", threadIsolation: true },
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.turnScope.endpoint.threadId).toBe("thread_a");
  });

  it("rejects a normalized message handled by the wrong channel adapter", () => {
    const wrongAdapter = adapter("account_a");
    wrongAdapter.channelType = "slack";

    const resolved = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: wrongAdapter,
      message: message(),
      principalResolver: createFakePrincipalResolver(),
      dmScope: { mode: "per-account-channel-peer", threadIsolation: true },
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toMatch(/adapter type/i);
  });

  it("preserves principal resolution failures as validation errors", () => {
    const principalResolver: PrincipalResolverPort = {
      resolve: () => err(new Error("principal mapping unavailable")),
    };

    const resolved = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: adapter("account_a"),
      message: message(),
      principalResolver,
      dmScope: { mode: "per-peer", threadIsolation: false },
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.errorKind).toBe("validation");
      expect(resolved.error.message).toBe("principal mapping unavailable");
    }
  });

  it("rejects routing when explicit tenant authority is empty", () => {
    const resolved = resolveInboundTurnIdentity({
      tenantId: "",
      agentId: "agent_a",
      adapter: adapter("account_a"),
      message: message(),
      principalResolver: createFakePrincipalResolver(),
      dmScope: { mode: "main", threadIsolation: false },
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.errorKind).toBe("validation");
  });

  it.each([
    ["parent channel", { parentChannelId: "parent_a" }, "conversation_a"],
    ["Slack thread", { slackThreadTs: "1712345.123" }, "1712345.123"],
    ["Teams thread", { msteamsThreadId: "teams_thread_a" }, "teams_thread_a"],
  ])("normalizes %s metadata into thread authority", (_label, metadata, expectedThreadId) => {
    const threaded = message();
    threaded.metadata = metadata;

    const resolved = resolveInboundTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      adapter: adapter("account_a"),
      message: threaded,
      principalResolver: createFakePrincipalResolver(),
      dmScope: { mode: "per-account-channel-peer", threadIsolation: true },
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.turnScope.endpoint.threadId).toBe(expectedThreadId);
  });
});
