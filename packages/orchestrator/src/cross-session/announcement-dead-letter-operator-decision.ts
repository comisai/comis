// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  QuarantineReleaseOutcome,
} from "@comis/core";
import { tryCatch, type Result } from "@comis/shared";
import { announcementRecoveryKey } from "./announcement-dead-letter-identity.js";

export type AnnouncementTerminalDecision = QuarantineReleaseOutcome | "no_reply";

export interface AnnouncementTerminalDecisionRecord {
  readonly recordType: "terminal_decision";
  readonly id: string;
  readonly keyDigest: string;
  readonly outcome: AnnouncementTerminalDecision;
  readonly decidedAt: number;
}

type TerminalDecisionOwner = AnnouncementDeadLetterEntryInput
  | AnnouncementParentDecisionReservation;

export function terminalDecisionIdentity(owner: TerminalDecisionOwner): {
  rootRunId: string;
  operationId: string;
} {
  return {
    rootRunId: owner.rootRunId ?? `announcement:${owner.sessionKey}`,
    operationId: owner.idempotencyKey ?? announcementRecoveryKey(owner),
  };
}

function decisionDigest(owner: TerminalDecisionOwner): Result<string, Error> {
  const identity = terminalDecisionIdentity(owner);
  return tryCatch(() => createHash("sha256")
    .update(`${identity.rootRunId}\u0000${identity.operationId}`, "utf8")
    .digest("hex"));
}

export function createTerminalDecisionRecord(
  owner: TerminalDecisionOwner,
  outcome: AnnouncementTerminalDecision,
  decidedAt: number,
): Result<AnnouncementTerminalDecisionRecord, Error> {
  const keyDigest = decisionDigest(owner);
  return keyDigest.ok
    ? {
        ok: true,
        value: {
          recordType: "terminal_decision",
          id: `terminal:${keyDigest.value}`,
          keyDigest: keyDigest.value,
          outcome,
          decidedAt,
        },
      }
    : keyDigest;
}

export function findTerminalDecision(
  records: readonly AnnouncementTerminalDecisionRecord[],
  owner: TerminalDecisionOwner,
): Result<AnnouncementTerminalDecisionRecord | undefined, Error> {
  const keyDigest = decisionDigest(owner);
  return keyDigest.ok
    ? { ok: true, value: records.find((record) => record.keyDigest === keyDigest.value) }
    : keyDigest;
}

export function isAnnouncementTerminalDecisionRecord(
  value: unknown,
): value is AnnouncementTerminalDecisionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "terminal_decision"
    && typeof record.id === "string"
    && /^terminal:[a-f0-9]{64}$/u.test(record.id)
    && typeof record.keyDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.keyDigest)
    && record.id === `terminal:${record.keyDigest}`
    && (
      record.outcome === "delivered"
      || record.outcome === "discarded"
      || record.outcome === "no_reply"
    )
    && typeof record.decidedAt === "number"
    && Number.isFinite(record.decidedAt);
}
