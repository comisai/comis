// SPDX-License-Identifier: Apache-2.0
/**
 * Parent-decision reservations and their handoff.
 *
 * A reservation records that a parent turn intends to decide the fate of an
 * announcement, so a restart does not race the parent to that decision. Handoff
 * transfers a batch of those intents as one durable unit — partially handing
 * off would leave operations owned by nobody.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  AnnouncementProducerReservation,
  OutwardSendLedgerPort,
} from "@comis/core";
import {
  createStableAnnouncementChunkOperationId,
  createStableAnnouncementChunkPartId,
  emitObservationalEventSafely,
  isStableAnnouncementChunkPartId,
  systemNowMs,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { GovernedAnnouncementAttachment } from "./announcement-outward-operation.js";
import { drainWithPreparedRecoveryAttachment } from "./announcement-dead-letter-attachment.js";
import {
  announcementProducerHandoffDigest,
  isAnnouncementProducerHandoff,
  isAnnouncementProducerRecoveryOutcome,
  isAnnouncementProducerReservation,
  isAnnouncementTextChunks,
  isParentDecisionReservation,
  isValidAnnouncementDecision,
  sameAnnouncementProducerReservation,
  type ChannelType,
  type DeadLetterEntry,
  type AnnouncementProducerHandoffRecord,
  type ParentDecisionReservationRecord,
  type ProducerReservationRecord,
} from "./announcement-dead-letter-file.js";
import { isInvalidDeadLetterRecord, type InvalidDeadLetterRecord } from "./announcement-dead-letter-invalid.js";
import {
  announcementTerminalRetirementDigest,
  terminalDecisionIdentity,
  type AnnouncementTerminalDecision,
} from "./announcement-dead-letter-terminal-decision.js";
import {
  announcementRecoveryKey,
  isSameAnnouncementRecovery,
  isSameGovernedDeadLetterOperation,
  resolveGovernedDeadLetterIdentity,
  type GovernedDeadLetterIdentity,
} from "./announcement-dead-letter-identity.js";
import type { RecoveryDeliveryOptions } from "./announcement-dead-letter-types.js";
import type { DeadLetterQueueContext, GovernedDrainOutcome } from "./announcement-dead-letter-context.js";
import type { AnnouncementDeadLetterAttachmentSnapshot } from "@comis/core";

export function createDecisionReservationStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    logger,
    eventBus,
  } = ctx;
  const consumeProducerReservationsDurably: DeadLetterQueueContext["consumeProducerReservationsDurably"] = (...a) => ctx.consumeProducerReservationsDurably(...a);
  const loadFromDisk: DeadLetterQueueContext["loadFromDisk"] = (...a) => ctx.loadFromDisk(...a);
  const persist: DeadLetterQueueContext["persist"] = (...a) => ctx.persist(...a);
  const canPersistProducerOwnership: DeadLetterQueueContext["canPersistProducerOwnership"] = (...a) => ctx.canPersistProducerOwnership(...a);
  const cleanupUnreferencedSnapshots: DeadLetterQueueContext["cleanupUnreferencedSnapshots"] = (...a) => ctx.cleanupUnreferencedSnapshots(...a);
  const lookupTerminalDecision: DeadLetterQueueContext["lookupTerminalDecision"] = (...a) => ctx.lookupTerminalDecision(...a);
  const terminalizeOwner: DeadLetterQueueContext["terminalizeOwner"] = (...a) => ctx.terminalizeOwner(...a);
  const consumeProducerSlots: DeadLetterQueueContext["consumeProducerSlots"] = (...a) => ctx.consumeProducerSlots(...a);
  async function reserveDecisionDurably(
    entry: AnnouncementParentDecisionReservation,
  ) {
    const loaded = await loadFromDisk();
    if (!loaded.ok) return loaded;
    const terminalDecision = await lookupTerminalDecision(entry);
    if (!terminalDecision.ok) return terminalDecision;
    if (terminalDecision.value !== undefined) {
      const reconciled = await terminalizeOwner(
        entry,
        terminalDecision.value,
        store.entries,
        store.decisionReservations,
      );
      if (!reconciled.ok) return reconciled;
      const consumed = await consumeProducerReservationsDurably([entry.runId]);
      if (!consumed.ok) return consumed;
      return ok({ created: false, terminalDecision: terminalDecision.value });
    }
    const existing = await ctx.decisionStore.lookup(entry.idempotencyKey);
    if (!existing.ok) return existing;
    const deferred = store.producerHandoffs.find((handoff) => handoff.operations.some((operation) =>
      operation.idempotencyKey === entry.idempotencyKey));
    if (deferred) {
      consumeProducerSlots([entry.runId]);
      return ok({ created: false, deferred: true });
    }
    const prepared = await ctx.prepareReservedAttachment(
      entry,
      existing.value ? [existing.value] : [],
    );
    if (!prepared.ok) return prepared;
    const reserved = await ctx.decisionStore.reserve(
      prepared.value.entry as AnnouncementParentDecisionReservation,
    );
    if (
      (!reserved.ok || !reserved.value.created)
      && prepared.value.cleanup
      && prepared.value.entry.attachment?.kind === "snapshot"
    ) {
      await cleanupUnreferencedSnapshots([{
        attachment: prepared.value.entry.attachment,
        cleanup: prepared.value.cleanup,
      }]);
    }
    if (reserved.ok && reserved.value.created) {
      emitObservationalEventSafely(
        { eventBus, logger },
        "announcement:dead_lettered",
        {
          runId: entry.runId,
          sessionKey: entry.sessionKey,
          channelType: entry.channelType,
          reason: "parent_decision_reserved",
          timestamp: systemNowMs(),
        },
      );
    }
    if (reserved.ok) consumeProducerSlots([entry.runId]);
    return reserved;
  }

  async function handoffDecisionsDurably(
    expectedKeys: readonly string[],
    operations: readonly AnnouncementParentDecisionReservation[],
  ): Promise<Result<{ created: boolean; deferred: boolean }, Error>> {
    const loaded = await loadFromDisk();
    if (!loaded.ok) return loaded;
    if (operations.length === 0) {
      return err(new Error("Announcement producer handoff set is invalid"));
    }
    const operationKeys = new Set(operations.map((operation) => operation.idempotencyKey));
    const producerKeys = new Set(operations.map((operation) => operation.runId));
    if (operationKeys.size !== operations.length) {
      return err(new Error("Announcement producer handoff identities are invalid"));
    }
    const existing = store.producerHandoffs.filter((handoff) => handoff.operations.some((operation) =>
      operationKeys.has(operation.idempotencyKey)));
    const reusable = existing.flatMap((handoff) => handoff.operations);
    const preparedOperations: AnnouncementParentDecisionReservation[] = [];
    const transientSnapshots: Array<{
      attachment: AnnouncementDeadLetterAttachmentSnapshot;
      cleanup: () => Promise<Result<void, Error>>;
    }> = [];
    for (const operation of operations) {
      const prepared = await ctx.prepareReservedAttachment(operation, reusable);
      if (!prepared.ok) {
        await cleanupUnreferencedSnapshots(transientSnapshots);
        return prepared;
      }
      const preparedOperation = prepared.value.entry as AnnouncementParentDecisionReservation;
      preparedOperations.push(preparedOperation);
      if (prepared.value.cleanup && preparedOperation.attachment?.kind === "snapshot") {
        transientSnapshots.push({
          attachment: preparedOperation.attachment,
          cleanup: prepared.value.cleanup,
        });
      }
    }
    if (existing.length > 0) {
      const retainedOperations = existing.flatMap((handoff) => handoff.operations);
      const existingKeys = new Set(retainedOperations.map((operation) => operation.idempotencyKey));
      const exact = retainedOperations.length === preparedOperations.length
        && preparedOperations.every((operation) => {
          const retained = retainedOperations.find((candidate) =>
            candidate.idempotencyKey === operation.idempotencyKey);
          return retained !== undefined
            && JSON.stringify(retained) === JSON.stringify(operation)
            && existing.every((handoff) =>
              JSON.stringify(handoff.expectedKeys) === JSON.stringify(expectedKeys));
        })
        && existingKeys.size === operationKeys.size;
      await cleanupUnreferencedSnapshots(transientSnapshots);
      consumeProducerSlots(producerKeys);
      return exact
        ? ok({ created: false, deferred: true })
        : err(new Error("Announcement producer handoff identity mismatch"));
    }
    if (!canPersistProducerOwnership(
      store.producerHandoffs.length + store.producerReservations.length + 1,
      producerKeys,
    )) {
      await cleanupUnreferencedSnapshots(transientSnapshots);
      return err(new Error("Announcement producer handoff capacity exhausted"));
    }
    const transitionId = tryCatch(() => randomUUID());
    if (!transitionId.ok) {
      await cleanupUnreferencedSnapshots(transientSnapshots);
      return transitionId;
    }
    const groupDigest = announcementProducerHandoffDigest(expectedKeys, preparedOperations);
    if (!groupDigest.ok) {
      await cleanupUnreferencedSnapshots(transientSnapshots);
      return groupDigest;
    }
    const record: AnnouncementProducerHandoffRecord = {
      recordType: "producer_handoff",
      id: `handoff:${transitionId.value}`,
      transitionId: transitionId.value,
      expectedKeys: [...expectedKeys],
      operationCount: preparedOperations.length,
      groupDigest: groupDigest.value,
      operations: preparedOperations,
    };
    const persisted = await persist(
      store.entries,
      store.decisionReservations,
      store.invalidRecords,
      [...store.producerHandoffs, record],
    );
    if (!persisted.ok) {
      await cleanupUnreferencedSnapshots(transientSnapshots);
      return persisted;
    }
    store.producerHandoffs = [...store.producerHandoffs, record];
    consumeProducerSlots(producerKeys);
    return ok({ created: false, deferred: true });
  }

  return {
    reserveDecisionDurably,
    handoffDecisionsDurably,
  };
}
