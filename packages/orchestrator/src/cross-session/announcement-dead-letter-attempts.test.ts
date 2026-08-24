// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { OutwardSendLedgerPort } from "@comis/core";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type {
  DeadLetterEntry,
  ParentDecisionReservationRecord,
} from "./announcement-dead-letter-file.js";
import { createDeliveryAttemptStage } from "./announcement-dead-letter-attempts.js";

const authority = {
  tenantId: "default",
  agentId: "agent-a",
  conversationRef: "conversation-a",
};

const endpoint = {
  channelType: "telegram",
  channelInstanceId: "test-instance",
  conversationId: "chat-a",
  conversationKind: "direct" as const,
};

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    announcementText: "completion",
    channelType: "telegram" as const,
    channelId: "chat-a",
    agentId: "agent-a",
    runId: "run-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    failedAt: 0,
    attemptCount: 0,
    idempotencyKey: "operation-a",
    rootRunId: "root-a",
    stepIndex: 0,
    completionKeys: ["operation-a"],
    deliveryAuthority: authority,
    destinationEndpoint: endpoint,
    ...overrides,
  };
}

function makeEntry(overrides: Record<string, unknown> = {}): DeadLetterEntry {
  return {
    ...makeInput(),
    id: "entry-a",
    lastAttemptAt: 0,
    ...overrides,
  } as DeadLetterEntry;
}

function makeReservation(
  overrides: Partial<ParentDecisionReservationRecord> = {},
): ParentDecisionReservationRecord {
  return {
    ...makeInput(),
    recordType: "parent_decision_reservation",
    id: "reservation-a",
    ...overrides,
  } as ParentDecisionReservationRecord;
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const store = {
    entries: [] as DeadLetterEntry[],
    decisionReservations: [] as ParentDecisionReservationRecord[],
    producerReservations: [],
    producerHandoffs: [],
    invalidRecords: [],
    terminalInvalidRecords: [],
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    store,
    maxRetries: 5,
    retryIntervalMs: 0,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
    parentDecisionGraceMs: 0,
    logger,
    outwardLedger: undefined,
    emittedAdmissionKeys: new Set(["operation-a"]),
    loadFromDisk: vi.fn(async () => ok(undefined)),
    persist: vi.fn(async () => ok(undefined)),
    canPersistCounts: vi.fn(() => true),
    cleanupUnreferencedSnapshots: vi.fn(async () => undefined),
    emitAdmission: vi.fn(),
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    terminalizeOwner: vi.fn(async () => ok(undefined)),
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

describe("durable delivery-attempt boundaries", () => {
  it("rejects unreadable terminal state, source attachments, and reservation identity conflicts", async () => {
    const terminalFailure = makeContext({
      lookupTerminalDecision: async () => err(new Error("terminal unavailable")),
    });
    await expect(createDeliveryAttemptStage(terminalFailure).enqueueDurably(makeInput()))
      .resolves.toMatchObject({ ok: false });

    const source = makeContext();
    await expect(createDeliveryAttemptStage(source).enqueueDurably(makeInput({
      attachment: { kind: "source", sourceAgentId: "agent-a", path: "artifact.bin" },
    }))).resolves.toMatchObject({
      ok: false,
      error: { message: "Dead-letter attachment must be snapshotted before enqueue" },
    });

    const conflict = makeContext();
    conflict.store.decisionReservations = [makeReservation({ channelId: "chat-b" })];
    await expect(createDeliveryAttemptStage(conflict).enqueueDurably(makeInput()))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "Parent decision delivery identity mismatch" },
      });
    expect(conflict.logger?.error).toHaveBeenCalledOnce();
  });

  it("keeps incomplete governed reservations and reports enqueue capacity or persistence failures", async () => {
    const ledger = {} as OutwardSendLedgerPort;
    const incomplete = makeContext({ outwardLedger: ledger });
    incomplete.store.decisionReservations = [makeReservation()];
    await expect(createDeliveryAttemptStage(incomplete).enqueueDurably(makeInput({ stepIndex: undefined })))
      .resolves.toEqual(ok(undefined));
    expect(incomplete.persist).not.toHaveBeenCalled();

    const capacity = makeContext({ canPersistCounts: () => false });
    await expect(createDeliveryAttemptStage(capacity).enqueueDurably(makeInput()))
      .resolves.toMatchObject({ ok: false, error: { message: "Dead-letter quarantine capacity exhausted" } });

    const persistence = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    await expect(createDeliveryAttemptStage(persistence).enqueueDurably(makeInput()))
      .resolves.toMatchObject({ ok: false });
    expect(persistence.logger?.error).toHaveBeenCalledOnce();
  });

  it("handles terminal, source, conflicting, parked, and reclaimed delivery claims", async () => {
    const terminalized = makeContext({ lookupTerminalDecision: async () => ok("discarded" as const) });
    await expect(createDeliveryAttemptStage(terminalized).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toEqual(ok({ claimed: false, terminalDecision: "discarded" }));

    const terminalizeFailure = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    await expect(createDeliveryAttemptStage(terminalizeFailure).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({ ok: false });

    const source = makeContext();
    await expect(createDeliveryAttemptStage(source).beginDeliveryAttemptDurably(makeInput({
      attachment: { kind: "source", sourceAgentId: "agent-a", path: "artifact.bin" },
    }))).resolves.toMatchObject({ ok: false });

    const conflict = makeContext();
    conflict.store.entries = [makeEntry({ announcementText: "different" })];
    await expect(createDeliveryAttemptStage(conflict).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({ ok: false, error: { message: "Dead-letter recovery key identity mismatch" } });

    const parked = makeContext();
    parked.store.entries = [makeEntry({ lastError: "outward_operation_unresolved" })];
    await expect(createDeliveryAttemptStage(parked).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toEqual(ok({ claimed: false }));

    const reclaimFailure = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    reclaimFailure.store.entries = [makeEntry({ lastError: "transport_rejected" })];
    await expect(createDeliveryAttemptStage(reclaimFailure).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({ ok: false });
  });

  it("rejects new claim capacity and persistence failures", async () => {
    const reservationConflict = makeContext();
    reservationConflict.store.decisionReservations = [makeReservation({
      announcementText: "different completion",
    })];
    await expect(createDeliveryAttemptStage(reservationConflict).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "Announcement operation reservation identity mismatch" },
      });

    const capacity = makeContext({ canPersistCounts: () => false });
    await expect(createDeliveryAttemptStage(capacity).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({ ok: false, error: { message: "Dead-letter quarantine capacity exhausted" } });

    const persistence = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    await expect(createDeliveryAttemptStage(persistence).beginDeliveryAttemptDurably(makeInput()))
      .resolves.toMatchObject({ ok: false });
  });

  it("settles missing, failed, accepted, and attachment-backed attempts durably", async () => {
    const missing = makeContext();
    await expect(createDeliveryAttemptStage(missing).settleDeliveryAttemptDurably("missing", "rejected"))
      .resolves.toEqual(ok(false));

    const persistFailure = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    persistFailure.store.entries = [makeEntry()];
    await expect(createDeliveryAttemptStage(persistFailure).settleDeliveryAttemptDurably("operation-a", "unknown"))
      .resolves.toMatchObject({ ok: false });

    const terminalizeFailure = makeContext({
      terminalizeOwner: async () => err(new Error("terminal unavailable")),
    });
    terminalizeFailure.store.entries = [makeEntry()];
    await expect(createDeliveryAttemptStage(terminalizeFailure).settleDeliveryAttemptDurably("operation-a", "accepted"))
      .resolves.toMatchObject({ ok: false });

    let persistCount = 0;
    const removalFailure = makeContext({
      persist: async () => ++persistCount === 2
        ? err(new Error("removal unavailable"))
        : ok(undefined),
    });
    removalFailure.store.entries = [makeEntry()];
    await expect(createDeliveryAttemptStage(removalFailure).settleDeliveryAttemptDurably("operation-a", "accepted"))
      .resolves.toMatchObject({ ok: false });

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
    const accepted = makeContext();
    accepted.store.entries = [makeEntry({ attachment: snapshot })];
    await expect(createDeliveryAttemptStage(accepted).settleDeliveryAttemptDurably("operation-a", "accepted"))
      .resolves.toEqual(ok(true));
    expect(accepted.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
  });

  it("validates and reconciles text-chunk manifests", async () => {
    const context = makeContext();
    const stage = createDeliveryAttemptStage(context);
    await expect(stage.recordDecisionTextChunksDurably("operation-a", []))
      .resolves.toMatchObject({ ok: false, error: { message: "Announcement text chunk manifest is invalid" } });
    await expect(stage.recordDecisionTextChunksDurably("operation-a", ["one"])).resolves.toMatchObject({ ok: false });

    context.store.entries = [makeEntry({ textChunks: ["one"] })];
    await expect(stage.recordDecisionTextChunksDurably("operation-a", ["two"])).resolves.toMatchObject({ ok: false });
    await expect(stage.lookupDecisionTextChunksDurably("missing")).resolves.toEqual(ok(undefined));

    context.store.decisionReservations = [makeReservation({
      idempotencyKey: "reservation-b",
      completionKeys: ["operation-a"],
      textChunks: ["two"],
    })];
    await expect(stage.lookupDecisionTextChunksDurably("operation-a")).resolves.toMatchObject({ ok: false });
    await expect(stage.recordDrainingEntryTextChunks(makeEntry({ idempotencyKey: undefined }), ["one"]))
      .resolves.toMatchObject({ ok: false });
  });

  it("parks unreadable reservations and handles terminal or persistence failures", async () => {
    const unreadable = makeContext({
      lookupTerminalDecision: async () => err(new Error("terminal unavailable")),
    });
    unreadable.store.decisionReservations = [makeReservation()];
    await createDeliveryAttemptStage(unreadable).adjudicateReservations();
    expect(unreadable.logger?.warn).toHaveBeenCalledOnce();

    const terminalizeFailure = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    terminalizeFailure.store.decisionReservations = [makeReservation()];
    await createDeliveryAttemptStage(terminalizeFailure).adjudicateReservations();
    expect(terminalizeFailure.persist).not.toHaveBeenCalled();

    const attachment = {
      kind: "snapshot" as const,
      sourceAgentId: "agent-a",
      sourcePath: "artifact.bin",
      path: "/snapshots/artifact.bin",
      fileName: "artifact.bin",
      mimeType: "application/octet-stream",
      contentDigest: "a".repeat(64),
      sizeBytes: 1,
    };
    const persistence = makeContext({ persist: async () => err(new Error("disk unavailable")) });
    persistence.store.decisionReservations = [makeReservation({ attachment })];
    await createDeliveryAttemptStage(persistence).adjudicateReservations();
    expect(persistence.logger?.warn).toHaveBeenCalledTimes(2);
  });

  it("leaves ledger allocation failures parked and promotes allocated attachment retries", async () => {
    const attachment = {
      kind: "snapshot" as const,
      sourceAgentId: "agent-a",
      sourcePath: "artifact.bin",
      path: "/snapshots/artifact.bin",
      fileName: "artifact.bin",
      mimeType: "application/octet-stream",
      contentDigest: "a".repeat(64),
      sizeBytes: 1,
    };
    const blockedLedger = {
      allocateStep: vi.fn(async () => err(new Error("ledger unavailable"))),
    } as unknown as OutwardSendLedgerPort;
    const blocked = makeContext();
    blocked.store.decisionReservations = [makeReservation({ attachment })];
    await createDeliveryAttemptStage(blocked).adjudicateReservations(blockedLedger);
    expect(blocked.store.decisionReservations).toHaveLength(1);

    const ledger = {
      allocateStep: vi.fn(async () => ok(7)),
    } as unknown as OutwardSendLedgerPort;
    const promoted = makeContext();
    promoted.store.decisionReservations = [makeReservation({ attachment })];
    await createDeliveryAttemptStage(promoted).adjudicateReservations(ledger);
    expect(promoted.store.entries[0]?.stepIndex).toBe(7);
    expect(promoted.store.decisionReservations).toEqual([]);
  });
});
