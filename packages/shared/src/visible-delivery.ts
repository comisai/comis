// SPDX-License-Identifier: Apache-2.0
/**
 * VisibleDeliveryRecord: structured metadata for outbound channel deliveries
 * captured in JSONL `details` for offline analysis (Phase 10 housekeeper consumes this).
 *
 * Persisted in `details.visibleDelivery` on `message(action='attach')` toolResult
 * entries; visible to operators inspecting JSONL but NOT injected back into the
 * model's context window across turns (R5 invariant 37, AC-8).
 *
 * Plain TypeScript interface (no Zod) per AGENTS §2.3 KISS — `@comis/shared`
 * has zero runtime deps, and this type is JSONL-persisted only (no port-bus
 * payload validation needed).
 *
 * @module
 */

/** Kind of visible delivery captured. Open-ended union for forward extensibility. */
export type VisibleDeliveryKind = "attachment" | "text" | "reaction";

export interface VisibleDeliveryRecord {
  /** What kind of delivery this records. */
  kind: VisibleDeliveryKind;
  /** Channel adapter that delivered (e.g., "telegram"). */
  channelType: string;
  /** Channel-specific identifier (e.g., user/group/peer id). */
  channelId: string;
  /** Human-readable caption for attachments; brief text for text/reaction. */
  caption?: string;
  /** Wall-clock millis when delivery completed (Date.now()). */
  deliveredAt: number;
}
