// SPDX-License-Identifier: Apache-2.0

import {
  createDeliveryService,
  createConversationLocator,
  createNoOpDeliveryQueue,
  type AnnouncementDeadLetterEntryInput,
  type AnnouncementParentDecisionReservation,
  type ComisLogger,
  type DeliveryService,
  type HookRunner,
  type TypedEventBus,
} from "@comis/core";
import { createAnnouncementDeadLetterQueue } from "@comis/orchestrator";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createReceiptAwareRecoverableAnnouncementDelivery,
  createRecoverableAnnouncementDelivery,
} from "./recoverable-announcement-delivery.js";

function makeRequest() {
  const conversation = createConversationLocator({
    tenantId: "default",
    agentId: "agent-1",
    partition: { kind: "agent" },
  });
  if (!conversation.ok) throw conversation.error;
  return {
    agentId: "agent-1",
    callerSessionKey: "default:user_a:telegram:chat-1",
    callerConversation: conversation.value,
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "telegram-primary",
      conversationId: "chat-1",
      conversationKind: "direct" as const,
    },
    runId: "run-1",
    channelType: "telegram",
    channelId: "chat-1",
    text: "completion",
    completionKeys: ["default:user_a:telegram:chat-1::run-1"],
  };
}

function makeChunkingDeliveryService() {
  return createDeliveryService({
    hookRunner: {
      runBeforeDelivery: vi.fn(async () => undefined),
      runAfterDelivery: vi.fn(async () => undefined),
    } as unknown as HookRunner,
    deliveryQueue: createNoOpDeliveryQueue(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ComisLogger,
    clock: {
      now: () => 1_000,
      nowDate: () => new Date(1_000),
    },
    maxCharsOverride: 32,
  });
}

function makeEventBus() {
  return {
    emitSafely: vi.fn(() => ({
      hadListeners: false,
      failures: [],
      pendingFailures: Promise.resolve([]),
    })),
  } as unknown as TypedEventBus;
}

describe("recoverable completion announcement delivery", () => {
  it("persists the operation before sending and retains a failed attempt", async () => {
    const order: string[] = [];
    let retained: AnnouncementParentDecisionReservation | undefined;
    const deadLetterQueue = {
      lookupDecision: vi.fn(async () => {
        order.push("lookup");
        return ok(retained
          ? { ...retained, textChunks: ["persisted first", "persisted second"] }
          : undefined);
      }),
      reserveDecision: vi.fn(async (reservation: AnnouncementParentDecisionReservation) => {
        order.push("reserve");
        retained = reservation;
        return ok({ created: true });
      }),
      resolveDecision: vi.fn(async () => ok(true)),
    };
    const send = vi.fn(async () => {
      order.push("send");
      return ok({
        delivered: false as const,
        identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
        failure: "transport_uncertain" as const,
      });
    });
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue,
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery({
      ...makeRequest(),
      options: {
        threadId: "topic-1",
        extra: { reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] } },
      },
      destinationEndpoint: {
        ...makeRequest().destinationEndpoint,
        threadId: "topic-1",
      },
    });

    expect(result).toMatchObject({ ok: true, value: { delivered: false } });
    expect(order).toEqual(["lookup", "reserve", "lookup", "send"]);
    const operationId = retained?.idempotencyKey;
    expect(retained).toMatchObject({
      rootRunId: "root-1",
      completionKeys: [operationId, "default:user_a:telegram:chat-1::run-1"],
      threadId: "topic-1",
      extra: { reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] } },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      preparedTextChunks: ["persisted first", "persisted second"],
    }));
    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
  });

  it("blocks transport when durable admission has no capacity", async () => {
    const send = vi.fn();
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue: {
        lookupDecision: vi.fn(async () => ok(undefined)),
        reserveDecision: vi.fn(async () => err(new Error("capacity exhausted"))),
        resolveDecision: vi.fn(async () => ok(true)),
      },
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery(makeRequest());

    expect(result).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the immutable attachment retained by durable admission", async () => {
    let retained: AnnouncementParentDecisionReservation | undefined;
    const snapshot = {
      kind: "snapshot" as const,
      sourceAgentId: "worker-a",
      sourcePath: "/workspace/report.csv",
      path: "/data/completion-attachments/snapshot.csv",
      fileName: "report.csv",
      mimeType: "text/csv",
      contentDigest: "a".repeat(64),
      sizeBytes: 12,
    };
    const send = vi.fn(async () => ok({
      delivered: true as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
      platformMessageId: "message-1",
    }));
    const deadLetterQueue = {
      lookupDecision: vi.fn(async () => ok(retained
        ? { ...retained, attachment: snapshot }
        : undefined)),
      reserveDecision: vi.fn(async (reservation: AnnouncementParentDecisionReservation) => {
        retained = reservation;
        return ok({ created: true });
      }),
      resolveDecision: vi.fn(async () => ok(true)),
    };
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue,
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery({
      ...makeRequest(),
      attachment: { sourceAgentId: "worker-a", path: "/workspace/report.csv" },
    });

    expect(result).toMatchObject({ ok: true, value: { delivered: true } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      preparedAttachment: snapshot,
    }));
    expect(deadLetterQueue.resolveDecision).toHaveBeenCalledOnce();
  });

  it("returns terminal settlement evidence when durable admission is already decided", async () => {
    const send = vi.fn(async () => ok({
      delivered: false as const,
      terminalDecision: "discarded" as const,
    }));
    const deadLetterQueue = {
      lookupDecision: vi.fn(async () => ok(undefined)),
      reserveDecision: vi.fn(async () => ok({ created: false })),
      resolveDecision: vi.fn(async () => ok(false)),
    };
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue,
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery(makeRequest());

    expect(result).toEqual(ok({ delivered: false, terminalDecision: "discarded" }));
    expect(send).toHaveBeenCalledOnce();
    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
  });
});

describe("receipt-aware completion announcement delivery", () => {
  it("persists chunk identities and does not replay an accepted prefix", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "receipt-aware-announcement-"));
    const filePath = join(tmpDir, "dead-letter.jsonl");
    const order: string[] = [];
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: makeEventBus(),
      retryIntervalMs: 0,
    });
    const deadLetterQueue = {
      lookupDecision: vi.fn(queue.lookupDecision),
      lookupDecisionTextChunks: vi.fn(queue.lookupDecisionTextChunks),
      reserveDecision: vi.fn(async (reservation: AnnouncementParentDecisionReservation) => {
        order.push("reserve");
        return queue.reserveDecision(reservation);
      }),
      recordDecisionTextChunks: vi.fn(async (key: string, chunks: readonly string[]) => {
        order.push("manifest");
        return queue.recordDecisionTextChunks(key, chunks);
      }),
      replaceDecisions: vi.fn(async (
        expectedKeys: readonly string[],
        operations: readonly AnnouncementParentDecisionReservation[],
      ) => {
        order.push("replace");
        return queue.replaceDecisions(expectedKeys, operations);
      }),
      beginDeliveryAttempt: vi.fn(async (entry: AnnouncementDeadLetterEntryInput) => {
        order.push("begin");
        return queue.beginDeliveryAttempt(entry);
      }),
      settleDeliveryAttempt: vi.fn(async (key: string, outcome: "accepted" | "rejected" | "unknown") => {
        order.push(`settle:${outcome}`);
        return queue.settleDeliveryAttempt(key, outcome);
      }),
    };
    const sendMessage = vi.fn(async () => {
      order.push("send");
      return sendMessage.mock.calls.length === 1
        ? ok("message-first")
        : err(new Error("503 response unavailable after dispatch"));
    });
    const delivery = createReceiptAwareRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram", sendMessage }],
      ]),
      deadLetterQueue,
      deliveryService: makeChunkingDeliveryService(),
    });
    const request = {
      ...makeRequest(),
      text: "First durable paragraph.\n\nSecond durable paragraph.\n\nThird durable paragraph.",
    };

    try {
      const result = await delivery(request);

      expect(result).toEqual(ok({ delivered: false, status: "unknown" }));
      expect(order.indexOf("manifest")).toBeLessThan(order.indexOf("send"));
      expect(order.indexOf("replace")).toBeLessThan(order.indexOf("send"));
      const claimedKeys = deadLetterQueue.beginDeliveryAttempt.mock.calls.map(([entry]) =>
        entry.idempotencyKey);
      expect(claimedKeys).toHaveLength(2);
      expect(new Set(claimedKeys).size).toBe(2);
      expect(deadLetterQueue.beginDeliveryAttempt.mock.calls.map(([entry]) => entry.textChunks))
        .toEqual([undefined, undefined]);
      const chunkReservations = deadLetterQueue.replaceDecisions.mock.calls.at(-1)?.[1] ?? [];
      expect(chunkReservations.filter((entry) => entry.textChunks !== undefined)).toHaveLength(1);
      expect(deadLetterQueue.settleDeliveryAttempt.mock.calls.map(([, outcome]) => outcome))
        .toEqual(["accepted", "unknown"]);
      const firstPassRows = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          idempotencyKey: string;
          lastError?: string;
          recordType?: string;
        });
      expect(firstPassRows).toHaveLength(2);
      expect(firstPassRows[0]).toEqual(expect.objectContaining({
        idempotencyKey: claimedKeys[1],
        lastError: "outward_operation_unresolved",
      }));
      expect(firstPassRows[1]).toEqual(expect.objectContaining({
        recordType: "parent_decision_reservation",
      }));

      const restartedQueue = createAnnouncementDeadLetterQueue({
        filePath,
        eventBus: makeEventBus(),
        retryIntervalMs: 0,
      });
      const replaySend = vi.fn(async () => ok("unexpected-replay"));
      const replay = createReceiptAwareRecoverableAnnouncementDelivery({
        adaptersByType: new Map([
          ["telegram", {
            channelId: "telegram-primary",
            channelType: "telegram",
            sendMessage: replaySend,
          }],
        ]),
        deadLetterQueue: restartedQueue,
        deliveryService: makeChunkingDeliveryService(),
      });

      await expect(replay(request)).resolves.toEqual(
        ok({ delivered: false, status: "unknown" }),
      );
      expect(replaySend).not.toHaveBeenCalled();
      const retainedRows = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { idempotencyKey: string });
      expect(retainedRows.map((row) => row.idempotencyKey))
        .toEqual(firstPassRows.map((row) => row.idempotencyKey));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an authoritative terminal outcome without invoking delivery", async () => {
    const deliveryService = { deliverToChannel: vi.fn() };
    const retireTerminalDecisions = vi.fn(async () => ok(undefined));
    const delivery = createReceiptAwareRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", {
          channelId: "telegram-primary",
          channelType: "telegram",
          sendMessage: vi.fn(),
        }],
      ]),
      deadLetterQueue: {
        lookupDecision: vi.fn(async () => ok(undefined)),
        lookupDecisionTextChunks: vi.fn(async () => ok(undefined)),
        reserveDecision: vi.fn(async () => ok({
          created: false,
          terminalDecision: "delivered" as const,
        })),
        recordDecisionTextChunks: vi.fn(async () => ok(undefined)),
        replaceDecisions: vi.fn(async () => ok({ created: false })),
        beginDeliveryAttempt: vi.fn(async () => ok({ claimed: false })),
        settleDeliveryAttempt: vi.fn(async () => ok(false)),
        retireTerminalDecisions,
      },
      deliveryService: deliveryService as unknown as DeliveryService,
    });

    await expect(delivery({ ...makeRequest(), retireOnSettlement: true })).resolves.toEqual(
      ok({ delivered: false, terminalDecision: "delivered" }),
    );
    expect(retireTerminalDecisions).toHaveBeenCalledWith([
      expect.stringMatching(/^completion-announcement:[a-f0-9]{64}$/u),
      "default:user_a:telegram:chat-1::run-1",
    ]);
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("cancels direct admission through the shared delivery lifecycle", async () => {
    const lifecycle = new AbortController();
    const deliveryService = { deliverToChannel: vi.fn() };
    const reserveDecision = vi.fn((_entry, signal?: AbortSignal) =>
      new Promise<{ ok: true; value: { created: boolean; deferred: boolean } }>((resolve) => {
        const retain = (): void => {
          resolve(ok({ created: false, deferred: true }));
        };
        if (signal?.aborted) {
          retain();
        } else {
          signal?.addEventListener("abort", retain, { once: true });
        }
      }));
    const delivery = createReceiptAwareRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", {
          channelId: "telegram-primary",
          channelType: "telegram",
          sendMessage: vi.fn(),
        }],
      ]),
      deadLetterQueue: {
        lookupDecision: vi.fn(async () => ok(undefined)),
        lookupDecisionTextChunks: vi.fn(async () => ok(undefined)),
        reserveDecision,
        recordDecisionTextChunks: vi.fn(async () => ok(undefined)),
        replaceDecisions: vi.fn(async () => ok({ created: false })),
        beginDeliveryAttempt: vi.fn(async () => ok({ claimed: false })),
        settleDeliveryAttempt: vi.fn(async () => ok(false)),
      },
      deliveryService: deliveryService as unknown as DeliveryService,
      lifecycleSignal: lifecycle.signal,
    });

    const pending = delivery(makeRequest());
    lifecycle.abort();

    await expect(pending).resolves.toEqual(ok({ delivered: false, status: "unknown" }));
    expect(reserveDecision).toHaveBeenCalledWith(expect.any(Object), lifecycle.signal);
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });
});
