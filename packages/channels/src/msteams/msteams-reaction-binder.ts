// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams reaction binder — the pure inbound-reaction mapper.
 *
 * Teams has no live SDK reaction callback: reactions arrive as
 * `messageReaction` activities pushed through the same webhook the message path
 * uses. So this file carries only the PURE transform — a `messageReaction`
 * activity to a {@link NormalizedReaction} — while the fan-out loop over the
 * registered handlers lives in the adapter alongside the message fan-out.
 *
 * The reactor id is UNTRUSTED inbound data; no trust is assigned here. The
 * reaction is minted through {@link parseReaction} so its `z.strictObject`
 * rejects any smuggled field (e.g. a trust/authority claim) before it leaves
 * the adapter.
 *
 * @module
 */

import type { NormalizedReaction } from "@comis/core";
import { parseReaction } from "@comis/core";
import type { TeamsActivity } from "./message-mapper.js";

/**
 * A Bot Framework `messageReaction` activity — the shared {@link TeamsActivity}
 * shape plus the reaction list that only reaction activities carry. Additive:
 * the message path never reads `reactionsAdded`.
 */
export interface TeamsReactionActivity extends TeamsActivity {
  reactionsAdded?: ReadonlyArray<{ type: string }>;
}

/**
 * The closed set of Teams reaction types mapped to their Unicode emoji. A type
 * outside this set is skipped (no reaction is surfaced).
 */
const REACTION_EMOJI: Record<string, string> = {
  like: "👍",
  heart: "❤️",
  laugh: "😆",
  surprised: "😮",
  sad: "😢",
  angry: "😡",
};

/** Resolve a reaction type to its emoji via the closed map, or undefined. */
function reactionEmoji(type: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against a literal closed record
  return Object.hasOwn(REACTION_EMOJI, type) ? REACTION_EMOJI[type] : undefined;
}

/**
 * Strip a trailing ";messageid=…" reply suffix from a conversation id so the
 * reaction's channelId matches the id the message mapper produces.
 */
function stripMessageIdSuffix(conversationId: string): string {
  const idx = conversationId.indexOf(";messageid=");
  return idx >= 0 ? conversationId.slice(0, idx) : conversationId;
}

/**
 * Map a Bot Framework `messageReaction` activity to a NormalizedReaction.
 *
 * Returns null for a non-reaction activity, an empty/unknown reaction type, or
 * an activity missing a reaction target or reactor — the adapter skips those.
 *
 * @param activity - A Bot Framework inbound activity
 * @returns A validated NormalizedReaction, or null to skip
 */
export function mapMsTeamsReaction(activity: TeamsReactionActivity): NormalizedReaction | null {
  if (activity.type !== "messageReaction") return null;

  const reactionType = activity.reactionsAdded?.[0]?.type;
  if (reactionType === undefined) return null;

  const emoji = reactionEmoji(reactionType);
  if (emoji === undefined) return null;

  const messageId = activity.replyToId ?? activity.id;
  if (messageId === undefined) return null;

  const reactorId = activity.from?.aadObjectId ?? activity.from?.id;
  if (reactorId === undefined) return null;

  const parsed = parseReaction({
    messageId,
    reactorId,
    emoji,
    channelType: "msteams",
    channelId: stripMessageIdSuffix(activity.conversation.id),
  });
  return parsed.ok ? parsed.value : null;
}
