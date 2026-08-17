// SPDX-License-Identifier: Apache-2.0
/** Durable retry and uncertainty quarantine for failed announcements. */

import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementDeadLetterAttachmentSnapshot,
  AnnouncementDeadLetterAttachmentSource,
  AnnouncementDeadLetterQueuePort,
  AnnouncementParentDecisionReservation,
  QuarantinedInvalidAnnouncementRecord,
} from "@comis/core";
import {
  emitObservationalEventSafely,
  systemNowMs,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import {
  createParentDecisionReservationStore,
  isDeadLetterSnapshotCapacityError,
  reservedDeadLetterSnapshotBytes,
  type DeadLetterEntry,
  type AnnouncementProducerHandoffRecord,
  type ParentDecisionReservationRecord,
  type ProducerReservationRecord,
  type StoredDeadLetterEntry,
} from "./announcement-dead-letter-file.js";
import {
  type InvalidDeadLetterRecord,
} from "./announcement-dead-letter-invalid.js";
import {
  createAnnouncementTerminalDecisionStore,
  type AnnouncementTerminalDecision,
} from "./announcement-dead-letter-terminal-decision.js";
import {
  announcementRecoveryKey,
} from "./announcement-dead-letter-identity.js";
import type {
  AnnouncementDeadLetterQueueOptions,
  PreparedRecoveryAttachment,
} from "./announcement-dead-letter-types.js";
import { createProducerLifecycle } from "./announcement-dead-letter-producer.js";
import { createGovernedDrainStage } from "./announcement-dead-letter-drain-governed.js";
import { createDecisionStage } from "./announcement-dead-letter-decisions.js";
import { createDeliveryAttemptStage } from "./announcement-dead-letter-attempts.js";
import { createSerialDrainStage } from "./announcement-dead-letter-drain-serial.js";
import { createDecisionReservationStage } from "./announcement-dead-letter-reservations.js";
import { createProducerPromotionStage } from "./announcement-dead-letter-promotion.js";
import { createStorageStage } from "./announcement-dead-letter-storage.js";
import {
  type DeadLetterQueueContext,
  type DeadLetterRecordStore,
} from "./announcement-dead-letter-context.js";
export { isAnnouncementChannelType } from "./announcement-dead-letter-file.js";
export type { AnnouncementLogger } from "./announcement-dead-letter-types.js";
export type {
  ChannelType,
  DeadLetterEntry,
  ParentDecisionReservation,
} from "./announcement-dead-letter-file.js";
import { releaseQuarantined } from "./announcement-dead-letter-quarantine.js";
export type {
  QuarantinedAnnouncement,
  QuarantineReleaseOutcome,
} from "./announcement-dead-letter-quarantine.js";

export type AnnouncementDeadLetterQueue = AnnouncementDeadLetterQueuePort;

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
    retirementProducerState,
    fileOperations,
  } = opts;
  const store: DeadLetterRecordStore = {
    entries: [],
    decisionReservations: [],
    producerReservations: [],
    producerHandoffs: [],
    invalidRecords: [],
    terminalInvalidRecords: [],
  };
  const activeProducerKeys = new Set<string>();
  const emittedAdmissionKeys = new Set<string>();
  const terminalDecisionStore = createAnnouncementTerminalDecisionStore(filePath);
  let operationTail: Promise<void> = Promise.resolve();
  let capacityVersion = 0;
  const capacityWaiters = new Set<() => void>();
  // Late-bound: every function member forwards at call time, so a stage can
  // be constructed before the stages it calls into have been built.
  const ctx: DeadLetterQueueContext = {
    store,
    maxRetries,
    retryIntervalMs,
    maxAgeMs,
    maxEntries,
    parentDecisionGraceMs,
    filePath,
    activeProducerKeys,
    emittedAdmissionKeys,
    opts,
    eventBus,
    governedSendToChannel,
    receiptAwareSendToChannel,
    prepareAttachment,
    cleanupAttachment,
    reconcileAttachments,
    retirementProducerState,
    terminalDecisionStore,
    fileOperations,
    ...(logger ? { logger } : {}),
    ...(outwardLedger ? { outwardLedger } : {}),
    serialize,
    serializeStateChange,
    signalCapacityChange: (...a: Parameters<DeadLetterQueueContext["signalCapacityChange"]>) => (signalCapacityChange as DeadLetterQueueContext["signalCapacityChange"])(...a),
    waitForCapacity: (...a: Parameters<DeadLetterQueueContext["waitForCapacity"]>) => (waitForCapacity as DeadLetterQueueContext["waitForCapacity"])(...a),
    admitWithBackpressure,
    loadFromDisk: (...a: Parameters<DeadLetterQueueContext["loadFromDisk"]>) => (loadFromDisk as DeadLetterQueueContext["loadFromDisk"])(...a),
    persist: (...a: Parameters<DeadLetterQueueContext["persist"]>) => (persist as DeadLetterQueueContext["persist"])(...a),
    canPersistCounts: (...a: Parameters<DeadLetterQueueContext["canPersistCounts"]>) => (canPersistCounts as DeadLetterQueueContext["canPersistCounts"])(...a),
    canPersistProducerOwnership: (...a: Parameters<DeadLetterQueueContext["canPersistProducerOwnership"]>) => (canPersistProducerOwnership as DeadLetterQueueContext["canPersistProducerOwnership"])(...a),
    snapshotRecords: (...a: Parameters<DeadLetterQueueContext["snapshotRecords"]>) => (snapshotRecords as DeadLetterQueueContext["snapshotRecords"])(...a),
    producerCapacityCount: (...a: Parameters<DeadLetterQueueContext["producerCapacityCount"]>) => (producerCapacityCount as DeadLetterQueueContext["producerCapacityCount"])(...a),
    quarantineCapacityCount: (...a: Parameters<DeadLetterQueueContext["quarantineCapacityCount"]>) => (quarantineCapacityCount as DeadLetterQueueContext["quarantineCapacityCount"])(...a),
    collectTerminalRetirementsDurably: (...a: Parameters<DeadLetterQueueContext["collectTerminalRetirementsDurably"]>) => (collectTerminalRetirementsDurably as DeadLetterQueueContext["collectTerminalRetirementsDurably"])(...a),
    refreshTerminalInvalidRecords: (...a: Parameters<DeadLetterQueueContext["refreshTerminalInvalidRecords"]>) => (refreshTerminalInvalidRecords as DeadLetterQueueContext["refreshTerminalInvalidRecords"])(...a),
    isSourceAttachment,
    preparedSnapshot: (...a: Parameters<DeadLetterQueueContext["preparedSnapshot"]>) => (preparedSnapshot as DeadLetterQueueContext["preparedSnapshot"])(...a),
    cleanupUnreferencedSnapshots: (...a: Parameters<DeadLetterQueueContext["cleanupUnreferencedSnapshots"]>) => (cleanupUnreferencedSnapshots as DeadLetterQueueContext["cleanupUnreferencedSnapshots"])(...a),
    emitAdmission: (...a: Parameters<DeadLetterQueueContext["emitAdmission"]>) => (emitAdmission as DeadLetterQueueContext["emitAdmission"])(...a),
    emitDelivered: (...a: Parameters<DeadLetterQueueContext["emitDelivered"]>) => (emitDelivered as DeadLetterQueueContext["emitDelivered"])(...a),
    emitLedgerTransition: (...a: Parameters<DeadLetterQueueContext["emitLedgerTransition"]>) => (emitLedgerTransition as DeadLetterQueueContext["emitLedgerTransition"])(...a),
    logLedgerFailure: (...a: Parameters<DeadLetterQueueContext["logLedgerFailure"]>) => (logLedgerFailure as DeadLetterQueueContext["logLedgerFailure"])(...a),
    retainBlockedEntry: (...a: Parameters<DeadLetterQueueContext["retainBlockedEntry"]>) => (retainBlockedEntry as DeadLetterQueueContext["retainBlockedEntry"])(...a),
    lookupTerminalDecision: (...a: Parameters<DeadLetterQueueContext["lookupTerminalDecision"]>) => (lookupTerminalDecision as DeadLetterQueueContext["lookupTerminalDecision"])(...a),
    recordTerminalDecision: (...a: Parameters<DeadLetterQueueContext["recordTerminalDecision"]>) => (recordTerminalDecision as DeadLetterQueueContext["recordTerminalDecision"])(...a),
    terminalizeOwner: (...a: Parameters<DeadLetterQueueContext["terminalizeOwner"]>) => (terminalizeOwner as DeadLetterQueueContext["terminalizeOwner"])(...a),
    retainsCompletionKey: (...a: Parameters<DeadLetterQueueContext["retainsCompletionKey"]>) => (retainsCompletionKey as DeadLetterQueueContext["retainsCompletionKey"])(...a),
    resolveDecisionDurably: (...a: Parameters<DeadLetterQueueContext["resolveDecisionDurably"]>) => (resolveDecisionDurably as DeadLetterQueueContext["resolveDecisionDurably"])(...a),
    textChunkOwners: (...a: Parameters<DeadLetterQueueContext["textChunkOwners"]>) => (textChunkOwners as DeadLetterQueueContext["textChunkOwners"])(...a),
    unresolvedChunkOperationId: (...a: Parameters<DeadLetterQueueContext["unresolvedChunkOperationId"]>) => (unresolvedChunkOperationId as DeadLetterQueueContext["unresolvedChunkOperationId"])(...a),
    settleTextChunkRelease: (...a: Parameters<DeadLetterQueueContext["settleTextChunkRelease"]>) => (settleTextChunkRelease as DeadLetterQueueContext["settleTextChunkRelease"])(...a),
    recordDrainingEntryTextChunks: (...a: Parameters<DeadLetterQueueContext["recordDrainingEntryTextChunks"]>) => (recordDrainingEntryTextChunks as DeadLetterQueueContext["recordDrainingEntryTextChunks"])(...a),
    recoveryOptions: (...a: Parameters<DeadLetterQueueContext["recoveryOptions"]>) => (recoveryOptions as DeadLetterQueueContext["recoveryOptions"])(...a),
    retryEntryFromReservation: (...a: Parameters<DeadLetterQueueContext["retryEntryFromReservation"]>) => (retryEntryFromReservation as DeadLetterQueueContext["retryEntryFromReservation"])(...a),
    parkGovernedEntry: (...a: Parameters<DeadLetterQueueContext["parkGovernedEntry"]>) => (parkGovernedEntry as DeadLetterQueueContext["parkGovernedEntry"])(...a),
    drainPreparedGovernedEntry: (...a: Parameters<DeadLetterQueueContext["drainPreparedGovernedEntry"]>) => (drainPreparedGovernedEntry as DeadLetterQueueContext["drainPreparedGovernedEntry"])(...a),
    drainGovernedEntry: (...a: Parameters<DeadLetterQueueContext["drainGovernedEntry"]>) => (drainGovernedEntry as DeadLetterQueueContext["drainGovernedEntry"])(...a),
    drainLedgerlessTextChunks: (...a: Parameters<DeadLetterQueueContext["drainLedgerlessTextChunks"]>) => (drainLedgerlessTextChunks as DeadLetterQueueContext["drainLedgerlessTextChunks"])(...a),
    adjudicateReservations: (...a: Parameters<DeadLetterQueueContext["adjudicateReservations"]>) => (adjudicateReservations as DeadLetterQueueContext["adjudicateReservations"])(...a),
    drainSerialized: (...a: Parameters<DeadLetterQueueContext["drainSerialized"]>) => (drainSerialized as DeadLetterQueueContext["drainSerialized"])(...a),
    publicProducerReservation: (...a: Parameters<DeadLetterQueueContext["publicProducerReservation"]>) => (publicProducerReservation as DeadLetterQueueContext["publicProducerReservation"])(...a),
    producerRecoveryAnnouncement: (...a: Parameters<DeadLetterQueueContext["producerRecoveryAnnouncement"]>) => (producerRecoveryAnnouncement as DeadLetterQueueContext["producerRecoveryAnnouncement"])(...a),
    consumeProducerSlots: (...a: Parameters<DeadLetterQueueContext["consumeProducerSlots"]>) => (consumeProducerSlots as DeadLetterQueueContext["consumeProducerSlots"])(...a),
    consumeProducerReservationsDurably: (keys) => consumeProducerReservationsDurably(keys),
    promoteProducerReservations: () => promoteProducerReservations(),
    recordProducerOutcomeDurably: (k, o) => recordProducerOutcomeDurably(k, o),
    releaseProducerDurably: (k) => releaseProducerDurably(k),
    removeProducerReservationDurably: (k) => removeProducerReservationDurably(k),
    promoteProducerHandoffs: () => promoteProducerHandoffs(),
    // Getter: the reservation store is built further down the factory, after
    // this object already has to exist for the stages wired above it.
    get decisionStore() { return decisionStore; },
    prepareReservedAttachment,
  };
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function producerCapacityCount(): number {
    return store.producerHandoffs.length + store.producerReservations.length;
  }

  function quarantineCapacityCount(): number {
    return store.entries.length + store.decisionReservations.length + store.invalidRecords.length;
  }

  function snapshotRecords(): StoredDeadLetterEntry[] {
    return [
      ...store.entries,
      ...store.decisionReservations,
      ...store.producerReservations,
      ...store.producerHandoffs,
      ...store.invalidRecords,
    ];
  }

  function signalCapacityChange(): void {
    capacityVersion++;
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  }

  async function serializeStateChange<T>(operation: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      const beforeProducer = producerCapacityCount();
      const beforeQuarantine = quarantineCapacityCount();
      const beforeBytes = reservedDeadLetterSnapshotBytes(snapshotRecords());
      const result = await operation();
      const afterBytes = reservedDeadLetterSnapshotBytes(snapshotRecords());
      if (
        producerCapacityCount() < beforeProducer
        || quarantineCapacityCount() < beforeQuarantine
        || (beforeBytes.ok && afterBytes.ok && afterBytes.value < beforeBytes.value)
      ) {
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
        || !isDeadLetterSnapshotCapacityError(result.error)
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

  const {
    collectTerminalRetirementsDurably,
    refreshTerminalInvalidRecords,
    loadFromDisk,
    persist,
  } = createStorageStage(ctx);


  function canPersistCounts(nextEntryCount: number, nextReservationCount: number): boolean {
    const currentCount = store.entries.length + store.decisionReservations.length + store.invalidRecords.length;
    const nextCount = nextEntryCount + nextReservationCount + store.invalidRecords.length;
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
    const consumedReservationCount = store.producerReservations.filter((reservation) =>
      consumedProducerKeys.has(reservation.runId)).length;
    const nextCount = nextProducerOwnershipCount - consumedReservationCount;
    const currentCount = producerCapacityCount();
    if (nextCount <= maxEntries || nextCount <= currentCount) return true;
    logger?.warn(
      {
        producerHandoffCount: store.producerHandoffs.length,
        producerReservationCount: store.producerReservations.length,
        maxEntries,
        errorKind: "resource" as const,
        hint: "allow retained announcements to drain before stopping additional completion producers",
      },
      "Announcement producer handoff capacity exhausted",
    );
    return false;
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
    idempotencyKey: string;
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
      reservation.idempotencyKey === entry.idempotencyKey
      && reservation.attachment?.kind === "snapshot");
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
      ...store.entries.flatMap((entry) =>
        entry.attachment?.kind === "snapshot" ? [entry.attachment.path] : []),
      ...store.decisionReservations.flatMap((reservation) =>
        reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
      ...store.producerReservations.flatMap((reservation) =>
        reservation.attachment?.kind === "snapshot" ? [reservation.attachment.path] : []),
      ...store.producerHandoffs.flatMap((handoff) => handoff.operations.flatMap((operation) =>
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
      store.entries.some((entry) =>
        entry.idempotencyKey === idempotencyKey
        || entry.completionKeys?.includes(idempotencyKey) === true),
    getReservations: () => store.decisionReservations,
    persist: (nextReservations, consumedProducerKeys) => persist(
      store.entries,
      nextReservations,
      store.invalidRecords,
      store.producerHandoffs,
      store.producerReservations,
      consumedProducerKeys,
    ),
    canPersistReservationCount: (count) => canPersistCounts(store.entries.length, count),
    replaceReservations: (nextReservations) => {
      store.decisionReservations = [...nextReservations];
    },
    logger,
  });

  const {
    quarantineClassification,
    lookupTerminalDecision,
    recordTerminalDecision,
    retainsCompletionKey,
    terminalizeOwner,
    textChunkOwners,
    unresolvedChunkOperationId,
    settleTextChunkRelease,
    resolveDecisionDurably,
  } = createDecisionStage(ctx);


  const {
    emitLedgerTransition,
    logLedgerFailure,
    retainBlockedEntry,
    parkGovernedEntry,
    drainPreparedGovernedEntry,
    drainGovernedEntry,
    emitDelivered,
  } = createGovernedDrainStage(ctx);


  const {
    enqueueDurably,
    beginDeliveryAttemptDurably,
    settleDeliveryAttemptDurably,
    recordDecisionTextChunksDurably,
    lookupDecisionTextChunksDurably,
    recordDrainingEntryTextChunks,
    retryEntryFromReservation,
    adjudicateReservations,
  } = createDeliveryAttemptStage(ctx);


  const {
    recoveryOptions,
    drainLedgerlessTextChunks,
    drainSerialized,
  } = createSerialDrainStage(ctx);


  const {
    reserveDecisionDurably,
    handoffDecisionsDurably,
  } = createDecisionReservationStage(ctx);


  const {
    publicProducerReservation,
    producerRecoveryAnnouncement,
    promoteProducerReservations,
    promoteProducerHandoffs,
  } = createProducerPromotionStage(ctx);


  const {
    reserveProducerDurably,
    releaseProducerDurably,
    recordProducerOutcomeDurably,
    removeProducerReservationDurably,
    cancelProducerDurably,
    suppressProducerDurably,
    consumeProducerReservationsDurably,
    consumeProducerSlots,
  } = createProducerLifecycle({
    store,
    ...(logger ? { logger } : {}),
    ...(retirementProducerState ? { retirementProducerState } : {}),
    activeProducerKeys,
    signalCapacityChange,
    loadFromDisk,
    persist,
    canPersistProducerOwnership,
    publicProducerReservation,
    terminalizeOwner,
    cleanupUnreferencedSnapshots,
  });

  return {
    reserveProducer: (reservation, signal) => admitWithBackpressure(
      () => reserveProducerDurably(reservation, false),
      signal,
    ),
    reclaimProducer: (reservation, signal) => admitWithBackpressure(
      () => reserveProducerDurably(reservation, true),
      signal,
    ),
    recordProducerOutcome: (producerKey, outcome, signal) => admitWithBackpressure(
      () => recordProducerOutcomeDurably(producerKey, outcome),
      signal,
    ),
    releaseProducer: (producerKey) => serializeStateChange(
      () => releaseProducerDurably(producerKey),
    ),
    cancelProducer: (producerKey) => serializeStateChange(
      () => cancelProducerDurably(producerKey),
    ),
    suppressProducer: (producerKey) => serializeStateChange(
      () => suppressProducerDurably(producerKey),
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
        const reusable = store.decisionReservations.filter((reservation) =>
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
          ...store.decisionReservations.filter((reservation) =>
            !expected.has(reservation.idempotencyKey)),
          ...pendingOperations,
        ];
        for (const terminal of terminalOperations) {
          const reconciled = await terminalizeOwner(
            terminal.operation,
            terminal.decision,
            store.entries,
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
          + store.producerHandoffs.length
          + store.producerReservations.length,
      });
    }),
    size: () => store.entries.length
      + store.decisionReservations.length
      + store.producerHandoffs.length
      + store.producerReservations.length
      + store.invalidRecords.length
      + store.terminalInvalidRecords.length,
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
      if (store.terminalInvalidRecords.some((record) => record.id === id)) {
        return err(new Error("Terminal-decision corruption requires storage repair"));
      }
      const releasedEntry = store.entries.find((candidate) => candidate.id === id);
      const releasedReservation = store.decisionReservations.find((candidate) => candidate.id === id);
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
          store.entries.filter((candidate) => candidate.id !== id),
          store.decisionReservations.filter((candidate) => candidate.id !== id),
        );
        if (!terminalized.ok) {
          return terminalized;
        }
      }
      const released = await releaseQuarantined({
        id,
        outcome,
        entries: store.entries,
        reservations: store.decisionReservations,
        invalidRecords: store.invalidRecords,
        logger,
        persist: async (nextEntries, nextReservations, nextInvalidRecords) => {
          const written = await persist(nextEntries, nextReservations, nextInvalidRecords);
          if (written.ok) {
            store.entries = [...nextEntries];
            store.decisionReservations = [...nextReservations];
            store.invalidRecords = [...nextInvalidRecords];
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
