// SPDX-License-Identifier: Apache-2.0
/** Type-only port for durable completion-announcement recovery. */

import type { Result } from "@comis/shared";
import type { ChannelEndpoint } from "../domain/conversation-scope.js";
import type { DeliveryAuthority } from "./delivery-queue.js";

/** Channel contribution identifier. Open because deployments can register channels. */
export type AnnouncementChannelType = string;

interface AnnouncementDeadLetterDeliveryOptions {
  readonly threadId?: string;
  readonly extra?: Record<string, unknown>;
  readonly authority?: DeliveryAuthority;
  readonly destinationEndpoint?: ChannelEndpoint;
}

export interface AnnouncementDeadLetterAttachmentSource {
  readonly kind: "source";
  readonly sourceAgentId: string;
  readonly path: string;
}

export interface AnnouncementDeadLetterAttachmentSnapshot {
  readonly kind: "snapshot";
  readonly sourceAgentId: string;
  readonly sourcePath: string;
  readonly path: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly contentDigest: string;
  readonly sizeBytes: number;
}

export type AnnouncementDeadLetterAttachment =
  | AnnouncementDeadLetterAttachmentSource
  | AnnouncementDeadLetterAttachmentSnapshot;

export type AnnouncementTextChunkManifest = readonly string[];

/** Failed completion admitted to durable delivery recovery. */
export interface AnnouncementDeadLetterEntryInput {
  announcementText: string;
  channelType: AnnouncementChannelType;
  channelId: string;
  agentId?: string;
  runId: string;
  sessionKey: string;
  failedAt: number;
  attemptCount: number;
  lastError?: string;
  threadId?: string;
  extra?: Record<string, unknown>;
  idempotencyKey?: string;
  rootRunId?: string;
  stepIndex?: number;
  /** Canonical conversation authority retained for delivery mirroring. */
  deliveryAuthority?: DeliveryAuthority;
  /** Immutable destination retained with the failed platform operation. */
  destinationEndpoint?: ChannelEndpoint;
  /** Exact generated file owned by this irreversible operation. */
  attachment?: AnnouncementDeadLetterAttachment;
  /** Stable operation discriminator used by the outward ledger. */
  partId?: string;
  /** Completion keys settled only after every related operation resolves. */
  completionKeys?: readonly string[];
  textChunks?: AnnouncementTextChunkManifest;
}

/** Persisted form of a failed completion. */
export interface AnnouncementDeadLetterEntry extends AnnouncementDeadLetterEntryInput {
  id: string;
  lastAttemptAt: number;
}

/** Durable ownership record written before a parent rewrite is attempted. */
export interface AnnouncementParentDecisionReservation {
  idempotencyKey: string;
  agentId: string;
  runId: string;
  sessionKey: string;
  announcementText: string;
  channelType: AnnouncementChannelType;
  channelId: string;
  failedAt: number;
  threadId?: string;
  extra?: Record<string, unknown>;
  rootRunId: string;
  deliveryAuthority: DeliveryAuthority;
  destinationEndpoint: ChannelEndpoint;
  /** Exact generated file owned by this irreversible operation. */
  attachment?: AnnouncementDeadLetterAttachment;
  /** Stable operation discriminator used by the outward ledger. */
  partId?: string;
  /** Completion keys settled only after every related operation resolves. */
  completionKeys: readonly string[];
  textChunks?: AnnouncementTextChunkManifest;
}

export interface AnnouncementParentDecisionReservationRecord
  extends AnnouncementParentDecisionReservation {
  recordType: "parent_decision_reservation";
  id: string;
}

/** Content-free operator projection of a retained delivery. */
export interface QuarantinedDeliveryAnnouncement {
  readonly id: string;
  readonly kind: "entry" | "parent_decision";
  readonly runId: string;
  readonly agentId?: string;
  readonly channelType: AnnouncementChannelType;
  readonly channelId: string;
  readonly threadId?: string;
  readonly failedAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
  readonly idempotencyKey?: string;
  readonly announcementChars: number;
}

/** Content-free operator projection of a persisted row that cannot be replayed. */
export interface QuarantinedInvalidAnnouncementRecord {
  readonly id: string;
  readonly kind: "invalid_record";
  readonly reason: "invalid_json" | "schema_mismatch" | "oversized_row";
  readonly sourceLine: number;
  readonly detectedAt: number;
  readonly rawDigest: string;
  readonly rawBytes: number;
}

export type QuarantinedAnnouncement =
  | QuarantinedDeliveryAnnouncement
  | QuarantinedInvalidAnnouncementRecord;

export type QuarantineReleaseOutcome = "delivered" | "discarded";

export interface AnnouncementDeadLetterStatus {
  readonly activeRecoveryCount: number;
  readonly quarantinedCount: number;
}

/**
 * Durable completion-delivery recovery boundary shared by producers and the
 * orchestrator adapter.
 */
export interface AnnouncementDeadLetterQueuePort {
  enqueue(entry: AnnouncementDeadLetterEntryInput): Promise<Result<void, Error>>;
  beginDeliveryAttempt(
    entry: AnnouncementDeadLetterEntryInput,
  ): Promise<Result<{ claimed: boolean }, Error>>;
  settleDeliveryAttempt(
    idempotencyKey: string,
    outcome: "accepted" | "rejected" | "unknown",
  ): Promise<Result<boolean, Error>>;
  reserveDecision(
    entry: AnnouncementParentDecisionReservation,
  ): Promise<Result<{ created: boolean }, Error>>;
  lookupDecision(
    idempotencyKey: string,
  ): Promise<Result<AnnouncementParentDecisionReservation | undefined, Error>>;
  resolveDecision(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>>;
  recordDecisionTextChunks(
    idempotencyKey: string,
    chunks: AnnouncementTextChunkManifest,
  ): Promise<Result<void, Error>>;
  /** Atomically replace rewrite reservations with the actual outward operations. */
  replaceDecisions(
    expectedKeys: readonly string[],
    operations: readonly AnnouncementParentDecisionReservation[],
  ): Promise<Result<{ created: boolean }, Error>>;
  drain(
    sendToChannel: (
      type: AnnouncementChannelType,
      id: string,
      text: string,
      options?: AnnouncementDeadLetterDeliveryOptions,
    ) => Promise<boolean>,
    onDelivered?: (idempotencyKey: string) => void,
  ): Promise<void>;
  durableStatus(): Promise<Result<AnnouncementDeadLetterStatus, Error>>;
  size(): number;
  listQuarantined(): Promise<Result<readonly QuarantinedAnnouncement[], Error>>;
  release(
    id: string,
    outcome: QuarantineReleaseOutcome,
  ): Promise<Result<boolean, Error>>;
}
