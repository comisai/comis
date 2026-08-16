// SPDX-License-Identifier: Apache-2.0
/**
 * The quarantined-announcement operator projection.
 *
 * Split from `announcement-dead-letter.ts` (the `announcement-dead-letter-file.ts`
 * discipline) to keep that file under the production line cap. PURE: the
 * projection is a total function of the queue's two in-memory lists, so the
 * operator view can never disagree with what a drain would act on.
 *
 * @module
 */

import { ok, type Result } from "@comis/shared";
import type {
  QuarantinedAnnouncement,
  QuarantineReleaseOutcome,
} from "@comis/core";
import type { DeadLetterEntry, ParentDecisionReservationRecord } from "./announcement-dead-letter-file.js";

/**
 * One quarantined announcement, as an operator sees it.
 *
 * Content-free by construction: the announcement's LENGTH is carried, never its
 * text. These rows ride an admin RPC and a terminal, and the announcement is
 * quarantined precisely because it was NOT delivered to its intended reader —
 * an operator deciding its fate needs the route and the reason, not the message.
 */
export type { QuarantinedAnnouncement, QuarantineReleaseOutcome } from "@comis/core";


/**
 * Project the live queue into the operator view: entries and parked
 * parent-decision reservations in one list, oldest-first so the longest-stuck
 * item leads, with the announcement's LENGTH standing in for its text.
 */
export function projectQuarantined(
  entries: readonly DeadLetterEntry[],
  reservations: readonly ParentDecisionReservationRecord[],
): readonly QuarantinedAnnouncement[] {
  return [
    ...entries.map((entry): QuarantinedAnnouncement => ({
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
    })),
    ...reservations.map((record): QuarantinedAnnouncement => ({
      id: record.id,
      kind: "parent_decision" as const,
      runId: record.runId,
      agentId: record.agentId,
      channelType: record.channelType,
      channelId: record.channelId,
      ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
      failedAt: record.failedAt,
      // A reservation is parked awaiting adjudication, never retried, so it has
      // no attempt history to report.
      attemptCount: 0,
      idempotencyKey: record.idempotencyKey,
      announcementChars: record.announcementText.length,
    })),
  ].sort((left, right) => left.failedAt - right.failedAt || left.id.localeCompare(right.id));
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
  readonly logger?: QuarantineLogger;
  readonly persist: (
    entries: readonly DeadLetterEntry[],
    reservations: readonly ParentDecisionReservationRecord[],
  ) => Promise<Result<void, Error>>;
}): Promise<Result<boolean, Error>> {
  const entry = input.entries.find((candidate) => candidate.id === input.id);
  const reservation = input.reservations.find((candidate) => candidate.id === input.id);
  if (entry === undefined && reservation === undefined) return ok(false);

  const nextEntries = input.entries.filter((candidate) => candidate.id !== input.id);
  const nextReservations = input.reservations.filter((candidate) => candidate.id !== input.id);
  const persisted = await input.persist(nextEntries, nextReservations);
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
      runId: entry?.runId ?? reservation?.runId,
      kind: entry !== undefined ? "entry" : "parent_decision",
      outcome: input.outcome,
      remaining: nextEntries.length + nextReservations.length,
    },
    "Quarantined announcement released by operator decision",
  );
  return ok(true);
}
