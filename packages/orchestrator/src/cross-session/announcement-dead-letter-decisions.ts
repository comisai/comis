// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal decisions and the text chunks a decision owns.
 *
 * A terminal decision is the queue's final word on one announcement —
 * delivered, no-reply, discarded — and it is recorded before anything acts on
 * it, so a crash mid-settlement resumes with the decision already made rather
 * than re-deciding.
 *
 * Chunk release is settled against the owners that still reference a chunk, so
 * a chunk shared by a group is only dropped once the last owner is terminal.
 *
 * @module
 */
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
} from "@comis/core";
import {
  createStableAnnouncementChunkOperationId,
  createStableAnnouncementChunkPartId,
  isStableAnnouncementChunkPartId,
  systemNowMs,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  type DeadLetterEntry,
} from "./announcement-dead-letter-file.js";
import {
  terminalDecisionIdentity,
  type AnnouncementTerminalDecision,
} from "./announcement-dead-letter-terminal-decision.js";
import {
} from "./announcement-dead-letter-identity.js";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import { classifyQuarantined } from "./announcement-dead-letter-quarantine.js";
import {
  CHUNK_UNRESOLVED_PREFIX,
  type AnnouncementTextChunkOwner,
} from "./announcement-dead-letter-context.js";

export function createDecisionStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    maxRetries,
    maxAgeMs,
    logger,
    outwardLedger,
    terminalDecisionStore,
  } = ctx;
  const persist: DeadLetterQueueContext["persist"] = (...a) => ctx.persist(...a);
  const cleanupUnreferencedSnapshots: DeadLetterQueueContext["cleanupUnreferencedSnapshots"] = (...a) => ctx.cleanupUnreferencedSnapshots(...a);
  function quarantineClassification() {
    return classifyQuarantined({
      entries: store.entries,
      reservations: store.decisionReservations,
      invalidRecords: [...store.invalidRecords, ...store.terminalInvalidRecords],
      governed: outwardLedger !== undefined,
      maxRetries,
      maxAgeMs,
      now: systemNowMs(),
    });
  }

  async function lookupTerminalDecision(
    owner: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
  ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> {
    const lookupOwner = (
      candidate: AnnouncementDeadLetterEntryInput | AnnouncementParentDecisionReservation,
    ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> => {
      if (!outwardLedger) return terminalDecisionStore.lookup(candidate);
      const identity = terminalDecisionIdentity(candidate);
      return outwardLedger.lookupTerminalDecision(identity.rootRunId, identity.operationId);
    };
    const direct = await lookupOwner(owner);
    if (!direct.ok || direct.value !== undefined) return direct;
    const terminalKeys = [...new Set([
      owner.terminalGroupKey,
      ...(owner.completionKeys ?? []),
    ].filter((key): key is string =>
      key !== undefined && key !== owner.idempotencyKey))];
    for (const terminalKey of terminalKeys) {
      const terminal = await lookupOwner({
        ...owner,
        idempotencyKey: terminalKey,
        completionKeys: [terminalKey],
        terminalGroupKey: undefined,
      });
      if (!terminal.ok) return terminal;
      if (terminal.value !== undefined) return terminal;
    }
    return direct;
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
    if (
      outcome !== "delivered"
      && owner.terminalGroupKey !== undefined
      && owner.terminalGroupKey !== owner.idempotencyKey
    ) {
      const groupTerminalized = await recordTerminalDecision({
        ...owner,
        idempotencyKey: owner.terminalGroupKey,
        completionKeys: [owner.terminalGroupKey],
        terminalGroupKey: undefined,
      }, outcome);
      if (!groupTerminalized.ok) return groupTerminalized;
    }
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
      const nextEntries = store.entries.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            attemptCount: 0,
            lastAttemptAt: 0,
            lastError: "transport_rejected",
          }
        : candidate);
      const retained = await persist(nextEntries);
      if (!retained.ok) return retained;
      store.entries = nextEntries;
      return ok("retain");
    }
    return ok("release");
  }

  async function resolveDecisionDurably(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>> {
    const reservation = await ctx.decisionStore.lookup(idempotencyKey);
    if (!reservation.ok || reservation.value === undefined) return reservation.ok
      ? ok(false)
      : reservation;
    const nextReservations = store.decisionReservations.filter(
      (candidate) => candidate.idempotencyKey !== idempotencyKey,
    );
    if (outcome === "receipt_committed") {
      const terminalized = await terminalizeOwner(
        reservation.value,
        "delivered",
        store.entries,
        nextReservations,
      );
      if (!terminalized.ok) return terminalized;
      const resolved = await ctx.decisionStore.resolve(idempotencyKey, outcome);
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
      store.entries,
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
    const resolved = await persist(store.entries, nextReservations, store.invalidRecords);
    if (resolved.ok) {
      store.decisionReservations = nextReservations;
    }
    if (reservation.value.attachment?.kind === "snapshot") {
      await cleanupUnreferencedSnapshots([{ attachment: reservation.value.attachment }]);
    }
    if (resolved.ok) {
      return ok(true);
    }
    return err(resolved.error);
  }

  return {
    quarantineClassification,
    lookupTerminalDecision,
    recordTerminalDecision,
    retainsCompletionKey,
    terminalizeOwner,
    textChunkOwners,
    unresolvedChunkOperationId,
    settleTextChunkRelease,
    resolveDecisionDurably,
  };
}
