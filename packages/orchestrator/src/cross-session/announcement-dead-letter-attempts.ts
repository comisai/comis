// SPDX-License-Identifier: Apache-2.0
/**
 * Admission and delivery-attempt bookkeeping.
 *
 * Everything that changes what the queue believes about an in-flight send:
 * admitting an entry under backpressure, opening an attempt, settling it as
 * accepted, rejected, or unknown, and adjudicating reservations whose fate the
 * ledger can still decide.
 *
 * "Unknown" is a real outcome here, not a failure to classify — a send whose
 * result never came back must stay unresolved until the ledger says otherwise,
 * because retrying it and dropping it are both wrong.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  OutwardSendLedgerPort,
} from "@comis/core";
import {
  systemNowMs,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  isAnnouncementTextChunks,
  type DeadLetterEntry,
  type ParentDecisionReservationRecord,
} from "./announcement-dead-letter-file.js";
import {
  type AnnouncementTerminalDecision,
} from "./announcement-dead-letter-terminal-decision.js";
import {
  announcementRecoveryKey,
  isSameAnnouncementRecovery,
} from "./announcement-dead-letter-identity.js";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";

export function createDeliveryAttemptStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    maxRetries,
    retryIntervalMs,
    maxAgeMs,
    parentDecisionGraceMs,
    logger,
    outwardLedger,
    emittedAdmissionKeys,
  } = ctx;
  const loadFromDisk: DeadLetterQueueContext["loadFromDisk"] = (...a) => ctx.loadFromDisk(...a);
  const persist: DeadLetterQueueContext["persist"] = (...a) => ctx.persist(...a);
  const canPersistCounts: DeadLetterQueueContext["canPersistCounts"] = (...a) => ctx.canPersistCounts(...a);
  const cleanupUnreferencedSnapshots: DeadLetterQueueContext["cleanupUnreferencedSnapshots"] = (...a) => ctx.cleanupUnreferencedSnapshots(...a);
  const emitAdmission: DeadLetterQueueContext["emitAdmission"] = (...a) => ctx.emitAdmission(...a);
  const lookupTerminalDecision: DeadLetterQueueContext["lookupTerminalDecision"] = (...a) => ctx.lookupTerminalDecision(...a);
  const terminalizeOwner: DeadLetterQueueContext["terminalizeOwner"] = (...a) => ctx.terminalizeOwner(...a);
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
    const keyedEntry = store.entries.find(
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
      ? store.decisionReservations.find(
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
    const nextEntries = [...store.entries];
    const nextReservations = reservation
      ? store.decisionReservations.filter((candidate) => candidate.id !== reservation.id)
      : store.decisionReservations;
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
    store.entries = nextEntries;
    store.decisionReservations = nextReservations;
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
    const existing = store.entries.find((candidate) =>
      candidate.idempotencyKey === entry.idempotencyKey);
    const reservation = store.decisionReservations.find((candidate) =>
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
        store.entries,
        store.decisionReservations,
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
      const reclaimedEntries = store.entries.map((candidate) => candidate.id === existing.id
        ? {
            ...candidate,
            attemptCount: candidate.attemptCount + 1,
            lastAttemptAt: now,
            lastError: "outward_operation_in_flight",
          }
        : candidate);
      const reclaimed = await persist(reclaimedEntries);
      if (!reclaimed.ok) return reclaimed;
      store.entries = reclaimedEntries;
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
    const nextEntries = [...store.entries, claimed];
    const nextReservations = reservation
      ? store.decisionReservations.filter((candidate) => candidate.id !== reservation.id)
      : store.decisionReservations;
    if (!canPersistCounts(nextEntries.length, nextReservations.length)) {
      return err(new Error("Dead-letter quarantine capacity exhausted"));
    }
    const persisted = await persist(nextEntries, nextReservations);
    if (!persisted.ok) return persisted;
    store.entries = nextEntries;
    store.decisionReservations = nextReservations;
    emitAdmission(claimed);
    return ok({ claimed: true });
  }

  async function settleDeliveryAttemptDurably(
    idempotencyKey: string,
    outcome: "accepted" | "rejected" | "unknown",
  ): Promise<Result<boolean, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const entry = store.entries.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (!entry) return ok(false);
    if (outcome === "accepted") {
      const pendingEntries = store.entries.map((candidate) => candidate.id === entry.id
        ? { ...candidate, lastError: "receipt_accepted_terminalization_pending" }
        : candidate);
      const pending = await persist(pendingEntries);
      if (!pending.ok) return pending;
      store.entries = pendingEntries;
      const nextEntries = pendingEntries.filter((candidate) => candidate.id !== entry.id);
      const terminalized = await terminalizeOwner(
        entry,
        "delivered",
        nextEntries,
        store.decisionReservations,
      );
      if (!terminalized.ok) return terminalized;
      const removed = await persist(nextEntries);
      if (!removed.ok) return removed;
      store.entries = nextEntries;
      emittedAdmissionKeys.delete(announcementRecoveryKey(entry));
      if (entry.attachment?.kind === "snapshot") {
        await cleanupUnreferencedSnapshots([{ attachment: entry.attachment }]);
      }
      return ok(true);
    }
    const nextEntries = store.entries.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            lastError: outcome === "rejected"
              ? "transport_rejected"
              : "outward_operation_unresolved",
          }
        : candidate);
    const persisted = await persist(nextEntries);
    if (!persisted.ok) return persisted;
    store.entries = nextEntries;
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
    const reservationIndex = store.decisionReservations.findIndex(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    const entryIndex = store.entries.findIndex(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if ((reservationIndex >= 0) === (entryIndex >= 0)) {
      return err(new Error("Announcement text chunk owner is unavailable or ambiguous"));
    }
    const existingChunks = reservationIndex >= 0
      ? store.decisionReservations[reservationIndex]?.textChunks
      : store.entries[entryIndex]?.textChunks;
    if (existingChunks !== undefined) {
      const matches = existingChunks.length === chunks.length
        && existingChunks.every((chunk, index) => chunk === chunks[index]);
      return matches
        ? ok(undefined)
        : err(new Error("Announcement text chunk manifest identity mismatch"));
    }
    const persistedChunks = [...chunks];
    const nextEntries = [...store.entries];
    const nextReservations = [...store.decisionReservations];
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
      store.entries = nextEntries;
      store.decisionReservations = nextReservations;
    }
    return persisted;
  }

  async function lookupDecisionTextChunksDurably(
    completionKey: string,
  ): Promise<Result<readonly string[] | undefined, Error>> {
    const load = await loadFromDisk();
    if (!load.ok) return load;
    const manifests = [
      ...store.entries.filter((entry) =>
        entry.idempotencyKey === completionKey
        || entry.completionKeys?.includes(completionKey) === true),
      ...store.decisionReservations.filter((reservation) =>
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
    const authoritativeEntry = store.entries.find((candidate) => candidate.id === entry.id);
    if (authoritativeEntry?.textChunks) {
      entry.textChunks = [...authoritativeEntry.textChunks];
    }
    return recorded;
  }

  function retryEntryFromReservation(
    reservation: ParentDecisionReservationRecord,
    options: { readonly lastError?: string; readonly stepIndex?: number } = {},
  ): DeadLetterEntry {
    const { recordType: _recordType, ...owner } = reservation;
    return {
      ...owner,
      attemptCount: 0,
      lastAttemptAt: 0,
      ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
      ...(options.stepIndex === undefined ? {} : { stepIndex: options.stepIndex }),
    };
  }

  /** Settle reservations after the rewrite grace. The ledger decides whether
   * delivery is safe; missing roots, errors, and uncertainty remain parked. */
  async function adjudicateReservations(ledger?: OutwardSendLedgerPort): Promise<void> {
    if (store.decisionReservations.length === 0) return;
    const settled: string[] = [];
    const terminalSettlements: Array<{
      reservation: ParentDecisionReservationRecord;
      decision: AnnouncementTerminalDecision;
    }> = [];
    const nextEntries = [...store.entries];
    for (const reservation of [...store.decisionReservations]) {
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
        nextEntries.push(retryEntryFromReservation(reservation, {
          lastError: "attachment_delivery_unavailable",
        }));
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
      nextEntries.push(retryEntryFromReservation(reservation, {
        ...(step?.ok && step.value.ok ? { stepIndex: step.value.value } : {}),
        ...(!ledger ? { lastError: "transport_rejected" } : {}),
      }));
      settled.push(reservation.idempotencyKey);
    }
    if (settled.length === 0) return;
    const remaining = store.decisionReservations.filter(
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
    store.entries = nextEntries;
    store.decisionReservations = [...remaining];
  }

  return {
    enqueueDurably,
    beginDeliveryAttemptDurably,
    settleDeliveryAttemptDurably,
    recordDecisionTextChunksDurably,
    lookupDecisionTextChunksDurably,
    recordDrainingEntryTextChunks,
    retryEntryFromReservation,
    adjudicateReservations,
  };
}
