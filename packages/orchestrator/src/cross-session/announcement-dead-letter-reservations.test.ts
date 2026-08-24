// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ConversationRefSchema, type AnnouncementParentDecisionReservation } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type { AnnouncementProducerHandoffRecord } from "./announcement-dead-letter-file.js";
import { announcementProducerHandoffDigest } from "./announcement-dead-letter-file.js";
import { createDecisionReservationStage } from "./announcement-dead-letter-reservations.js";

const conversationRef = ConversationRefSchema.parse(`cv_${"e".repeat(43)}`);

function makeDecision(
  overrides: Partial<AnnouncementParentDecisionReservation> = {},
): AnnouncementParentDecisionReservation {
  return {
    idempotencyKey: "operation-a",
    agentId: "agent-a",
    runId: "producer-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    announcementText: "completion",
    channelType: "telegram",
    channelId: "chat-a",
    failedAt: 1,
    rootRunId: "root-a",
    deliveryAuthority: { tenantId: "default", agentId: "agent-a", conversationRef },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-a",
      conversationKind: "direct",
    },
    completionKeys: ["operation-a"],
    ...overrides,
  };
}

function makeHandoff(
  operation = makeDecision(),
  expectedKeys: readonly string[] = ["operation-a"],
): AnnouncementProducerHandoffRecord {
  const digest = announcementProducerHandoffDigest(expectedKeys, [operation]);
  if (!digest.ok) throw digest.error;
  return {
    recordType: "producer_handoff",
    id: "handoff-a",
    transitionId: "transition-a",
    expectedKeys,
    operationCount: 1,
    groupDigest: digest.value,
    operations: [operation],
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const store = {
    entries: [], decisionReservations: [], producerReservations: [],
    producerHandoffs: [] as AnnouncementProducerHandoffRecord[],
    invalidRecords: [], terminalInvalidRecords: [],
  };
  const cleanup = vi.fn(async () => ok(undefined));
  const decisionStore = {
    lookup: vi.fn(async () => ok(undefined)),
    reserve: vi.fn(async () => ok({ created: true })),
  };
  return {
    store,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    eventBus: { emit: vi.fn() },
    loadFromDisk: vi.fn(async () => ok(undefined)),
    persist: vi.fn(async () => ok(undefined)),
    canPersistProducerOwnership: vi.fn(() => true),
    cleanupUnreferencedSnapshots: vi.fn(async () => undefined),
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    terminalizeOwner: vi.fn(async () => ok(undefined)),
    consumeProducerSlots: vi.fn(),
    consumeProducerReservationsDurably: vi.fn(async () => ok(undefined)),
    decisionStore,
    prepareReservedAttachment: vi.fn(async (entry) => ok({ entry, cleanup })),
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

describe("decision reservation and handoff boundaries", () => {
  it("propagates reservation load, terminalization, consumption, and lookup failures", async () => {
    const unreadable = makeContext({ loadFromDisk: async () => err(new Error("disk unavailable")) });
    await expect(createDecisionReservationStage(unreadable).reserveDecisionDurably(makeDecision()))
      .resolves.toMatchObject({ ok: false });

    const terminalizeFailure = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    await expect(createDecisionReservationStage(terminalizeFailure).reserveDecisionDurably(makeDecision()))
      .resolves.toMatchObject({ ok: false });

    const consumptionFailure = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
      consumeProducerReservationsDurably: async () => err(new Error("consumption unavailable")),
    });
    await expect(createDecisionReservationStage(consumptionFailure).reserveDecisionDurably(makeDecision()))
      .resolves.toMatchObject({ ok: false });

    const lookupFailure = makeContext({
      decisionStore: {
        lookup: async () => err(new Error("lookup unavailable")),
        reserve: async () => ok({ created: true }),
      },
    });
    await expect(createDecisionReservationStage(lookupFailure).reserveDecisionDurably(makeDecision()))
      .resolves.toMatchObject({ ok: false });
  });

  it("reuses deferred ownership and cleans an unclaimed prepared snapshot", async () => {
    const deferred = makeContext();
    deferred.store.producerHandoffs = [makeHandoff()];
    await expect(createDecisionReservationStage(deferred).reserveDecisionDurably(makeDecision()))
      .resolves.toEqual(ok({ created: false, deferred: true }));
    expect(deferred.consumeProducerSlots).toHaveBeenCalledOnce();

    const snapshot = {
      kind: "snapshot" as const,
      sourceAgentId: "agent-a",
      sourcePath: "artifact.bin",
      path: "/snapshots/artifact.bin",
      fileName: "artifact.bin",
      mimeType: "application/octet-stream",
      contentDigest: "a".repeat(64),
      sizeBytes: 1,
    };
    const cleanup = vi.fn(async () => ok(undefined));
    const unclaimed = makeContext({
      decisionStore: {
        lookup: async () => ok(undefined),
        reserve: async () => ok({ created: false }),
      },
      prepareReservedAttachment: async (entry: AnnouncementParentDecisionReservation) => ok({
        entry: { ...entry, attachment: snapshot },
        cleanup,
      }),
    });
    await expect(createDecisionReservationStage(unclaimed).reserveDecisionDurably(makeDecision()))
      .resolves.toEqual(ok({ created: false }));
    expect(unclaimed.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
  });

  it("validates empty and duplicate producer handoff sets", async () => {
    const stage = createDecisionReservationStage(makeContext());
    await expect(stage.handoffDecisionsDurably([], [])).resolves.toMatchObject({
      ok: false,
      error: { message: "Announcement producer handoff set is invalid" },
    });
    await expect(stage.handoffDecisionsDurably([], [makeDecision(), makeDecision()]))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "Announcement producer handoff identities are invalid" },
      });
  });

  it("cleans earlier snapshots when a later handoff operation cannot be prepared", async () => {
    let calls = 0;
    const cleanup = vi.fn(async () => ok(undefined));
    const context = makeContext({
      prepareReservedAttachment: async (entry: AnnouncementParentDecisionReservation) => {
        calls += 1;
        return calls === 1
          ? ok({ entry: { ...entry, attachment: {
              kind: "snapshot" as const,
              sourceAgentId: "agent-a", sourcePath: "a", path: "/a", fileName: "a",
              mimeType: "application/octet-stream", contentDigest: "a".repeat(64), sizeBytes: 1,
            } }, cleanup })
          : err(new Error("preparation unavailable"));
      },
    });
    await expect(createDecisionReservationStage(context).handoffDecisionsDurably([], [
      makeDecision(),
      makeDecision({ idempotencyKey: "operation-b", completionKeys: ["operation-b"] }),
    ])).resolves.toMatchObject({ ok: false });
    expect(context.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
  });

  it("accepts an exact retained handoff and rejects a changed one", async () => {
    const exact = makeContext();
    exact.store.producerHandoffs = [makeHandoff()];
    await expect(createDecisionReservationStage(exact).handoffDecisionsDurably(
      ["operation-a"],
      [makeDecision()],
    )).resolves.toEqual(ok({ created: false, deferred: true }));

    const mismatch = makeContext();
    mismatch.store.producerHandoffs = [makeHandoff()];
    await expect(createDecisionReservationStage(mismatch).handoffDecisionsDurably(
      ["changed"],
      [makeDecision()],
    )).resolves.toMatchObject({
      ok: false,
      error: { message: "Announcement producer handoff identity mismatch" },
    });
  });

  it("rejects handoff capacity, digest, and persistence failures", async () => {
    const capacity = makeContext({ canPersistProducerOwnership: () => false });
    await expect(createDecisionReservationStage(capacity).handoffDecisionsDurably([], [makeDecision()]))
      .resolves.toMatchObject({ ok: false, error: { message: "Announcement producer handoff capacity exhausted" } });

    const digest = makeContext();
    await expect(createDecisionReservationStage(digest).handoffDecisionsDurably([], [
      makeDecision({ extra: { invalid: 1n } }),
    ])).resolves.toMatchObject({ ok: false });

    const persistence = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    await expect(createDecisionReservationStage(persistence).handoffDecisionsDurably([], [makeDecision()]))
      .resolves.toMatchObject({ ok: false });
    expect(persistence.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
  });
});
