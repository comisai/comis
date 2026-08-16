// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  QuarantineReleaseOutcome,
} from "@comis/core";
import { tryCatch, type Result } from "@comis/shared";
import { announcementRecoveryKey } from "./announcement-dead-letter-identity.js";

export interface AnnouncementOperatorDecisionRecord {
  readonly recordType: "operator_decision";
  readonly id: string;
  readonly keyDigest: string;
  readonly outcome: QuarantineReleaseOutcome;
  readonly decidedAt: number;
}

type OperatorDecisionOwner = AnnouncementDeadLetterEntryInput
  | AnnouncementParentDecisionReservation;

export function operatorDecisionIdentity(owner: OperatorDecisionOwner): {
  rootRunId: string;
  operationId: string;
} {
  return {
    rootRunId: owner.rootRunId ?? `announcement:${owner.sessionKey}`,
    operationId: owner.idempotencyKey ?? announcementRecoveryKey(owner),
  };
}

function decisionDigest(owner: OperatorDecisionOwner): Result<string, Error> {
  const identity = operatorDecisionIdentity(owner);
  return tryCatch(() => createHash("sha256")
    .update(`${identity.rootRunId}\u0000${identity.operationId}`, "utf8")
    .digest("hex"));
}

export function createOperatorDecisionRecord(
  owner: OperatorDecisionOwner,
  outcome: QuarantineReleaseOutcome,
  decidedAt: number,
): Result<AnnouncementOperatorDecisionRecord, Error> {
  const keyDigest = decisionDigest(owner);
  return keyDigest.ok
    ? {
        ok: true,
        value: {
          recordType: "operator_decision",
          id: `operator:${keyDigest.value}`,
          keyDigest: keyDigest.value,
          outcome,
          decidedAt,
        },
      }
    : keyDigest;
}

export function findOperatorDecision(
  records: readonly AnnouncementOperatorDecisionRecord[],
  owner: OperatorDecisionOwner,
): Result<AnnouncementOperatorDecisionRecord | undefined, Error> {
  const keyDigest = decisionDigest(owner);
  return keyDigest.ok
    ? { ok: true, value: records.find((record) => record.keyDigest === keyDigest.value) }
    : keyDigest;
}

export function isAnnouncementOperatorDecisionRecord(
  value: unknown,
): value is AnnouncementOperatorDecisionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "operator_decision"
    && typeof record.id === "string"
    && /^operator:[a-f0-9]{64}$/u.test(record.id)
    && typeof record.keyDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.keyDigest)
    && record.id === `operator:${record.keyDigest}`
    && (record.outcome === "delivered" || record.outcome === "discarded")
    && typeof record.decidedAt === "number"
    && Number.isFinite(record.decidedAt);
}
