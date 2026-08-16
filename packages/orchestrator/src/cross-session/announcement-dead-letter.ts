// SPDX-License-Identifier: Apache-2.0
/** Durable retry and uncertainty quarantine for failed announcements. */

import { randomUUID } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementDeadLetterQueuePort,
  OutwardSendLedgerPort,
} from "@comis/core";
import { emitObservationalEventSafely, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { GovernedAnnouncementAttachment } from "./announcement-outward-operation.js";
import { drainWithPreparedRecoveryAttachment } from "./announcement-dead-letter-attachment.js";
import {
  createParentDecisionReservationStore,
  isParentDecisionReservation,
  readDeadLetterSnapshot,
  writeDeadLetterEntries,
  type ChannelType,
  type DeadLetterEntry,
  type ParentDecisionReservationRecord,
} from "./announcement-dead-letter-file.js";
import {
  isInvalidDeadLetterRecord,
  type InvalidDeadLetterRecord,
} from "./announcement-dead-letter-invalid.js";
import {
  announcementRecoveryKey,
  isSameAnnouncementRecovery,
  isSameGovernedDeadLetterOperation,
  resolveGovernedDeadLetterIdentity,
  type GovernedDeadLetterIdentity,
} from "./announcement-dead-letter-identity.js";
import type {
  AnnouncementDeadLetterQueueOptions,
  RecoveryDeliveryOptions,
} from "./announcement-dead-letter-types.js";
export { isAnnouncementChannelType } from "./announcement-dead-letter-file.js";
export type { AnnouncementLogger } from "./announcement-dead-letter-types.js";
export type {
  ChannelType,
  DeadLetterEntry,
  ParentDecisionReservation,
} from "./announcement-dead-letter-file.js";
import { projectQuarantined, releaseQuarantined } from "./announcement-dead-letter-quarantine.js";
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
    prepareAttachment,
    fileOperations,
  } = opts;
  let entries: DeadLetterEntry[] = [];
  let decisionReservations: ParentDecisionReservationRecord[] = [];
  let invalidRecords: InvalidDeadLetterRecord[] = [];
  const emittedAdmissionKeys = new Set<string>();
  let loaded = false;
  let operationTail: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
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
      entries = read.value.entries.filter((entry): entry is DeadLetterEntry =>
        !isParentDecisionReservation(entry) && !isInvalidDeadLetterRecord(entry));
      decisionReservations = read.value.entries.filter(isParentDecisionReservation);
      invalidRecords = read.value.entries.filter(isInvalidDeadLetterRecord);
      loaded = true;
      logger?.debug(
        { entryCount: entries.length + decisionReservations.length + invalidRecords.length },
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
  ): Promise<Result<void, Error>> {
    const written = await writeDeadLetterEntries(
      filePath,
      [...nextEntries, ...nextReservations, ...nextInvalidRecords],
      fileOperations,
    );
    if (written.ok) return written;
    if (written.error.state === "snapshot_visible") {
      entries = [...nextEntries];
      decisionReservations = [...nextReservations];
      invalidRecords = [...nextInvalidRecords];
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

  const decisionStore = createParentDecisionReservationStore({
    load: loadFromDisk,
    hasDeliveryKey: (idempotencyKey) =>
      entries.some((entry) =>
        entry.idempotencyKey === idempotencyKey
        || entry.completionKeys?.includes(idempotencyKey) === true),
    getReservations: () => decisionReservations,
    persist: (nextReservations) => persist(entries, nextReservations),
    canPersistReservationCount: (count) => canPersistCounts(entries.length, count),
    replaceReservations: (nextReservations) => {
      decisionReservations = [...nextReservations];
    },
    logger,
  });

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
    identity: GovernedDeadLetterIdentity,
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
  ): Promise<"receipt_already_committed" | "receipt_committed_now" | "retained"> {
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
    const ensureSessionObservation = opts.ensureSessionObservation;
    if (ensureSessionObservation) {
      const observed = tryCatch(() => ensureSessionObservation({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
      }));
      if (!observed.ok || !observed.value.ok) {
        logger?.warn(
          {
            runId: identity.runId,
            rootRunId: identity.rootRunId,
            stepIndex: identity.stepIndex,
            errorKind: "resource" as const,
            hint: "repair session trajectory storage; delivery recovery remains governed by its durable ledger",
          },
          "Dead-letter recovery session diagnostics could not be initialized",
        );
      }
    }

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
      governedSendToChannel(
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
  ): Promise<"receipt_already_committed" | "receipt_committed_now" | "retained"> {
    return drainWithPreparedRecoveryAttachment({
      attachment: entry.attachment,
      runId: entry.runId,
      ...(logger ? { logger } : {}),
      ...(prepareAttachment ? { prepareAttachment } : {}),
      retain: (reason) => retainBlockedEntry(entry, reason),
      logFailure: (transition, errorKind, hint, message) =>
        logLedgerFailure(entry, transition, errorKind, hint, message),
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
    if (reservation && !governedIdentityComplete) return ok(undefined);
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

  /** Settle reservations after the rewrite grace. The ledger decides whether
   * delivery is safe; missing roots, errors, and uncertainty remain parked. */
  async function adjudicateReservations(ledger: OutwardSendLedgerPort): Promise<void> {
    if (decisionReservations.length === 0) return;
    const settled: string[] = [];
    for (const reservation of [...decisionReservations]) {
      const remainingGraceMs = parentDecisionGraceMs
        - (systemNowMs() - reservation.failedAt);
      if (remainingGraceMs > 0) {
        logger?.debug(
          { runId: reservation.runId, remainingMs: remainingGraceMs, step: "parent-decision-rewrite-grace" },
          "Parent decision reservation remains parked while its rewrite can still be running",
        );
        continue;
      }
       const step = await fromPromise(
        ledger.allocateStep(reservation.rootRunId, reservation.idempotencyKey),
      );
      if (!step.ok || !step.value.ok) {
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
      entries.push({
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
        stepIndex: step.value.value,
        deliveryAuthority: reservation.deliveryAuthority,
        destinationEndpoint: reservation.destinationEndpoint,
        completionKeys: reservation.completionKeys,
        ...(reservation.partId ? { partId: reservation.partId } : {}),
        ...(reservation.attachment ? { attachment: reservation.attachment } : {}),
        ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
      } as DeadLetterEntry);
      settled.push(reservation.idempotencyKey);
    }
    if (settled.length === 0) return;
    const remaining = decisionReservations.filter(
      (r) => !settled.includes(r.idempotencyKey),
    );
    decisionReservations = [...remaining];
    const persisted = await persist(entries, remaining);
    if (!persisted.ok) {
      logger?.warn(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; the adjudicated announcements stay in memory for this drain",
        },
        "Failed to persist adjudicated parent decision reservations",
      );
    }
  }

  async function drainSerialized(
    sendToChannel: (type: ChannelType, id: string, text: string, options?: RecoveryDeliveryOptions) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void> {
    const load = await loadFromDisk();
    if (!load.ok) return;
    if (outwardLedger) await adjudicateReservations(outwardLedger);
    if (entries.length === 0) return;
    const now = systemNowMs();
    const workingEntries = entries.map((entry) => ({ ...entry }));
    const deliveredIds = new Set<string>();
    const deliveredEntries: Array<{
      entry: DeadLetterEntry;
      outcome: "untracked_delivery" | "receipt_already_committed" | "receipt_committed_now";
      durationMs: number;
    }> = [];
    for (const entry of workingEntries) {
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
      const boundary = await fromPromise(sendToChannel(
        entry.channelType,
        entry.channelId,
        entry.announcementText,
        entry.threadId || entry.extra || entry.deliveryAuthority || entry.destinationEndpoint
          ? {
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.extra ? { extra: entry.extra } : {}),
              ...(entry.deliveryAuthority ? { authority: entry.deliveryAuthority } : {}),
              ...(entry.destinationEndpoint ? { destinationEndpoint: entry.destinationEndpoint } : {}),
            }
          : undefined,
      ));
      if (boundary.ok && boundary.value) {
        deliveredIds.add(entry.id);
        deliveredEntries.push({
          entry: { ...entry, attemptCount: entry.attemptCount + 1 },
          outcome: "untracked_delivery", durationMs: systemNowMs() - deliveryStartedAt,
        });
      } else {
        entry.attemptCount++;
        entry.lastAttemptAt = systemNowMs();
        entry.lastError = boundary.ok
          ? "sendToChannel returned false"
          : "sendToChannel rejected";
      }
    }
    const nextEntries = workingEntries.filter((entry) => !deliveredIds.has(entry.id));
    const persisted = await persist(nextEntries);
    if (!persisted.ok) {
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
      emitDelivered(entry, entry.attemptCount);
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
              : "dead-letter-delivery",
        },
        outcome === "receipt_already_committed"
          ? "Committed dead-letter operation removed without replay"
          : outcome === "receipt_committed_now"
            ? "Dead-letter entry delivered and platform receipt committed"
            : "Dead-letter entry delivered successfully",
      );
    }
  }

  return {
    enqueue: (entry) => serialize(() => enqueueDurably(entry)),
    reserveDecision: (entry) => serialize(async () => {
      const reserved = await decisionStore.reserve(entry);
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
      return reserved;
    }),
    lookupDecision: (idempotencyKey) =>
      serialize(() => decisionStore.lookup(idempotencyKey)),
    resolveDecision: (idempotencyKey, outcome) =>
      serialize(() => decisionStore.resolve(idempotencyKey, outcome)),
    replaceDecisions: (expectedKeys, operations) =>
      serialize(() => decisionStore.replace(expectedKeys, operations)),
    drain: (sendToChannel, onDelivered) =>
      serialize(() => drainSerialized(sendToChannel, onDelivered)),
    durableSize: () => serialize(async () => {
      const load = await loadFromDisk();
      return load.ok
        ? ok(entries.length + decisionReservations.length + invalidRecords.length)
        : load;
    }),
    size: () => entries.length + decisionReservations.length + invalidRecords.length,
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
      return ok(projectQuarantined(entries, decisionReservations, invalidRecords));
    }),
    release: (id, outcome) => serialize(async () => {
      const loaded = await loadFromDisk();
      if (!loaded.ok) return loaded;
      const releasedEntry = entries.find((candidate) => candidate.id === id);
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
      return released;
    }),
  };
}
