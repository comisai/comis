// SPDX-License-Identifier: Apache-2.0
/**
 * Producer reservation lifecycle for the announcement dead-letter queue.
 *
 * A producer reservation is the claim that one specific run owns the right to
 * announce one specific completion. Every transition here is durable before it
 * is observable, because the whole point of the reservation is to survive the
 * process that took it: a reservation that exists only in memory cannot stop a
 * restarted daemon from announcing the same completion twice.
 *
 * Reserve, release, cancel, suppress, and record-outcome are therefore each
 * written to disk before the in-memory set is swapped, and the active-key set
 * is only updated once the write lands.
 *
 * @module
 */
import type {
  AnnouncementDeadLetterAttachmentSnapshot,
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  AnnouncementProducerRecoveryOutcome,
  AnnouncementProducerReservation,
  AnnouncementProducerReservationOutcome,
  AnnouncementRetirementProducer,
  AnnouncementRetirementProducerState,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import type { AnnouncementTerminalDecision } from "./announcement-dead-letter-terminal-decision.js";
import {
  isAnnouncementProducerRecoveryOutcome,
  isAnnouncementRetirementProducer,
  isValidAnnouncementDecision,
  sameAnnouncementProducerReservation,
} from "./announcement-dead-letter-guards.js";
import type { DeadLetterRecordStore } from "./announcement-dead-letter.js";
import type { AnnouncementLogger } from "./announcement-dead-letter-types.js";
import type {
  DeadLetterEntry,
  ParentDecisionReservationRecord,
  ProducerReservationRecord,
} from "./announcement-dead-letter-file.js";
import type { InvalidDeadLetterRecord } from "./announcement-dead-letter-invalid.js";
import type { AnnouncementProducerHandoffRecord } from "./announcement-dead-letter-guards.js";

/** Factory-scope state and helpers the producer lifecycle operates on. */
export interface ProducerLifecycleContext {
  store: DeadLetterRecordStore;
  logger?: AnnouncementLogger;
  retirementProducerState?: (
    producer: AnnouncementRetirementProducer,
  ) => Promise<Result<AnnouncementRetirementProducerState, Error>>;
  activeProducerKeys: Set<string>;
  signalCapacityChange: () => void;
  loadFromDisk: () => Promise<Result<void, Error>>;
  persist: (
    nextEntries: readonly DeadLetterEntry[],
    nextReservations?: readonly ParentDecisionReservationRecord[],
    nextInvalidRecords?: readonly InvalidDeadLetterRecord[],
    nextProducerHandoffs?: readonly AnnouncementProducerHandoffRecord[],
    nextProducerReservations?: readonly ProducerReservationRecord[],
    consumedProducerKeys?: readonly string[],
  ) => Promise<Result<void, Error>>;
  canPersistProducerOwnership: (
    nextProducerOwnershipCount: number,
    consumedProducerKeys?: ReadonlySet<string>,
  ) => boolean;
  publicProducerReservation: (record: ProducerReservationRecord) => AnnouncementProducerReservation;
  terminalizeOwner: (
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    outcome: AnnouncementTerminalDecision,
    retainedEntries: readonly DeadLetterEntry[],
    retainedReservations: readonly AnnouncementParentDecisionReservation[],
  ) => Promise<Result<void, Error>>;
  cleanupUnreferencedSnapshots: (
    candidates: readonly {
      attachment: AnnouncementDeadLetterAttachmentSnapshot;
      cleanup?: () => Promise<Result<void, Error>>;
    }[],
  ) => Promise<void>;
}

export function createProducerLifecycle(ctx: ProducerLifecycleContext) {
  const {
    store,
    logger,
    retirementProducerState,
    activeProducerKeys,
    signalCapacityChange,
    loadFromDisk,
    persist,
    canPersistProducerOwnership,
    publicProducerReservation,
    terminalizeOwner,
    cleanupUnreferencedSnapshots,
  } = ctx;
  async function reserveProducerDurably(
    reservation: AnnouncementProducerReservation,
    reclaimActive: boolean,
  ): Promise<Result<AnnouncementProducerReservationOutcome, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const producerKey = reservation.runId;
    if (producerKey.length === 0 || producerKey.length > 256) {
      return err(new Error("Announcement producer identity is invalid"));
    }
    if (
      !isValidAnnouncementDecision(reservation)
      || !isAnnouncementRetirementProducer(reservation.producer)
    ) {
      return err(new Error("Announcement producer reservation is invalid"));
    }
    let existing = store.producerReservations.find((candidate) => candidate.runId === producerKey);
    if (existing && !sameAnnouncementProducerReservation(existing, reservation)) {
      return err(new Error("Announcement producer reservation identity mismatch"));
    }
    if (
      existing?.lifecycleState === "delivery_owned"
      || store.entries.some((entry) => entry.runId === producerKey)
      || store.decisionReservations.some((entry) => entry.runId === producerKey)
      || store.producerHandoffs.some((handoff) => handoff.operations.some((operation) =>
        operation.runId === producerKey))
    ) {
      activeProducerKeys.delete(producerKey);
      return ok({
        status: "recovery_owned",
        lifecycleState: "delivery_owned",
        ...(existing?.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {}),
      });
    }
    if (existing?.lifecycleState === "cancel_pending") {
      const cancelled = await removeProducerReservationDurably(producerKey);
      if (!cancelled.ok) return cancelled;
      existing = undefined;
    }
    if (existing?.lifecycleState === "no_reply_pending") {
      activeProducerKeys.delete(producerKey);
      const terminalized = await terminalizeOwner(
        publicProducerReservation(existing),
        "no_reply",
        store.entries,
        store.decisionReservations,
      );
      if (!terminalized.ok) return terminalized;
      const settled = store.producerReservations.map((candidate) =>
        candidate.runId === producerKey
          ? { ...candidate, lifecycleState: "no_reply" as const }
          : candidate);
      const persisted = await persist(
        store.entries,
        store.decisionReservations,
        store.invalidRecords,
        store.producerHandoffs,
        settled,
      );
      if (!persisted.ok) return persisted;
      store.producerReservations = settled;
      return ok({
        status: "recovery_owned",
        lifecycleState: "no_reply",
        ...(existing.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {}),
      });
    }
    if (existing?.lifecycleState === "no_reply") {
      activeProducerKeys.delete(producerKey);
      return ok({
        status: "recovery_owned",
        lifecycleState: "no_reply",
        ...(existing.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {}),
      });
    }
    if (existing?.lifecycleState === "active") {
      if (!reclaimActive || activeProducerKeys.has(producerKey)) {
        return ok({ status: "recovery_owned", lifecycleState: "active" });
      }
      if (retirementProducerState) {
        const producerState = await retirementProducerState(existing.producer);
        if (!producerState.ok) return producerState;
        if (producerState.value.status === "terminal") {
          if (producerState.value.recoveryOutcome !== undefined) {
            const recorded = await recordProducerOutcomeDurably(
              producerKey,
              producerState.value.recoveryOutcome,
            );
            if (!recorded.ok) return recorded;
            activeProducerKeys.delete(producerKey);
            return ok({
              status: "recovery_owned",
              lifecycleState: "promotion_ready",
              recoveryOutcome: producerState.value.recoveryOutcome,
            });
          }
          const released = await releaseProducerDurably(producerKey);
          if (!released.ok) return released;
          return ok({ status: "recovery_owned", lifecycleState: "promotion_ready" });
        }
      }
      activeProducerKeys.add(producerKey);
      return ok({ status: "claimed" });
    }
    if (existing?.lifecycleState === "promotion_ready") {
      activeProducerKeys.delete(producerKey);
      return ok({
        status: "recovery_owned",
        lifecycleState: "promotion_ready",
        ...(existing.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {}),
      });
    }
    if (!existing && !canPersistProducerOwnership(
      store.producerHandoffs.length + store.producerReservations.length + 1,
    )) {
      return err(new Error("Announcement producer capacity exhausted"));
    }
    const id = existing?.id ?? randomUUID();
    const record: ProducerReservationRecord = {
      ...reservation,
      recordType: "producer_reservation",
      id,
      lifecycleState: "active",
    };
    const next = existing
      ? store.producerReservations.map((candidate) => candidate.runId === producerKey ? record : candidate)
      : [...store.producerReservations, record];
    const persisted = await persist(
      store.entries,
      store.decisionReservations,
      store.invalidRecords,
      store.producerHandoffs,
      next,
    );
    if (!persisted.ok) {
      return persisted.error.message === "Dead-letter snapshot exceeds the row limit"
        || persisted.error.message === "Dead-letter snapshot exceeds the byte limit"
        ? err(new Error("Announcement producer capacity exhausted"))
        : persisted;
    }
    store.producerReservations = next;
    activeProducerKeys.add(producerKey);
    return ok({ status: "claimed" });
  }

  async function releaseProducerDurably(producerKey: string): Promise<Result<void, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const record = store.producerReservations.find((candidate) => candidate.runId === producerKey);
    if (!record) {
      activeProducerKeys.delete(producerKey);
      return ok(undefined);
    }
    if (
      record.lifecycleState === "cancel_pending"
      || record.lifecycleState === "no_reply_pending"
    ) {
      return err(new Error("Announcement producer has a conflicting terminal transition"));
    }
    if (
      record.lifecycleState === "delivery_owned"
      || record.lifecycleState === "no_reply"
    ) {
      activeProducerKeys.delete(producerKey);
      return ok(undefined);
    }
    if (record.lifecycleState !== "promotion_ready") {
      const next = store.producerReservations.map((candidate) =>
        candidate.runId === producerKey
          ? { ...candidate, lifecycleState: "promotion_ready" as const }
          : candidate);
      const persisted = await persist(
        store.entries,
        store.decisionReservations,
        store.invalidRecords,
        store.producerHandoffs,
        next,
      );
      if (!persisted.ok) return persisted;
      store.producerReservations = next;
    }
    activeProducerKeys.delete(producerKey);
    return ok(undefined);
  }

  async function recordProducerOutcomeDurably(
    producerKey: string,
    outcome: AnnouncementProducerRecoveryOutcome,
  ): Promise<Result<void, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    if (!isAnnouncementProducerRecoveryOutcome(outcome)) {
      return err(new Error("Announcement producer recovery outcome is invalid"));
    }
    const record = store.producerReservations.find((candidate) => candidate.runId === producerKey);
    if (!record) return err(new Error("Announcement producer recovery owner was not found"));
    if (record.producer.kind !== outcome.kind) {
      return err(new Error("Announcement producer recovery outcome identity mismatch"));
    }
    const transferred = store.entries.some((entry) => entry.runId === producerKey)
      || store.decisionReservations.some((entry) => entry.runId === producerKey)
      || store.producerHandoffs.some((handoff) => handoff.operations.some((operation) =>
        operation.runId === producerKey));
    const next = store.producerReservations.map((candidate) => {
      if (candidate.runId !== producerKey) return candidate;
      if (
        candidate.lifecycleState === "cancel_pending"
        || candidate.lifecycleState === "no_reply_pending"
      ) {
        return candidate;
      }
      return {
        ...candidate,
        lifecycleState: candidate.lifecycleState === "delivery_owned" || transferred
          ? "delivery_owned" as const
          : candidate.lifecycleState === "no_reply"
            ? "no_reply" as const
            : "promotion_ready" as const,
        recoveryOutcome: outcome,
      };
    });
    const updated = next.find((candidate) => candidate.runId === producerKey);
    if (
      updated?.lifecycleState === "cancel_pending"
      || updated?.lifecycleState === "no_reply_pending"
    ) {
      return err(new Error("Announcement producer has a conflicting terminal transition"));
    }
    const persisted = await persist(
      store.entries,
      store.decisionReservations,
      store.invalidRecords,
      store.producerHandoffs,
      next,
    );
    if (!persisted.ok) return persisted;
    store.producerReservations = next;
    return ok(undefined);
  }

  async function removeProducerReservationDurably(
    producerKey: string,
  ): Promise<Result<void, Error>> {
    const removed = store.producerReservations.filter((candidate) => candidate.runId === producerKey);
    const next = store.producerReservations.filter((candidate) => candidate.runId !== producerKey);
    if (next.length === store.producerReservations.length) {
      activeProducerKeys.delete(producerKey);
      return ok(undefined);
    }
    const persisted = await persist(
      store.entries,
      store.decisionReservations,
      store.invalidRecords,
      store.producerHandoffs,
      next,
    );
    if (!persisted.ok) return persisted;
    store.producerReservations = next;
    activeProducerKeys.delete(producerKey);
    await cleanupUnreferencedSnapshots(removed.flatMap((reservation) =>
      reservation.attachment?.kind === "snapshot"
        ? [{ attachment: reservation.attachment }]
        : []));
    return ok(undefined);
  }

  async function cancelProducerDurably(producerKey: string): Promise<Result<void, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const record = store.producerReservations.find((candidate) => candidate.runId === producerKey);
    if (!record) {
      const transferred = store.entries.some((entry) => entry.runId === producerKey)
        || store.decisionReservations.some((entry) => entry.runId === producerKey)
        || store.producerHandoffs.some((handoff) => handoff.operations.some((operation) =>
          operation.runId === producerKey));
      if (transferred) {
        return err(new Error("Announcement producer ownership already transferred"));
      }
      activeProducerKeys.delete(producerKey);
      return ok(undefined);
    }
    if (record.lifecycleState === "no_reply_pending" || record.lifecycleState === "no_reply") {
      return err(new Error("Announcement producer suppression is already pending"));
    }
    if (record.lifecycleState === "delivery_owned") {
      return err(new Error("Announcement producer ownership already transferred"));
    }
    if (record.lifecycleState !== "cancel_pending") {
      const pendingRecord: ProducerReservationRecord = {
        ...record,
        lifecycleState: "cancel_pending",
      };
      const next = store.producerReservations.map((candidate) =>
        candidate.runId === producerKey ? pendingRecord : candidate);
      const persisted = await persist(
        store.entries,
        store.decisionReservations,
        store.invalidRecords,
        store.producerHandoffs,
        next,
      );
      if (!persisted.ok && !store.producerReservations.some((candidate) =>
        candidate.runId === producerKey && candidate.lifecycleState === "cancel_pending")) {
        return persisted;
      }
      if (persisted.ok) store.producerReservations = next;
    }
    activeProducerKeys.delete(producerKey);
    const removed = await removeProducerReservationDurably(producerKey);
    if (!removed.ok) {
      logger?.warn(
        {
          runId: producerKey,
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; the durable cancellation intent will finish during recovery",
        },
        "Announcement producer cancellation cleanup remains pending",
      );
      return ok(undefined);
    }
    return removed;
  }

  async function suppressProducerDurably(producerKey: string): Promise<Result<boolean, Error>> {
    const loadedFromDisk = await loadFromDisk();
    if (!loadedFromDisk.ok) return loadedFromDisk;
    const record = store.producerReservations.find((candidate) => candidate.runId === producerKey);
    const ownedEntries = store.entries.filter((entry) => entry.runId === producerKey);
    const ownedReservations = store.decisionReservations.filter((entry) => entry.runId === producerKey);
    const ownedHandoffs = store.producerHandoffs.filter((handoff) =>
      handoff.operations.some((operation) => operation.runId === producerKey));
    if (ownedHandoffs.some((handoff) =>
      handoff.operations.some((operation) => operation.runId !== producerKey))) {
      return err(new Error("Announcement producer handoff ownership is inconsistent"));
    }
    const ownedHandoffOperations = ownedHandoffs.flatMap((handoff) => handoff.operations);
    if (!record && ownedEntries.length === 0 && ownedReservations.length === 0
      && ownedHandoffOperations.length === 0) {
      return ok(false);
    }
    let pendingProducerDurable = record?.lifecycleState === "no_reply_pending";
    const pendingRecord = record
      ? { ...record, lifecycleState: "no_reply_pending" as const }
      : undefined;
    if (record && record.lifecycleState !== "no_reply_pending") {
      const next = store.producerReservations.map((candidate) =>
        candidate.runId === producerKey
          ? { ...record, lifecycleState: "no_reply_pending" as const }
          : candidate);
      const persisted = await persist(
        store.entries,
        store.decisionReservations,
        store.invalidRecords,
        store.producerHandoffs,
        next,
      );
      if (!persisted.ok) {
        pendingProducerDurable = store.producerReservations.some((candidate) =>
          candidate.runId === producerKey && candidate.lifecycleState === "no_reply_pending");
        if (!pendingProducerDurable) {
          const terminalized = await terminalizeOwner(
            publicProducerReservation(record),
            "no_reply",
            store.entries,
            store.decisionReservations,
          );
          if (!terminalized.ok) return persisted;
          activeProducerKeys.delete(producerKey);
          return ok(true);
        }
      } else {
        store.producerReservations = next;
        pendingProducerDurable = true;
      }
    }
    activeProducerKeys.delete(producerKey);
    const nextEntries = store.entries.filter((entry) => entry.runId !== producerKey);
    const nextReservations = store.decisionReservations.filter((entry) => entry.runId !== producerKey);
    const nextHandoffs = store.producerHandoffs.filter((handoff) => !ownedHandoffs.includes(handoff));
    const retainedOwners = [
      ...nextReservations,
      ...nextHandoffs.flatMap((handoff) => handoff.operations),
    ];
    const owners = [
      ...(pendingRecord ? [publicProducerReservation(pendingRecord)] : []),
      ...ownedEntries,
      ...ownedReservations,
      ...ownedHandoffOperations,
    ];
    for (const owner of owners) {
      const terminalized = await terminalizeOwner(
        owner,
        "no_reply",
        nextEntries,
        retainedOwners,
      );
      if (!terminalized.ok) {
        if (!pendingProducerDurable) return terminalized;
        logger?.warn(
          {
            runId: producerKey,
            errorKind: "resource" as const,
            hint: "restore terminal-decision storage; the durable no-reply producer state will retry during recovery",
          },
          "Announcement producer suppression remains pending",
        );
        return ok(true);
      }
    }
    const nextProducerReservations = store.producerReservations.map((candidate) =>
      candidate.runId === producerKey
        ? { ...candidate, lifecycleState: "no_reply" as const }
        : candidate);
    const removed = await persist(
      nextEntries,
      nextReservations,
      store.invalidRecords,
      nextHandoffs,
      nextProducerReservations,
      [producerKey],
    );
    if (removed.ok) {
      store.entries = nextEntries;
      store.decisionReservations = nextReservations;
      store.producerHandoffs = nextHandoffs;
      store.producerReservations = nextProducerReservations;
    } else {
      logger?.warn(
        {
          runId: producerKey,
          errorKind: "resource" as const,
          hint: "restore dead-letter storage; terminally suppressed announcement owners will be removed during recovery",
        },
        "Terminal announcement suppression cleanup remains pending",
      );
    }
    await cleanupUnreferencedSnapshots([
      ...ownedEntries,
      ...ownedReservations,
      ...ownedHandoffOperations,
      ...(record ? [record] : []),
    ].flatMap((owner) => owner.attachment?.kind === "snapshot"
      ? [{ attachment: owner.attachment }]
      : []));
    return ok(true);
  }

  async function consumeProducerReservationsDurably(
    producerKeys: readonly string[],
  ): Promise<Result<void, Error>> {
    const uniqueKeys = new Set(producerKeys);
    const removed = store.producerReservations.filter((candidate) => uniqueKeys.has(candidate.runId));
    if (removed.length === 0) {
      consumeProducerSlots(uniqueKeys);
      return ok(undefined);
    }
    const persisted = await persist(
      store.entries,
      store.decisionReservations,
      store.invalidRecords,
      store.producerHandoffs,
      store.producerReservations,
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

  return {
    reserveProducerDurably,
    releaseProducerDurably,
    recordProducerOutcomeDurably,
    removeProducerReservationDurably,
    cancelProducerDurably,
    suppressProducerDurably,
    consumeProducerReservationsDurably,
    consumeProducerSlots,
  };
}
