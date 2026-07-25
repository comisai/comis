// SPDX-License-Identifier: Apache-2.0
/**
 * DeliveryMirrorPort -- hexagonal architecture boundary for session mirroring.
 *
 * Provides persistence for delivered messages so they can be injected into
 * the agent's prompt on subsequent turns. This enables the agent to "see"
 * messages it sent to other channels/sessions, creating cross-session awareness.
 *
 * The createNoOpDeliveryMirror() factory lives at
 * ../delivery/no-op-delivery-mirror.ts; this file is type-only.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { ChannelEndpoint, ConversationRef } from "../domain/conversation-scope.js";
import type { DeliveryAuthority } from "./delivery-queue.js";

/**
 * A delivery mirror entry representing a single delivered message recorded
 * for later prompt injection.
 *
 * All fields are readonly -- mutations happen via port methods
 * (acknowledge/clearSession/pruneOld).
 */
export interface DeliveryMirrorEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly conversationRef: ConversationRef;
  readonly destinationEndpoint: ChannelEndpoint;
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
  readonly tenantId: string;
  readonly agentId: string;
  readonly conversationRef: ConversationRef;
  readonly destinationEndpoint: ChannelEndpoint;
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
 * Adapters: SqliteDeliveryMirrorAdapter (@comis/memory),
 *           NoOpDeliveryMirror (createNoOpDeliveryMirror in ../delivery/no-op-delivery-mirror.ts).
 */
export interface DeliveryMirrorPort {
  /**
   * Record a delivered message in the mirror.
   * Duplicate entries with the same idempotency key are silently ignored.
   * @returns The assigned entry ID on success.
   */
  record(entry: DeliveryMirrorRecordInput): Promise<Result<string, Error>>;

  /**
   * Retrieve all pending entries for one exact conversation authority.
   * Ordered by created_at ASC (oldest first).
   * @param authority - Exact tenant, agent, and opaque conversation authority
   */
  pending(authority: DeliveryAuthority): Promise<Result<DeliveryMirrorEntry[], Error>>;

  /**
   * Mark entries as acknowledged (injected into prompt).
   * Acknowledged entries no longer appear in pending() results.
   * @param ids - Array of entry IDs to acknowledge
   */
  acknowledge(ids: string[]): Promise<Result<void, Error>>;

  /**
   * Permanently remove every mirror entry for one exact conversation authority.
   * Session lifecycle operations use this before clearing transcript stores
   * so pending outbound text cannot be injected after reset or key reuse.
   * @param authority - Exact tenant, agent, and opaque conversation authority
   * @returns The number of entries deleted.
   */
  clearSession(authority: DeliveryAuthority): Promise<Result<number, Error>>;

  /**
   * Remove entries older than maxAgeMs from the mirror.
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns The number of entries pruned.
   */
  pruneOld(maxAgeMs: number): Promise<Result<number, Error>>;
}
