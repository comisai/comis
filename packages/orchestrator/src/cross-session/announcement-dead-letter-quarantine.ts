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

import type { ChannelType, DeadLetterEntry, ParentDecisionReservationRecord } from "./announcement-dead-letter-file.js";

/**
 * One quarantined announcement, as an operator sees it.
 *
 * Content-free by construction: the announcement's LENGTH is carried, never its
 * text. These rows ride an admin RPC and a terminal, and the announcement is
 * quarantined precisely because it was NOT delivered to its intended reader —
 * an operator deciding its fate needs the route and the reason, not the message.
 */
export interface QuarantinedAnnouncement {
  readonly id: string;
  /** `entry` — a failed delivery. `parent_decision` — a parked adjudication. */
  readonly kind: "entry" | "parent_decision";
  readonly runId: string;
  readonly agentId?: string;
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly threadId?: string;
  readonly failedAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  /** Why it is parked (e.g. `outward_operation_unresolved`). */
  readonly lastError?: string;
  readonly idempotencyKey?: string;
  /** Size of the withheld announcement text, in characters. */
  readonly announcementChars: number;
}

/** What an operator decided about a quarantined announcement. */
export type QuarantineReleaseOutcome = "delivered" | "discarded";


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
