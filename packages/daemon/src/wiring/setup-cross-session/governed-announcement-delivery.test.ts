// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type {
  ChannelEndpoint,
  DeliveryService,
  OutwardSendLedgerPort,
  TypedEventBus,
} from "@comis/core";
import { createConversationLocator } from "@comis/core";
import { createAnnouncementDelivery } from "./governed-announcement-delivery.js";

type AttachmentRouteOverride = {
  endpoint?: Partial<ChannelEndpoint>;
  channelId?: string;
  options?: { threadId: string };
};

const eventBus = {
  emitSafely: vi.fn(() => ({ failures: [], pendingFailures: Promise.resolve([]) })),
} as unknown as TypedEventBus;

function makeDeliveryService(): DeliveryService {
  const deliverToChannel: DeliveryService["deliverToChannel"] = vi.fn(async (
    adapter,
    channelId,
    text,
    options,
    sendChunk,
  ) => {
    const sent = sendChunk
      ? await sendChunk({
          adapter,
          channelId,
          text,
          options: {
            ...(options.threadId ? { threadId: options.threadId } : {}),
            ...(options.extra ? { extra: options.extra } : {}),
          },
          chunkIndex: 0,
          totalChunks: 1,
        })
      : await adapter.sendMessage(channelId, text);
    return ok({
      chunks: sent.ok
        ? [{
            status: "accepted" as const,
            messageId: sent.value,
            charCount: text.length,
            retried: false,
          }]
        : [{
            status: "unknown" as const,
            error: sent.error,
            errorKind: "platform" as const,
            charCount: text.length,
            retried: false,
          }],
      totalChars: text.length,
      platform: sent.ok
        ? {
            status: "accepted" as const,
            deliveredChunks: 1,
            settledAtMs: 1,
            lastMessageId: sent.value,
          }
        : {
            status: "unknown" as const,
            errorKind: "platform" as const,
            deliveredChunks: 0,
            failedChunks: 1,
            ambiguousChunks: 1,
            settledAtMs: 1,
          },
      queueDisposition: "settled" as const,
    });
  });
  return {
    deliverToChannel,
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  } as unknown as DeliveryService;
}

function makeLedger(): OutwardSendLedgerPort {
  return {
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    recordTerminalDecision: vi.fn(async () => ok(undefined)),
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    reclaimPreSend: vi.fn(async () => ok(true)),
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

function makeChannelPrincipalCaller() {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-primary",
    conversationId: "chat-1",
    threadId: "topic-7",
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "tenant-a",
    agentId: "agent-1",
    partition: {
      kind: "channel-principal",
      channelType: "telegram",
      principalId: "principal-a",
    },
  });
  if (!locator.ok) throw locator.error;
  return { endpoint, locator: locator.value };
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

    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "default:user1:chan1",
      runId: "run-1",
      callerConversation: makeConversation(),
      destinationEndpoint: makeChannelPrincipalCaller().endpoint,
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
    });

    expect(result).toEqual(ok({ delivered: false, failure: "allocation_blocked" }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("passes authenticated caller authority to delivery persistence without ambient context", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const adapter = {
      channelId: "telegram-primary",
      channelType: "telegram",
      sendMessage: vi.fn(async () => ok("telegram-message-1")),
    };
    const caller = makeChannelPrincipalCaller();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", adapter]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ({ ok: true, value: "root-1" }),
    });

    const request = {
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
      options: { threadId: "topic-7" },
    };
    const result = await delivery.sendLedgerAnnouncement?.(request);

    expect(result?.ok && result.value.delivered).toBe(true);
    expect(deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "completion",
      {
        completionMode: "settled",
        threadId: "topic-7",
        authority: {
          tenantId: "tenant-a",
          agentId: "agent-1",
          conversationRef: caller.locator.conversationRef,
        },
        destinationEndpoint: caller.endpoint,
      },
      expect.any(Function),
    );
  });

  it("governs each irreversible text chunk with a distinct ledger operation", async () => {
    const ledger = makeLedger();
    vi.mocked(ledger.allocateStep)
      .mockResolvedValueOnce(ok(0))
      .mockResolvedValueOnce(ok(1));
    const adapter = {
      channelId: "telegram-primary",
      channelType: "telegram",
      sendMessage: vi.fn()
        .mockResolvedValueOnce(ok("message-first"))
        .mockResolvedValueOnce(err(new Error("500 response unavailable"))),
    };
    const deliveryService = makeDeliveryService();
    vi.mocked(deliveryService.deliverToChannel).mockImplementation(async (
      deliveryAdapter,
      channelId,
      _text,
      _options,
      sendChunk,
    ) => {
      if (!sendChunk) return err(new Error("governed chunk sender missing"));
      const first = await sendChunk({
        adapter: deliveryAdapter,
        channelId,
        text: "first chunk",
        options: { threadId: "topic-7" },
        chunkIndex: 0,
        totalChunks: 2,
      });
      if (!first.ok) return first;
      const second = await sendChunk({
        adapter: deliveryAdapter,
        channelId,
        text: "second chunk",
        options: { threadId: "topic-7" },
        chunkIndex: 1,
        totalChunks: 2,
      });
      return ok({
        chunks: [
          {
            status: "accepted" as const,
            messageId: first.value,
            charCount: 11,
            retried: false,
          },
          second.ok
            ? {
                status: "accepted" as const,
                messageId: second.value,
                charCount: 12,
                retried: false,
              }
            : {
                status: "unknown" as const,
                error: second.error,
                errorKind: "platform" as const,
                charCount: 12,
                retried: false,
              },
        ],
        totalChars: 23,
        platform: second.ok
          ? { status: "accepted" as const, deliveredChunks: 2, settledAtMs: 1 }
          : {
              status: "unknown" as const,
              errorKind: "platform" as const,
              deliveredChunks: 1,
              failedChunks: 1,
              ambiguousChunks: 1,
              settledAtMs: 1,
            },
        queueDisposition: "settled" as const,
      });
    });
    const caller = makeChannelPrincipalCaller();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", adapter]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ok("root-chunked"),
    });

    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-chunked",
      channelType: "telegram",
      channelId: "chat-1",
      text: "long completion",
      options: { threadId: "topic-7" },
    });

    expect(result).toMatchObject({ ok: true, value: { delivered: false } });
    const allocatedIds = vi.mocked(ledger.allocateStep).mock.calls.map((call) => call[1]);
    expect(allocatedIds).toHaveLength(2);
    expect(new Set(allocatedIds).size).toBe(2);
    expect(ledger.commit).toHaveBeenCalledWith("root-chunked", 0, "message-first");
    expect(ledger.commit).not.toHaveBeenCalledWith("root-chunked", 1, expect.anything());
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("preserves an unknown platform outcome as an uncertain governed failure", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const adapter = {
      channelId: "telegram-primary",
      channelType: "telegram",
      sendMessage: vi.fn(async () => err(new Error("500 Internal Server Error"))),
    };
    const caller = makeChannelPrincipalCaller();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", adapter]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ({ ok: true, value: "root-uncertain" }),
    });

    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-uncertain",
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
      options: { threadId: "topic-7" },
    });

    expect(result).toEqual(ok({
      delivered: false,
      identity: { agentId: "agent-1", rootRunId: "root-uncertain", stepIndex: 0 },
      failure: "transport_uncertain",
    }));
    expect(ledger.parkUncertain).toHaveBeenCalledWith("root-uncertain", 0);
    expect(ledger.commit).not.toHaveBeenCalled();
  });

  it("rejects a governed announcement route that differs from the captured endpoint", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const caller = makeChannelPrincipalCaller();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", {
        channelId: "telegram-primary",
        channelType: "telegram",
        sendMessage: vi.fn(async () => ok("unexpected-message")),
      }]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ({ ok: true, value: "root-1" }),
    });

    const request = {
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-route-mismatch",
      channelType: "telegram",
      channelId: "other-chat",
      text: "must not send",
      options: { threadId: "topic-7" },
    };
    const result = await delivery.sendLedgerAnnouncement?.(request);

    expect(result).toEqual(ok({ delivered: false, failure: "operation_validation_blocked" }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it.each<[string, AttachmentRouteOverride]>([
    ["adapter instance", { endpoint: { channelInstanceId: "telegram-secondary" } }],
    ["conversation", { channelId: "other-chat" }],
    ["thread", { options: { threadId: "topic-8" } }],
    ["conversation kind", { endpoint: { conversationKind: "shared" as const } }],
  ])("blocks governed attachment delivery when %s authority differs", async (_field, override) => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const sendAttachment = vi.fn(async () => ok({
      kind: "tracked" as const,
      messageId: "unexpected-document-message",
    }));
    const caller = makeChannelPrincipalCaller();
    const cleanup = vi.fn(async () => ok(undefined));
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", {
        channelId: "telegram-primary",
        channelType: "telegram",
        sendMessage: vi.fn(async () => ok("unexpected-message")),
        sendAttachment,
      }]]),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ({ ok: true, value: "root-1" }),
      prepareCompletionAttachment: vi.fn(async () => ok({
        kind: "snapshot" as const,
        sourceAgentId: "agent-1",
        sourcePath: "/workspace/reports/completion-report.csv",
        path: "/tmp/completion-report.csv",
        fileName: "completion-report.csv",
        mimeType: "text/csv",
        contentDigest: "a".repeat(64),
        sizeBytes: 128,
        cleanup,
      })),
    });

    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: { ...caller.endpoint, ...override.endpoint },
      runId: "run-route-mismatch",
      channelType: "telegram",
      channelId: override.channelId ?? "chat-1",
      text: "must not send",
      options: override.options ?? { threadId: "topic-7" },
      attachment: {
        sourceAgentId: "agent-1",
        path: "/workspace/reports/completion-report.csv",
      },
    });

    expect(result).toEqual(ok({ delivered: false, failure: "operation_validation_blocked" }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(sendAttachment).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("delivers a validated generated file as the governed channel operation", async () => {
    const emitSafely = vi.fn(() => ({ failures: [], pendingFailures: Promise.resolve([]) }));
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const cleanup = vi.fn(async () => ok(undefined));
    const sendAttachment = vi.fn(async () => ok({
      kind: "tracked" as const,
      messageId: "document-message",
    }));
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([["telegram", {
        channelId: "telegram-primary",
        channelType: "telegram",
        sendMessage: vi.fn(async () => ok("text-message")),
        sendAttachment,
      }]]),
      deliveryService,
      eventBus: { emitSafely } as unknown as TypedEventBus,
      outwardLedger: ledger,
      resolveRootRunId: () => ({ ok: true, value: "root-1" }),
      prepareCompletionAttachment: vi.fn(async () => ok({
        kind: "snapshot" as const,
        sourceAgentId: "agent-1",
        sourcePath: "/workspace/reports/completion-report.csv",
        path: "/tmp/completion-report.csv",
        fileName: "completion-report.csv",
        mimeType: "text/csv",
        contentDigest: "a".repeat(64),
        sizeBytes: 128,
        cleanup,
      })),
      verifyCompletionAttachment: vi.fn(async (attachment) => ok(attachment)),
    });

    const caller = makeChannelPrincipalCaller();
    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "The report is ready.",
      options: { threadId: "topic-7" },
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
      { threadId: "topic-7" },
    );
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(ledger.commit).toHaveBeenCalledWith("root-1", 0, "document-message");
    expect(emitSafely).toHaveBeenCalledWith(
      "delivery:outward_ledger_transition",
      expect.objectContaining({
        rootRunId: "root-1",
        runId: "run-1",
        sessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
        transition: "prepare",
        outcome: "prepared",
        deliveryKind: "attachment",
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("emits a routed part failure when attachment preparation is rejected", async () => {
    const emitSafely = vi.fn(() => ({ failures: [], pendingFailures: Promise.resolve([]) }));
    const caller = makeChannelPrincipalCaller();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map([[
        "telegram",
        {
          channelId: "telegram-primary",
          channelType: "telegram",
          sendMessage: vi.fn(async () => ok("unexpected-message")),
          sendAttachment: vi.fn(async () => ok({
            kind: "tracked" as const,
            messageId: "unexpected-document-message",
          })),
        },
      ]]),
      deliveryService: makeDeliveryService(),
      eventBus: { emitSafely } as unknown as TypedEventBus,
      outwardLedger: makeLedger(),
      resolveRootRunId: () => ({ ok: true, value: "root-partial" }),
      prepareCompletionAttachment: vi.fn(async () => err(new Error("invalid output"))),
      verifyCompletionAttachment: vi.fn(async (attachment) => ok(attachment)),
    });

    const result = await delivery.sendLedgerAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
      callerConversation: caller.locator,
      destinationEndpoint: caller.endpoint,
      runId: "run-partial",
      partId: "attachment:1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "The second report is ready.",
      options: { threadId: "topic-7" },
      attachment: {
        sourceAgentId: "agent-1",
        path: "/workspace/reports/second-report.csv",
      },
    });

    expect(result).toEqual(ok({
      delivered: false,
      failure: "attachment_preparation_blocked",
    }));
    expect(emitSafely).toHaveBeenCalledWith(
      "delivery:outward_ledger_transition",
      expect.objectContaining({
        rootRunId: "root-partial",
        sessionKey: "tenant-a:agent:agent-1:principal-a:telegram:peer:principal-a",
        partId: "attachment:1",
        transition: "prepare",
        outcome: "failed",
        deliveryKind: "attachment",
      }),
    );
  });
});
