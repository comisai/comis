// SPDX-License-Identifier: Apache-2.0
/**
 * Discord channel narrowing — runtime methods we use that discord.js types
 * either omit or under-narrow for the polymorphic `Channel | null` return of
 * `client.channels.fetch()`.
 *
 * The interface is a STRUCTURAL subset of discord.js's actual runtime shape;
 * it does NOT add fields. All methods listed here exist on TextChannel,
 * NewsChannel, ThreadChannel, DMChannel, and forum threads in discord.js 14.x.
 *
 * NOTE: discord.js is exact-pinned at 14.26.4 (CLAUDE.md "Supply-chain
 * invariants"). A future minor/major bump must verify the listed runtime
 * methods still exist on the polymorphic Channel union.
 *
 * Anti-pattern reminder (41-RESEARCH §"Anti-Patterns" line 425): this file
 * does NOT import @comis/shared's `Result`. `asTextLike` is a typed-cast
 * utility, not a fallible computation; `null` is the right "not text-like"
 * signal that callers handle.
 *
 * @module
 */

import type {
  AnyThreadChannel,
  GuildBasedChannel,
  TextBasedChannel,
  MessageManager,
  ThreadManager,
  Message,
} from "discord.js";

/**
 * Structural subset of a Discord text-like channel covering the runtime
 * methods used by `discord-actions.ts` (pin/unpin/send/edit/delete/setTopic/
 * setRateLimitPerUser/sendTyping/threads.*).
 *
 * Plan 41-05 (TS-HYG-06) imports this to eliminate the 18 `as any` casts
 * in `discord-actions.ts`.
 */
export interface DiscordTextLikeChannel {
  readonly id: string;
  readonly type: number;
  readonly messages: MessageManager;
  setTopic(topic: string, reason?: string): Promise<unknown>;
  setRateLimitPerUser(rateLimitPerUser: number, reason?: string): Promise<unknown>;
  send(payload: Record<string, unknown> | string): Promise<Message>;
  edit(options: Record<string, unknown>): Promise<unknown>;
  delete(reason?: string): Promise<unknown>;
  sendTyping(): Promise<void>;
  /** Present only on text channels that support threads; undefined elsewhere. */
  readonly threads?: ThreadManager;
}

/**
 * Narrow a discord.js channel to `DiscordTextLikeChannel`. Returns `null`
 * if the channel is `null`, lacks an `isTextBased()` method, or
 * `isTextBased()` returns falsy.
 *
 * The cast `channel as unknown as DiscordTextLikeChannel` is gated by the
 * runtime guards above — a forged object would have to satisfy both the
 * function-presence and `isTextBased() === true` checks to slip through,
 * and underlying discord.js API calls would still fail at the SDK boundary.
 */
export function asTextLike(
  channel: AnyThreadChannel | GuildBasedChannel | TextBasedChannel | null,
): DiscordTextLikeChannel | null {
  if (!channel) return null;
  if (typeof (channel as { isTextBased?: () => boolean }).isTextBased !== "function") return null;
  if (!(channel as { isTextBased: () => boolean }).isTextBased()) return null;
  return channel as unknown as DiscordTextLikeChannel;
}
