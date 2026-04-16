/**
 * DeliveryQueuePort -- hexagonal architecture boundary for crash-safe delivery.
 *
 * Provides persistence for outbound messages so they survive daemon crashes.
 * The queue uses at-least-once delivery semantics: messages are enqueued before
 * send, acknowledged on success, and retried on failure.
 *
 * Crash-Safe Delivery Queue.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";

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
  readonly formatApplied: boolean;
  readonly chunkingApplied: boolean;
  readonly status: "pending" | "in_flight" | "delivered" | "failed" | "expired";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly expireAt: number;
  readonly lastAttemptAt: number | null;
  readonly nextRetryAt: number | null;
  readonly lastError: string | null;
  readonly markdownFallbackApplied: boolean;
  readonly deliveredMessageId: string | null;
  readonly traceId: string | null;
}

/**
 * Fields supplied by the caller when enqueuing a message.
 * The queue assigns id, status, attemptCount, and retry/error fields automatically.
 */
export type DeliveryQueueEnqueueInput = Omit<
  DeliveryQueueEntry,
  "id" | "status" | "attemptCount" | "lastAttemptAt" | "nextRetryAt" | "lastError" | "markdownFallbackApplied" | "deliveredMessageId"
>;

/**
 * DeliveryQueuePort: persistence boundary for outbound message durability.
 *
 * Adapters: SqliteDeliveryQueueAdapter (@comis/memory), NoOpDeliveryQueue (below).
 */
export interface DeliveryQueuePort {
  /**
   * Persist a new outbound message in the queue.
   * @returns The assigned entry ID on success.
   */
  enqueue(entry: DeliveryQueueEnqueueInput): Promise<Result<string, Error>>;

  /**
   * Mark an entry as successfully delivered.
   * @param id - The queue entry ID
   * @param messageId - The platform-assigned message ID
   */
  ack(id: string, messageId: string): Promise<Result<void, Error>>;

  /**
   * Record a transient failure and schedule a retry.
   * @param id - The queue entry ID
   * @param error - Error description
   * @param nextRetryAt - Epoch ms for next retry attempt
   */
  nack(id: string, error: string, nextRetryAt: number): Promise<Result<void, Error>>;

  /**
   * Mark an entry as permanently failed (no more retries).
   * @param id - The queue entry ID
   * @param error - Error description
   */
  fail(id: string, error: string): Promise<Result<void, Error>>;

  /**
   * Retrieve all pending entries ready for delivery (scheduled_at <= now).
   * Ordered by created_at ASC (oldest first).
   */
  pendingEntries(): Promise<Result<DeliveryQueueEntry[], Error>>;

  /**
   * Remove expired entries that were never delivered.
   * @returns The number of entries pruned.
   */
  pruneExpired(): Promise<Result<number, Error>>;

  /**
   * Count of entries in active states (pending + in_flight).
   */
  depth(): Promise<Result<number, Error>>;

  /**
   * Per-status count breakdown for observability.
   * @param channelType - Optional filter to restrict counts to a specific channel.
   */
  statusCounts(channelType?: string): Promise<Result<DeliveryQueueStatusCounts, Error>>;
}

/**
 * No-op delivery queue for when the queue feature is disabled.
 *
 * All operations succeed immediately with no persistence.
 * enqueue returns a random UUID, ack/nack/fail return void,
 * pendingEntries returns [], pruneExpired/depth return 0.
 */
export function createNoOpDeliveryQueue(): DeliveryQueuePort {
  return Object.freeze({
    enqueue: () => Promise.resolve(ok(randomUUID())),
    ack: () => Promise.resolve(ok(undefined)),
    nack: () => Promise.resolve(ok(undefined)),
    fail: () => Promise.resolve(ok(undefined)),
    pendingEntries: () => Promise.resolve(ok([] as DeliveryQueueEntry[])),
    pruneExpired: () => Promise.resolve(ok(0)),
    depth: () => Promise.resolve(ok(0)),
    statusCounts: () => Promise.resolve(ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 })),
  });
}
