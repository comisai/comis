// SPDX-License-Identifier: Apache-2.0
/**
 * The quarantined-announcement operator projection.
 *
 * Split from `announcement-dead-letter.ts` (the `announcement-dead-letter-file.ts`
 * discipline) to keep that file under the production line cap. PURE: the
 * projection is a total function of the queue's in-memory lists, so the
 * operator view can never disagree with what a drain would act on.
 *
 * @module
 */

import { ok, type Result } from "@comis/shared";
import type {
  AnnouncementDeadLetterStatus,
  QuarantinedAnnouncement,
  QuarantineReleaseOutcome,
} from "@comis/core";
import type { DeadLetterEntry, ParentDecisionReservationRecord } from "./announcement-dead-letter-file.js";
import type { InvalidDeadLetterRecord } from "./announcement-dead-letter-invalid.js";

/**
 * One quarantined announcement, as an operator sees it.
 *
 * Content-free by construction: the announcement's LENGTH is carried, never its
 * text. These rows ride an admin RPC and a terminal, and the announcement is
 * quarantined precisely because it was NOT delivered to its intended reader —
 * an operator deciding its fate needs the route and the reason, not the message.
 */
export type { QuarantinedAnnouncement, QuarantineReleaseOutcome } from "@comis/core";

export interface AnnouncementQuarantineClassification {
  readonly actionableIds: ReadonlySet<string>;
  readonly rows: readonly QuarantinedAnnouncement[];
  readonly status: AnnouncementDeadLetterStatus;
}

const GOVERNED_OPERATOR_ERRORS = new Set([
  "attachment_preparation_blocked",
  "attachment_preparation_unavailable",
  "identity_incomplete",
  "operation_validation_blocked",
  "outward_committed_receipt_missing",
  "outward_operation_failed",
  "outward_operation_identity_mismatch",
  "outward_operation_mapping_mismatch",
  "outward_operation_unresolved",
]);

export function classifyQuarantined(input: {
  readonly entries: readonly DeadLetterEntry[];
  readonly reservations: readonly ParentDecisionReservationRecord[];
  readonly invalidRecords: readonly InvalidDeadLetterRecord[];
  readonly governed: boolean;
  readonly maxRetries: number;
  readonly maxAgeMs: number;
  readonly now: number;
}): AnnouncementQuarantineClassification {
  const actionableEntries = input.entries.filter((entry) => input.governed
    ? entry.lastError !== undefined && GOVERNED_OPERATOR_ERRORS.has(entry.lastError)
    : entry.lastError === "outward_operation_unresolved"
      || entry.attemptCount >= input.maxRetries
      || input.now - entry.failedAt >= input.maxAgeMs);
  const rows = projectQuarantined(actionableEntries, [], input.invalidRecords);
  return {
    actionableIds: new Set(rows.map((row) => row.id)),
    rows,
    status: {
      activeRecoveryCount: input.entries.length
        - actionableEntries.length
        + input.reservations.length,
      quarantinedCount: rows.length,
    },
  };
}


/**
 * Project retained deliveries and invalid records into one content-free,
 * oldest-first operator view.
 */
export function projectQuarantined(
  entries: readonly DeadLetterEntry[],
  reservations: readonly ParentDecisionReservationRecord[],
  invalidRecords: readonly InvalidDeadLetterRecord[],
): readonly QuarantinedAnnouncement[] {
  const rows: Array<{ readonly row: QuarantinedAnnouncement; readonly sortAt: number }> = [
    ...entries.map((entry) => ({
      sortAt: entry.failedAt,
      row: {
        id: entry.id,
        kind: "entry" as const,
        runId: entry.runId,
        ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
        channelType: entry.channelType,
        channelId: entry.channelId,
        ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
        failedAt: entry.failedAt,
        attemptCount: entry.attemptCount,
        lastAttemptAt: entry.lastAttemptAt,
        ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
        ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
        announcementChars: entry.announcementText.length,
      },
    })),
    ...reservations.map((record) => ({
      sortAt: record.failedAt,
      row: {
        id: record.id,
        kind: "parent_decision" as const,
        runId: record.runId,
        agentId: record.agentId,
        channelType: record.channelType,
        channelId: record.channelId,
        ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
        failedAt: record.failedAt,
        attemptCount: 0,
        idempotencyKey: record.idempotencyKey,
        announcementChars: record.announcementText.length,
      },
    })),
    ...invalidRecords.map((record) => ({
      sortAt: record.detectedAt,
      row: {
        id: record.id,
        kind: "invalid_record" as const,
        reason: record.reason,
        sourceLine: record.sourceLine,
        detectedAt: record.detectedAt,
        rawDigest: record.rawDigest,
        rawBytes: record.rawBytes,
      },
    })),
  ];
  return rows
    .sort((left, right) => left.sortAt - right.sortAt || left.row.id.localeCompare(right.row.id))
    .map(({ row }) => row);
}

/** Minimal structural logger accepted by the release path. */
interface QuarantineLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Apply an operator decision to one parked announcement.
 *
 * Persists BEFORE the caller mutates its in-memory state (the injected
 * `persist` commits both), so a storage failure leaves the announcement parked
 * rather than dropping an undelivered message on a bad write. An unknown id
 * resolves `false` rather than failing — releasing the same id twice is an
 * operator retrying, not an error.
 */
export async function releaseQuarantined(input: {
  readonly id: string;
  readonly outcome: QuarantineReleaseOutcome;
  readonly entries: readonly DeadLetterEntry[];
  readonly reservations: readonly ParentDecisionReservationRecord[];
  readonly invalidRecords: readonly InvalidDeadLetterRecord[];
  readonly logger?: QuarantineLogger;
  readonly persist: (
    entries: readonly DeadLetterEntry[],
    reservations: readonly ParentDecisionReservationRecord[],
    invalidRecords: readonly InvalidDeadLetterRecord[],
  ) => Promise<Result<void, Error>>;
}): Promise<Result<boolean, Error>> {
  const entry = input.entries.find((candidate) => candidate.id === input.id);
  const reservation = input.reservations.find((candidate) => candidate.id === input.id);
  const invalidRecord = input.invalidRecords.find((candidate) => candidate.id === input.id);
  if (entry === undefined && reservation === undefined && invalidRecord === undefined) {
    return ok(false);
  }

  const nextEntries = input.entries.filter((candidate) => candidate.id !== input.id);
  const nextReservations = input.reservations.filter((candidate) => candidate.id !== input.id);
  const nextInvalidRecords = input.invalidRecords.filter((candidate) => candidate.id !== input.id);
  const persisted = await input.persist(nextEntries, nextReservations, nextInvalidRecords);
  if (!persisted.ok) {
    input.logger?.error(
      {
        errorKind: "resource" as const,
        hint: "restore dead-letter storage before releasing; the announcement is still quarantined",
      },
      "Quarantined announcement release was not durably persisted",
    );
    return persisted;
  }
  input.logger?.info(
    {
      ...(entry?.runId ?? reservation?.runId
        ? { runId: entry?.runId ?? reservation?.runId }
        : {}),
      kind: entry !== undefined
        ? "entry"
        : reservation !== undefined
          ? "parent_decision"
          : "invalid_record",
      outcome: input.outcome,
      remaining: nextEntries.length + nextReservations.length + nextInvalidRecords.length,
    },
    "Quarantined announcement released by operator decision",
  );
  return ok(true);
}
