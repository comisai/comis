// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix reaction binder — the pure inbound-reaction mapper.
 *
 * A reaction arrives on the `/sync` timeline as its own `m.reaction` event whose
 * `m.relates_to` annotation names the reacted-to event and carries the emoji as
 * the literal `key`. Matrix has NO closed reaction vocabulary — the `key` IS the
 * emoji — so, unlike platforms with a fixed reaction set, there is no type→emoji
 * map here; the key passes straight through.
 *
 * This is a PURE transform: an `m.reaction` {@link MatrixEvent} to a
 * {@link NormalizedReaction}, with no SDK client and no closure. The fan-out over
 * the registered handlers lives in the adapter alongside the message fan-out.
 *
 * The reactor id is UNTRUSTED federated data; no trust is assigned here. The
 * reaction is minted through {@link parseReaction} so its `z.strictObject`
 * rejects any smuggled field and its `z.string().min(1)` rejects an absent,
 * empty, or non-string reactor / target / emoji — the schema is the boundary.
 *
 * @module
 */

import type { MatrixEvent, Room } from "matrix-js-sdk";
import type { NormalizedReaction } from "@comis/core";
import { parseReaction } from "@comis/core";

/** The Matrix event type that carries a reaction annotation. */
const REACTION_EVENT_TYPE = "m.reaction";

/**
 * Map an inbound `m.reaction` timeline event to a NormalizedReaction.
 *
 * Returns null for a non-reaction event, an event whose relation envelope is
 * absent or not an object, or any reaction the strict schema rejects (an absent
 * or empty reactor MXID / reacted-to event id / emoji, or a non-string smuggled
 * where a string is required) — the caller skips those.
 *
 * @param event - An inbound `matrix-js-sdk` timeline event (untrusted).
 * @param room - The room the reaction arrived in; its id is the channelId.
 * @returns A validated NormalizedReaction, or null to skip.
 */
export function mapMatrixReaction(event: MatrixEvent, room: Room): NormalizedReaction | null {
  if (event.getType() !== REACTION_EVENT_TYPE) return null;

  const relatesTo = (event.getContent() as { "m.relates_to"?: unknown })["m.relates_to"];
  if (typeof relatesTo !== "object" || relatesTo === null) return null;
  const relation = relatesTo as { event_id?: unknown; key?: unknown };

  // Mint through parseReaction: the reactor MXID, reacted-to event id, and emoji
  // are all untrusted federated values, so the strict schema — not an inline
  // guard — is the authoritative boundary. getSender() is string|null and the
  // relation fields are unknown; the schema rejects null / undefined / empty /
  // non-string in one place.
  const parsed = parseReaction({
    messageId: relation.event_id,
    reactorId: event.getSender(),
    emoji: relation.key,
    channelType: "matrix",
    channelId: room.roomId,
  });
  return parsed.ok ? parsed.value : null;
}
