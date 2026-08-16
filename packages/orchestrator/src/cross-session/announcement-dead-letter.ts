// SPDX-License-Identifier: Apache-2.0
/** Durable retry and uncertainty quarantine for failed announcements. */

import { randomUUID } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementDeadLetterAttachmentSnapshot,
  AnnouncementDeadLetterAttachmentSource,
  AnnouncementDeadLetterQueuePort,
  AnnouncementParentDecisionReservation,
  AnnouncementProducerReservation,
  OutwardSendLedgerPort,
  OutwardSendRecord,
  QuarantinedInvalidAnnouncementRecord,
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
  createParentDecisionReservationStore,
  isAnnouncementProducerHandoff,
  isAnnouncementProducerReservation,
  isAnnouncementTextChunks,
  isValidAnnouncementDecision,
  isParentDecisionReservation,
  readDeadLetterSnapshot,
  writeDeadLetterEntries,
  type ChannelType,
  type DeadLetterEntry,
  type AnnouncementProducerHandoffRecord,
  type ParentDecisionReservationRecord,
  type ProducerReservationRecord,
  sameAnnouncementProducerReservation,
} from "./announcement-dead-letter-file.js";
import {
  isInvalidDeadLetterRecord,
  type InvalidDeadLetterRecord,
} from "./announcement-dead-letter-invalid.js";
import {
  announcementTerminalRetirementDigest,
  createAnnouncementTerminalDecisionStore,
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
import type {
  AnnouncementDeadLetterQueueOptions,
  PreparedRecoveryAttachment,
  RecoveryDeliveryOptions,
} from "./announcement-dead-letter-types.js";
export { isAnnouncementChannelType } from "./announcement-dead-letter-file.js";
export type { AnnouncementLogger } from "./announcement-dead-letter-types.js";
export type {
  ChannelType,
  DeadLetterEntry,
  ParentDecisionReservation,
} from "./announcement-dead-letter-file.js";
import { classifyQuarantined, releaseQuarantined } from "./announcement-dead-letter-quarantine.js";
export type {
  QuarantinedAnnouncement,
  QuarantineReleaseOutcome,
} from "./announcement-dead-letter-quarantine.js";

export type AnnouncementDeadLetterQueue = AnnouncementDeadLetterQueuePort;
type GovernedDrainOutcome =
  | "receipt_already_committed"
  | "receipt_committed_now"
  | "retained";
const CHUNK_IN_FLIGHT_PREFIX = "outward_operation_in_flight:";
const CHUNK_UNRESOLVED_PREFIX = "outward_operation_unresolved:";
type AnnouncementTextChunkOwner = AnnouncementParentDecisionReservation;
/** Create a JSONL-backed announcement dead-letter queue. */
export function createAnnouncementDeadLetterQueue(
  opts: AnnouncementDeadLetterQueueOptions,
): AnnouncementDeadLetterQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const retryIntervalMs = opts.retryIntervalMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 3_600_000;
  const maxEntries = opts.maxEntries ?? 100;
  // Cover the 300-second rewrite timeout plus a drain interval to prevent a race.
  const parentDecisionGraceMs = 300_000 + retryIntervalMs;
  const {
    filePath,
    eventBus,
    logger,
    outwardLedger,
    governedSendToChannel,
    receiptAwareSendToChannel,
    prepareAttachment,
    cleanupAttachment,
    reconcileAttachments,
    retirementProducerExists,
    fileOperations,
  } = opts;
  let entries: DeadLetterEntry[] = [];
  let decisionReservations: ParentDecisionReservationRecord[] = [];
  let producerReservations: ProducerReservationRecord[] = [];
  let producerHandoffs: AnnouncementProducerHandoffRecord[] = [];
  let invalidRecords: InvalidDeadLetterRecord[] = [];
  let terminalInvalidRecords: QuarantinedInvalidAnnouncementRecord[] = [];
  const activeProducerKeys = new Set<string>();
  const emittedAdmissionKeys = new Set<string>();
  const terminalDecisionStore = createAnnouncementTerminalDecisionStore(filePath);
  let loaded = false;
  let operationTail: Promise<void> = Promise.resolve();
  let capacityVersion = 0;
  const capacityWaiters = new Set<() => void>();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function capacityCount(): number {
    return entries.length
      + decisionReservations.length
      + producerReservations.length
      + producerHandoffs.length
      + invalidRecords.length;
  }

  function signalCapacityChange(): void {
    capacityVersion++;
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  }

  async function serializeStateChange<T>(operation: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      const before = capacityCount();
      const result = await operation();
      if (capacityCount() < before) {
        signalCapacityChange();
        const collected = await collectTerminalRetirementsDurably();
        if (!collected.ok) {
          logger?.warn(
            {
              errorKind: "resource" as const,
              hint: "restore terminal-decision storage; durable retirement intents remain queued",
            },
            "Announcement terminal retirement intents could not be collected",
          );
        }
      }
      return result;
    });
  }

  function waitForCapacity(version: number, signal?: AbortSignal): Promise<boolean> {
    if (capacityVersion !== version) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (retry: boolean): void => {
        if (settled) return;
        settled = true;
        capacityWaiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(retry);
      };
      const wake = (): void => finish(true);
      const abort = (): void => finish(false);
      capacityWaiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (capacityVersion !== version) {
        finish(true);
      } else if (signal?.aborted) {
        finish(false);
      }
    });
  }

  async function admitWithBackpressure<T>(
    operation: () => Promise<Result<T, Error>>,
    signal?: AbortSignal,
    retainOnCancellation?: () => Promise<Result<T, Error>>,
  ): Promise<Result<T, Error>> {
    while (true) {
      const version = capacityVersion;
      const result = await serializeStateChange(operation);
      if (
        result.ok
        || (
          result.error.message !== "Dead-letter quarantine capacity exhausted"
          && result.error.message !== "Announcement producer capacity exhausted"
        )
      ) {
        return result;
      }
      if (!await waitForCapacity(version, signal)) {
        return retainOnCancellation
          ? serializeStateChange(retainOnCancellation)
          : err(new Error("Dead-letter admission cancelled"));
      }
    }
  }

  function emitAdmission(entry: DeadLetterEntry): void {
    const key = announcementRecoveryKey(entry);
    if (emittedAdmissionKeys.has(key)) return;
    emittedAdmissionKeys.add(key);
    emitObservationalEventSafely(
      { eventBus, logger },
      "announcement:dead_lettered",
      {
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        channelType: entry.channelType,
        reason: "delivery_failed",
        timestamp: systemNowMs(),
      },
    );
  }

  async function collectTerminalRetirementsDurably(): Promise<Result<number, Error>> {
    if (!retirementProducerExists) return ok(0);
    const retainedDigests = new Set<string>();
    const retainedOwners = [
      ...entries,
      ...decisionReservations,
      ...producerReservations,
      ...producerHandoffs.flatMap((handoff) => handoff.operations),
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
      retirementProducerExists,
      (completionKeyDigests) => ok(
        completionKeyDigests.some((digest) => retainedDigests.has(digest)),
      ),
    );
  }

  async function refreshTerminalInvalidRecords(): Promise<Result<void, Error>> {
    if (outwardLedger) {
      terminalInvalidRecords = [];
      return ok(undefined);
    }
    const previousIds = terminalInvalidRecords.map((record) => record.id).sort().join("\u0000");
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
    terminalInvalidRecords = [...terminalInvalid.value];
    const nextIds = terminalInvalidRecords.map((record) => record.id).sort().join("\u0000");
    if (terminalInvalidRecords.length > 0 && nextIds !== previousIds) {
      logger?.warn(
        {
          invalidRecordCount: terminalInvalidRecords.length,
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
      decisionReservations = read.value.entries.filter(isParentDecisionReservation);
      producerReservations = read.value.entries.filter(isAnnouncementProducerReservation);
      producerHandoffs = read.value.entries.filter(isAnnouncementProducerHandoff);
      invalidRecords = read.value.entries.filter(isInvalidDeadLetterRecord);
      if (producerHandoffs.length > maxEntries) {
        return err(new Error("Announcement producer handoff capacity is invalid"));
      }
      const recoveredInFlight = loadedEntries.some((entry) =>
        entry.lastError === "outward_operation_in_flight"
        || entry.lastError?.startsWith(CHUNK_IN_FLIGHT_PREFIX) === true);
      entries = loadedEntries.map((entry) => {
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
            ...entries,
            ...decisionReservations,
            ...producerReservations,
            ...producerHandoffs,
            ...invalidRecords,
          ],
          fileOperations,
        );
        if (!recovered.ok) return err(recovered.error.error);
      }
      if (reconcileAttachments) {
        const referencedPaths = [
          ...entries.flatMap((entry) =>
            entry.attachment?.kind === "snapshot" ? [entry.attachment.path] : []),
          ...decisionReservations.flatMap((reservation) =>
            reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
          ...producerReservations.flatMap((reservation) =>
            reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
          ...producerHandoffs.flatMap((handoff) => handoff.operations.flatMap((operation) =>
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
          entryCount: entries.length + decisionReservations.length + invalidRecords.length,
          producerReservationCount: producerReservations.length,
          producerHandoffCount: producerHandoffs.length,
        },
        "Loaded dead-letter entries from disk",
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
    nextReservations: readonly ParentDecisionReservationRecord[] = decisionReservations,
    nextInvalidRecords: readonly InvalidDeadLetterRecord[] = invalidRecords,
    nextProducerHandoffs: readonly AnnouncementProducerHandoffRecord[] = producerHandoffs,
    nextProducerReservations: readonly ProducerReservationRecord[] = producerReservations,
    consumedProducerKeys: readonly string[] = [],
  ): Promise<Result<void, Error>> {
    const transferredProducerKeys = new Set([
      ...nextEntries.map((entry) => entry.runId),
      ...nextReservations.map((reservation) => reservation.runId),
      ...nextProducerHandoffs.flatMap((handoff) => handoff.operations.map((operation) =>
        operation.runId)),
      ...consumedProducerKeys,
    ]);
    const retainedProducerReservations = nextProducerReservations.filter(
      (reservation) => !transferredProducerKeys.has(reservation.runId),
    );
    const written = await writeDeadLetterEntries(
      filePath,
      [
        ...nextEntries,
        ...nextReservations,
        ...retainedProducerReservations,
        ...nextProducerHandoffs,
        ...nextInvalidRecords,
      ],
      fileOperations,
    );
    if (written.ok) {
      producerReservations = [...retainedProducerReservations];
      for (const producerKey of transferredProducerKeys) activeProducerKeys.delete(producerKey);
      return written;
    }
    if (written.error.state === "snapshot_visible") {
      entries = [...nextEntries];
      decisionReservations = [...nextReservations];
      invalidRecords = [...nextInvalidRecords];
      producerHandoffs = [...nextProducerHandoffs];
      producerReservations = [...retainedProducerReservations];
      for (const producerKey of transferredProducerKeys) activeProducerKeys.delete(producerKey);
    }
    return err(written.error.error);
  }

  function canPersistCounts(nextEntryCount: number, nextReservationCount: number): boolean {
    const currentCount = entries.length + decisionReservations.length + invalidRecords.length;
    const nextCount = nextEntryCount + nextReservationCount + invalidRecords.length;
    if (nextCount <= maxEntries || nextCount <= currentCount) return true;
    logger?.warn(
      {
        entryCount: currentCount,
        maxEntries,
        errorKind: "resource" as const,
        hint: "release retained dead letters before admitting new completion operations; existing evidence remains intact",
      },
      "Dead-letter quarantine capacity exhausted",
    );
    return false;
  }

  function canPersistProducerOwnership(
    nextProducerOwnershipCount: number,
    consumedProducerKeys: ReadonlySet<string> = new Set(),
  ): boolean {
    const consumedReservationCount = producerReservations.filter((reservation) =>
      consumedProducerKeys.has(reservation.runId)).length;
    const nextCount = nextProducerOwnershipCount - consumedReservationCount;
    const currentCount = producerHandoffs.length + producerReservations.length;
    if (nextCount <= maxEntries || nextCount <= currentCount) return true;
    logger?.warn(
      {
        producerHandoffCount: producerHandoffs.length,
        producerReservationCount: producerReservations.length,
        maxEntries,
        errorKind: "resource" as const,
        hint: "allow retained announcements to drain before stopping additional completion producers",
      },
      "Announcement producer handoff capacity exhausted",
    );
    return false;
  }

  async function reserveProducerDurably(
    reservation: AnnouncementProducerReservation,
  ): Promise<Result<void, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const producerKey = reservation.runId;
    if (producerKey.length === 0 || producerKey.length > 256) {
      return err(new Error("Announcement producer identity is invalid"));
    }
    if (!isValidAnnouncementDecision(reservation)) {
      return err(new Error("Announcement producer reservation is invalid"));
    }
    if (
      entries.some((entry) => entry.runId === producerKey)
      || decisionReservations.some((entry) => entry.runId === producerKey)
      || producerHandoffs.some((handoff) => handoff.operations.some((operation) =>
        operation.runId === producerKey))
    ) {
      activeProducerKeys.add(producerKey);
      return ok(undefined);
    }
    const existing = producerReservations.find((candidate) => candidate.runId === producerKey);
    if (existing && !sameAnnouncementProducerReservation(existing, reservation)) {
      return err(new Error("Announcement producer reservation identity mismatch"));
    }
    if (!existing && !canPersistProducerOwnership(
      producerHandoffs.length + producerReservations.length + 1,
    )) {
      return err(new Error("Announcement producer capacity exhausted"));
    }
    const id = existing?.id ?? randomUUID();
    const record: ProducerReservationRecord = {
      ...reservation,
      recordType: "producer_reservation",
      id,
    };
    const next = existing
      ? producerReservations.map((candidate) => candidate.runId === producerKey ? record : candidate)
      : [...producerReservations, record];
    const persisted = await persist(
      entries,
      decisionReservations,
      invalidRecords,
      producerHandoffs,
      next,
    );
    if (!persisted.ok) return persisted;
    producerReservations = next;
    activeProducerKeys.add(producerKey);
    return ok(undefined);
  }

  async function releaseProducerDurably(producerKey: string): Promise<Result<void, Error>> {
    activeProducerKeys.delete(producerKey);
    return ok(undefined);
  }

  async function cancelProducerDurably(producerKey: string): Promise<Result<void, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const removed = producerReservations.filter((candidate) => candidate.runId === producerKey);
    const next = producerReservations.filter((candidate) => candidate.runId !== producerKey);
    if (next.length === producerReservations.length) {
      activeProducerKeys.delete(producerKey);
      return ok(undefined);
    }
    const persisted = await persist(
      entries,
      decisionReservations,
      invalidRecords,
      producerHandoffs,
      next,
    );
    if (!persisted.ok) return persisted;
    producerReservations = next;
    activeProducerKeys.delete(producerKey);
    await cleanupUnreferencedSnapshots(removed.flatMap((reservation) =>
      reservation.attachment?.kind === "snapshot"
        ? [{ attachment: reservation.attachment }]
        : []));
    return ok(undefined);
  }

  async function consumeProducerReservationsDurably(
    producerKeys: readonly string[],
  ): Promise<Result<void, Error>> {
    const uniqueKeys = new Set(producerKeys);
    const removed = producerReservations.filter((candidate) => uniqueKeys.has(candidate.runId));
    if (removed.length === 0) {
      consumeProducerSlots(uniqueKeys);
      return ok(undefined);
    }
    const persisted = await persist(
      entries,
      decisionReservations,
      invalidRecords,
      producerHandoffs,
      producerReservations,
      [...uniqueKeys],
    );
    if (!persisted.ok) return persisted;
    consumeProducerSlots(uniqueKeys);
    await cleanupUnreferencedSnapshots(removed.flatMap((reservation) =>
      reservation.attachment?.kind === "snapshot"
        ? [{ attachment: reservation.attachment }]
        : []));
    return ok(undefined);
  }

  function consumeProducerSlots(producerKeys: Iterable<string>): void {
    let consumed = false;
    for (const producerKey of producerKeys) {
      if (activeProducerKeys.delete(producerKey)) consumed = true;
    }
    if (consumed) signalCapacityChange();
  }

  function isSourceAttachment(
    attachment: AnnouncementDeadLetterEntryInput["attachment"],
  ): attachment is AnnouncementDeadLetterAttachmentSource {
    return attachment?.kind === "source";
  }

  function preparedSnapshot(
    attachment: PreparedRecoveryAttachment,
  ): AnnouncementDeadLetterAttachmentSnapshot {
    return {
      kind: "snapshot",
      sourceAgentId: attachment.sourceAgentId,
      sourcePath: attachment.sourcePath,
      path: attachment.path,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      contentDigest: attachment.contentDigest,
      sizeBytes: attachment.sizeBytes,
    };
  }

  async function prepareReservedAttachment<T extends {
    attachment?: AnnouncementDeadLetterEntryInput["attachment"];
  }>(
    entry: T,
    reusable: readonly AnnouncementParentDecisionReservation[] = [],
  ): Promise<Result<{
    entry: T;
    cleanup?: () => Promise<Result<void, Error>>;
  }, Error>> {
    if (!isSourceAttachment(entry.attachment)) return ok({ entry });
    const existing = reusable.find((reservation) =>
      reservation.attachment?.kind === "snapshot"
      && reservation.attachment.sourceAgentId === entry.attachment?.sourceAgentId
      && reservation.attachment.sourcePath === entry.attachment?.path);
    if (existing?.attachment?.kind === "snapshot") {
      return ok({ entry: { ...entry, attachment: existing.attachment } });
    }
    if (!prepareAttachment) {
      return err(new Error("Completion attachment snapshot admission is unavailable"));
    }
    const prepared = await fromPromise(prepareAttachment(entry.attachment));
    if (!prepared.ok) return prepared;
    if (!prepared.value.ok) return prepared.value;
    return ok({
      entry: { ...entry, attachment: preparedSnapshot(prepared.value.value) },
      cleanup: prepared.value.value.cleanup,
    });
  }

  async function cleanupUnreferencedSnapshots(
    candidates: readonly {
      attachment: AnnouncementDeadLetterAttachmentSnapshot;
      cleanup?: () => Promise<Result<void, Error>>;
    }[],
  ): Promise<void> {
    const referencedPaths = new Set([
      ...entries.flatMap((entry) =>
        entry.attachment?.kind === "snapshot" ? [entry.attachment.path] : []),
      ...decisionReservations.flatMap((reservation) =>
        reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
      ...producerReservations.flatMap((reservation) =>
        reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
      ...producerHandoffs.flatMap((handoff) => handoff.operations.flatMap((operation) =>
        operation.attachment?.kind === "snapshot" ? [operation.attachment.path] : [])),
    ]);
    const cleanedPaths = new Set<string>();
    for (const candidate of candidates) {
      if (
        referencedPaths.has(candidate.attachment.path)
        || cleanedPaths.has(candidate.attachment.path)
      ) continue;
      const cleaned = candidate.cleanup
        ? await candidate.cleanup()
        : cleanupAttachment
          ? await cleanupAttachment(candidate.attachment)
          : ok(undefined);
      cleanedPaths.add(candidate.attachment.path);
      if (!cleaned.ok) {
        logger?.warn(
          {
            errorKind: "resource" as const,
            hint: "remove the stale completion snapshot and verify attachment storage permissions",
          },
          "Completion attachment snapshot cleanup failed",
        );
      }
    }
  }

  const decisionStore = createParentDecisionReservationStore({
    load: loadFromDisk,
    hasDeliveryKey: (idempotencyKey) =>
      entries.some((entry) =>
        entry.idempotencyKey === idempotencyKey
        || entry.completionKeys?.includes(idempotencyKey) === true),
    getReservations: () => decisionReservations,
    persist: (nextReservations, consumedProducerKeys) => persist(
      entries,
      nextReservations,
      invalidRecords,
      producerHandoffs,
      producerReservations,
      consumedProducerKeys,
    ),
    canPersistReservationCount: (count) => canPersistCounts(entries.length, count),
    replaceReservations: (nextReservations) => {
      decisionReservations = [...nextReservations];
    },
    logger,
  });

  function quarantineClassification() {
    return classifyQuarantined({
      entries,
      reservations: decisionReservations,
      invalidRecords: [...invalidRecords, ...terminalInvalidRecords],
      governed: outwardLedger !== undefined,
      maxRetries,
      maxAgeMs,
      now: systemNowMs(),
    });
  }

  async function lookupTerminalDecision(
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
  ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> {
    if (outwardLedger) {
      const identity = terminalDecisionIdentity(owner);
      return outwardLedger.lookupTerminalDecision(identity.rootRunId, identity.operationId);
    }
    return terminalDecisionStore.lookup(owner);
  }

  async function recordTerminalDecision(
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    outcome: AnnouncementTerminalDecision,
  ): Promise<Result<void, Error>> {
    if (outwardLedger) {
      const identity = terminalDecisionIdentity(owner);
      return outwardLedger.recordTerminalDecision(identity.rootRunId, identity.operationId, outcome);
    }
    return terminalDecisionStore.record(owner, outcome);
  }

  function retainsCompletionKey(
    completionKey: string,
    retainedEntries: readonly DeadLetterEntry[],
    retainedReservations: readonly AnnouncementParentDecisionReservation[],
  ): boolean {
    return retainedEntries.some((candidate) =>
      candidate.idempotencyKey === completionKey
      || candidate.completionKeys?.includes(completionKey) === true)
      || retainedReservations.some((candidate) =>
        candidate.idempotencyKey === completionKey
        || candidate.completionKeys.includes(completionKey));
  }

  async function terminalizeOwner(
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    outcome: AnnouncementTerminalDecision,
    retainedEntries: readonly DeadLetterEntry[],
    retainedReservations: readonly AnnouncementParentDecisionReservation[],
  ): Promise<Result<void, Error>> {
    const terminalized = await recordTerminalDecision(owner, outcome);
    if (!terminalized.ok) return terminalized;
    const completionKeys = [...new Set(owner.completionKeys ?? [])];
    for (const completionKey of completionKeys) {
      if (
        completionKey === owner.idempotencyKey
        || retainsCompletionKey(completionKey, retainedEntries, retainedReservations)
      ) continue;
      const completed = await recordTerminalDecision({
        ...owner,
        idempotencyKey: completionKey,
        completionKeys: [completionKey],
        retirementKeys: owner.retirementKeys && owner.retirementKeys.length > 0
          ? owner.retirementKeys
          : [completionKey],
      }, outcome);
      if (!completed.ok) return completed;
    }
    return ok(undefined);
  }

  function textChunkOwners(
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
  ): AnnouncementTextChunkOwner[] {
    if (
      !owner.textChunks
      || !owner.agentId
      || !owner.rootRunId
      || !owner.deliveryAuthority
      || !owner.destinationEndpoint
      || isStableAnnouncementChunkPartId(owner.partId)
    ) return [];
    const agentId = owner.agentId;
    const rootRunId = owner.rootRunId;
    const deliveryAuthority = owner.deliveryAuthority;
    const destinationEndpoint = owner.destinationEndpoint;
    return owner.textChunks.map((announcementText, chunkIndex) => {
      const partId = createStableAnnouncementChunkPartId(owner.partId, chunkIndex);
      const idempotencyKey = createStableAnnouncementChunkOperationId(
        agentId,
        owner.sessionKey,
        owner.runId,
        owner.partId,
        chunkIndex,
      );
      return {
        ...owner,
        agentId,
        rootRunId,
        deliveryAuthority,
        destinationEndpoint,
        announcementText,
        partId,
        idempotencyKey,
        completionKeys: owner.completionKeys?.some((key) => key !== owner.idempotencyKey)
          ? [...new Set(owner.completionKeys.filter((key) => key !== owner.idempotencyKey))]
          : [idempotencyKey],
      };
    });
  }

  function unresolvedChunkOperationId(entry: DeadLetterEntry): string | undefined {
    return entry.lastError?.startsWith(CHUNK_UNRESOLVED_PREFIX) === true
      ? entry.lastError.slice(CHUNK_UNRESOLVED_PREFIX.length)
      : undefined;
  }

  async function settleTextChunkRelease(
    entry: DeadLetterEntry,
    outcome: "delivered" | "discarded",
  ): Promise<Result<"release" | "retain", Error>> {
    const chunkOwners = textChunkOwners(entry);
    if (chunkOwners.length === 0) return ok("release");
    const unresolvedOperationId = unresolvedChunkOperationId(entry);
    let hasUnattemptedChunk = false;
    for (const chunkOwner of chunkOwners) {
      const terminal = await lookupTerminalDecision(chunkOwner);
      if (!terminal.ok) return terminal;
      if (terminal.value !== undefined) {
        if (outcome === "delivered" && terminal.value !== "delivered") {
          return err(new Error("Announcement chunk release conflicts with its durable outcome"));
        }
        continue;
      }
      if (!outwardLedger) {
        if (outcome === "delivered" && unresolvedOperationId !== chunkOwner.idempotencyKey) {
          hasUnattemptedChunk = true;
          continue;
        }
        const terminalized = await recordTerminalDecision(chunkOwner, outcome);
        if (!terminalized.ok) return terminalized;
        continue;
      }
      const step = await outwardLedger.allocateStep(
        entry.rootRunId ?? `announcement:${entry.sessionKey}`,
        chunkOwner.idempotencyKey,
      );
      if (!step.ok) return step;
      const record = await outwardLedger.lookup(
        entry.rootRunId ?? `announcement:${entry.sessionKey}`,
        step.value,
      );
      if (!record.ok) return record;
      if (record.value?.state === "committed") continue;
      if (
        record.value?.state === "send_attempt_started"
        || record.value?.state === "unknown_after_send"
      ) {
        return err(new Error("Announcement chunk is still in flight"));
      }
      if (!record.value && outcome === "delivered") {
        hasUnattemptedChunk = true;
        continue;
      }
      const terminalized = await recordTerminalDecision(chunkOwner, outcome);
      if (!terminalized.ok) return terminalized;
    }
    if (outcome === "delivered" && hasUnattemptedChunk) {
      const nextEntries = entries.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            attemptCount: 0,
            lastAttemptAt: 0,
            lastError: "transport_rejected",
          }
        : candidate);
      const retained = await persist(nextEntries);
      if (!retained.ok) return retained;
      entries = nextEntries;
      return ok("retain");
    }
    return ok("release");
  }

  function sameRetainedOwner(
    reservation: {
      readonly rootRunId?: string;
      readonly agentId?: string;
      readonly channelType: string;
      readonly channelId: string;
    },
    record: OutwardSendRecord,
    stepIndex: number,
  ): boolean {
    return record.rootRunId === reservation.rootRunId
      && record.stepIndex === stepIndex
      && record.agentId === reservation.agentId
      && record.channelType === reservation.channelType
      && record.channelId === reservation.channelId
      && record.operationKind === "cross_session_announcement";
  }

  async function resolveDecisionDurably(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>> {
    const reservation = await decisionStore.lookup(idempotencyKey);
    if (!reservation.ok || reservation.value === undefined) return reservation.ok
      ? ok(false)
      : reservation;
    const nextReservations = decisionReservations.filter(
      (candidate) => candidate.idempotencyKey !== idempotencyKey,
    );
    if (outcome === "receipt_committed") {
      const terminalized = await terminalizeOwner(
        reservation.value,
        "delivered",
        entries,
        nextReservations,
      );
      if (!terminalized.ok) return terminalized;
      const resolved = await decisionStore.resolve(idempotencyKey, outcome);
      if (reservation.value.attachment?.kind === "snapshot") {
        await cleanupUnreferencedSnapshots([{ attachment: reservation.value.attachment }]);
      }
      return resolved;
    }
    const existing = await lookupTerminalDecision(reservation.value);
    if (!existing.ok) return existing;
    if (existing.value !== undefined && existing.value !== "no_reply") {
      return err(new Error("No-reply resolution conflicts with its durable outcome"));
    }
    const terminalized = await terminalizeOwner(
      reservation.value,
      "no_reply",
      entries,
      nextReservations,
    );
    if (!terminalized.ok) {
      logger?.error(
        {
          errorKind: "dependency" as const,
          hint: "restore decision-quarantine storage or the outward ledger before retrying the no-reply resolution",
        },
        "Announcement no-reply resolution could not be durably terminalized",
      );
      return terminalized;
    }
    const resolved = await persist(entries, nextReservations, invalidRecords);
    if (resolved.ok) {
      decisionReservations = nextReservations;
    }
    if (reservation.value.attachment?.kind === "snapshot") {
      await cleanupUnreferencedSnapshots([{ attachment: reservation.value.attachment }]);
    }
    if (resolved.ok) {
      return ok(true);
    }
    return err(resolved.error);
  }

  type LedgerTransition = "lookup" | "begin" | "mark_unknown" | "commit" | "park";
  type LedgerOutcome = "blocked" | "in_flight" | "committed" | "failed" | "parked";
  function emitLedgerTransition(
    identity: Pick<GovernedDeadLetterIdentity, "rootRunId" | "stepIndex" | "runId" | "sessionKey">,
    transition: LedgerTransition,
    outcome: LedgerOutcome,
    details: { platformMessageId?: string } = {},
  ): void {
    emitObservationalEventSafely(
      { eventBus, logger },
      "delivery:outward_ledger_transition",
      {
        rootRunId: identity.rootRunId,
        runId: identity.runId,
        stepIndex: identity.stepIndex,
        transition,
        outcome,
        sessionKey: identity.sessionKey,
        ...details,
        timestamp: systemNowMs(),
      },
    );
  }
  /** Ledger-failure conditions already reported, keyed by entry + message.
   *
   *  A retained entry is re-reached on EVERY drain, so re-logging its standing
   *  condition at ERROR each pass turns one stuck entry into unbounded ERROR
   *  volume and buries genuinely new failures. Report the transition INTO the
   *  condition once; later passes stay at DEBUG. Keyed by the entry's unique id,
   *  so a re-enqueued run is a different key and reports again. Bounded by a
   *  wholesale reset rather than per-entry pruning: the worst case is one
   *  duplicate ERROR after a reset, which is self-healing, whereas an unpruned
   *  set would grow for the daemon's lifetime. */
  const MAX_REPORTED_LEDGER_FAILURES = 512;
  const reportedLedgerFailures = new Set<string>();

  function logLedgerFailure(
    entry: DeadLetterEntry,
    transition: string,
    errorKind: "dependency" | "precondition" | "validation",
    hint: string,
    message: string,
  ): void {
    const conditionKey = `${entry.id}\u0000${message}`;
    if (reportedLedgerFailures.has(conditionKey)) {
      logger?.debug(
        { runId: entry.runId, transition, step: "dead-letter-outward-ledger", alreadyReported: true },
        message,
      );
      return;
    }
    if (reportedLedgerFailures.size >= MAX_REPORTED_LEDGER_FAILURES) reportedLedgerFailures.clear();
    reportedLedgerFailures.add(conditionKey);
    logger?.error(
      {
        runId: entry.runId,
        ...(entry.rootRunId !== undefined ? { rootRunId: entry.rootRunId } : {}),
        ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
        transition,
        step: "dead-letter-outward-ledger",
        errorKind,
        hint,
      },
      message,
    );
  }

  function retainBlockedEntry(entry: DeadLetterEntry, reason: string): void {
    entry.lastAttemptAt = systemNowMs();
    entry.lastError = reason;
  }

  async function parkGovernedEntry(
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
    identity: Pick<
      GovernedDeadLetterIdentity,
      "rootRunId" | "stepIndex" | "runId" | "sessionKey"
    >,
  ): Promise<void> {
    const parked = await ledger.parkUncertain(identity.rootRunId, identity.stepIndex);
    if (!parked.ok) {
      logLedgerFailure(
        entry,
        "park",
        "dependency",
        "repair the outward ledger and verify the channel manually before any retry",
        "Dead-letter announcement could not be parked",
      );
      emitLedgerTransition(identity, "park", "blocked");
      return;
    }
    if (!parked.value) {
      emitLedgerTransition(identity, "park", "blocked");
      return;
    }

    logger?.error(
      {
        rootRunId: identity.rootRunId,
        stepIndex: identity.stepIndex,
        step: "dead-letter-outward-ledger",
        errorKind: "precondition" as const,
        hint: "verify the destination channel manually before creating a new announcement operation",
      },
      "Dead-letter announcement parked without an authoritative platform receipt",
    );
    emitLedgerTransition(identity, "park", "parked");
  }

  /**
   * Execute one ledger-governed retry. Only a definitive `lookup → absent`
   * result may begin a new send attempt. Every retained state or ledger error
   * blocks the channel call; in-flight/ambiguous rows are parked atomically.
   */
  async function drainPreparedGovernedEntry(
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
    preparedAttachment?: GovernedAnnouncementAttachment,
  ): Promise<GovernedDrainOutcome> {
    const identityResult = resolveGovernedDeadLetterIdentity(entry, preparedAttachment);
    if (!identityResult.ok) {
      const invalidOperation = identityResult.error === "operation_validation_blocked";
      logLedgerFailure(
        entry,
        invalidOperation ? "validate" : "identity",
        "validation",
        invalidOperation
          ? "repair unsupported announcement delivery options before operator-directed recovery"
          : "restore the original agentId, rootRunId, and stepIndex before operator-directed recovery",
        invalidOperation
          ? "Dead-letter announcement operation validation failed"
          : "Dead-letter announcement lacks a complete governed operation identity",
      );
      if (
        typeof entry.rootRunId === "string"
        && entry.rootRunId.length > 0
        && Number.isSafeInteger(entry.stepIndex)
        && entry.stepIndex !== undefined
        && entry.stepIndex >= 0
      ) {
        emitLedgerTransition(
          { ...entry, rootRunId: entry.rootRunId, stepIndex: entry.stepIndex },
          "lookup",
          "blocked",
        );
      }
      retainBlockedEntry(entry, identityResult.error);
      return "retained";
    }
    const identity = identityResult.value;

    const existing = await ledger.lookup(identity.rootRunId, identity.stepIndex);
    if (!existing.ok) {
      logLedgerFailure(
        entry,
        "lookup",
        "dependency",
        "restore outward-ledger reads and verify the retained operation before retrying",
        "Dead-letter outward-ledger lookup failed",
      );
      emitLedgerTransition(identity, "lookup", "blocked");
      await parkGovernedEntry(ledger, entry, identity);
      retainBlockedEntry(entry, "outward_ledger_lookup_blocked");
      return "retained";
    }

    if (existing.value !== undefined) {
      if (!isSameGovernedDeadLetterOperation(entry, identity, existing.value)) {
        logLedgerFailure(
          entry,
          "lookup",
          "validation",
          "reuse a retained operation identity only with its exact original agent, destination, and payload",
          "Dead-letter announcement operation identity mismatch",
        );
        emitLedgerTransition(identity, "lookup", "blocked");
        retainBlockedEntry(entry, "outward_operation_identity_mismatch");
        return "retained";
      }

      switch (existing.value.state) {
        case "committed":
          if (
            existing.value.platformMessageId === undefined
            || existing.value.platformMessageId.length === 0
          ) {
            logLedgerFailure(
              entry,
              "lookup",
              "precondition",
              "repair the committed ledger receipt before treating this announcement as delivered",
              "Committed dead-letter announcement lacks a platform receipt",
            );
            emitLedgerTransition(identity, "lookup", "blocked");
            retainBlockedEntry(entry, "outward_committed_receipt_missing");
            return "retained";
          }
          emitLedgerTransition(identity, "lookup", "committed", {
            platformMessageId: existing.value.platformMessageId,
          });
          return "receipt_already_committed";
        case "send_attempt_started":
        case "unknown_after_send":
          emitLedgerTransition(identity, "lookup", "in_flight");
          await parkGovernedEntry(ledger, entry, identity);
          retainBlockedEntry(entry, "outward_operation_unresolved");
          return "retained";
        case "unresolved":
          logLedgerFailure(
            entry,
            "lookup",
            "precondition",
            "verify the destination channel manually; an unresolved announcement is never replayed automatically",
            "Dead-letter announcement remains unresolved",
          );
          emitLedgerTransition(identity, "lookup", "parked");
          retainBlockedEntry(entry, "outward_operation_unresolved");
          return "retained";
        case "failed":
          logLedgerFailure(
            entry,
            "lookup",
            "precondition",
            "inspect the terminal ledger failure before creating a distinct announcement operation",
            "Dead-letter announcement is terminally failed",
          );
          emitLedgerTransition(identity, "lookup", "failed");
          retainBlockedEntry(entry, "outward_operation_failed");
          return "retained";
        default: {
          const _exhaustive: never = existing.value.state;
          return _exhaustive;
        }
      }
    }

    if (!governedSendToChannel) {
      retainBlockedEntry(entry, "outward_receipt_transport_unavailable");
      logLedgerFailure(
        entry,
        "transport",
        "precondition",
        "wire a receipt-aware announcement transport before operator-directed recovery",
        "Governed dead-letter transport cannot provide a platform receipt",
      );
      return "retained";
    }

    const begun = await ledger.begin({
      rootRunId: identity.rootRunId,
      stepIndex: identity.stepIndex,
      agentId: identity.agentId,
      channelType: entry.channelType,
      channelId: entry.channelId,
      operationKind: "cross_session_announcement",
      operationFingerprint: identity.operationFingerprint,
      contentDigest: identity.contentDigest,
    });
    if (!begun.ok) {
      logLedgerFailure(
        entry,
        "begin",
        "dependency",
        "inspect and park any retained row before retrying with the same operation identity",
        "Dead-letter outward-ledger begin failed",
      );
      emitLedgerTransition(identity, "begin", "blocked");
      await parkGovernedEntry(ledger, entry, identity);
      retainBlockedEntry(entry, "outward_ledger_begin_blocked");
      return "retained";
    }
    emitLedgerTransition(identity, "begin", "in_flight");

    const markedUnknown = await ledger.markUnknown(identity.rootRunId, identity.stepIndex);
    if (!markedUnknown.ok) {
      logLedgerFailure(
        entry,
        "mark_unknown",
        "dependency",
        "park the retained send intent and repair the ledger before any retry",
        "Dead-letter outward-ledger uncertainty transition failed",
      );
      emitLedgerTransition(identity, "mark_unknown", "blocked");
      await parkGovernedEntry(ledger, entry, identity);
      retainBlockedEntry(entry, "outward_ledger_mark_unknown_blocked");
      return "retained";
    }
    emitLedgerTransition(identity, "mark_unknown", "in_flight");

    const boundary = await fromPromise(
      preparedAttachment
        ? governedSendToChannel(
            entry.channelType,
            entry.channelId,
            entry.announcementText,
            {
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.extra ? { extra: entry.extra } : {}),
              authority: identity.deliveryAuthority,
              destinationEndpoint: identity.destinationEndpoint,
            },
            preparedAttachment,
          )
        : governedSendToChannel(
            entry.channelType,
            entry.channelId,
            entry.announcementText,
            {
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.extra ? { extra: entry.extra } : {}),
              authority: identity.deliveryAuthority,
              destinationEndpoint: identity.destinationEndpoint,
            },
          ),
    );
    entry.attemptCount++;
    entry.lastAttemptAt = systemNowMs();
    if (!boundary.ok || !boundary.value.ok) {
      entry.lastError = "outward_transport_outcome_unavailable";
      await parkGovernedEntry(ledger, entry, identity);
      return "retained";
    }
    const outcome = boundary.value.value;
    if (!outcome.delivered) {
      entry.lastError = outcome.status === "unknown"
        ? "outward_transport_uncertain"
        : "outward_transport_rejected";
      await parkGovernedEntry(ledger, entry, identity);
      return "retained";
    }
    const receipt = outcome.platformMessageId;
    if (receipt === undefined || receipt.length === 0) {
      entry.lastError = "outward_platform_receipt_missing";
      await parkGovernedEntry(ledger, entry, identity);
      return "retained";
    }

    const committed = await ledger.commit(identity.rootRunId, identity.stepIndex, receipt);
    if (!committed.ok) {
      entry.lastError = "outward_receipt_commit_blocked";
      logLedgerFailure(
        entry,
        "commit",
        "dependency",
        "verify the destination manually and repair the ledger before any retry",
        "Dead-letter platform receipt could not be committed",
      );
      emitLedgerTransition(identity, "commit", "blocked");
      await parkGovernedEntry(ledger, entry, identity);
      return "retained";
    }
    emitLedgerTransition(identity, "commit", "committed", {
      platformMessageId: receipt,
    });
    return "receipt_committed_now";
  }

  async function drainGovernedEntry(
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
  ): Promise<GovernedDrainOutcome> {
    const ensureSessionObservation = opts.ensureSessionObservation;
    const recoveryAgentId = entry.agentId;
    if (ensureSessionObservation && recoveryAgentId) {
      const observed = tryCatch(() => ensureSessionObservation({
        agentId: recoveryAgentId,
        sessionKey: entry.sessionKey,
      }));
      if (!observed.ok || !observed.value.ok) {
        logger?.warn(
          {
            runId: entry.runId,
            ...(entry.rootRunId ? { rootRunId: entry.rootRunId } : {}),
            ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
            errorKind: "resource" as const,
            hint: "repair session trajectory storage; delivery recovery remains governed by its durable ledger",
          },
          "Dead-letter recovery session diagnostics could not be initialized",
        );
      }
    }
    if (!entry.attachment) {
      if (entry.stepIndex !== undefined) {
        return drainPreparedGovernedEntry(ledger, entry);
      }
      if (
        !governedSendToChannel
        || !entry.rootRunId
        || !entry.agentId
        || !entry.idempotencyKey
        || !entry.deliveryAuthority
        || !entry.destinationEndpoint
      ) {
        retainBlockedEntry(entry, "identity_incomplete");
        return "retained";
      }
      const boundary = await fromPromise(governedSendToChannel(
        entry.channelType,
        entry.channelId,
        entry.announcementText,
        {
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
          ...(entry.extra ? { extra: entry.extra } : {}),
          authority: entry.deliveryAuthority,
          destinationEndpoint: entry.destinationEndpoint,
          governedText: {
            operationId: entry.idempotencyKey,
            rootRunId: entry.rootRunId,
            runId: entry.runId,
            agentId: entry.agentId,
            sessionKey: entry.sessionKey,
            ...(entry.partId ? { partId: entry.partId } : {}),
            ...(entry.textChunks
              ? { preparedTextChunks: entry.textChunks }
              : {
                  persistTextChunks: (chunks: readonly string[]) =>
                    recordDrainingEntryTextChunks(entry, chunks),
                }),
          },
        },
      ));
      entry.attemptCount++;
      entry.lastAttemptAt = systemNowMs();
      if (!boundary.ok || !boundary.value.ok || !boundary.value.value.delivered) {
        entry.lastError = "outward_operation_unresolved";
        return "retained";
      }
      return "receipt_committed_now";
    }
    if (
      entry.attachment
      && entry.rootRunId
      && entry.stepIndex !== undefined
      && entry.agentId
      && entry.idempotencyKey
    ) {
      const existing = await ledger.lookup(entry.rootRunId, entry.stepIndex);
      if (!existing.ok) {
        logLedgerFailure(
          entry,
          "lookup",
          "dependency",
          "restore outward-ledger reads and verify the retained operation before retrying",
          "Dead-letter outward-ledger lookup failed",
        );
        retainBlockedEntry(entry, "outward_ledger_lookup_blocked");
        return "retained";
      }
      if (existing.value) {
        const allocated = await ledger.allocateStep(entry.rootRunId, entry.idempotencyKey);
        if (!allocated.ok || allocated.value !== entry.stepIndex) {
          logLedgerFailure(
            entry,
            "allocate",
            "validation",
            "restore the retained operation mapping before settling its terminal ledger row",
            "Dead-letter announcement operation mapping is inconsistent",
          );
          retainBlockedEntry(entry, "outward_operation_mapping_mismatch");
          return "retained";
        }
        if (!sameRetainedOwner(entry, existing.value, entry.stepIndex)) {
          logLedgerFailure(
            entry,
            "lookup",
            "validation",
            "reuse a retained operation identity only with its exact original agent and destination",
            "Dead-letter announcement operation identity mismatch",
          );
          retainBlockedEntry(entry, "outward_operation_identity_mismatch");
          return "retained";
        }
        const identity = { ...entry, rootRunId: entry.rootRunId, stepIndex: entry.stepIndex };
        switch (existing.value.state) {
          case "committed":
            if (!existing.value.platformMessageId) {
              logLedgerFailure(
                entry,
                "lookup",
                "precondition",
                "repair the committed ledger receipt before treating this announcement as delivered",
                "Committed dead-letter announcement lacks a platform receipt",
              );
              retainBlockedEntry(entry, "outward_committed_receipt_missing");
              return "retained";
            }
            emitLedgerTransition(identity, "lookup", "committed", {
              platformMessageId: existing.value.platformMessageId,
            });
            return "receipt_already_committed";
          case "send_attempt_started":
          case "unknown_after_send":
            emitLedgerTransition(identity, "lookup", "in_flight");
            await parkGovernedEntry(ledger, entry, identity);
            retainBlockedEntry(entry, "outward_operation_unresolved");
            return "retained";
          case "unresolved":
            emitLedgerTransition(identity, "lookup", "parked");
            retainBlockedEntry(entry, "outward_operation_unresolved");
            return "retained";
          case "failed":
            emitLedgerTransition(identity, "lookup", "failed");
            retainBlockedEntry(entry, "outward_operation_failed");
            return "retained";
          default: {
            const _exhaustive: never = existing.value.state;
            return _exhaustive;
          }
        }
      }
    }
    return drainWithPreparedRecoveryAttachment({
      attachment: entry.attachment?.kind === "snapshot" ? entry.attachment : undefined,
      drainPrepared: (attachment) => drainPreparedGovernedEntry(ledger, entry, attachment),
    });
  }

  function emitDelivered(entry: DeadLetterEntry, attemptCount: number): void {
    emitObservationalEventSafely(
      { eventBus, logger },
      "announcement:dead_letter_delivered",
      {
        runId: entry.runId,
        channelType: entry.channelType,
        attemptCount,
        timestamp: systemNowMs(),
      },
    );
  }

  async function enqueueDurably(
    entry: AnnouncementDeadLetterEntryInput,
  ): Promise<Result<void, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const terminalDecision = await lookupTerminalDecision(entry);
    if (!terminalDecision.ok) return terminalDecision;
    if (terminalDecision.value !== undefined) return ok(undefined);
    if (entry.attachment?.kind === "source") {
      return err(new Error("Dead-letter attachment must be snapshotted before enqueue"));
    }
    const entryRecoveryKey = announcementRecoveryKey(entry);
    const keyedEntry = entries.find(
      (candidate) => announcementRecoveryKey(candidate) === entryRecoveryKey,
    );
    if (keyedEntry) {
      const same = isSameAnnouncementRecovery(keyedEntry, entry);
      if (!same.ok) return same;
      if (!same.value) {
        logger?.error(
          {
            errorKind: "validation" as const,
            hint: "reuse a dead-letter recovery key only for its exact original owner, destination, and content",
          },
          "Dead-letter recovery key identity mismatch",
        );
        return err(new Error("Dead-letter recovery key identity mismatch"));
      }
      emitAdmission(keyedEntry);
      return ok(undefined);
    }
    const reservation = entry.idempotencyKey !== undefined
      ? decisionReservations.find(
          (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
        )
      : undefined;
    if (
      reservation
      && (
        reservation.agentId !== entry.agentId
        || reservation.runId !== entry.runId
        || reservation.channelType !== entry.channelType
        || reservation.channelId !== entry.channelId
        || reservation.threadId !== entry.threadId
      )
    ) {
      logger?.error(
        {
          errorKind: "validation" as const,
          hint: "reuse a parent decision key only with its exact original owner and destination",
        },
        "Parent decision delivery identity mismatch",
      );
      return err(new Error("Parent decision delivery identity mismatch"));
    }
    const governedIdentityComplete = outwardLedger !== undefined
      && typeof entry.rootRunId === "string"
      && entry.rootRunId.length > 0
      && typeof entry.agentId === "string"
      && entry.agentId.length > 0
      && entry.stepIndex !== undefined
      && Number.isSafeInteger(entry.stepIndex)
      && entry.stepIndex >= 0;
    if (reservation && outwardLedger !== undefined && !governedIdentityComplete) return ok(undefined);
    if (reservation) {
      const same = isSameAnnouncementRecovery(
        {
          ...entry,
          ...reservation,
          stepIndex: entry.stepIndex,
          lastAttemptAt: 0,
        },
        entry,
      );
      if (!same.ok) return same;
      if (!same.value) {
        logger?.error(
          {
            errorKind: "validation" as const,
            hint: "reuse an operation reservation only with its exact payload and recovery authority",
          },
          "Announcement operation reservation identity mismatch",
        );
        return err(new Error("Announcement operation reservation identity mismatch"));
      }
    }

    const id = tryCatch(() => randomUUID());
    if (!id.ok) return id;
    const fullEntry: DeadLetterEntry = {
      ...entry,
      id: id.value,
      lastAttemptAt: systemNowMs(),
    };
    const nextEntries = [...entries];
    const nextReservations = reservation
      ? decisionReservations.filter((candidate) => candidate.id !== reservation.id)
      : decisionReservations;
    nextEntries.push(fullEntry);
    if (!canPersistCounts(nextEntries.length, nextReservations.length)) {
      return err(new Error("Dead-letter quarantine capacity exhausted"));
    }
    const persisted = await persist(nextEntries, nextReservations);
    if (!persisted.ok) {
      logger?.error(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage before retrying the enqueue operation",
        },
        "Dead-letter enqueue was not persisted",
      );
      return persisted;
    }
    entries = nextEntries;
    decisionReservations = nextReservations;
    emitAdmission(fullEntry);
    return ok(undefined);
  }

  async function beginDeliveryAttemptDurably(
    entry: AnnouncementDeadLetterEntryInput,
  ): Promise<Result<{
    claimed: boolean;
    terminalDecision?: AnnouncementTerminalDecision;
  }, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    if (!entry.idempotencyKey) {
      return err(new Error("Dead-letter delivery attempt requires an idempotency key"));
    }
    const existing = entries.find((candidate) =>
      candidate.idempotencyKey === entry.idempotencyKey);
    const reservation = decisionReservations.find((candidate) =>
      candidate.idempotencyKey === entry.idempotencyKey);
    const retainedRetirementKeys = reservation?.retirementKeys ?? existing?.retirementKeys;
    const claimedEntry = entry.retirementKeys === undefined && retainedRetirementKeys !== undefined
      ? { ...entry, retirementKeys: retainedRetirementKeys }
      : entry;
    const terminalDecision = await lookupTerminalDecision(claimedEntry);
    if (!terminalDecision.ok) return terminalDecision;
    if (terminalDecision.value !== undefined) {
      const reconciled = await terminalizeOwner(
        claimedEntry,
        terminalDecision.value,
        entries,
        decisionReservations,
      );
      if (!reconciled.ok) return reconciled;
      return ok({ claimed: false, terminalDecision: terminalDecision.value });
    }
    if (claimedEntry.attachment?.kind === "source") {
      return err(new Error("Dead-letter attachment must be snapshotted before delivery"));
    }
    if (existing) {
      const same = isSameAnnouncementRecovery(existing, claimedEntry);
      if (!same.ok) return same;
      if (!same.value) return err(new Error("Dead-letter recovery key identity mismatch"));
      if (existing.lastError !== "transport_rejected") return ok({ claimed: false });
      const now = systemNowMs();
      if (
        existing.attemptCount >= maxRetries
        || now - existing.failedAt >= maxAgeMs
        || now - existing.lastAttemptAt < retryIntervalMs
      ) return ok({ claimed: false });
      const reclaimedEntries = entries.map((candidate) => candidate.id === existing.id
        ? {
            ...candidate,
            attemptCount: candidate.attemptCount + 1,
            lastAttemptAt: now,
            lastError: "outward_operation_in_flight",
          }
        : candidate);
      const reclaimed = await persist(reclaimedEntries);
      if (!reclaimed.ok) return reclaimed;
      entries = reclaimedEntries;
      return ok({ claimed: true });
    }
    if (reservation) {
      const same = isSameAnnouncementRecovery(
        { ...claimedEntry, ...reservation, lastAttemptAt: 0 },
        claimedEntry,
      );
      if (!same.ok) return same;
      if (!same.value) {
        return err(new Error("Announcement operation reservation identity mismatch"));
      }
    }
    const id = tryCatch(() => randomUUID());
    if (!id.ok) return id;
    const now = systemNowMs();
    const claimed: DeadLetterEntry = {
      ...claimedEntry,
      id: id.value,
      attemptCount: claimedEntry.attemptCount,
      lastAttemptAt: now,
      lastError: "outward_operation_in_flight",
    };
    const nextEntries = [...entries, claimed];
    const nextReservations = reservation
      ? decisionReservations.filter((candidate) => candidate.id !== reservation.id)
      : decisionReservations;
    if (!canPersistCounts(nextEntries.length, nextReservations.length)) {
      return err(new Error("Dead-letter quarantine capacity exhausted"));
    }
    const persisted = await persist(nextEntries, nextReservations);
    if (!persisted.ok) return persisted;
    entries = nextEntries;
    decisionReservations = nextReservations;
    emitAdmission(claimed);
    return ok({ claimed: true });
  }

  async function settleDeliveryAttemptDurably(
    idempotencyKey: string,
    outcome: "accepted" | "rejected" | "unknown",
  ): Promise<Result<boolean, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const entry = entries.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (!entry) return ok(false);
    if (outcome === "accepted") {
      const pendingEntries = entries.map((candidate) => candidate.id === entry.id
        ? { ...candidate, lastError: "receipt_accepted_terminalization_pending" }
        : candidate);
      const pending = await persist(pendingEntries);
      if (!pending.ok) return pending;
      entries = pendingEntries;
      const nextEntries = pendingEntries.filter((candidate) => candidate.id !== entry.id);
      const terminalized = await terminalizeOwner(
        entry,
        "delivered",
        nextEntries,
        decisionReservations,
      );
      if (!terminalized.ok) return terminalized;
      const removed = await persist(nextEntries);
      if (!removed.ok) return removed;
      entries = nextEntries;
      emittedAdmissionKeys.delete(announcementRecoveryKey(entry));
      if (entry.attachment?.kind === "snapshot") {
        await cleanupUnreferencedSnapshots([{ attachment: entry.attachment }]);
      }
      return ok(true);
    }
    const nextEntries = entries.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            lastError: outcome === "rejected"
              ? "transport_rejected"
              : "outward_operation_unresolved",
          }
        : candidate);
    const persisted = await persist(nextEntries);
    if (!persisted.ok) return persisted;
    entries = nextEntries;
    return ok(true);
  }

  async function recordDecisionTextChunksDurably(
    idempotencyKey: string,
    chunks: readonly string[],
  ): Promise<Result<void, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    if (!isAnnouncementTextChunks(chunks)) {
      return err(new Error("Announcement text chunk manifest is invalid"));
    }
    const reservationIndex = decisionReservations.findIndex(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    const entryIndex = entries.findIndex(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if ((reservationIndex >= 0) === (entryIndex >= 0)) {
      return err(new Error("Announcement text chunk owner is unavailable or ambiguous"));
    }
    const existingChunks = reservationIndex >= 0
      ? decisionReservations[reservationIndex]?.textChunks
      : entries[entryIndex]?.textChunks;
    if (existingChunks !== undefined) {
      const matches = existingChunks.length === chunks.length
        && existingChunks.every((chunk, index) => chunk === chunks[index]);
      return matches
        ? ok(undefined)
        : err(new Error("Announcement text chunk manifest identity mismatch"));
    }
    const persistedChunks = [...chunks];
    const nextEntries = [...entries];
    const nextReservations = [...decisionReservations];
    if (reservationIndex >= 0) {
      const reservation = nextReservations[reservationIndex];
      if (!reservation) return err(new Error("Announcement text chunk owner is unavailable"));
      nextReservations[reservationIndex] = { ...reservation, textChunks: persistedChunks };
    } else {
      const entry = nextEntries[entryIndex];
      if (!entry) return err(new Error("Announcement text chunk owner is unavailable"));
      nextEntries[entryIndex] = { ...entry, textChunks: persistedChunks };
    }
    const persisted = await persist(nextEntries, nextReservations);
    if (persisted.ok) {
      entries = nextEntries;
      decisionReservations = nextReservations;
    }
    return persisted;
  }

  async function lookupDecisionTextChunksDurably(
    completionKey: string,
  ): Promise<Result<readonly string[] | undefined, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const manifests = [
      ...entries.filter((entry) =>
        entry.idempotencyKey === completionKey
        || entry.completionKeys?.includes(completionKey) === true),
      ...decisionReservations.filter((reservation) =>
        reservation.idempotencyKey === completionKey
        || reservation.completionKeys.includes(completionKey)),
    ].flatMap((owner) => owner.textChunks ? [owner.textChunks] : []);
    const manifest = manifests[0];
    if (!manifest) return ok(undefined);
    const matches = manifests.every((candidate) =>
      candidate.length === manifest.length
      && candidate.every((chunk, index) => chunk === manifest[index]));
    return matches
      ? ok([...manifest])
      : err(new Error("Announcement text chunk manifest identity mismatch"));
  }

  async function recordDrainingEntryTextChunks(
    entry: DeadLetterEntry,
    chunks: readonly string[],
  ): Promise<Result<void, Error>> {
    if (!entry.idempotencyKey) {
      return err(new Error("Announcement text chunk owner has no durable identity"));
    }
    const recorded = await recordDecisionTextChunksDurably(entry.idempotencyKey, chunks);
    const authoritativeEntry = entries.find((candidate) => candidate.id === entry.id);
    if (authoritativeEntry?.textChunks) {
      entry.textChunks = [...authoritativeEntry.textChunks];
    }
    return recorded;
  }

  /** Settle reservations after the rewrite grace. The ledger decides whether
   * delivery is safe; missing roots, errors, and uncertainty remain parked. */
  async function adjudicateReservations(ledger?: OutwardSendLedgerPort): Promise<void> {
    if (decisionReservations.length === 0) return;
    const settled: string[] = [];
    const terminalSettlements: Array<{
      reservation: ParentDecisionReservationRecord;
      decision: AnnouncementTerminalDecision;
    }> = [];
    const nextEntries = [...entries];
    for (const reservation of [...decisionReservations]) {
      const terminalDecision = await lookupTerminalDecision(reservation);
      if (!terminalDecision.ok) {
        logger?.warn(
          {
            runId: reservation.runId,
            errorKind: "dependency" as const,
            hint: "restore terminal-decision storage before adjudicating the retained parent completion",
          },
          "Parent decision terminal state could not be read",
        );
        continue;
      }
      if (terminalDecision.value !== undefined) {
        settled.push(reservation.idempotencyKey);
        terminalSettlements.push({
          reservation,
          decision: terminalDecision.value,
        });
        continue;
      }
      const remainingGraceMs = parentDecisionGraceMs
        - (systemNowMs() - reservation.failedAt);
      if (remainingGraceMs > 0) {
        logger?.debug(
          { runId: reservation.runId, remainingMs: remainingGraceMs, step: "parent-decision-rewrite-grace" },
          "Parent decision reservation remains parked while its rewrite can still be running",
        );
        continue;
      }
      if (!ledger && reservation.attachment) {
        logger?.warn(
          {
            runId: reservation.runId,
            errorKind: "precondition" as const,
            hint: "enable governed attachment delivery or explicitly release the quarantined announcement",
          },
          "Ledgerless completion attachment requires operator review",
        );
        nextEntries.push({
          id: reservation.id,
          announcementText: reservation.announcementText,
          channelType: reservation.channelType,
          channelId: reservation.channelId,
          agentId: reservation.agentId,
          runId: reservation.runId,
          sessionKey: reservation.sessionKey,
          failedAt: reservation.failedAt,
          attemptCount: 0,
          lastAttemptAt: 0,
          lastError: "attachment_delivery_unavailable",
          idempotencyKey: reservation.idempotencyKey,
          rootRunId: reservation.rootRunId,
          deliveryAuthority: reservation.deliveryAuthority,
          destinationEndpoint: reservation.destinationEndpoint,
          completionKeys: reservation.completionKeys,
          ...(reservation.retirementKeys
            ? { retirementKeys: reservation.retirementKeys }
            : {}),
          ...(reservation.partId ? { partId: reservation.partId } : {}),
          ...(reservation.textChunks ? { textChunks: reservation.textChunks } : {}),
          attachment: reservation.attachment,
          ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
          ...(reservation.extra ? { extra: reservation.extra } : {}),
        } as DeadLetterEntry);
        settled.push(reservation.idempotencyKey);
        continue;
      }
      const step = ledger && reservation.attachment
        ? await fromPromise(
            ledger.allocateStep(reservation.rootRunId, reservation.idempotencyKey),
          )
        : undefined;
      if (step && (!step.ok || !step.value.ok)) {
          logger?.debug(
            { runId: reservation.runId },
            "Parent decision reservation left parked: outward step could not be resolved",
          );
          continue;
        }
      logger?.warn(
        {
          runId: reservation.runId,
          errorKind: "timeout" as const,
          hint: "Inspect the parent completion rewrite timeout; the durable user-safe fallback is now eligible for governed delivery",
          step: "parent-decision-fallback",
        },
        "Parent decision rewrite grace elapsed; adjudicating its safe fallback",
      );
      nextEntries.push({
        id: reservation.id,
        announcementText: reservation.announcementText,
        channelType: reservation.channelType,
        channelId: reservation.channelId,
        agentId: reservation.agentId,
        runId: reservation.runId,
        sessionKey: reservation.sessionKey,
        failedAt: reservation.failedAt,
        attemptCount: 0,
        lastAttemptAt: 0,
        idempotencyKey: reservation.idempotencyKey,
        rootRunId: reservation.rootRunId,
        ...(step?.ok && step.value.ok ? { stepIndex: step.value.value } : {}),
        deliveryAuthority: reservation.deliveryAuthority,
        destinationEndpoint: reservation.destinationEndpoint,
        completionKeys: reservation.completionKeys,
        ...(reservation.retirementKeys
          ? { retirementKeys: reservation.retirementKeys }
          : {}),
        ...(!ledger ? { lastError: "transport_rejected" } : {}),
        ...(reservation.partId ? { partId: reservation.partId } : {}),
        ...(reservation.textChunks ? { textChunks: reservation.textChunks } : {}),
        ...(reservation.attachment ? { attachment: reservation.attachment } : {}),
        ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
        ...(reservation.extra ? { extra: reservation.extra } : {}),
      } as DeadLetterEntry);
      settled.push(reservation.idempotencyKey);
    }
    if (settled.length === 0) return;
    const remaining = decisionReservations.filter(
      (r) => !settled.includes(r.idempotencyKey),
    );
    for (const terminal of terminalSettlements) {
      const reconciled = await terminalizeOwner(
        terminal.reservation,
        terminal.decision,
        nextEntries,
        remaining,
      );
      if (!reconciled.ok) return;
    }
    const persisted = await persist(nextEntries, remaining);
    if (!persisted.ok) {
      logger?.warn(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; the adjudicated announcements stay in memory for this drain",
        },
        "Failed to persist adjudicated parent decision reservations",
      );
      return;
    }
    entries = nextEntries;
    decisionReservations = [...remaining];
  }

  function recoveryOptions(entry: DeadLetterEntry): RecoveryDeliveryOptions | undefined {
    return entry.threadId || entry.extra || entry.deliveryAuthority || entry.destinationEndpoint
      ? {
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
          ...(entry.extra ? { extra: entry.extra } : {}),
          ...(entry.deliveryAuthority ? { authority: entry.deliveryAuthority } : {}),
          ...(entry.destinationEndpoint ? { destinationEndpoint: entry.destinationEndpoint } : {}),
        }
      : undefined;
  }

  async function drainLedgerlessTextChunks(
    entry: DeadLetterEntry,
    workingEntries: readonly DeadLetterEntry[],
    deliveredIds: ReadonlySet<string>,
  ): Promise<"delivered" | "retained" | "discarded" | "no_reply"> {
    const chunkOwners = textChunkOwners(entry);
    if (chunkOwners.length === 0 || !receiptAwareSendToChannel) return "retained";
    const unresolvedOperationId = unresolvedChunkOperationId(entry);
    if (unresolvedOperationId !== undefined) {
      const unresolvedOwner = chunkOwners.find((owner) =>
        owner.idempotencyKey === unresolvedOperationId);
      if (!unresolvedOwner) return "retained";
      const terminal = await lookupTerminalDecision(unresolvedOwner);
      if (!terminal.ok || terminal.value === undefined) return "retained";
      if (terminal.value !== "delivered") return terminal.value;
      entry.lastError = "transport_rejected";
      const reconciled = workingEntries.filter((candidate) => !deliveredIds.has(candidate.id));
      const persisted = await persist(reconciled);
      if (!persisted.ok) return "retained";
      entries = [...reconciled];
    } else if (
      entry.lastError === "outward_operation_in_flight"
      || entry.lastError === "outward_operation_unresolved"
    ) {
      return "retained";
    }
    for (const chunkOwner of chunkOwners) {
      const terminal = await lookupTerminalDecision(chunkOwner);
      if (!terminal.ok) return "retained";
      if (terminal.value !== undefined) {
        if (terminal.value !== "delivered") return terminal.value;
        continue;
      }
      if (entry.attemptCount >= maxRetries) {
        entry.lastError = "attempt_limit_reached";
        return "retained";
      }
      entry.attemptCount++;
      entry.lastAttemptAt = systemNowMs();
      entry.lastError = `${CHUNK_IN_FLIGHT_PREFIX}${chunkOwner.idempotencyKey}`;
      const inFlightEntries = workingEntries.filter((candidate) =>
        !deliveredIds.has(candidate.id));
      const inFlightPersisted = await persist(inFlightEntries);
      if (!inFlightPersisted.ok) return "retained";
      entries = [...inFlightEntries];
      const sent = await fromPromise(receiptAwareSendToChannel(
        entry.channelType,
        entry.channelId,
        chunkOwner.announcementText,
        recoveryOptions(entry),
      ));
      const status = sent.ok && sent.value.ok ? sent.value.value.status : "unknown";
      if (status === "accepted") {
        const terminalized = await recordTerminalDecision(chunkOwner, "delivered");
        if (!terminalized.ok) {
          entry.lastError = `${CHUNK_UNRESOLVED_PREFIX}${chunkOwner.idempotencyKey}`;
          return "retained";
        }
        entry.attemptCount = 0;
        entry.lastError = "transport_rejected";
        const stableEntries = workingEntries.filter((candidate) =>
          !deliveredIds.has(candidate.id));
        const stablePersisted = await persist(stableEntries);
        if (!stablePersisted.ok) return "retained";
        entries = [...stableEntries];
        continue;
      }
      entry.lastError = status === "rejected"
        ? "transport_rejected"
        : `${CHUNK_UNRESOLVED_PREFIX}${chunkOwner.idempotencyKey}`;
      const retainedEntries = workingEntries.filter((candidate) =>
        !deliveredIds.has(candidate.id));
      const retained = await persist(retainedEntries);
      if (retained.ok) entries = [...retainedEntries];
      return "retained";
    }
    return "delivered";
  }

  async function drainSerialized(
    sendToChannel: (type: ChannelType, id: string, text: string, options?: RecoveryDeliveryOptions) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void> {
    const load = await loadFromDisk();
    if (!load.ok) return;
    const collectedRetirements = await collectTerminalRetirementsDurably();
    if (!collectedRetirements.ok) {
      logger?.warn(
        {
          errorKind: "resource" as const,
          hint: "restore terminal-decision storage; durable retirement intents remain queued",
        },
        "Announcement terminal retirement intents could not be collected",
      );
    }
    await promoteProducerReservations();
    await promoteProducerHandoffs();
    await adjudicateReservations(outwardLedger);
    if (entries.length === 0) return;
    const now = systemNowMs();
    const workingEntries = entries.map((entry) => ({ ...entry }));
    const deliveredIds = new Set<string>();
    const deliveredEntries: Array<{
      entry: DeadLetterEntry;
      outcome:
        | "untracked_delivery"
        | "receipt_already_committed"
        | "receipt_committed_now"
        | "suppressed_terminal_decision";
      durationMs: number;
    }> = [];
    for (const entry of workingEntries) {
      const terminalDecision = await lookupTerminalDecision(entry);
      if (!terminalDecision.ok) {
        logger?.warn(
          {
            runId: entry.runId,
            errorKind: "dependency" as const,
            hint: "restore terminal-decision storage before retrying the retained announcement",
          },
          "Dead-letter terminal state could not be read",
        );
        continue;
      }
      if (terminalDecision.value !== undefined) {
        const retainedEntries = workingEntries.filter((candidate) =>
          candidate.id !== entry.id && !deliveredIds.has(candidate.id));
        const reconciled = await terminalizeOwner(
          entry,
          terminalDecision.value,
          retainedEntries,
          decisionReservations,
        );
        if (!reconciled.ok) continue;
        deliveredIds.add(entry.id);
        deliveredEntries.push({
          entry,
          outcome: "suppressed_terminal_decision",
          durationMs: systemNowMs() - now,
        });
        continue;
      }
      if (!outwardLedger && entry.lastError === "receipt_accepted_terminalization_pending") {
        const retainedEntries = workingEntries.filter((candidate) =>
          candidate.id !== entry.id && !deliveredIds.has(candidate.id));
        const terminalized = await terminalizeOwner(
          entry,
          "delivered",
          retainedEntries,
          decisionReservations,
        );
        if (!terminalized.ok) continue;
        deliveredIds.add(entry.id);
        deliveredEntries.push({
          entry,
          outcome: "untracked_delivery",
          durationMs: systemNowMs() - now,
        });
        continue;
      }
      if (!outwardLedger && textChunkOwners(entry).length > 0) {
        const chunkOutcome = await drainLedgerlessTextChunks(
          entry,
          workingEntries,
          deliveredIds,
        );
        if (chunkOutcome === "retained") continue;
        const retainedEntries = workingEntries.filter((candidate) =>
          candidate.id !== entry.id && !deliveredIds.has(candidate.id));
        const terminalized = await terminalizeOwner(
          entry,
          chunkOutcome === "delivered" ? "delivered" : chunkOutcome,
          retainedEntries,
          decisionReservations,
        );
        if (!terminalized.ok) continue;
        deliveredIds.add(entry.id);
        deliveredEntries.push({
          entry: { ...entry },
          outcome: chunkOutcome === "delivered"
            ? "untracked_delivery"
            : "suppressed_terminal_decision",
          durationMs: systemNowMs() - now,
        });
        continue;
      }
      if (!outwardLedger && entry.lastError === "outward_operation_in_flight") {
        continue;
      }
      if (!outwardLedger && entry.lastError === "outward_operation_unresolved") {
        continue;
      }
      if (!outwardLedger && entry.lastError === "attachment_delivery_unavailable") {
        continue;
      }
      if (!outwardLedger && entry.attemptCount >= maxRetries) {
        if (entry.lastError !== "attempt_limit_reached") {
          logger?.warn(
            {
              runId: entry.runId,
              attemptCount: entry.attemptCount,
              errorKind: "precondition" as const,
              hint: "review and explicitly release the exhausted dead-letter entry",
            },
            "Dead-letter entry reached its attempt limit",
          );
        }
        entry.lastError = "attempt_limit_reached";
        continue;
      }
      if (!outwardLedger && now - entry.failedAt >= maxAgeMs) {
        if (entry.lastError !== "retention_window_elapsed") {
          logger?.warn(
            {
              runId: entry.runId,
              ageMs: now - entry.failedAt,
              errorKind: "precondition" as const,
              hint: "review and explicitly release the expired dead-letter entry",
            },
            "Dead-letter entry reached its retention window",
          );
        }
        entry.lastError = "retention_window_elapsed";
        continue;
      }
      if (now - entry.lastAttemptAt < retryIntervalMs) continue;
      const deliveryStartedAt = systemNowMs();
      if (outwardLedger) {
        const governed = await drainGovernedEntry(outwardLedger, entry);
        if (governed !== "retained") {
          deliveredIds.add(entry.id);
          deliveredEntries.push({ entry, outcome: governed, durationMs: systemNowMs() - deliveryStartedAt });
        }
        continue;
      }
      entry.attemptCount++;
      entry.lastAttemptAt = systemNowMs();
      entry.lastError = "outward_operation_in_flight";
      const preAttemptEntries = workingEntries.filter((candidate) =>
        !deliveredIds.has(candidate.id));
      const preAttemptPersisted = await persist(preAttemptEntries);
      if (!preAttemptPersisted.ok) return;
      entries = [...preAttemptEntries];
      const options = recoveryOptions(entry);
      const receiptBoundary = receiptAwareSendToChannel
        ? await fromPromise(receiptAwareSendToChannel(
            entry.channelType,
            entry.channelId,
            entry.announcementText,
            options,
          ))
        : undefined;
      const booleanBoundary = receiptBoundary === undefined
        ? await fromPromise(sendToChannel(
            entry.channelType,
            entry.channelId,
            entry.announcementText,
            options,
          ))
        : undefined;
      const deliveryStatus = receiptBoundary?.ok && receiptBoundary.value.ok
        ? receiptBoundary.value.value.status
        : booleanBoundary?.ok && booleanBoundary.value
          ? "accepted" as const
          : "unknown" as const;
      if (deliveryStatus === "accepted") {
        entry.lastError = "receipt_accepted_terminalization_pending";
        const pendingEntries = workingEntries.filter((candidate) =>
          !deliveredIds.has(candidate.id));
        const pendingPersisted = await persist(pendingEntries);
        if (!pendingPersisted.ok) return;
        entries = [...pendingEntries];
        const retainedEntries = pendingEntries.filter((candidate) =>
          candidate.id !== entry.id);
        const terminalized = await terminalizeOwner(
          entry,
          "delivered",
          retainedEntries,
          decisionReservations,
        );
        if (!terminalized.ok) continue;
        deliveredIds.add(entry.id);
        deliveredEntries.push({
          entry: { ...entry },
          outcome: "untracked_delivery", durationMs: systemNowMs() - deliveryStartedAt,
        });
      } else if (deliveryStatus === "rejected") {
        entry.lastError = "transport_rejected";
      } else {
        entry.lastError = "outward_operation_unresolved";
      }
    }
    const nextEntries = workingEntries.filter((entry) => !deliveredIds.has(entry.id));
    const deliveredSnapshots = deliveredEntries.flatMap(({ entry }) =>
      entry.attachment?.kind === "snapshot" ? [{ attachment: entry.attachment }] : []);
    const persisted = await persist(nextEntries);
    if (!persisted.ok) {
      await cleanupUnreferencedSnapshots(deliveredSnapshots);
      logger?.error(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; no delivery completion was acknowledged",
        },
        "Dead-letter drain state was not persisted",
      );
      return;
    }
    entries = nextEntries;
    await cleanupUnreferencedSnapshots(deliveredSnapshots);
    for (const delivered of deliveredEntries) {
      emittedAdmissionKeys.delete(announcementRecoveryKey(delivered.entry));
    }
    const settledCompletionKeys = new Set<string>();
    for (const delivered of deliveredEntries) {
      const { entry, outcome, durationMs } = delivered;
      const completionKeys = entry.completionKeys
        ?? (entry.idempotencyKey ? [entry.idempotencyKey] : []);
      for (const completionKey of completionKeys) {
        const stillRetained = entries.some((candidate) =>
          candidate.idempotencyKey === completionKey
          || candidate.completionKeys?.includes(completionKey) === true)
          || decisionReservations.some((candidate) =>
            candidate.idempotencyKey === completionKey
            || candidate.completionKeys.includes(completionKey));
        if (!stillRetained && onDelivered && !settledCompletionKeys.has(completionKey)) {
          settledCompletionKeys.add(completionKey);
          tryCatch(() => onDelivered(completionKey));
        }
      }
      if (outcome !== "suppressed_terminal_decision") emitDelivered(entry, entry.attemptCount);
      // INFO closes the opening WARN after the queue file is unlinked. It is
      // emitted once per resolved entry, so volume is naturally bounded.
      logger?.info(
        {
          runId: entry.runId,
          attemptCount: entry.attemptCount,
          durationMs,
          ...(outcome !== "untracked_delivery" ? {
            rootRunId: entry.rootRunId,
            stepIndex: entry.stepIndex,
          } : {}),
          step: outcome === "receipt_already_committed"
            ? "dlq-ledger-committed-skip"
            : outcome === "receipt_committed_now"
              ? "dlq-ledger-receipt-committed"
              : outcome === "suppressed_terminal_decision"
                ? "dlq-terminal-decision-suppressed"
              : "dead-letter-delivery",
        },
        outcome === "receipt_already_committed"
          ? "Committed dead-letter operation removed without replay"
          : outcome === "receipt_committed_now"
            ? "Dead-letter entry delivered and platform receipt committed"
            : outcome === "suppressed_terminal_decision"
              ? "Dead-letter terminal decision removed without delivery"
            : "Dead-letter entry delivered successfully",
      );
    }
  }

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
        entries,
        decisionReservations,
      );
      if (!reconciled.ok) return reconciled;
      const consumed = await consumeProducerReservationsDurably([entry.runId]);
      if (!consumed.ok) return consumed;
      return ok({ created: false, terminalDecision: terminalDecision.value });
    }
    const existing = await decisionStore.lookup(entry.idempotencyKey);
    if (!existing.ok) return existing;
    const deferred = producerHandoffs.find((handoff) => handoff.operations.some((operation) =>
      operation.idempotencyKey === entry.idempotencyKey));
    if (deferred) {
      consumeProducerSlots([entry.runId]);
      return ok({ created: false, deferred: true });
    }
    const prepared = await prepareReservedAttachment(
      entry,
      existing.value ? [existing.value] : [],
    );
    if (!prepared.ok) return prepared;
    const reserved = await decisionStore.reserve(
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
    const existing = producerHandoffs.filter((handoff) => handoff.operations.some((operation) =>
      operationKeys.has(operation.idempotencyKey)));
    const reusable = existing.flatMap((handoff) => handoff.operations);
    const preparedOperations: AnnouncementParentDecisionReservation[] = [];
    const transientSnapshots: Array<{
      attachment: AnnouncementDeadLetterAttachmentSnapshot;
      cleanup: () => Promise<Result<void, Error>>;
    }> = [];
    for (const operation of operations) {
      const prepared = await prepareReservedAttachment(operation, reusable);
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
      producerHandoffs.length + producerReservations.length + 1,
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
      entries,
      decisionReservations,
      invalidRecords,
      [...producerHandoffs, record],
    );
    if (!persisted.ok) {
      await cleanupUnreferencedSnapshots(transientSnapshots);
      return persisted;
    }
    producerHandoffs = [...producerHandoffs, record];
    consumeProducerSlots(producerKeys);
    return ok({ created: false, deferred: true });
  }

  function publicProducerReservation(
    record: ProducerReservationRecord,
  ): AnnouncementProducerReservation {
    const { recordType: _recordType, id: _id, ...reservation } = record;
    return reservation;
  }

  async function promoteProducerReservations(): Promise<void> {
    for (const record of [...producerReservations]) {
      if (activeProducerKeys.has(record.runId)) continue;
      const reservation = publicProducerReservation(record);
      const terminal = await lookupTerminalDecision(reservation);
      if (!terminal.ok) continue;
      if (terminal.value !== undefined) {
        const reconciled = await terminalizeOwner(
          reservation,
          terminal.value,
          entries,
          decisionReservations,
        );
        if (!reconciled.ok) continue;
        await cancelProducerDurably(record.runId);
        continue;
      }
      const promoted = await decisionStore.reserve(reservation);
      if (!promoted.ok) continue;
      if (!promoted.value.created) await cancelProducerDurably(record.runId);
    }
  }

  async function promoteProducerHandoffs(): Promise<void> {
    for (const handoff of [...producerHandoffs]) {
      const expectedKeys = handoff.expectedKeys;
      const promotable: AnnouncementParentDecisionReservation[] = [];
      const terminalOperations: Array<{
        operation: AnnouncementParentDecisionReservation;
        decision: AnnouncementTerminalDecision;
      }> = [];
      const settledCompletionKeys = new Set<string>();
      let terminalLookupFailed = false;
      for (const operation of handoff.operations) {
        const terminal = await lookupTerminalDecision(operation);
        if (!terminal.ok) {
          terminalLookupFailed = true;
          break;
        }
        if (terminal.value === undefined) {
          promotable.push(operation);
          continue;
        }
        terminalOperations.push({ operation, decision: terminal.value });
        const terminalized = await recordTerminalDecision(operation, terminal.value);
        if (!terminalized.ok) {
          terminalLookupFailed = true;
          break;
        }
      }
      if (terminalLookupFailed) continue;
      const logicalCompletionKeys = new Set(terminalOperations.flatMap(({ operation }) =>
        operation.completionKeys.filter((key) => key !== operation.idempotencyKey)));
      for (const completionKey of logicalCompletionKeys) {
        if (promotable.some((operation) =>
          operation.idempotencyKey === completionKey
          || operation.completionKeys.includes(completionKey))) continue;
        const owners = terminalOperations.filter(({ operation }) =>
          operation.completionKeys.includes(completionKey));
        const representative = owners[0]?.operation;
        if (!representative) continue;
        const decision: AnnouncementTerminalDecision = owners.every(({ decision: outcome }) =>
          outcome === "delivered")
          ? "delivered"
          : owners.some(({ decision: outcome }) => outcome === "no_reply")
            ? "no_reply"
            : "discarded";
        const terminalized = await recordTerminalDecision({
          ...representative,
          idempotencyKey: completionKey,
          completionKeys: [completionKey],
          retirementKeys: [completionKey],
        }, decision);
        if (!terminalized.ok) {
          terminalLookupFailed = true;
          break;
        }
        settledCompletionKeys.add(completionKey);
      }
      if (terminalLookupFailed) continue;
      const promoted = await decisionStore.replace(
        expectedKeys,
        promotable,
        [...settledCompletionKeys],
      );
      if (!promoted.ok) {
        if (promoted.error.message !== "Dead-letter quarantine capacity exhausted") {
          logger?.warn(
            {
              errorKind: "resource" as const,
              hint: "restore dead-letter storage before retrying the retained producer handoff",
            },
            "Announcement producer handoff could not be promoted",
          );
        }
        continue;
      }
      const remaining = producerHandoffs.filter((candidate) =>
        candidate.transitionId !== handoff.transitionId);
      const removed = await persist(entries, decisionReservations, invalidRecords, remaining);
      if (!removed.ok) continue;
      producerHandoffs = remaining;
    }
  }

  return {
    reserveProducer: (reservation, signal) => admitWithBackpressure(
      () => reserveProducerDurably(reservation),
      signal,
    ),
    releaseProducer: (producerKey) => serializeStateChange(
      () => releaseProducerDurably(producerKey),
    ),
    cancelProducer: (producerKey) => serializeStateChange(
      () => cancelProducerDurably(producerKey),
    ),
    enqueue: (entry, signal) => admitWithBackpressure(() => enqueueDurably(entry), signal),
    beginDeliveryAttempt: (entry, signal) =>
      admitWithBackpressure(() => beginDeliveryAttemptDurably(entry), signal),
    settleDeliveryAttempt: (idempotencyKey, outcome) =>
      serializeStateChange(() => settleDeliveryAttemptDurably(idempotencyKey, outcome)),
    reserveDecision: (entry, signal) => admitWithBackpressure(
      () => reserveDecisionDurably(entry),
      signal,
      () => handoffDecisionsDurably([], [entry]),
    ),
    lookupDecision: (idempotencyKey) =>
      serialize(() => decisionStore.lookup(idempotencyKey)),
    lookupDecisionTextChunks: (completionKey) =>
      serialize(() => lookupDecisionTextChunksDurably(completionKey)),
    resolveDecision: (idempotencyKey, outcome) =>
      serializeStateChange(() => resolveDecisionDurably(idempotencyKey, outcome)),
    recordDecisionTextChunks: (idempotencyKey, chunks) =>
      serialize(() => recordDecisionTextChunksDurably(idempotencyKey, chunks)),
    replaceDecisions: (expectedKeys, operations, signal) =>
      admitWithBackpressure(async () => {
        const loaded = await loadFromDisk();
        if (!loaded.ok) return loaded;
        const nonterminalOperations: AnnouncementParentDecisionReservation[] = [];
        const terminalOperations: Array<{
          operation: AnnouncementParentDecisionReservation;
          decision: AnnouncementTerminalDecision;
        }> = [];
        const settledCompletionKeys = new Set<string>();
        const expected = new Set(expectedKeys);
        const reusable = decisionReservations.filter((reservation) =>
          expected.has(reservation.idempotencyKey));
        for (const operation of operations) {
          const terminalDecision = await lookupTerminalDecision(operation);
          if (!terminalDecision.ok) return terminalDecision;
          if (terminalDecision.value === undefined) {
            nonterminalOperations.push(operation);
            continue;
          }
          terminalOperations.push({
            operation,
            decision: terminalDecision.value,
          });
          for (const completionKey of operation.completionKeys) {
            if (completionKey !== operation.idempotencyKey) {
              settledCompletionKeys.add(completionKey);
            }
          }
        }
        if (nonterminalOperations.length > maxEntries) {
          return err(new Error("Replacement announcement set exceeds quarantine capacity"));
        }
        const pendingOperations: AnnouncementParentDecisionReservation[] = [];
        const transientSnapshots: Array<{
          attachment: AnnouncementDeadLetterAttachmentSnapshot;
          cleanup: () => Promise<Result<void, Error>>;
        }> = [];
        for (const operation of nonterminalOperations) {
          const prepared = await prepareReservedAttachment(operation, reusable);
          if (!prepared.ok) {
            await cleanupUnreferencedSnapshots(transientSnapshots);
            return prepared;
          }
          pendingOperations.push(
            prepared.value.entry as AnnouncementParentDecisionReservation,
          );
          if (
            prepared.value.cleanup
            && prepared.value.entry.attachment?.kind === "snapshot"
          ) {
            transientSnapshots.push({
              attachment: prepared.value.entry.attachment,
              cleanup: prepared.value.cleanup,
            });
          }
        }
        const anticipatedReservations = [
          ...decisionReservations.filter((reservation) =>
            !expected.has(reservation.idempotencyKey)),
          ...pendingOperations,
        ];
        for (const terminal of terminalOperations) {
          const reconciled = await terminalizeOwner(
            terminal.operation,
            terminal.decision,
            entries,
            anticipatedReservations,
          );
          if (!reconciled.ok) {
            await cleanupUnreferencedSnapshots(transientSnapshots);
            return reconciled;
          }
        }
        const producerKeys = [...new Set(operations.map((operation) => operation.runId))];
        const replaced = await decisionStore.replace(
          expectedKeys,
          pendingOperations,
          [...settledCompletionKeys],
          producerKeys,
        );
        if (replaced.ok) {
          consumeProducerSlots(producerKeys);
        }
        if (!replaced.ok || !replaced.value.created) {
          await cleanupUnreferencedSnapshots(transientSnapshots);
        }
        await cleanupUnreferencedSnapshots(reusable.flatMap((reservation) =>
          reservation.attachment?.kind === "snapshot"
            ? [{ attachment: reservation.attachment }]
            : []));
        return replaced;
      }, signal, () => handoffDecisionsDurably(expectedKeys, operations)),
    prepareTerminalDecisionRetirement: (completionKeys, producer) => serialize(async () => {
      if (outwardLedger) return ok(undefined);
      return terminalDecisionStore.prepareRetirement(completionKeys, producer);
    }),
    collectTerminalDecisionRetirements: () => serialize(
      () => collectTerminalRetirementsDurably(),
    ),
    drain: (sendToChannel, onDelivered) =>
      serializeStateChange(() => drainSerialized(sendToChannel, onDelivered)),
    durableStatus: () => serialize(async () => {
      const load = await loadFromDisk();
      if (!load.ok) return load;
      const terminalInvalid = await refreshTerminalInvalidRecords();
      if (!terminalInvalid.ok) return terminalInvalid;
      const status = quarantineClassification().status;
      return ok({
        ...status,
        activeRecoveryCount: status.activeRecoveryCount
          + producerHandoffs.length
          + producerReservations.length,
      });
    }),
    size: () => entries.length
      + decisionReservations.length
      + producerHandoffs.length
      + producerReservations.length
      + invalidRecords.length
      + terminalInvalidRecords.length,
    listQuarantined: () => serialize(async () => {
      // Load before projecting: the in-memory lists are empty until some
      // operation has faulted the file in, and `list` is usually the FIRST
      // thing an operator runs after a restart.
      const loadedFromDisk = await loadFromDisk();
      if (!loadedFromDisk.ok) {
        logger?.warn(
          {
            errorKind: "resource" as const,
            hint: "restore dead-letter storage; the quarantine listing is incomplete",
          },
          "Quarantined announcement listing could not read the dead-letter file",
        );
        return loadedFromDisk;
      }
      const terminalInvalid = await refreshTerminalInvalidRecords();
      if (!terminalInvalid.ok) return terminalInvalid;
      return ok(quarantineClassification().rows);
    }),
    release: (id, outcome) => serializeStateChange(async () => {
      const loaded = await loadFromDisk();
      if (!loaded.ok) return loaded;
      const terminalInvalid = await refreshTerminalInvalidRecords();
      if (!terminalInvalid.ok) return terminalInvalid;
      if (!quarantineClassification().actionableIds.has(id)) return ok(false);
      if (terminalInvalidRecords.some((record) => record.id === id)) {
        return err(new Error("Terminal-decision corruption requires storage repair"));
      }
      const releasedEntry = entries.find((candidate) => candidate.id === id);
      const releasedReservation = decisionReservations.find((candidate) => candidate.id === id);
      const releasedDelivery = releasedEntry ?? releasedReservation;
      if (releasedEntry) {
        const chunkRelease = await settleTextChunkRelease(releasedEntry, outcome);
        if (!chunkRelease.ok) return chunkRelease;
        if (chunkRelease.value === "retain") return ok(true);
      }
      if (releasedDelivery) {
        const terminalized = await terminalizeOwner(
          releasedDelivery,
          outcome,
          entries.filter((candidate) => candidate.id !== id),
          decisionReservations.filter((candidate) => candidate.id !== id),
        );
        if (!terminalized.ok) {
          return terminalized;
        }
      }
      const released = await releaseQuarantined({
        id,
        outcome,
        entries,
        reservations: decisionReservations,
        invalidRecords,
        logger,
        persist: async (nextEntries, nextReservations, nextInvalidRecords) => {
          const written = await persist(nextEntries, nextReservations, nextInvalidRecords);
          if (written.ok) {
            entries = [...nextEntries];
            decisionReservations = [...nextReservations];
            invalidRecords = [...nextInvalidRecords];
          }
          return written;
        },
      });
      if (released.ok && released.value && releasedEntry) {
        emittedAdmissionKeys.delete(announcementRecoveryKey(releasedEntry));
      }
      if (releasedDelivery?.attachment?.kind === "snapshot") {
        await cleanupUnreferencedSnapshots([{ attachment: releasedDelivery.attachment }]);
      }
      return released;
    }),
  };
}
