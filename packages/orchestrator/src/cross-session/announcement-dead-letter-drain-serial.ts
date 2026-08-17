// SPDX-License-Identifier: Apache-2.0
/**
 * Serialized drain over the retained set.
 *
 * Walks retained entries one at a time against a plain channel sender, which
 * is the path taken when no outward ledger is wired. Without a ledger there is
 * no receipt to reconcile against, so ordering does the work instead: entries
 * are drained serially and each is settled before the next begins, so a crash
 * leaves at most one send unaccounted for.
 *
 * @module
 */
import type {
} from "@comis/core";
import {
  systemNowMs,
} from "@comis/core";
import { fromPromise, tryCatch } from "@comis/shared";
import {
  type ChannelType,
  type DeadLetterEntry,
} from "./announcement-dead-letter-file.js";
import {
} from "./announcement-dead-letter-terminal-decision.js";
import {
  announcementRecoveryKey,
} from "./announcement-dead-letter-identity.js";
import type { RecoveryDeliveryOptions } from "./announcement-dead-letter-types.js";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import {
  CHUNK_IN_FLIGHT_PREFIX,
  CHUNK_UNRESOLVED_PREFIX,
} from "./announcement-dead-letter-context.js";

export function createSerialDrainStage(ctx: DeadLetterQueueContext) {
  const {
    store,
    maxRetries,
    retryIntervalMs,
    maxAgeMs,
    logger,
    outwardLedger,
    emittedAdmissionKeys,
    receiptAwareSendToChannel,
  } = ctx;
  const promoteProducerReservations: DeadLetterQueueContext["promoteProducerReservations"] = (...a) => ctx.promoteProducerReservations(...a);
  const promoteProducerHandoffs: DeadLetterQueueContext["promoteProducerHandoffs"] = (...a) => ctx.promoteProducerHandoffs(...a);
  const loadFromDisk: DeadLetterQueueContext["loadFromDisk"] = (...a) => ctx.loadFromDisk(...a);
  const persist: DeadLetterQueueContext["persist"] = (...a) => ctx.persist(...a);
  const collectTerminalRetirementsDurably: DeadLetterQueueContext["collectTerminalRetirementsDurably"] = (...a) => ctx.collectTerminalRetirementsDurably(...a);
  const cleanupUnreferencedSnapshots: DeadLetterQueueContext["cleanupUnreferencedSnapshots"] = (...a) => ctx.cleanupUnreferencedSnapshots(...a);
  const emitDelivered: DeadLetterQueueContext["emitDelivered"] = (...a) => ctx.emitDelivered(...a);
  const lookupTerminalDecision: DeadLetterQueueContext["lookupTerminalDecision"] = (...a) => ctx.lookupTerminalDecision(...a);
  const recordTerminalDecision: DeadLetterQueueContext["recordTerminalDecision"] = (...a) => ctx.recordTerminalDecision(...a);
  const terminalizeOwner: DeadLetterQueueContext["terminalizeOwner"] = (...a) => ctx.terminalizeOwner(...a);
  const textChunkOwners: DeadLetterQueueContext["textChunkOwners"] = (...a) => ctx.textChunkOwners(...a);
  const unresolvedChunkOperationId: DeadLetterQueueContext["unresolvedChunkOperationId"] = (...a) => ctx.unresolvedChunkOperationId(...a);
  const drainGovernedEntry: DeadLetterQueueContext["drainGovernedEntry"] = (...a) => ctx.drainGovernedEntry(...a);
  const adjudicateReservations: DeadLetterQueueContext["adjudicateReservations"] = (...a) => ctx.adjudicateReservations(...a);
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
      store.entries = [...reconciled];
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
      store.entries = [...inFlightEntries];
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
        store.entries = [...stableEntries];
        continue;
      }
      entry.lastError = status === "rejected"
        ? "transport_rejected"
        : `${CHUNK_UNRESOLVED_PREFIX}${chunkOwner.idempotencyKey}`;
      const retainedEntries = workingEntries.filter((candidate) =>
        !deliveredIds.has(candidate.id));
      const retained = await persist(retainedEntries);
      if (retained.ok) store.entries = [...retainedEntries];
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
    if (store.entries.length === 0) return;
    const now = systemNowMs();
    const workingEntries = store.entries.map((entry) => ({ ...entry }));
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
          store.decisionReservations,
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
          store.decisionReservations,
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
          store.decisionReservations,
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
      store.entries = [...preAttemptEntries];
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
        store.entries = [...pendingEntries];
        const retainedEntries = pendingEntries.filter((candidate) =>
          candidate.id !== entry.id);
        const terminalized = await terminalizeOwner(
          entry,
          "delivered",
          retainedEntries,
          store.decisionReservations,
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
    store.entries = nextEntries;
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
        const stillRetained = store.entries.some((candidate) =>
          candidate.idempotencyKey === completionKey
          || candidate.completionKeys?.includes(completionKey) === true)
          || store.decisionReservations.some((candidate) =>
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

  return {
    recoveryOptions,
    drainLedgerlessTextChunks,
    drainSerialized,
  };
}
