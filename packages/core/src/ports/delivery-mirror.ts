/**
 * DeliveryMirrorPort -- hexagonal architecture boundary for session mirroring.
 *
 * Provides persistence for delivered messages so they can be injected into
 * the agent's prompt on subsequent turns. This enables the agent to "see"
 * messages it sent to other channels/sessions, creating cross-session awareness.
 *
 * Session Mirroring.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";

/**
 * A delivery mirror entry representing a single delivered message recorded
 * for later prompt injection.
 *
 * All fields are readonly -- mutations happen via port methods (acknowledge/pruneOld).
 */
export interface DeliveryMirrorEntry {
  readonly id: string;
  readonly sessionKey: string;
  readonly text: string;
  /** Media URLs stored as a JSON array string in the database, parsed as string[] in the domain. */
  readonly mediaUrls: string[];
  readonly channelType: string;
  readonly channelId: string;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly status: "pending" | "acknowledged";
  readonly createdAt: number;
  readonly acknowledgedAt: number | null;
}

/**
 * Fields supplied by the caller when recording a mirror entry.
 * The adapter assigns id, status, createdAt, and acknowledgedAt automatically.
 */
export interface DeliveryMirrorRecordInput {
  readonly sessionKey: string;
  readonly text: string;
  readonly mediaUrls: string[];
  readonly channelType: string;
  readonly channelId: string;
  readonly origin: string;
  readonly idempotencyKey: string;
}

/**
 * DeliveryMirrorPort: persistence boundary for session mirroring.
 *
 * Records delivered messages and retrieves pending (unacknowledged) entries
 * for prompt injection into agent context on subsequent turns.
 *
 * Adapters: SqliteDeliveryMirrorAdapter (@comis/memory), NoOpDeliveryMirror (below).
 */
export interface DeliveryMirrorPort {
  /**
   * Record a delivered message in the mirror.
   * Duplicate entries with the same idempotency key are silently ignored.
   * @returns The assigned entry ID on success.
   */
  record(entry: DeliveryMirrorRecordInput): Promise<Result<string, Error>>;

  /**
   * Retrieve all pending (unacknowledged) entries for a session.
   * Ordered by created_at ASC (oldest first).
   * @param sessionKey - The session key to filter by
   */
  pending(sessionKey: string): Promise<Result<DeliveryMirrorEntry[], Error>>;

  /**
   * Mark entries as acknowledged (injected into prompt).
   * Acknowledged entries no longer appear in pending() results.
   * @param ids - Array of entry IDs to acknowledge
   */
  acknowledge(ids: string[]): Promise<Result<void, Error>>;

  /**
   * Remove entries older than maxAgeMs from the mirror.
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns The number of entries pruned.
   */
  pruneOld(maxAgeMs: number): Promise<Result<number, Error>>;
}

/**
 * No-op delivery mirror for when the mirror feature is disabled.
 *
 * All operations succeed immediately with no persistence.
 * record returns a random UUID, pending returns [], acknowledge returns void,
 * pruneOld returns 0.
 */
export function createNoOpDeliveryMirror(): DeliveryMirrorPort {
  return Object.freeze({
    record: () => Promise.resolve(ok(randomUUID())),
    pending: () => Promise.resolve(ok([] as DeliveryMirrorEntry[])),
    acknowledge: () => Promise.resolve(ok(undefined)),
    pruneOld: () => Promise.resolve(ok(0)),
  });
}
