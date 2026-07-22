// SPDX-License-Identifier: Apache-2.0
import { createConversationRef } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatSettledDelivery } from "./heartbeat-settled-delivery.js";

const endpoint = {
  channelType: "telegram",
  channelInstanceId: "bot-main",
  conversationId: "chat-a",
  threadId: "topic-7",
  conversationKind: "shared" as const,
};

function accepted() {
  return ok({
    chunks: [{ status: "accepted" as const, messageId: "message-a", charCount: 5, retried: false }],
    totalChars: 5,
    platform: { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 1_000, lastMessageId: "message-a" },
    queueDisposition: "settled" as const,
  });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const deliverToChannel = vi.fn(async () => accepted());
  const check = vi.fn(() => false);
  const recordPossiblyVisible = vi.fn();
  const adapter = {
    channelId: "bot-main",
    channelType: "telegram",
    sendMessage: vi.fn(),
  };
  return {
    deps: {
      tenantId: "tenant-a",
      clock: { now: () => 1_000, nowDate: () => new Date(1_000) },
      adaptersByType: new Map([["telegram", adapter]]),
      deliveryService: { deliverToChannel },
      outputGuard: { scan: vi.fn(() => ok({ blocked: false, sanitized: "hello" })) },
      duplicateDetector: { check, recordPossiblyVisible, clear: vi.fn() },
      isQuietHours: vi.fn(() => ok(false)),
      criticalBypass: true,
      logger: { warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as never,
    adapter,
    deliverToChannel,
    check,
    recordPossiblyVisible,
  };
}

describe("heartbeat settled delivery", () => {
  it("uses exact endpoint authority and records accepted visibility", async () => {
    const { deps, adapter, deliverToChannel, check, recordPossiblyVisible } = makeDeps();
    const deliver = createHeartbeatSettledDelivery(deps);

    const outcome = await deliver({
      correlationId: "heartbeat-a",
      agentId: "agent-a",
      endpoint,
      text: "hello",
      level: "alert",
      allowDm: true,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: "accepted",
      deliveredChunks: 1,
      settledAtMs: 1_000,
      lastMessageId: "message-a",
    });
    const scope = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "endpoint-conversation" as const, endpoint },
    };
    const conversationRef = createConversationRef(scope);
    expect(conversationRef.ok).toBe(true);
    expect(deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-a",
      "hello",
      expect.objectContaining({
        completionMode: "settled",
        authority: {
          tenantId: "tenant-a",
          agentId: "agent-a",
          conversationRef: conversationRef.ok ? conversationRef.value : "",
        },
        destinationEndpoint: endpoint,
        threadId: "topic-7",
        origin: "heartbeat",
      }),
    );
    const candidate = { agentId: "agent-a", destinationEndpoint: endpoint, text: "hello" };
    expect(check).toHaveBeenCalledWith(candidate);
    expect(recordPossiblyVisible).toHaveBeenCalledWith(candidate);
  });

  it("fails closed on adapter mismatch before delivery", async () => {
    const { deps, deliverToChannel, recordPossiblyVisible } = makeDeps({
      adaptersByType: new Map([["telegram", {
        channelId: "different-bot",
        channelType: "telegram",
        sendMessage: vi.fn(),
      }]]),
    });
    const outcome = await createHeartbeatSettledDelivery(deps)({
      correlationId: "heartbeat-a",
      agentId: "agent-a",
      endpoint,
      text: "hello",
      level: "alert",
      allowDm: true,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ status: "pre_send_failed", reason: "target_precondition", errorKind: "precondition" });
    expect(deliverToChannel).not.toHaveBeenCalled();
    expect(recordPossiblyVisible).not.toHaveBeenCalled();
  });

  it("records unknown platform visibility but not definite rejection", async () => {
    const unknown = makeDeps({
      deliveryService: {
        deliverToChannel: vi.fn(async () => ok({
          chunks: [{ status: "unknown", error: new Error("ambiguous"), errorKind: "dependency", charCount: 5, retried: false }],
          totalChars: 5,
          platform: { status: "unknown", errorKind: "dependency", deliveredChunks: 0, failedChunks: 1, ambiguousChunks: 1, settledAtMs: 1_000 },
          queueDisposition: "settled",
        })),
      },
    });
    const request = {
      correlationId: "heartbeat-a",
      agentId: "agent-a",
      endpoint,
      text: "hello",
      level: "alert" as const,
      allowDm: true,
      signal: new AbortController().signal,
    };
    expect((await createHeartbeatSettledDelivery(unknown.deps)(request)).status).toBe("unknown");
    expect(unknown.recordPossiblyVisible).toHaveBeenCalledOnce();

    const rejected = makeDeps({
      deliveryService: {
        deliverToChannel: vi.fn(async () => ok({
          chunks: [{ status: "rejected", error: new Error("denied"), errorKind: "platform", charCount: 5, retried: false }],
          totalChars: 5,
          platform: { status: "rejected", errorKind: "platform", deliveredChunks: 0, failedChunks: 1, settledAtMs: 1_000 },
          queueDisposition: "settled",
        })),
      },
    });
    expect((await createHeartbeatSettledDelivery(rejected.deps)(request)).status).toBe("rejected");
    expect(rejected.recordPossiblyVisible).not.toHaveBeenCalled();
  });

  it("applies direct-message and quiet-hours visibility before send", async () => {
    const directEndpoint = { ...endpoint, threadId: undefined, conversationKind: "direct" as const };
    const direct = makeDeps();
    expect(await createHeartbeatSettledDelivery(direct.deps)({
      correlationId: "heartbeat-a", agentId: "agent-a", endpoint: directEndpoint,
      text: "hello", level: "alert", allowDm: false, signal: new AbortController().signal,
    })).toEqual({ status: "suppressed", reason: "dm_policy" });
    expect(direct.deliverToChannel).not.toHaveBeenCalled();

    const quiet = makeDeps({ isQuietHours: vi.fn(() => ok(true)), criticalBypass: true });
    const deliver = createHeartbeatSettledDelivery(quiet.deps);
    expect(await deliver({
      correlationId: "heartbeat-a", agentId: "agent-a", endpoint,
      text: "hello", level: "alert", allowDm: true, signal: new AbortController().signal,
    })).toEqual({ status: "suppressed", reason: "quiet_hours" });
    expect((await deliver({
      correlationId: "heartbeat-b", agentId: "agent-a", endpoint,
      text: "critical", level: "critical", allowDm: true, signal: new AbortController().signal,
    })).status).toBe("accepted");
  });

  it("maps output-guard and delivery boundary failures without visibility evidence", async () => {
    const blocked = makeDeps({ outputGuard: { scan: vi.fn(() => err(new Error("guard failed"))) } });
    const outcome = await createHeartbeatSettledDelivery(blocked.deps)({
      correlationId: "heartbeat-a", agentId: "agent-a", endpoint,
      text: "hello", level: "alert", allowDm: true, signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ status: "pre_send_failed", reason: "output_guard", errorKind: "internal" });
    expect(blocked.recordPossiblyVisible).not.toHaveBeenCalled();
  });
});
