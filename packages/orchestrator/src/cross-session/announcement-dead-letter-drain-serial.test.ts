// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type { DeadLetterEntry } from "./announcement-dead-letter-file.js";
import { createSerialDrainStage } from "./announcement-dead-letter-drain-serial.js";

function makeEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: "entry-a",
    announcementText: "completion",
    channelType: "telegram",
    channelId: "chat-a",
    runId: "run-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    failedAt: Date.now(),
    attemptCount: 0,
    lastAttemptAt: 0,
    idempotencyKey: "operation-a",
    completionKeys: ["operation-a"],
    ...overrides,
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const store = {
    entries: [makeEntry()],
    decisionReservations: [],
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
    logger,
    outwardLedger: undefined,
    emittedAdmissionKeys: new Set(["operation-a"]),
    receiptAwareSendToChannel: undefined,
    promoteProducerReservations: vi.fn(async () => undefined),
    promoteProducerHandoffs: vi.fn(async () => undefined),
    loadFromDisk: vi.fn(async () => ok(undefined)),
    persist: vi.fn(async () => ok(undefined)),
    collectTerminalRetirementsDurably: vi.fn(async () => ok(0)),
    cleanupUnreferencedSnapshots: vi.fn(async () => undefined),
    emitDelivered: vi.fn(),
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    recordTerminalDecision: vi.fn(async () => ok(undefined)),
    terminalizeOwner: vi.fn(async () => ok(undefined)),
    textChunkOwners: vi.fn(() => []),
    unresolvedChunkOperationId: vi.fn(() => undefined),
    drainGovernedEntry: vi.fn(async () => "retained" as const),
    adjudicateReservations: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

describe("serialized dead-letter drain boundaries", () => {
  it("stops on unreadable state and reports retirement collection failures", async () => {
    const unreadable = makeContext({ loadFromDisk: async () => err(new Error("unreadable")) });
    await createSerialDrainStage(unreadable).drainSerialized(vi.fn(async () => true));
    expect(unreadable.persist).not.toHaveBeenCalled();

    const retirementFailure = makeContext({
      store: { ...makeContext().store, entries: [] },
      collectTerminalRetirementsDurably: async () => err(new Error("retirement unavailable")),
    });
    await createSerialDrainStage(retirementFailure).drainSerialized(vi.fn(async () => true));
    expect(retirementFailure.logger?.warn).toHaveBeenCalledOnce();
  });

  it("retains entries when terminal decisions cannot be read or applied", async () => {
    const lookupFailure = makeContext({
      lookupTerminalDecision: async () => err(new Error("terminal store unavailable")),
    });
    await createSerialDrainStage(lookupFailure).drainSerialized(vi.fn(async () => true));
    expect(lookupFailure.store.entries).toHaveLength(1);
    expect(lookupFailure.logger?.warn).toHaveBeenCalledOnce();

    const terminalizeFailure = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    await createSerialDrainStage(terminalizeFailure).drainSerialized(vi.fn(async () => true));
    expect(terminalizeFailure.store.entries).toHaveLength(1);
  });

  it("removes an entry whose terminal decision is already durable", async () => {
    const context = makeContext({
      lookupTerminalDecision: async () => ok("discarded" as const),
    });
    const onDelivered = vi.fn();
    await createSerialDrainStage(context).drainSerialized(vi.fn(async () => true), onDelivered);

    expect(context.store.entries).toEqual([]);
    expect(onDelivered).toHaveBeenCalledWith("operation-a");
    expect(context.emitDelivered).not.toHaveBeenCalled();
  });

  it("finishes accepted terminalization before attempting another delivery", async () => {
    const failed = makeContext({
      store: { ...makeContext().store, entries: [makeEntry({ lastError: "receipt_accepted_terminalization_pending" })] },
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    const send = vi.fn(async () => true);
    await createSerialDrainStage(failed).drainSerialized(send);
    expect(send).not.toHaveBeenCalled();
    expect(failed.store.entries).toHaveLength(1);

    const completed = makeContext({
      store: { ...makeContext().store, entries: [makeEntry({ lastError: "receipt_accepted_terminalization_pending" })] },
    });
    await createSerialDrainStage(completed).drainSerialized(send);
    expect(completed.store.entries).toEqual([]);
  });

  it("retains accepted sends when pending state or terminalization cannot persist", async () => {
    let callCount = 0;
    const pendingFailure = makeContext({
      receiptAwareSendToChannel: async () => ok({
        delivered: true as const,
        status: "accepted" as const,
        platformMessageId: "message-a",
      }),
      persist: vi.fn(async () => {
        callCount += 1;
        return callCount === 2 ? err(new Error("pending snapshot unavailable")) : ok(undefined);
      }),
    });
    await createSerialDrainStage(pendingFailure).drainSerialized(vi.fn(async () => true));
    expect(pendingFailure.store.entries).toHaveLength(1);

    const terminalizeFailure = makeContext({
      receiptAwareSendToChannel: async () => ok({
        delivered: true as const,
        status: "accepted" as const,
        platformMessageId: "message-a",
      }),
      terminalizeOwner: async () => err(new Error("terminalization unavailable")),
    });
    await createSerialDrainStage(terminalizeFailure).drainSerialized(vi.fn(async () => true));
    expect(terminalizeFailure.store.entries[0]?.lastError)
      .toBe("receipt_accepted_terminalization_pending");
  });

  it("distinguishes rejected and unresolved receipt-aware sends", async () => {
    const rejected = makeContext({
      receiptAwareSendToChannel: async () => ok({
        delivered: false as const,
        status: "rejected" as const,
      }),
    });
    await createSerialDrainStage(rejected).drainSerialized(vi.fn(async () => true));
    expect(rejected.store.entries[0]?.lastError).toBe("transport_rejected");

    const unresolved = makeContext({
      receiptAwareSendToChannel: async () => err(new Error("transport unavailable")),
    });
    await createSerialDrainStage(unresolved).drainSerialized(vi.fn(async () => true));
    expect(unresolved.store.entries[0]?.lastError).toBe("outward_operation_unresolved");
  });

  it("does not acknowledge delivered entries when final queue persistence fails", async () => {
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
    const context = makeContext({
      store: { ...makeContext().store, entries: [makeEntry({ attachment: snapshot })] },
      lookupTerminalDecision: async () => ok("delivered" as const),
      persist: async () => err(new Error("snapshot unavailable")),
    });
    await createSerialDrainStage(context).drainSerialized(vi.fn(async () => true));

    expect(context.logger?.error).toHaveBeenCalledOnce();
    expect(context.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
    expect(context.store.entries).toHaveLength(1);
  });

  it("retains unresolved chunk ownership and applies a durable chunk decision", async () => {
    const chunkOwner = {
      ...makeEntry(),
      idempotencyKey: "chunk-a",
      completionKeys: ["operation-a", "chunk-a"],
    };
    const missingOwner = makeContext({
      textChunkOwners: () => [chunkOwner],
      unresolvedChunkOperationId: () => "chunk-missing",
      receiptAwareSendToChannel: async () => ok({
        delivered: true as const,
        status: "accepted" as const,
      }),
    });
    await createSerialDrainStage(missingOwner).drainSerialized(vi.fn(async () => true));
    expect(missingOwner.store.entries).toHaveLength(1);

    const discarded = makeContext({
      textChunkOwners: () => [chunkOwner],
      unresolvedChunkOperationId: () => "chunk-a",
      lookupTerminalDecision: async () => ok("discarded" as const),
      receiptAwareSendToChannel: async () => ok({
        delivered: true as const,
        status: "accepted" as const,
      }),
    });
    await createSerialDrainStage(discarded).drainSerialized(vi.fn(async () => true));
    expect(discarded.store.entries).toEqual([]);
  });

  it("retains ambiguous ledgerless entries without calling the channel", async () => {
    for (const lastError of [
      "outward_operation_in_flight",
      "outward_operation_unresolved",
      "attachment_delivery_unavailable",
    ]) {
      const context = makeContext({
        store: { ...makeContext().store, entries: [makeEntry({ lastError })] },
      });
      const send = vi.fn(async () => true);
      await createSerialDrainStage(context).drainSerialized(send);
      expect(send).not.toHaveBeenCalled();
    }
  });
});
