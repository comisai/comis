// SPDX-License-Identifier: Apache-2.0
/** Durable retry and uncertainty quarantine for failed announcements. */

import { randomUUID } from "node:crypto";
import type { TypedEventBus, OutwardSendLedgerPort, OutwardSendRecord } from "@comis/core";
import { emitObservationalEventSafely, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  createAnnouncementOperationDigests,
  type AnnouncementDeliveryOptions,
  type AnnouncementPlatformSendOutcome,
} from "./announcement-outward-operation.js";
import {
  createParentDecisionReservationStore,
  isParentDecisionReservation,
  MalformedDeadLetterFileError,
  readDeadLetterEntries,
  writeDeadLetterEntries,
  type ChannelType,
  type DeadLetterEntry,
  type DeadLetterWriteOperations,
  type ParentDecisionReservation,
  type ParentDecisionReservationRecord,
} from "./announcement-dead-letter-file.js";
export { isAnnouncementChannelType } from "./announcement-dead-letter-file.js";
export type {
  ChannelType,
  DeadLetterEntry,
  ParentDecisionReservation,
} from "./announcement-dead-letter-file.js";

/** Minimal structural logger accepted from the daemon composition root. */
export interface AnnouncementLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Dead-letter queue interface for announcement retry management. */
export interface AnnouncementDeadLetterQueue {
  /**
   * Persist a failed announcement to the dead-letter queue.
   * Resolves only after the queue state is durable. A failed persistence never
   * mutates the in-memory queue and never emits a queued event.
   */
  enqueue(
    entry: Omit<DeadLetterEntry, "id" | "lastAttemptAt">,
  ): Promise<Result<void, Error>>;
  reserveDecision(
    entry: ParentDecisionReservation,
  ): Promise<Result<{ created: boolean }, Error>>;
  lookupDecision(
    idempotencyKey: string,
  ): Promise<Result<ParentDecisionReservation | undefined, Error>>;
  resolveDecision(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>>;
  /**
   * Process queued entries via the provided sendToChannel callback. Ungoverned
   * entries are retried. Governed unresolved/ambiguous entries remain parked
   * for operator review and never reach the callback; a committed receipt
   * removes the entry without sending.
   *
   * `onDelivered` (optional) is invoked with the entry's
   * `idempotencyKey` after a SUCCESSFUL re-delivery, so the caller can record
   * the recovered key in the shared deliveredKeys set (deliveryDedup.mark /
   * batcher.markDelivered). Without it, a DLQ-recovered announcement is never
   * marked delivered and a later sweep double-notifies the same run. Only fired
   * for keyed entries on success; never on failure (the key must stay open).
   */
  drain(
    sendToChannel: (type: ChannelType, id: string, text: string, options?: AnnouncementDeliveryOptions) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void>;
  /** Return the current number of entries in the queue. */
  size(): number;
}

/** Configuration options for the dead-letter queue factory. */
interface AnnouncementDeadLetterQueueOptions {
  /** JSONL file path (already safePath'd by caller). */
  filePath: string;
  /** Maximum retry attempts before dropping an entry (default: 5). */
  maxRetries?: number;
  /** Minimum interval between retry attempts in ms (default: 60_000). */
  retryIntervalMs?: number;
  /** Maximum age of an entry in ms before it is dropped (default: 3_600_000). */
  maxAgeMs?: number;
  /** Maximum number of entries in the queue (default: 100). */
  maxEntries?: number;
  /** Event bus for emitting dead-letter events. */
  eventBus: TypedEventBus;
  /** Optional logger for diagnostics. */
  logger?: AnnouncementLogger;
  /**
   * The closed five-state outward-send uncertainty ledger. When present, every
   * entry must carry its persisted `(agentId, rootRunId, stepIndex)` identity.
   * A committed row with a receipt suppresses the send; all other retained
   * states are blocked or parked. Only a definitive absent lookup may begin a
   * new governed send. `undefined` means the drain uses the unledgered delivery
   * path. Wired from the daemon.
   */
  outwardLedger?: OutwardSendLedgerPort;
  /** Receipt-aware transport used only for a governed row with no ledger record. */
  governedSendToChannel?: (
    type: ChannelType,
    id: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ) => Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  fileOperations?: DeadLetterWriteOperations;
}

/** Create a JSONL-backed announcement dead-letter queue. */
export function createAnnouncementDeadLetterQueue(
  opts: AnnouncementDeadLetterQueueOptions,
): AnnouncementDeadLetterQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const retryIntervalMs = opts.retryIntervalMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 3_600_000;
  const maxEntries = opts.maxEntries ?? 100;
  const {
    filePath,
    eventBus,
    logger,
    outwardLedger,
    governedSendToChannel,
    fileOperations,
  } = opts;

  let entries: DeadLetterEntry[] = [];
  let decisionReservations: ParentDecisionReservationRecord[] = [];
  let loaded = false;
  let operationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadFromDisk(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
    const read = await readDeadLetterEntries(filePath, logger);
    if (read.ok) {
      entries = read.value.filter((entry): entry is DeadLetterEntry =>
        !isParentDecisionReservation(entry));
      decisionReservations = read.value.filter(isParentDecisionReservation);
      loaded = true;
      logger?.debug(
        { entryCount: entries.length + decisionReservations.length },
        "Loaded dead-letter entries from disk",
      );
      return ok(undefined);
    }
    if (!(read.error instanceof MalformedDeadLetterFileError)) {
      logger?.warn(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage access before accepting or draining announcements",
        },
        "Failed to read dead-letter file",
      );
    }
    return err(read.error);
  }

  async function persist(
    nextEntries: readonly DeadLetterEntry[],
    nextReservations: readonly ParentDecisionReservationRecord[] = decisionReservations,
  ): Promise<Result<void, Error>> {
    const written = await writeDeadLetterEntries(
      filePath,
      [...nextEntries, ...nextReservations],
      fileOperations,
    );
    if (written.ok) return written;
    if (written.error.state === "snapshot_visible") {
      entries = [...nextEntries];
      decisionReservations = [...nextReservations];
    }
    return err(written.error.error);
  }

  const decisionStore = createParentDecisionReservationStore({
    load: loadFromDisk,
    hasDeliveryKey: (idempotencyKey) =>
      entries.some((entry) => entry.idempotencyKey === idempotencyKey),
    getReservations: () => decisionReservations,
    persist: (nextReservations) => persist(entries, nextReservations),
    replaceReservations: (nextReservations) => {
      decisionReservations = [...nextReservations];
    },
    logger,
  });

  interface GovernedEntryIdentity {
    rootRunId: string;
    stepIndex: number;
    agentId: string;
    contentDigest: string;
    operationFingerprint: string;
  }

  type LedgerTransition = "lookup" | "begin" | "mark_unknown" | "commit" | "park";
  type LedgerOutcome = "blocked" | "in_flight" | "committed" | "failed" | "parked";

  function emitLedgerTransition(
    identity: Pick<GovernedEntryIdentity, "rootRunId" | "stepIndex">,
    transition: LedgerTransition,
    outcome: LedgerOutcome,
  ): void {
    emitObservationalEventSafely(
      { eventBus, logger },
      "delivery:outward_ledger_transition",
      {
        rootRunId: identity.rootRunId,
        stepIndex: identity.stepIndex,
        transition,
        outcome,
        timestamp: systemNowMs(),
      },
    );
  }

  function logLedgerFailure(
    entry: DeadLetterEntry,
    transition: string,
    errorKind: "dependency" | "precondition" | "validation",
    hint: string,
    message: string,
  ): void {
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

  function resolveGovernedIdentity(
    entry: DeadLetterEntry,
  ): Result<
    GovernedEntryIdentity,
    "identity_incomplete" | "operation_validation_blocked"
  > {
    if (
      typeof entry.rootRunId !== "string"
      || entry.rootRunId.length === 0
      || !Number.isSafeInteger(entry.stepIndex)
      || entry.stepIndex === undefined
      || entry.stepIndex < 0
      || typeof entry.agentId !== "string"
      || entry.agentId.length === 0
    ) {
      return err("identity_incomplete" as const);
    }

    const digests = createAnnouncementOperationDigests({
      channelId: entry.channelId,
      channelType: entry.channelType,
      text: entry.announcementText,
      ...(entry.threadId || entry.extra ? {
        options: {
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
          ...(entry.extra ? { extra: entry.extra } : {}),
        },
      } : {}),
    });
    if (!digests.ok) return err("operation_validation_blocked" as const);
    const { contentDigest, operationFingerprint } = digests.value;

    return ok({
      rootRunId: entry.rootRunId,
      stepIndex: entry.stepIndex,
      agentId: entry.agentId,
      contentDigest,
      operationFingerprint,
    });
  }

  function isSameOperation(
    entry: DeadLetterEntry,
    identity: GovernedEntryIdentity,
    record: OutwardSendRecord,
  ): boolean {
    return record.rootRunId === identity.rootRunId
      && record.stepIndex === identity.stepIndex
      && record.agentId === identity.agentId
      && record.channelType === entry.channelType
      && record.channelId === entry.channelId
      && record.operationKind === "cross_session_announcement"
      && record.operationFingerprint === identity.operationFingerprint
      && record.contentDigest === identity.contentDigest;
  }

  async function parkGovernedEntry(
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
    identity: GovernedEntryIdentity,
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
  async function drainGovernedEntry(
    ledger: OutwardSendLedgerPort,
    entry: DeadLetterEntry,
  ): Promise<"committed" | "retained"> {
    const identityResult = resolveGovernedIdentity(entry);
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
          { rootRunId: entry.rootRunId, stepIndex: entry.stepIndex },
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
      if (!isSameOperation(entry, identity, existing.value)) {
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
          emitLedgerTransition(identity, "lookup", "committed");
          return "committed";
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
        entry.threadId || entry.extra
          ? {
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.extra ? { extra: entry.extra } : {}),
            }
          : undefined,
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
    const receipt = outcome.platformMessageId;
    if (!outcome.delivered || receipt === undefined || receipt.length === 0) {
      entry.lastError = outcome.delivered
        ? "outward_platform_receipt_missing"
        : "outward_transport_rejected_without_no_send_proof";
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
    emitLedgerTransition(identity, "commit", "committed");
    return "committed";
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
    entry: Omit<DeadLetterEntry, "id" | "lastAttemptAt">,
  ): Promise<Result<void, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const keyedEntry = entry.idempotencyKey !== undefined
      ? entries.find((candidate) => candidate.idempotencyKey === entry.idempotencyKey)
      : undefined;
    if (keyedEntry) return ok(undefined);
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
    const dropped = !outwardLedger && nextEntries.length >= maxEntries
      ? nextEntries.shift()
      : undefined;
    nextEntries.push(fullEntry);
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
    if (dropped) {
      logger?.error(
        {
          errorKind: "resource" as const,
          hint: "resolve retryable dead letters before the queue reaches capacity",
          droppedRunId: dropped.runId,
        },
        "Retryable dead-letter queue reached capacity",
      );
    } else if (outwardLedger && entries.length > maxEntries) {
      logger?.warn(
        {
          entryCount: entries.length,
          errorKind: "resource" as const,
          hint: "resolve quarantined outward operations; governed evidence is never capacity-evicted",
        },
        "Governed dead-letter quarantine exceeds its review threshold",
      );
    }
    emitObservationalEventSafely(
      { eventBus, logger },
      "announcement:dead_lettered",
      {
        runId: fullEntry.runId,
        channelType: fullEntry.channelType,
        reason: fullEntry.lastError ?? "delivery_failed",
        timestamp: systemNowMs(),
      },
    );
    return ok(undefined);
  }

  async function drainSerialized(
    sendToChannel: (type: ChannelType, id: string, text: string, options?: AnnouncementDeliveryOptions) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void> {
    const load = await loadFromDisk();
    if (!load.ok || entries.length === 0) return;
    const now = systemNowMs();
    const workingEntries = entries
      .map((entry) => ({ ...entry }))
      .filter((entry) => {
        if (outwardLedger) return true;
        if (entry.attemptCount >= maxRetries) {
          logger?.debug(
            { runId: entry.runId, attemptCount: entry.attemptCount },
            "Retryable dead-letter entry dropped after its attempt limit",
          );
          return false;
        }
        if (now - entry.failedAt >= maxAgeMs) {
          logger?.debug(
            { runId: entry.runId, ageMs: now - entry.failedAt },
            "Retryable dead-letter entry dropped after its retention window",
          );
          return false;
        }
        return true;
      });
    const deliveredIds = new Set<string>();
    const deliveredEntries: DeadLetterEntry[] = [];

    for (const entry of workingEntries) {
      if (now - entry.lastAttemptAt < retryIntervalMs) continue;
      if (outwardLedger) {
        const governed = await drainGovernedEntry(outwardLedger, entry);
        if (governed === "committed") {
          deliveredIds.add(entry.id);
          deliveredEntries.push(entry);
        }
        continue;
      }

      const boundary = await fromPromise(sendToChannel(
        entry.channelType,
        entry.channelId,
        entry.announcementText,
        entry.threadId || entry.extra
          ? {
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.extra ? { extra: entry.extra } : {}),
            }
          : undefined,
      ));
      if (boundary.ok && boundary.value) {
        deliveredIds.add(entry.id);
        deliveredEntries.push({ ...entry, attemptCount: entry.attemptCount + 1 });
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
    for (const entry of deliveredEntries) {
      const idempotencyKey = entry.idempotencyKey;
      if (idempotencyKey && onDelivered) {
        tryCatch(() => onDelivered(idempotencyKey));
      }
      emitDelivered(entry, entry.attemptCount);
      logger?.debug(
        {
          runId: entry.runId,
          attemptCount: entry.attemptCount,
          ...(outwardLedger ? {
            rootRunId: entry.rootRunId,
            stepIndex: entry.stepIndex,
            step: "dlq-ledger-committed-skip",
          } : {}),
        },
        outwardLedger
          ? "Committed dead-letter operation removed without replay"
          : "Dead-letter entry delivered successfully",
      );
    }
  }

  return {
    enqueue: (entry) => serialize(() => enqueueDurably(entry)),
    reserveDecision: (entry) => serialize(() => decisionStore.reserve(entry)),
    lookupDecision: (idempotencyKey) =>
      serialize(() => decisionStore.lookup(idempotencyKey)),
    resolveDecision: (idempotencyKey, outcome) =>
      serialize(() => decisionStore.resolve(idempotencyKey, outcome)),
    drain: (sendToChannel, onDelivered) =>
      serialize(() => drainSerialized(sendToChannel, onDelivered)),
    size: () => entries.length + decisionReservations.length,
  };
}
