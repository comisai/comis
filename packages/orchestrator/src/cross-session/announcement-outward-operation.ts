// SPDX-License-Identifier: Apache-2.0
/** Durable lifecycle for a completion announcement's irreversible platform send. */

import { createHash } from "node:crypto";
import {
  emitObservationalEventSafely,
  systemNowMs,
  type ComisLogger,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
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
  agentId: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
}

export interface AnnouncementDeliveryOptions {
  threadId?: string;
  extra?: Record<string, unknown>;
}

export interface AnnouncementPlatformSendOutcome {
  /**
   * Local delivery completion. `false` is not proof that the platform did not
   * accept a request; the transport contract has no safe-rejection
   * discriminator. Every post-call false/error is therefore parked.
   */
  delivered: boolean;
  platformMessageId?: string;
}

export type GovernedAnnouncementFailure =
  | "operation_validation_blocked"
  | "allocation_blocked"
  | "lookup_blocked"
  | "operation_mismatch"
  | "operation_retained"
  | "begin_blocked"
  | "uncertainty_transition_blocked"
  | "transport_failed"
  | "transport_rejected"
  | "platform_receipt_missing"
  | "commit_blocked";

export type GovernedAnnouncementSendOutcome =
  | { delivered: true; identity: AnnouncementOperationIdentity }
  | {
      delivered: false;
      identity?: AnnouncementOperationIdentity;
      failure: GovernedAnnouncementFailure;
    };

export type SendGovernedAnnouncement = (
  request: GovernedAnnouncementRequest,
) => Promise<Result<GovernedAnnouncementSendOutcome, Error>>;

/** Origin-rich request accepted by the composition-root resolver. */
export interface CompletionAnnouncementSendRequest {
  agentId: string;
  callerSessionKey: string;
  runId: string;
  channelType: string;
  channelId: string;
  text: string;
  options?: AnnouncementDeliveryOptions;
}

export type SendGovernedCompletionAnnouncement = (
  request: CompletionAnnouncementSendRequest,
) => Promise<Result<GovernedAnnouncementSendOutcome, Error>>;

interface GovernedAnnouncementSenderDeps {
  ledger: OutwardSendLedgerPort;
  sendToPlatform: (
    channelType: string,
    channelId: string,
    text: string,
    options?: AnnouncementDeliveryOptions,
  ) => Promise<Result<AnnouncementPlatformSendOutcome, Error>>;
  eventBus?: TypedEventBus;
  logger?: Pick<ComisLogger, "error" | "warn">;
}

/** Build the bounded allocation key for one originating completion operation. */
export function createStableAnnouncementOperationId(
  agentId: string,
  callerSessionKey: string,
  runId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ agentId, callerSessionKey, kind: "completion_announcement", runId }))
    .digest("hex");
  return `completion-announcement:${digest}`;
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
}): Result<AnnouncementOperationDigests, Error> {
  const input = tryCatch(() => ({
    channelType: params.channelType,
    channelId: params.channelId,
    text: params.text,
    options: params.options,
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
    channelId: input.value.channelId,
    channelType: input.value.channelType,
    kind: "cross_session_announcement",
    options: input.value.options ?? null,
    targetMessageId: null,
    text: input.value.text,
  });
  if (!canonical.ok) return canonical;
  return tryCatch(() => ({
    contentDigest: createHash("sha256").update(input.value.text).digest("hex"),
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
    identity: Pick<AnnouncementOperationIdentity, "rootRunId" | "stepIndex">,
    transition: "lookup" | "begin" | "mark_unknown" | "commit" | "park",
    outcome: "blocked" | "in_flight" | "committed" | "parked",
  ): void {
    if (!deps.eventBus) return;
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
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

  async function park(identity: AnnouncementOperationIdentity): Promise<void> {
    const parked = await deps.ledger.parkUncertain(identity.rootRunId, identity.stepIndex);
    if (!parked.ok || !parked.value) {
      logFailure(
        identity,
        "park",
        "dependency",
        "repair the outward ledger and verify the destination manually before any retry",
        "Completion announcement uncertainty could not be parked",
      );
      emit(identity, "park", "blocked");
      return;
    }
    emit(identity, "park", "parked");
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
    const allocated = await deps.ledger.allocateStep(request.rootRunId, request.operationId);
    if (!allocated.ok) {
      logFailure(
        { agentId: request.agentId, rootRunId: request.rootRunId },
        "allocate",
        "dependency",
        "repair the outward operation store before retrying the same completion",
        "Completion announcement operation allocation failed",
      );
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
      emit(identity, "lookup", "blocked");
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
        emit(identity, "lookup", "blocked");
        return ok({ delivered: false, identity, failure: "operation_mismatch" });
      }
      if (
        existing.value.state === "committed"
        && existing.value.platformMessageId !== undefined
        && existing.value.platformMessageId.length > 0
      ) {
        emit(identity, "lookup", "committed");
        return ok({ delivered: true, identity });
      }
      if (
        existing.value.state === "send_attempt_started"
        || existing.value.state === "unknown_after_send"
      ) {
        await park(identity);
      }
      emit(identity, "lookup", "blocked");
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
      emit(identity, "begin", "blocked");
      return ok({ delivered: false, identity, failure: "begin_blocked" });
    }
    emit(identity, "begin", "in_flight");

    const markedUnknown = await deps.ledger.markUnknown(identity.rootRunId, identity.stepIndex);
    if (!markedUnknown.ok) {
      await park(identity);
      logFailure(
        identity,
        "mark_unknown",
        "dependency",
        "repair the outward ledger before retrying; the platform call was blocked",
        "Completion announcement uncertainty transition failed",
      );
      emit(identity, "mark_unknown", "blocked");
      return ok({ delivered: false, identity, failure: "uncertainty_transition_blocked" });
    }
    emit(identity, "mark_unknown", "in_flight");

    const boundary = await fromPromise(
      deps.sendToPlatform(
        request.channelType,
        request.channelId,
        request.text,
        request.options,
      ),
    );
    if (!boundary.ok || !boundary.value.ok) {
      await park(identity);
      return ok({ delivered: false, identity, failure: "transport_failed" });
    }
    if (!boundary.value.value.delivered) {
      await park(identity);
      return ok({ delivered: false, identity, failure: "transport_rejected" });
    }
    const receipt = boundary.value.value.platformMessageId;
    if (receipt === undefined || receipt.length === 0) {
      await park(identity);
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
      await park(identity);
      logFailure(
        identity,
        "commit",
        "dependency",
        "verify the destination manually before any retry; the platform receipt was not committed",
        "Completion announcement receipt commit failed",
      );
      emit(identity, "commit", "blocked");
      return ok({ delivered: false, identity, failure: "commit_blocked" });
    }
    emit(identity, "commit", "committed");
    return ok({ delivered: true, identity });
  };

  return { send };
}
