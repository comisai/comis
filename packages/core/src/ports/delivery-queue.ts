// SPDX-License-Identifier: Apache-2.0
/**
 * DeliveryQueuePort -- hexagonal architecture boundary for crash-safe delivery.
 *
 * Provides persistence for outbound messages so they survive daemon crashes.
 * A platform call is never blindly replayed: drainers atomically claim pending
 * rows, and an interrupted in-flight row is parked because its remote outcome
 * cannot be reconstructed from local state.
 *
 * The createNoOpDeliveryQueue() factory lives at ../delivery/no-op-delivery-queue.ts;
 * this file is type-only.
 *
 * @module
 */

import type { Result } from "@comis/shared";

/**
 * Per-status count breakdown for delivery queue observability.
 */
export interface DeliveryQueueStatusCounts {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly delivered: number;
  readonly expired: number;
}

/**
 * A delivery queue entry representing a single outbound message.
 *
 * All fields are readonly -- mutations happen via port methods (ack/nack/fail).
 */
export interface DeliveryQueueEntry {
  readonly id: string;
  readonly text: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly tenantId: string;
  /** Serialized DeliverToChannelOptions */
  readonly optionsJson: string;
  readonly origin: string;
  readonly status: "pending" | "in_flight" | "delivered" | "failed" | "expired";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly expireAt: number;
  readonly lastAttemptAt: number | null;
  readonly nextRetryAt: number | null;
  /** Fixed content-free outcome category; never a raw SDK/platform error. */
  readonly lastError: string | null;
  readonly traceId: string | null;
}

/**
 * Fields supplied by the caller when enqueuing a message.
 * The queue assigns id, status, attemptCount, and retry/error fields automatically.
 */
export type DeliveryQueueEnqueueInput = Omit<
  DeliveryQueueEntry,
  "id" | "status" | "attemptCount" | "lastAttemptAt" | "nextRetryAt" | "lastError"
>;

/**
 * DeliveryQueuePort: persistence boundary for outbound message durability.
 *
 * Adapters: SqliteDeliveryQueueAdapter (@comis/memory),
 *           NoOpDeliveryQueue (createNoOpDeliveryQueue in ../delivery/no-op-delivery-queue.ts).
 */
export interface DeliveryQueuePort {
  /**
   * Persist a new outbound message in the queue.
   * @returns The assigned entry ID on success.
   */
  enqueue(entry: DeliveryQueueEnqueueInput): Promise<Result<string, Error>>;

  /**
   * Enqueue a new outbound message with status='in_flight'.
   *
   * Used by the channel-side synchronous-send path: insert as 'in_flight' so the
   * recurring drainer's `WHERE status='pending'` filter does not race-pick the row
   * mid-send. Same semantics as enqueue() except for the initial status.
   * On crash, the startup sweep parks these rows as failed because the platform
   * may already have accepted the message.
   *
   * Emits delivery:enqueued (same event as enqueue()) -- universal observability.
   *
   * @returns The assigned entry ID on success.
   */
  enqueueInFlight(entry: DeliveryQueueEnqueueInput): Promise<Result<string, Error>>;

  /**
   * Atomically claim one due pending row for a platform attempt.
   *
   * The adapter performs a compare-and-swap (`pending` -> `in_flight`). A false
   * result means another drainer already owns the row or it is no longer due.
   * Callers must not invoke the platform unless this returns true.
   */
  claim(id: string): Promise<Result<boolean, Error>>;

  /**
   * Mark an entry as successfully delivered.
   * @param id - The queue entry ID
   * @param messageId - The platform-assigned message ID
   */
  ack(id: string, messageId: string): Promise<Result<void, Error>>;

  /**
   * Record a transient failure and schedule a retry.
   * @param id - The queue entry ID
   * @param error - Fixed content-free rejection category
   * @param nextRetryAt - Epoch ms for next retry attempt
   */
  nack(id: string, error: string, nextRetryAt: number): Promise<Result<void, Error>>;

  /**
   * Mark an entry as permanently failed (no more retries).
   * @param id - The queue entry ID
   * @param error - Fixed content-free terminal outcome category
   */
  fail(id: string, error: string): Promise<Result<void, Error>>;

  /**
   * Retrieve all pending entries ready for delivery (scheduled_at and any
   * retry deadline are both <= now).
   * Ordered by created_at ASC (oldest first).
   */
  pendingEntries(): Promise<Result<DeliveryQueueEntry[], Error>>;

  /**
   * Retrieve every NOT-yet-delivered entry -- any row whose status is not
   * 'delivered' (pending / in_flight / failed / expired), regardless of
   * scheduled_at.
   *
   * Distinct from pendingEntries(): that query is drainer-scoped ("what is due
   * to send right now"), so it intentionally hides in_flight rows for race
   * safety. This query is the inverse -- "what has NOT been confirmed delivered
   * yet" -- consumed by the MCP resources/read CONFIRMED-only filter so an
   * in-flight / failed / future-scheduled outbound message is never reported as
   * confirmed and leaked to an MCP client.
   */
  unconfirmedEntries(): Promise<Result<DeliveryQueueEntry[], Error>>;

  /**
   * Remove expired entries that were never delivered.
   * @returns The number of entries pruned.
   */
  pruneExpired(): Promise<Result<number, Error>>;

  /**
   * Per-status count breakdown for observability.
   * @param channelType - Optional filter to restrict counts to a specific channel.
   */
  statusCounts(channelType?: string): Promise<Result<DeliveryQueueStatusCounts, Error>>;

  /**
   * Park all rows with status='in_flight' as failed with a fixed, content-free
   * uncertainty reason.
   *
   * Called once at daemon startup before the startup drain. A prior process may
   * have crashed after the platform accepted the message but before ack(), so
   * replaying a stale row could duplicate an irreversible outward effect.
   *
   * @returns The number of rows parked (transitioned in_flight -> failed).
   */
  recoverInFlight(): Promise<Result<number, Error>>;
}
