// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  DeliveryService,
  OutwardSendLedgerPort,
  TypedEventBus,
} from "@comis/core";
import { createConversationLocator } from "@comis/core";
import { createAnnouncementDelivery } from "./governed-announcement-delivery.js";

const eventBus = {
  emitSafely: vi.fn(() => ({ failures: [], pendingFailures: Promise.resolve([]) })),
} as unknown as TypedEventBus;

function makeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  } as unknown as DeliveryService;
}

function makeLedger(): OutwardSendLedgerPort {
  return {
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
}

function makeConversation() {
  const locator = createConversationLocator({
    tenantId: "default",
    agentId: "agent-1",
    partition: { kind: "agent" },
  });
  if (!locator.ok) throw locator.error;
  return locator.value;
}

describe("completion announcement delivery wiring", () => {
  it("returns false without calling the delivery service when no adapter exists", async () => {
    const deliveryService = makeDeliveryService();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map(),
      deliveryService,
      eventBus,
    });

    await expect(delivery.sendToChannel("telegram", "chat-1", "text"))
      .resolves.toBe(false);
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("blocks a governed attempt before allocation when the root resolver is absent", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map(),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
    });

    const result = await delivery.sendGovernedAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "default:user1:chan1",
      runId: "run-1",
      callerConversation: makeConversation(),
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
    });

    expect(result).toEqual(ok({ delivered: false, failure: "allocation_blocked" }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("delivers a validated generated file as the governed channel operation", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    vi.mocked(deliveryService.deliverToChannel).mockResolvedValue(ok({
      ok: true,
      totalChunks: 1,
      deliveredChunks: 1,
      failedChunks: 0,
      chunks: [{
        ok: true,
        messageId: "text-message",
        charCount: 10,
        retried: false,
      }],
      totalChars: 10,
    }));
    const cleanup = vi.fn(async () => ok(undefined));
    const sendAttachment = vi.fn(async () => ok({
      kind: "tracked" as const,
      messageId: "document-message",
    }));
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", {
        channelType: "telegram",
        sendMessage: vi.fn(async () => ok("text-message")),
        sendAttachment,
      }]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => "root-1",
      prepareCompletionAttachment: vi.fn(async () => ok({
        path: "/tmp/completion-report.csv",
        fileName: "completion-report.csv",
        mimeType: "text/csv",
        contentDigest: "a".repeat(64),
        sizeBytes: 128,
        cleanup,
      })),
    });

    const result = await delivery.sendGovernedAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "default:agent:agent-1:user1:telegram:peer:user1",
      callerConversation: makeConversation(),
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "The report is ready.",
      attachment: {
        sourceAgentId: "agent-1",
        path: "/workspace/reports/completion-report.csv",
      },
    });

    expect(result?.ok && result.value.delivered).toBe(true);
    expect(sendAttachment).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        type: "file",
        url: "/tmp/completion-report.csv",
        fileName: "completion-report.csv",
        mimeType: "text/csv",
        caption: "The report is ready.",
      }),
      undefined,
    );
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(ledger.commit).toHaveBeenCalledWith("root-1", 0, "document-message");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
