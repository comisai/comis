// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ConversationRefSchema } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type {
  AnnouncementProducerHandoffRecord,
  ProducerReservationRecord,
} from "./announcement-dead-letter-file.js";
import { createProducerPromotionStage } from "./announcement-dead-letter-promotion.js";

const conversationRef = ConversationRefSchema.parse(`cv_${"e".repeat(43)}`);

function makeRecord(
  lifecycleState: ProducerReservationRecord["lifecycleState"] = "promotion_ready",
  overrides: Partial<ProducerReservationRecord> = {},
): ProducerReservationRecord {
  return {
    recordType: "producer_reservation",
    id: "reservation-a",
    idempotencyKey: "operation-a",
    agentId: "agent-a",
    runId: "producer-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    announcementText: "fallback completion",
    channelType: "telegram",
    channelId: "chat-a",
    failedAt: 100,
    rootRunId: "root-a",
    deliveryAuthority: { tenantId: "default", agentId: "agent-a", conversationRef },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-a",
      conversationKind: "direct",
    },
    completionKeys: ["operation-a"],
    producer: {
      kind: "session",
      tenantId: "default",
      agentId: "agent-a",
      conversationRef,
      checkpointId: "producer-a",
    },
    lifecycleState,
    ...overrides,
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const store = {
    entries: [],
    decisionReservations: [],
    producerReservations: [],
    producerHandoffs: [],
    invalidRecords: [],
    terminalInvalidRecords: [],
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    store,
    logger,
    activeProducerKeys: new Set<string>(),
    retirementProducerState: undefined,
    recordProducerOutcomeDurably: vi.fn(async () => ok(undefined)),
    releaseProducerDurably: vi.fn(async () => ok(undefined)),
    removeProducerReservationDurably: vi.fn(async () => ok(undefined)),
    persist: vi.fn(async () => ok(undefined)),
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    recordTerminalDecision: vi.fn(async () => ok(undefined)),
    terminalizeOwner: vi.fn(async () => ok(undefined)),
    decisionStore: {
      reserve: vi.fn(async () => ok({ created: true })),
      replace: vi.fn(async () => ok({ created: true })),
    },
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

describe("announcement producer promotion recovery", () => {
  it("projects each retained producer outcome into its recovery announcement", () => {
    const stage = createProducerPromotionStage(makeContext());
    expect(stage.producerRecoveryAnnouncement(makeRecord("promotion_ready", {
      producer: {
        kind: "tool_result",
        tenantId: "default",
        agentId: "agent-a",
        conversationRef,
        toolCallId: "tool-a",
        operationId: "operation-a",
      },
      recoveryOutcome: {
        kind: "tool_result",
        terminalReason: "completed",
        completedAtMs: 1,
        response: "  tool response  ",
        stats: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    }))).toMatchObject({ announcementText: "tool response" });
    expect(stage.producerRecoveryAnnouncement(makeRecord("promotion_ready", {
      producer: {
        kind: "tool_result",
        tenantId: "default",
        agentId: "agent-a",
        conversationRef,
        toolCallId: "tool-a",
        operationId: "operation-a",
      },
      recoveryOutcome: {
        kind: "tool_result",
        terminalReason: "failed",
        completedAtMs: 1,
        errorKind: "dependency",
        summary: "tool failed",
      },
    }))).toMatchObject({ announcementText: "tool failed" });
    expect(stage.producerRecoveryAnnouncement(makeRecord("promotion_ready", {
      producer: { kind: "graph", tenantId: "default", graphId: "graph-a" },
      recoveryOutcome: {
        kind: "graph",
        terminalReason: "completed",
        completedAtMs: 1,
        announcementText: "graph complete",
        extra: { graphId: "graph-a" },
      },
    }))).toMatchObject({ announcementText: "graph complete", extra: { graphId: "graph-a" } });
    expect(stage.producerRecoveryAnnouncement(makeRecord("promotion_ready", {
      recoveryOutcome: {
        kind: "session",
        terminalReason: "completed",
        completedAtMs: 1,
        summary: "session complete",
        resultRef: { kind: "file", ref: "result.json", bytes: 12 },
      },
    }))).toMatchObject({ announcementText: expect.stringContaining("result.json") });
  });

  it("logs failed producer probes and reconciles pending terminal ownership", async () => {
    const failedProbe = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord("active")] },
      retirementProducerState: async () => err(new Error("producer store unavailable")),
    });
    await createProducerPromotionStage(failedProbe).promoteProducerReservations();
    expect(failedProbe.logger?.warn).toHaveBeenCalledOnce();

    const failedTerminal = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord("no_reply_pending")] },
      terminalizeOwner: vi.fn(async () => err(new Error("terminal store unavailable"))),
    });
    await createProducerPromotionStage(failedTerminal).promoteProducerReservations();
    expect(failedTerminal.removeProducerReservationDurably).not.toHaveBeenCalled();

    const completedTerminal = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord("no_reply_pending")] },
    });
    await createProducerPromotionStage(completedTerminal).promoteProducerReservations();
    expect(completedTerminal.removeProducerReservationDurably).toHaveBeenCalledWith("producer-a");
  });

  it("handles settled authority failures and terminal-decision reconciliation", async () => {
    const settledProbe = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord("delivery_owned")] },
      retirementProducerState: async () => err(new Error("producer store unavailable")),
    });
    await createProducerPromotionStage(settledProbe).promoteProducerReservations();
    expect(settledProbe.logger?.warn).toHaveBeenCalledOnce();

    const lookupFailure = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord()] },
      lookupTerminalDecision: vi.fn(async () => err(new Error("terminal store unavailable"))),
    });
    await createProducerPromotionStage(lookupFailure).promoteProducerReservations();
    expect(lookupFailure.decisionStore.reserve).not.toHaveBeenCalled();

    const reconcileFailure = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord()] },
      lookupTerminalDecision: vi.fn(async () => ok("discarded" as const)),
      terminalizeOwner: vi.fn(async () => err(new Error("terminalization unavailable"))),
    });
    await createProducerPromotionStage(reconcileFailure).promoteProducerReservations();
    expect(reconcileFailure.removeProducerReservationDurably).not.toHaveBeenCalled();

    const reconciled = makeContext({
      store: { ...makeContext().store, producerReservations: [makeRecord()] },
      lookupTerminalDecision: vi.fn(async () => ok("discarded" as const)),
    });
    await createProducerPromotionStage(reconciled).promoteProducerReservations();
    expect(reconciled.removeProducerReservationDurably).toHaveBeenCalledWith("producer-a");
  });

  it("retains handoffs when terminal evidence or replacement persistence fails", async () => {
    const operation = makeRecord();
    const handoff = {
      recordType: "producer_handoff",
      id: "handoff-a",
      transitionId: "transition-a",
      expectedKeys: ["operation-a"],
      operationCount: 1,
      groupDigest: "a".repeat(64),
      operations: [operation],
    } as unknown as AnnouncementProducerHandoffRecord;

    const lookupFailure = makeContext({
      store: { ...makeContext().store, producerHandoffs: [handoff] },
      lookupTerminalDecision: vi.fn(async () => err(new Error("terminal store unavailable"))),
    });
    await createProducerPromotionStage(lookupFailure).promoteProducerHandoffs();
    expect(lookupFailure.decisionStore.replace).not.toHaveBeenCalled();

    const recordFailure = makeContext({
      store: { ...makeContext().store, producerHandoffs: [handoff] },
      lookupTerminalDecision: vi.fn(async () => ok("delivered" as const)),
      recordTerminalDecision: vi.fn(async () => err(new Error("terminal store unavailable"))),
    });
    await createProducerPromotionStage(recordFailure).promoteProducerHandoffs();
    expect(recordFailure.decisionStore.replace).not.toHaveBeenCalled();

    const replaceFailure = makeContext({
      store: { ...makeContext().store, producerHandoffs: [handoff] },
      decisionStore: {
        reserve: vi.fn(),
        replace: vi.fn(async () => err(new Error("snapshot unavailable"))),
      },
    });
    await createProducerPromotionStage(replaceFailure).promoteProducerHandoffs();
    expect(replaceFailure.logger?.warn).toHaveBeenCalledOnce();

    const persistFailure = makeContext({
      store: { ...makeContext().store, producerHandoffs: [handoff] },
      persist: vi.fn(async () => err(new Error("snapshot unavailable"))),
    });
    await createProducerPromotionStage(persistFailure).promoteProducerHandoffs();
    expect(persistFailure.store.producerHandoffs).toHaveLength(1);
  });
});
