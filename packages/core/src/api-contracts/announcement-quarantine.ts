// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.quarantine.list` / `obs.quarantine.release` wire shapes — the
 * operator lever over quarantined background-task announcements.
 *
 * An uncertain announcement is held on purpose: nothing drains it, because
 * re-sending an announcement whose delivery could not be PROVEN risks telling a
 * user the same thing twice. A malformed storage row is held because it cannot
 * be safely replayed. The runtime surfaces either condition and waits for an
 * operator decision.
 *
 * Both are `admin`-only and carry no `rpc` route, which puts them in the
 * deny-by-origin control plane: an agent turn — including a prompt-injected one
 * — can never reach them. Releasing decides the fate of a message a user was
 * supposed to receive, which is an operator's call, not an agent's.
 *
 * The list rows are content-free: ids, route, timing, failure reason, and the
 * announcement's LENGTH. Never its text. The rows ride a terminal and an admin
 * RPC, and an operator deciding whether a reader was already informed needs the
 * route and the reason, not the message body.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

/**
 * One parked announcement as the wire carries it. Mirrors the orchestrator's
 * `QuarantinedAnnouncement` field-for-field; there is no announcement-text
 * field, structurally — only `announcementChars`.
 */
export interface QuarantinedDeliveryAnnouncementWire {
  id: string;
  kind: "entry" | "parent_decision";
  runId: string;
  agentId?: string;
  channelType: string;
  channelId: string;
  threadId?: string;
  failedAt: number;
  attemptCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  idempotencyKey?: string;
  announcementChars: number;
}

export interface QuarantinedInvalidAnnouncementWire {
  id: string;
  kind: "invalid_record";
  reason: "invalid_json" | "schema_mismatch" | "oversized_row";
  sourceLine: number;
  detectedAt: number;
  rawDigest: string;
  rawBytes: number;
}

export type QuarantinedAnnouncementWire =
  | QuarantinedDeliveryAnnouncementWire
  | QuarantinedInvalidAnnouncementWire;

/** List every quarantined announcement awaiting an operator decision. */
export const ObsQuarantineListContract = defineContract({
  method: "obs.quarantine.list",
  request: z.object({}),
  response: z.object({
    /** Oldest-first, so the longest-stuck item leads. */
    rows: z.array(z.record(z.string(), z.unknown())),
    /** Total parked items — equals `rows.length`; explicit so a caller that
     *  renders nothing still reports the count it was told. */
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * Record an operator's decision about one parked announcement and drop it.
 *
 * `delivered` — the reader already has it, verified out of band. `discarded` —
 * it is not worth sending. Both remove the item; the queue exists to hold an
 * UNDECIDED announcement, so either decision finishes it. The distinction is
 * kept for the audit trail, not for the queue.
 */
export const ObsQuarantineReleaseContract = defineContract({
  method: "obs.quarantine.release",
  request: z.object({
    /** The `id` from `obs.quarantine.list`. */
    id: z.string().min(1),
    outcome: z.enum(["delivered", "discarded"]),
  }),
  response: z.object({
    /** False when no parked item carries that id — a repeat release, not an
     *  error, so the caller can report "already gone" rather than fail. */
    released: z.boolean(),
    /** Items still parked after this decision. */
    remaining: z.number(),
  }),
  scopes: ["admin"] as const,
});
