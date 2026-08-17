// SPDX-License-Identifier: Apache-2.0
/**
 * Reading the dead-letter file in and writing it back out.
 *
 * Load is idempotent and lazy: every durable operation calls it first, so the
 * queue never acts on a stale view after another process rewrote the file.
 * Rows that fail validation are quarantined rather than dropped — a row nobody
 * can parse is still evidence that an announcement was owed.
 *
 * Persist rewrites all record kinds together in one atomic replace, which is
 * why they are read and swapped as a single set.
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
import {
  readDeadLetterSnapshot,
  validateDeadLetterSnapshotAdmission,
  writeDeadLetterEntries,
  type StoredDeadLetterEntry,
} from "./announcement-dead-letter-file.js";
import {
  CHUNK_IN_FLIGHT_PREFIX,
  CHUNK_UNRESOLVED_PREFIX,
} from "./announcement-dead-letter-context.js";
import type { DeadLetterQueueContext, GovernedDrainOutcome } from "./announcement-dead-letter-context.js";

export function createStorageStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    maxEntries,
    filePath,
    logger,
    outwardLedger,
    activeProducerKeys,
    reconcileAttachments,
    retirementProducerState,
    fileOperations,
    terminalDecisionStore,
  } = ctx;
  // Owned here: the load is lazy and idempotent, and this flag is the only
  // thing that makes a second call cheap rather than a redundant file read.
  let loaded = false;
  const snapshotRecords: DeadLetterQueueContext["snapshotRecords"] = (...a) => ctx.snapshotRecords(...a);
  async function collectTerminalRetirementsDurably(): Promise<Result<number, Error>> {
    if (!retirementProducerState) return ok(0);
    const retainedDigests = new Set<string>();
    const retainedOwners = [
      ...store.entries,
      ...store.decisionReservations,
      ...store.producerReservations,
      ...store.producerHandoffs.flatMap((handoff) => handoff.operations),
    ];
    for (const owner of retainedOwners) {
      const keys = owner.retirementKeys && owner.retirementKeys.length > 0
        ? owner.retirementKeys
        : owner.completionKeys && owner.completionKeys.length > 0
          ? owner.completionKeys
        : owner.idempotencyKey
          ? [owner.idempotencyKey]
          : [];
      for (const key of keys) {
        const digest = announcementTerminalRetirementDigest(key);
        if (!digest.ok) return digest;
        retainedDigests.add(digest.value);
      }
    }
    return terminalDecisionStore.collectRetirements(
      async (producer) => {
        const state = await retirementProducerState(producer);
        return state.ok ? ok(state.value.status === "active") : state;
      },
      (completionKeyDigests) => ok(
        completionKeyDigests.some((digest) => retainedDigests.has(digest)),
      ),
    );
  }

  async function refreshTerminalInvalidRecords(): Promise<Result<void, Error>> {
    if (outwardLedger) {
      store.terminalInvalidRecords = [];
      return ok(undefined);
    }
    const previousIds = store.terminalInvalidRecords.map((record) => record.id).sort().join("\u0000");
    const terminalInvalid = await terminalDecisionStore.listInvalid();
    if (!terminalInvalid.ok) {
      logger?.error(
        {
          errorKind: "resource" as const,
          hint: "restore terminal-decision storage before accepting ledgerless announcements",
        },
        "Terminal-decision quarantine could not be inspected",
      );
      return terminalInvalid;
    }
    store.terminalInvalidRecords = [...terminalInvalid.value];
    const nextIds = store.terminalInvalidRecords.map((record) => record.id).sort().join("\u0000");
    if (store.terminalInvalidRecords.length > 0 && nextIds !== previousIds) {
      logger?.warn(
        {
          invalidRecordCount: store.terminalInvalidRecords.length,
          errorKind: "precondition" as const,
          hint: "repair the quarantined terminal-decision records; unaffected delivery identities remain available",
        },
        "Invalid terminal-decision records quarantined",
      );
    }
    return ok(undefined);
  }

  async function loadFromDisk(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
    const read = await readDeadLetterSnapshot(filePath, logger);
    if (read.ok) {
      if (read.value.invalidRowCount > 0) {
        const normalized = await writeDeadLetterEntries(
          filePath,
          read.value.entries,
          fileOperations,
        );
        if (!normalized.ok) {
          logger?.error(
            {
              invalidRowCount: read.value.invalidRowCount,
              errorKind: "resource" as const,
              hint: "restore dead-letter storage so invalid rows can be isolated before delivery continues",
            },
            "Invalid dead-letter evidence was not durably isolated",
          );
          return err(normalized.error.error);
        }
      }
      const loadedEntries = read.value.entries.filter((entry): entry is DeadLetterEntry =>
        !isParentDecisionReservation(entry)
        && !isAnnouncementProducerReservation(entry)
        && !isAnnouncementProducerHandoff(entry)
        && !isInvalidDeadLetterRecord(entry));
      store.decisionReservations = read.value.entries.filter(isParentDecisionReservation);
      store.producerReservations = read.value.entries.filter(isAnnouncementProducerReservation);
      store.producerHandoffs = read.value.entries.filter(isAnnouncementProducerHandoff);
      store.invalidRecords = read.value.entries.filter(isInvalidDeadLetterRecord);
      if (store.producerHandoffs.length > maxEntries) {
        return err(new Error("Announcement producer handoff capacity is invalid"));
      }
      const recoveredInFlight = loadedEntries.some((entry) =>
        entry.lastError === "outward_operation_in_flight"
        || entry.lastError?.startsWith(CHUNK_IN_FLIGHT_PREFIX) === true);
      store.entries = loadedEntries.map((entry) => {
        if (entry.lastError === "outward_operation_in_flight") {
          return { ...entry, lastError: "outward_operation_unresolved" };
        }
        if (entry.lastError?.startsWith(CHUNK_IN_FLIGHT_PREFIX) === true) {
          return {
            ...entry,
            lastError: `${CHUNK_UNRESOLVED_PREFIX}${entry.lastError.slice(CHUNK_IN_FLIGHT_PREFIX.length)}`,
          };
        }
        return entry;
      });
      if (recoveredInFlight) {
        const recovered = await writeDeadLetterEntries(
          filePath,
          [
            ...store.entries,
            ...store.decisionReservations,
            ...store.producerReservations,
            ...store.producerHandoffs,
            ...store.invalidRecords,
          ],
          fileOperations,
        );
        if (!recovered.ok) return err(recovered.error.error);
      }
      if (reconcileAttachments) {
        const referencedPaths = [
          ...store.entries.flatMap((entry) =>
            entry.attachment?.kind === "snapshot" ? [entry.attachment.path] : []),
          ...store.decisionReservations.flatMap((reservation) =>
            reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
          ...store.producerReservations.flatMap((reservation) =>
            reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
          ...store.producerHandoffs.flatMap((handoff) => handoff.operations.flatMap((operation) =>
            operation.attachment?.kind === "snapshot" ? [operation.attachment.path] : [])),
        ];
        const reconciled = await fromPromise(reconcileAttachments(referencedPaths));
        if (!reconciled.ok || !reconciled.value.ok) {
          logger?.error(
            {
              errorKind: "resource" as const,
              hint: "restore completion-attachment storage before accepting retained announcements",
            },
            "Completion attachment snapshots could not be reconciled",
          );
          return reconciled.ok ? reconciled.value : reconciled;
        }
      }
      const terminalInvalid = await refreshTerminalInvalidRecords();
      if (!terminalInvalid.ok) return terminalInvalid;
      loaded = true;
      const collectedRetirements = await collectTerminalRetirementsDurably();
      if (!collectedRetirements.ok) {
        logger?.warn(
          {
            errorKind: "resource" as const,
            hint: "restore terminal-decision storage; durable retirement intents will retry on the next recovery pass",
          },
          "Announcement terminal retirement intents could not be collected",
        );
      }
      logger?.debug(
        {
          entryCount: store.entries.length + store.decisionReservations.length + store.invalidRecords.length,
          producerReservationCount: store.producerReservations.length,
          producerHandoffCount: store.producerHandoffs.length,
        },
        "Loaded dead-letter store.entries from disk",
      );
      return ok(undefined);
    }
    logger?.warn(
      {
        errorKind: "resource" as const,
        hint: "restore dead-letter storage access before accepting or draining announcements",
      },
      "Failed to read dead-letter file",
    );
    return err(read.error);
  }

  async function persist(
    nextEntries: readonly DeadLetterEntry[],
    nextReservations: readonly ParentDecisionReservationRecord[] = store.decisionReservations,
    nextInvalidRecords: readonly InvalidDeadLetterRecord[] = store.invalidRecords,
    nextProducerHandoffs: readonly AnnouncementProducerHandoffRecord[] = store.producerHandoffs,
    nextProducerReservations: readonly ProducerReservationRecord[] = store.producerReservations,
    consumedProducerKeys: readonly string[] = [],
  ): Promise<Result<void, Error>> {
    const transferredProducerKeys = new Set([
      ...nextEntries.map((entry) => entry.runId),
      ...nextReservations.map((reservation) => reservation.runId),
      ...nextProducerHandoffs.flatMap((handoff) => handoff.operations.map((operation) =>
        operation.runId)),
      ...consumedProducerKeys,
    ]);
    const retainedProducerReservations = nextProducerReservations.flatMap((reservation) => {
      if (!transferredProducerKeys.has(reservation.runId)) return [reservation];
      if (reservation.lifecycleState === "no_reply") return [reservation];
      if (reservation.recoveryOutcome === undefined) return [];
      return [{ ...reservation, lifecycleState: "delivery_owned" as const }];
    });
    const nextRecords: StoredDeadLetterEntry[] = [
      ...nextEntries,
      ...nextReservations,
      ...retainedProducerReservations,
      ...nextProducerHandoffs,
      ...nextInvalidRecords,
    ];
    const admitted = validateDeadLetterSnapshotAdmission(snapshotRecords(), nextRecords);
    if (!admitted.ok) return admitted;
    const written = await writeDeadLetterEntries(
      filePath,
      nextRecords,
      fileOperations,
    );
    if (written.ok) {
      store.producerReservations = [...retainedProducerReservations];
      for (const producerKey of transferredProducerKeys) activeProducerKeys.delete(producerKey);
      return written;
    }
    if (written.error.state === "snapshot_visible") {
      store.entries = [...nextEntries];
      store.decisionReservations = [...nextReservations];
      store.invalidRecords = [...nextInvalidRecords];
      store.producerHandoffs = [...nextProducerHandoffs];
      store.producerReservations = [...retainedProducerReservations];
      for (const producerKey of transferredProducerKeys) activeProducerKeys.delete(producerKey);
    }
    return err(written.error.error);
  }

  return {
    collectTerminalRetirementsDurably,
    refreshTerminalInvalidRecords,
    loadFromDisk,
    persist,
  };
}
