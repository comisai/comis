// SPDX-License-Identifier: Apache-2.0
/**
 * Producer promotion — turning a reserved producer into a live announcement.
 *
 * A reservation taken before a crash is inert on restart: it names an
 * announcement nobody is currently making. Promotion decides which of those
 * reservations and handoffs should become announcements again, and rebuilds
 * the public reservation shape callers see.
 *
 * The projection back to a public reservation deliberately drops the internal
 * bookkeeping fields, so a recovered reservation is indistinguishable from a
 * fresh one to everything downstream.
 *
 * @module
 */
import type {
  AnnouncementParentDecisionReservation,
  AnnouncementProducerReservation,
} from "@comis/core";
import {
} from "@comis/core";
import {
  type ProducerReservationRecord,
} from "./announcement-dead-letter-file.js";
import {
  type AnnouncementTerminalDecision,
} from "./announcement-dead-letter-terminal-decision.js";
import {
} from "./announcement-dead-letter-identity.js";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";

export function createProducerPromotionStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    logger,
    activeProducerKeys,
    retirementProducerState,
  } = ctx;
  const recordProducerOutcomeDurably: DeadLetterQueueContext["recordProducerOutcomeDurably"] = (...a) => ctx.recordProducerOutcomeDurably(...a);
  const releaseProducerDurably: DeadLetterQueueContext["releaseProducerDurably"] = (...a) => ctx.releaseProducerDurably(...a);
  const removeProducerReservationDurably: DeadLetterQueueContext["removeProducerReservationDurably"] = (...a) => ctx.removeProducerReservationDurably(...a);
  const persist: DeadLetterQueueContext["persist"] = (...a) => ctx.persist(...a);
  const lookupTerminalDecision: DeadLetterQueueContext["lookupTerminalDecision"] = (...a) => ctx.lookupTerminalDecision(...a);
  const recordTerminalDecision: DeadLetterQueueContext["recordTerminalDecision"] = (...a) => ctx.recordTerminalDecision(...a);
  const terminalizeOwner: DeadLetterQueueContext["terminalizeOwner"] = (...a) => ctx.terminalizeOwner(...a);
  function publicProducerReservation(
    record: ProducerReservationRecord,
  ): AnnouncementProducerReservation {
    const {
      recordType: _recordType,
      id: _id,
      lifecycleState: _lifecycleState,
      recoveryOutcome: _recoveryOutcome,
      ...reservation
    } = record;
    return reservation;
  }

  function producerRecoveryAnnouncement(
    record: ProducerReservationRecord,
  ): AnnouncementProducerReservation {
    const reservation = publicProducerReservation(record);
    const outcome = record.recoveryOutcome;
    if (outcome === undefined) return reservation;
    if (outcome.kind === "tool_result") {
      const announcementText = outcome.terminalReason === "completed"
        ? outcome.response
        : outcome.summary;
      return {
        ...reservation,
        announcementText: announcementText.trim() || reservation.announcementText,
      };
    }
    if (outcome.kind === "graph") {
      return {
        ...reservation,
        announcementText: outcome.announcementText,
        ...(outcome.extra ? { extra: outcome.extra } : {}),
      };
    }
    const summary = outcome.summary?.trim() || reservation.announcementText;
    const resultLine = outcome.resultRef === undefined
      ? ""
      : `\n\nFull result (drill in with read/grep/jq): ${outcome.resultRef.ref} (${outcome.resultRef.bytes}B, ${outcome.resultRef.kind})`;
    return { ...reservation, announcementText: `${summary}${resultLine}` };
  }

  async function promoteProducerReservations(): Promise<void> {
    for (const record of [...store.producerReservations]) {
      if (activeProducerKeys.has(record.runId)) continue;
      const reservation = producerRecoveryAnnouncement(record);
      if (record.lifecycleState === "active") {
        if (!retirementProducerState) continue;
        const producerState = await retirementProducerState(record.producer);
        if (!producerState.ok) {
          logger?.warn(
            {
              runId: record.runId,
              errorKind: "resource" as const,
              hint: "restore the authoritative producer store so stale announcement ownership can be reconciled",
            },
            "Announcement producer authority could not be reconciled",
          );
          continue;
        }
        if (producerState.value.status === "active") continue;
        if (producerState.value.status === "terminal") {
          if (producerState.value.recoveryOutcome !== undefined) {
            await recordProducerOutcomeDurably(
              record.runId,
              producerState.value.recoveryOutcome,
            );
            continue;
          }
          if (record.producer.kind === "session") {
            await releaseProducerDurably(record.runId);
            continue;
          }
        }
        await removeProducerReservationDurably(record.runId);
        continue;
      }
      if (
        record.lifecycleState === "delivery_owned"
        || record.lifecycleState === "no_reply"
      ) {
        if (!retirementProducerState) continue;
        const producerState = await retirementProducerState(record.producer);
        if (!producerState.ok) {
          logger?.warn(
            {
              runId: record.runId,
              errorKind: "resource" as const,
              hint: "restore the authoritative producer store so settled announcement ownership can retire",
            },
            "Settled announcement producer authority could not be reconciled",
          );
          continue;
        }
        const hasToolResultRecovery = record.producer.kind === "tool_result"
          && producerState.value.status === "terminal"
          && producerState.value.recoveryOutcome !== undefined;
        if (
          producerState.value.status !== "active"
          && !hasToolResultRecovery
        ) {
          await removeProducerReservationDurably(record.runId);
        }
        continue;
      }
      if (record.lifecycleState === "cancel_pending") {
        await removeProducerReservationDurably(record.runId);
        continue;
      }
      if (record.lifecycleState === "no_reply_pending") {
        const terminalized = await terminalizeOwner(
          reservation,
          "no_reply",
          store.entries,
          store.decisionReservations,
        );
        if (!terminalized.ok) continue;
        await removeProducerReservationDurably(record.runId);
        continue;
      }
      const terminal = await lookupTerminalDecision(reservation);
      if (!terminal.ok) continue;
      if (terminal.value !== undefined) {
        const reconciled = await terminalizeOwner(
          reservation,
          terminal.value,
          store.entries,
          store.decisionReservations,
        );
        if (!reconciled.ok) continue;
        await removeProducerReservationDurably(record.runId);
        continue;
      }
      const promoted = await ctx.decisionStore.reserve(reservation);
      if (!promoted.ok) continue;
      if (!promoted.value.created) await removeProducerReservationDurably(record.runId);
    }
  }

  async function promoteProducerHandoffs(): Promise<void> {
    for (const handoff of [...store.producerHandoffs]) {
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
      const promoted = await ctx.decisionStore.replace(
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
      const remaining = store.producerHandoffs.filter((candidate) =>
        candidate.transitionId !== handoff.transitionId);
      const removed = await persist(store.entries, store.decisionReservations, store.invalidRecords, remaining);
      if (!removed.ok) continue;
      store.producerHandoffs = remaining;
    }
  }

  return {
    publicProducerReservation,
    producerRecoveryAnnouncement,
    promoteProducerReservations,
    promoteProducerHandoffs,
  };
}
