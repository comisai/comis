// SPDX-License-Identifier: Apache-2.0
/**
 * Governed drain: replaying a failed announcement against the outward ledger.
 *
 * The ledger is what makes a retry safe. Before re-sending, the entry is
 * matched against its recorded operation; a receipt already committed means the
 * platform accepted the send even though the caller never learned so, and the
 * entry is settled rather than sent again. An entry that cannot be adjudicated
 * is parked, not retried — an ambiguous send is the one case where doing
 * nothing is strictly better than guessing.
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
import type {
  DeadLetterQueueContext,
  GovernedDrainOutcome,
  LedgerOutcome,
  LedgerTransition,
} from "./announcement-dead-letter-context.js";

export function createGovernedDrainStage(ctx: DeadLetterQueueContext) {
  const {
    logger,
    store,
    opts,
    eventBus,
    governedSendToChannel,
  } = ctx;
  const recordDrainingEntryTextChunks: DeadLetterQueueContext["recordDrainingEntryTextChunks"] = (...a) => ctx.recordDrainingEntryTextChunks(...a);
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
        if (entry.attachment.kind !== "snapshot") {
          retainBlockedEntry(entry, "attachment_preparation_blocked");
          return "retained";
        }
        const resolvedIdentity = resolveGovernedDeadLetterIdentity(entry, entry.attachment);
        if (!resolvedIdentity.ok) {
          logLedgerFailure(
            entry,
            "identity",
            "validation",
            "restore the exact retained attachment operation before settling its ledger receipt",
            "Dead-letter attachment operation identity is incomplete",
          );
          retainBlockedEntry(entry, resolvedIdentity.error);
          return "retained";
        }
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
        if (!isSameGovernedDeadLetterOperation(entry, resolvedIdentity.value, existing.value)) {
          logLedgerFailure(
            entry,
            "lookup",
            "validation",
            "reuse a retained operation identity only with its exact original route and payload",
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

  return {
    emitLedgerTransition,
    logLedgerFailure,
    retainBlockedEntry,
    parkGovernedEntry,
    drainPreparedGovernedEntry,
    drainGovernedEntry,
    emitDelivered,
  };
}
