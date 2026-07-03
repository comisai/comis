// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * NormalizedReaction: Channel-agnostic representation of an inbound reaction.
 *
 * The reaction-capable adapters (Discord/Slack/Telegram) convert their native
 * reaction-add event into this shape before it reaches core logic — the sibling
 * of {@link NormalizedMessage} for the reaction surface. Adapters whose platform
 * exposes no reactor-id (iMessage/LINE/IRC/Email/Echo) never produce one.
 *
 * UNTRUSTED inbound data: this type carries NO trust/authority field — only the
 * platform ids, the emoji, and the channel. Trust is resolved downstream from
 * config (the daemon wiring), never asserted by the reaction. A reaction
 * can only WEIGHT learning, never write content or raise trust.
 *
 * SECURITY: `z.strictObject` is load-bearing — it rejects smuggled fields
 * (e.g. a `trustLevel`/`source` promotion claim) at {@link parseReaction}.
 */
export const NormalizedReactionSchema = z.strictObject({
  /** Platform id of the message that was reacted to (NOT a UUID — Discord snowflake / Telegram numeric / Slack ts). */
  messageId: z.string().min(1),
  /** Platform id of the reacting user. SAME identity space as NormalizedMessage.senderId — what the trust resolver + rate limiter key on. */
  reactorId: z.string().min(1),
  /** The reaction emoji (Unicode for Discord/Telegram; Slack delivers a short name e.g. "thumbsup" — mapped at the adapter). */
  emoji: z.string().min(1),
  /** Channel platform (discord/slack/telegram). */
  channelType: z.string().min(1),
  /** Platform channel/chat id the reaction occurred in. */
  channelId: z.string().min(1),
});

export type NormalizedReaction = z.infer<typeof NormalizedReactionSchema>;

/**
 * Parse unknown input into a NormalizedReaction, returning Result<T, ZodError>.
 *
 * The input is untrusted platform data — `z.strictObject` rejects any field the
 * reactor smuggled in, and the ids are `z.string().min(1)` (platform ids
 * are not UUIDs, but an empty id is never valid).
 */
export function parseReaction(raw: unknown): Result<NormalizedReaction, z.ZodError> {
  const result = NormalizedReactionSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}
