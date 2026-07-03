// SPDX-License-Identifier: Apache-2.0
/**
 * Discord reaction-add binder.
 *
 * Co-located out of discord-adapter.ts to hold the 800-line file-size cap
 * (the adapter only keeps the `reactionHandlers` array + the bind call + the
 * `onReaction` registration). This module owns the single
 * `Events.MessageReactionAdd` listener — Comis's inbound-reaction capture
 * point. The Discord client ALREADY holds the
 * `GuildMessageReactions`/`DirectMessageReactions` intents (discord-adapter.ts:92-93).
 *
 * Posture (mirrors the MessageCreate binder at discord-adapter.ts:142):
 * - bot-own filter: `user.bot` reactions are skipped (the reaction-surface
 *   analogue of `msg.author.bot`).
 * - PARTIAL guard: discord.js v14 delivers a PARTIAL reaction for an uncached
 *   message; `reaction.fetch()` must resolve it before `messageId`/`emoji` can
 *   be read. A failed fetch is a NON-FATAL skip.
 * - fire-and-forget fanout: every handler is `void Promise.resolve(...).catch()`ed
 *   so one throwing handler never crashes the gateway event loop.
 *
 * The reactorId is UNTRUSTED inbound (an arbitrary chat sender); no trust is
 * assigned here — the binder only normalizes to {@link NormalizedReaction} and
 * fans out. Trust + the messageId→trajectory resolve happen daemon-side.
 *
 * @module
 */

import type { ComisLogger, NormalizedReaction, ReactionHandler } from "@comis/core";
import {
  type Client,
  Events,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

/** Log a non-fatal reaction-handler failure (sync throw or rejected promise). */
function warnHandlerFailed(logger: ComisLogger, handlerErr: unknown): void {
  logger.warn(
    {
      channelType: "discord",
      errorKind: "platform" as const,
      err: handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)),
      hint: "Discord reaction handler threw; reaction dropped (non-fatal)",
    },
    "Reaction handler failed",
  );
}

/**
 * Register the `MessageReactionAdd` listener on `client`. Every non-bot
 * reaction-add on a (cached or fetch-resolved) message mints a
 * NormalizedReaction and is dispatched to each handler in `reactionHandlers`.
 *
 * @param client - the discord.js Client (intents already include reactions)
 * @param reactionHandlers - the live handler array the adapter pushes onReaction handlers onto
 * @param logger - adapter logger for the non-fatal handler-failure WARN branch
 */
export function bindDiscordReactions(
  client: Client,
  reactionHandlers: ReactionHandler[],
  logger: ComisLogger,
): void {
  client.on(
    Events.MessageReactionAdd,
    async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
    ) => {
      // Bot-own filter — never count the bot's own reactions (mirror msg.author.bot).
      if (user.bot) {
        return;
      }

      // discord.js v14: a reaction on an uncached message arrives PARTIAL; the
      // emoji/messageId fields require reaction.fetch() first. A failed fetch
      // is a non-fatal skip (the message is gone / unreadable) — never throw.
      let resolved: MessageReaction | PartialMessageReaction = reaction;
      if (reaction.partial) {
        const fetched = await reaction.fetch().catch(() => undefined);
        if (!fetched) {
          return;
        }
        resolved = fetched;
      }

      const normalized: NormalizedReaction = {
        messageId: resolved.message.id,
        // SAME identity space as senderId (author.id) — what the trust resolver
        // + rate limiter key on downstream.
        reactorId: user.id,
        emoji: resolved.emoji.name ?? resolved.emoji.toString(),
        channelType: "discord",
        channelId: resolved.message.channelId,
      };

      for (const handler of reactionHandlers) {
        // Wrap in try/catch as well as .catch so a SYNCHRONOUS throw from a
        // handler is non-fatal too (a sync throw escapes Promise.resolve()
        // because handler() runs before the promise wraps it).
        try {
          void Promise.resolve(handler(normalized)).catch((handlerErr: unknown) =>
            warnHandlerFailed(logger, handlerErr),
          );
        } catch (handlerErr) {
          warnHandlerFailed(logger, handlerErr);
        }
      }
    },
  );
}
