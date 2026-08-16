// SPDX-License-Identifier: Apache-2.0
/** Durable lifecycle for a completion announcement's irreversible platform send. */

import { createHash } from "node:crypto";
import {
  emitObservationalEventSafely,
  systemNowMs,
  type ComisLogger,
  type AnnouncementDeadLetterAttachmentSnapshot,
  type ChannelEndpoint,
  type ConversationLocator,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type OutwardTerminalDecision,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface AnnouncementOperationIdentity {
  agentId: string;
  rootRunId: string;
  stepIndex: number;
}

export interface GovernedAnnouncementRequest {
  operationId: string;
  rootRunId: string;
  runId: string;
  agentId: string;
  sessionKey: string;
  partId?: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
  attachment?: GovernedAnnouncementAttachment;
  preparedTextChunks?: readonly string[];
}

/** Immutable prepared snapshot metadata bound into one outward operation. */
export type GovernedAnnouncementAttachment = AnnouncementDeadLetterAttachmentSnapshot;

/** Untrusted generated-file reference resolved by the daemon composition root. */
export interface CompletionAttachmentRef {
  sourceAgentId: string;
  path: string;
}

export interface AnnouncementDeliveryOptions {
  threadId?: string;
  extra?: Record<string, unknown>;
}

export type AnnouncementPlatformSendOutcome =
  | {
      delivered: true;
      status: "accepted";
      platformMessageId?: string;
    }
  | {
      delivered: false;
      status: "rejected" | "unknown";
    };

export type GovernedAnnouncementFailure =
  | "operation_validation_blocked"
  | "attachment_preparation_blocked"
  | "allocation_blocked"
  | "lookup_blocked"
  | "operation_mismatch"
  | "operation_retained"
  | "begin_blocked"
  | "uncertainty_transition_blocked"
  | "transport_failed"
  | "transport_rejected"
  | "transport_uncertain"
  | "platform_receipt_missing"
  | "commit_blocked";

export type GovernedAnnouncementSendOutcome =
  | {
      delivered: true;
      identity: AnnouncementOperationIdentity;
      platformMessageId?: string;
    }
  | { delivered: false; terminalDecision: OutwardTerminalDecision }
  | {
      delivered: false;
      identity?: AnnouncementOperationIdentity;
      failure: GovernedAnnouncementFailure;
    };

export function isGovernedAnnouncementConfirmedDelivered(
  outcome: GovernedAnnouncementSendOutcome,
): boolean {
  return outcome.delivered
    || ("terminalDecision" in outcome && outcome.terminalDecision === "delivered");
}

export type SendGovernedAnnouncement = (
  request: GovernedAnnouncementRequest,
) => Promise<Result<GovernedAnnouncementSendOutcome, Error>>;

/** Origin-rich request accepted by the composition-root resolver. */
export interface CompletionAnnouncementSendRequest {
  agentId: string;
  callerSessionKey: string;
  callerConversation: ConversationLocator;
  /** Immutable authenticated endpoint captured with the caller turn. */
  destinationEndpoint: ChannelEndpoint;
  runId: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
  /** Distinguishes independently governed files emitted by the same run. */
  partId?: string;
  attachment?: CompletionAttachmentRef;
  preparedAttachment?: GovernedAnnouncementAttachment;
  preparedTextChunks?: readonly string[];
  completionKeys?: readonly string[];
  signal?: AbortSignal;
}

export type SendGovernedCompletionAnnouncement = (
  request: CompletionAnnouncementSendRequest,
) => Promise<Result<GovernedAnnouncementSendOutcome, Error>>;

export type RecoverableAnnouncementSendOutcome =
  | AnnouncementPlatformSendOutcome
  | { delivered: false; terminalDecision: OutwardTerminalDecision };

export type SendRecoverableCompletionAnnouncement = (
  request: CompletionAnnouncementSendRequest,
) => Promise<Result<RecoverableAnnouncementSendOutcome, Error>>;

interface GovernedAnnouncementSenderDeps {
  ledger: OutwardSendLedgerPort;
  sendToPlatform: (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
    attachment?: GovernedAnnouncementAttachment,
  ) => Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  eventBus?: TypedEventBus;
  logger?: Pick<ComisLogger, "error" | "warn">;
}

interface AnnouncementTransitionEvidence {
  deliveryKind: "text" | "attachment";
  platformMessageId?: string;
  runId: string;
  sessionKey: string;
  partId?: string;
}

export interface AnnouncementOperationDigests {
  contentDigest: string;
  operationFingerprint: string;
}

function invalidJsonValue(): Result<never, Error> {
  return err(new Error(
    "Announcement delivery options must contain only finite JSON values in plain objects and dense arrays",
  ));
}

function canonicalJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): Result<string, Error> {
  if (value === null) return ok("null");
  switch (typeof value) {
    case "string": {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? invalidJsonValue() : ok(serialized);
    }
    case "boolean":
      return ok(value ? "true" : "false");
    case "number":
      return Number.isFinite(value) ? ok(JSON.stringify(value)) : invalidJsonValue();
    case "object":
      break;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return invalidJsonValue();
    default:
      return invalidJsonValue();
  }

  if (ancestors.has(value)) return invalidJsonValue();
  ancestors.add(value);

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      ancestors.delete(value);
      return invalidJsonValue();
    }
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        ancestors.delete(value);
        return invalidJsonValue();
      }
      const canonical = canonicalJsonValue(descriptor.value, ancestors);
      if (!canonical.ok) {
        ancestors.delete(value);
        return canonical;
      }
      parts.push(canonical.value);
    }
    if (keys.some((key) => {
      if (key === "length") return false;
      const index = Number(key);
      return !Number.isSafeInteger(index)
        || index < 0
        || index >= value.length
        || String(index) !== key;
    })) {
      ancestors.delete(value);
      return invalidJsonValue();
    }
    ancestors.delete(value);
    return ok(`[${parts.join(",")}]`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return invalidJsonValue();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    ancestors.delete(value);
    return invalidJsonValue();
  }
  const sortedKeys = (keys as string[]).sort();
  const parts: string[] = [];
  for (const key of sortedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      ancestors.delete(value);
      return invalidJsonValue();
    }
    const canonical = canonicalJsonValue(descriptor.value, ancestors);
    if (!canonical.ok) {
      ancestors.delete(value);
      return canonical;
    }
    parts.push(`${JSON.stringify(key)}:${canonical.value}`);
  }
  ancestors.delete(value);
  return ok(`{${parts.join(",")}}`);
}

function canonicalJson(value: unknown): Result<string, Error> {
  const boundary = tryCatch(() => canonicalJsonValue(value, new WeakSet<object>()));
  return boundary.ok ? boundary.value : invalidJsonValue();
}

/** Canonical content-free hashes shared by the initial sender and DLQ verifier. */
export function createAnnouncementOperationDigests(params: {
  channelType: string;
  channelId: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
  attachment?: GovernedAnnouncementAttachment;
}): Result<AnnouncementOperationDigests, Error> {
  const input = tryCatch(() => ({
    channelType: params.channelType,
    channelId: params.channelId,
    text: params.text,
    options: params.options,
    attachment: params.attachment,
  }));
  if (!input.ok) return invalidJsonValue();
  if (
    typeof input.value.channelType !== "string"
    || typeof input.value.channelId !== "string"
    || typeof input.value.text !== "string"
  ) {
    return invalidJsonValue();
  }
  const canonical = canonicalJson({
    ...(input.value.attachment === undefined
      ? {}
      : { attachment: {
          contentDigest: input.value.attachment.contentDigest,
          fileName: input.value.attachment.fileName,
          mimeType: input.value.attachment.mimeType,
          sizeBytes: input.value.attachment.sizeBytes,
        } }),
    channelId: input.value.channelId,
    channelType: input.value.channelType,
    kind: "cross_session_announcement",
    options: input.value.options ?? null,
    targetMessageId: null,
    text: input.value.text,
  });
  if (!canonical.ok) return canonical;
  return tryCatch(() => ({
    contentDigest: createHash("sha256").update(
      input.value.attachment === undefined ? input.value.text : canonical.value,
    ).digest("hex"),
    operationFingerprint: createHash("sha256")
      .update(canonical.value)
      .digest("hex"),
  }));
}

function isSameOperation(
  request: GovernedAnnouncementRequest,
  record: OutwardSendRecord,
  digests: AnnouncementOperationDigests,
): boolean {
  return record.rootRunId === request.rootRunId
    && record.agentId === request.agentId
    && record.channelType === request.channelType
    && record.channelId === request.channelId
    && record.operationKind === "cross_session_announcement"
    && record.operationFingerprint === digests.operationFingerprint
    && record.contentDigest === digests.contentDigest;
}

/**
 * Create a single-attempt, receipt-committing announcement sender. A platform
 * receipt is the only positive commit proof. Any thrown/error/false/no-receipt
 * outcome becomes unresolved, and its governed DLQ row is an operator
 * escalation record rather than an automatic retry.
 */
export function createGovernedAnnouncementSender(deps: GovernedAnnouncementSenderDeps): {
  send: SendGovernedAnnouncement;
} {
  function emit(
    identity: { rootRunId: string; stepIndex?: number },
    transition: "allocate" | "lookup" | "begin" | "mark_unknown" | "commit" | "park",
    outcome: "blocked" | "in_flight" | "committed" | "parked",
    evidence: AnnouncementTransitionEvidence,
  ): void {
    if (!deps.eventBus) return;
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "delivery:outward_ledger_transition",
      {
        rootRunId: identity.rootRunId,
        ...(identity.stepIndex === undefined ? {} : { stepIndex: identity.stepIndex }),
        transition,
        outcome,
        ...evidence,
        timestamp: systemNowMs(),
      },
    );
  }

  function logFailure(
    identity: Partial<AnnouncementOperationIdentity>,
    transition: string,
    errorKind: "dependency" | "precondition" | "validation",
    hint: string,
    message: string,
  ): void {
    deps.logger?.error(
      {
        ...(identity.rootRunId ? { rootRunId: identity.rootRunId } : {}),
        ...(identity.stepIndex !== undefined ? { stepIndex: identity.stepIndex } : {}),
        transition,
        step: "completion-announcement-outward-ledger",
        errorKind,
        hint,
      },
      message,
    );
  }

  async function park(
    identity: AnnouncementOperationIdentity,
    evidence: AnnouncementTransitionEvidence,
  ): Promise<void> {
    const parked = await deps.ledger.parkUncertain(identity.rootRunId, identity.stepIndex);
    if (!parked.ok || !parked.value) {
      logFailure(
        identity,
        "park",
        "dependency",
        "repair the outward ledger and verify the destination manually before any retry",
        "Completion announcement uncertainty could not be parked",
      );
      emit(identity, "park", "blocked", evidence);
      return;
    }
    emit(identity, "park", "parked", evidence);
  }

  const send: SendGovernedAnnouncement = async (request) => {
    const digestResult = createAnnouncementOperationDigests(request);
    if (!digestResult.ok) {
      logFailure(
        { agentId: request.agentId, rootRunId: request.rootRunId },
        "validate",
        "validation",
        "remove cyclic, unsupported, or non-finite values from the announcement delivery options",
        "Completion announcement operation validation failed",
      );
      return ok({ delivered: false, failure: "operation_validation_blocked" });
    }
    const digests = digestResult.value;
    const deliveryEvidence = {
      deliveryKind: request.attachment === undefined
        ? "text" as const
        : "attachment" as const,
      runId: request.runId,
      sessionKey: request.sessionKey,
      ...(request.partId === undefined ? {} : { partId: request.partId }),
    };
    const terminalDecision = await deps.ledger.lookupTerminalDecision(
      request.rootRunId,
      request.operationId,
    );
    if (!terminalDecision.ok) {
      logFailure(
        { agentId: request.agentId, rootRunId: request.rootRunId },
        "terminal_decision_lookup",
        "dependency",
        "repair outward terminal-decision storage before retrying the retained completion",
        "Completion announcement terminal decision lookup failed",
      );
      return ok({ delivered: false, failure: "lookup_blocked" });
    }
    if (terminalDecision.value !== undefined) {
      return ok({ delivered: false, terminalDecision: terminalDecision.value });
    }
    const allocated = await deps.ledger.allocateStep(request.rootRunId, request.operationId);
    if (!allocated.ok) {
      logFailure(
        { agentId: request.agentId, rootRunId: request.rootRunId },
        "allocate",
        "dependency",
        "repair the outward operation store before retrying the same completion",
        "Completion announcement operation allocation failed",
      );
      emit({ rootRunId: request.rootRunId }, "allocate", "blocked", deliveryEvidence);
      return ok({ delivered: false, failure: "allocation_blocked" });
    }

    const identity: AnnouncementOperationIdentity = {
      agentId: request.agentId,
      rootRunId: request.rootRunId,
      stepIndex: allocated.value,
    };
    const existing = await deps.ledger.lookup(identity.rootRunId, identity.stepIndex);
    if (!existing.ok) {
      logFailure(
        identity,
        "lookup",
        "dependency",
        "repair outward-ledger reads before retrying the retained completion",
        "Completion announcement ledger lookup failed",
      );
      emit(identity, "lookup", "blocked", deliveryEvidence);
      return ok({ delivered: false, identity, failure: "lookup_blocked" });
    }
    if (existing.value !== undefined) {
      if (!isSameOperation(request, existing.value, digests)) {
        logFailure(
          identity,
          "lookup",
          "validation",
          "reuse a completion operation identity only with its exact original destination and payload",
          "Completion announcement operation identity mismatch",
        );
        emit(identity, "lookup", "blocked", deliveryEvidence);
        return ok({ delivered: false, identity, failure: "operation_mismatch" });
      }
      if (
        existing.value.state === "committed"
        && existing.value.platformMessageId !== undefined
        && existing.value.platformMessageId.length > 0
      ) {
        emit(identity, "lookup", "committed", {
          ...deliveryEvidence,
          platformMessageId: existing.value.platformMessageId,
        });
        return ok({
          delivered: true,
          identity,
          platformMessageId: existing.value.platformMessageId,
        });
      }
      if (
        existing.value.state === "send_attempt_started"
        || existing.value.state === "unknown_after_send"
      ) {
        await park(identity, deliveryEvidence);
      }
      emit(identity, "lookup", "blocked", deliveryEvidence);
      return ok({ delivered: false, identity, failure: "operation_retained" });
    }

    const begun = await deps.ledger.begin({
      ...identity,
      channelType: request.channelType,
      channelId: request.channelId,
      operationKind: "cross_session_announcement",
      ...digests,
    });
    if (!begun.ok) {
      logFailure(
        identity,
        "begin",
        "dependency",
        "inspect the retained operation before retrying; another attempt may own this identity",
        "Completion announcement durable intent could not be recorded",
      );
      emit(identity, "begin", "blocked", deliveryEvidence);
      return ok({ delivered: false, identity, failure: "begin_blocked" });
    }
    emit(identity, "begin", "in_flight", deliveryEvidence);

    const markedUnknown = await deps.ledger.markUnknown(identity.rootRunId, identity.stepIndex);
    if (!markedUnknown.ok) {
      await park(identity, deliveryEvidence);
      logFailure(
        identity,
        "mark_unknown",
        "dependency",
        "repair the outward ledger before retrying; the platform call was blocked",
        "Completion announcement uncertainty transition failed",
      );
      emit(identity, "mark_unknown", "blocked", deliveryEvidence);
      return ok({ delivered: false, identity, failure: "uncertainty_transition_blocked" });
    }
    emit(identity, "mark_unknown", "in_flight", deliveryEvidence);

    const boundary = await fromPromise(
      deps.sendToPlatform(
        request.channelType,
        request.channelId,
        request.text,
        request.options,
        request.attachment,
      ),
    );
    if (!boundary.ok || !boundary.value.ok) {
      await park(identity, deliveryEvidence);
      return ok({ delivered: false, identity, failure: "transport_failed" });
    }
    if (!boundary.value.value.delivered) {
      await park(identity, deliveryEvidence);
      return ok({
        delivered: false,
        identity,
        failure: boundary.value.value.status === "unknown"
          ? "transport_uncertain"
          : "transport_rejected",
      });
    }
    const receipt = boundary.value.value.platformMessageId;
    if (receipt === undefined || receipt.length === 0) {
      await park(identity, deliveryEvidence);
      logFailure(
        identity,
        "receipt",
        "precondition",
        "verify the destination manually; a successful local result without a platform receipt is not replay-safe",
        "Completion announcement platform receipt missing",
      );
      return ok({ delivered: false, identity, failure: "platform_receipt_missing" });
    }

    const committed = await deps.ledger.commit(identity.rootRunId, identity.stepIndex, receipt);
    if (!committed.ok) {
      await park(identity, deliveryEvidence);
      logFailure(
        identity,
        "commit",
        "dependency",
        "verify the destination manually before any retry; the platform receipt was not committed",
        "Completion announcement receipt commit failed",
      );
      emit(identity, "commit", "blocked", deliveryEvidence);
      return ok({ delivered: false, identity, failure: "commit_blocked" });
    }
    emit(identity, "commit", "committed", {
      ...deliveryEvidence,
      platformMessageId: receipt,
    });
    return ok({ delivered: true, identity, platformMessageId: receipt });
  };

  return { send };
}
