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
 *
 * The `threads?` field combines the base `ThreadManager` (for `fetchActive()`)
 * with the create overload from `GuildTextThreadManager` (which extends
 * `ThreadManager<false>` and adds `create()`). Plan 41-05's `threadCreate`
 * action call site needs both methods on the same narrowed reference, and
 * the underlying discord.js types model them via the GuildTextThreadManager
 * subclass rather than the ThreadManager base — the structural intersection
 * captures both shapes in a single field type. The `create()` parameter
 * type is intentionally permissive (`Record<string, unknown>`) because the
 * action layer builds the payload defensively from RPC arguments.
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
  /**
   * Present only on text channels that support threads; undefined elsewhere.
   * `fetchActive()` lives on `ThreadManager` (base); `create()` lives on
   * `GuildTextThreadManager` (subclass) — see interface JSDoc for the
   * structural intersection rationale.
   */
  readonly threads?: ThreadManager & {
    create?(options: Record<string, unknown>): Promise<{ id: string; name: string }>;
  };
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

/**
 * Phase 41 TS-HYG-06 secondary shape — for the per-thread iteration sites
 * in `discord-actions.ts` `threadList` action (RESEARCH §"Discord `as any`
 * inventory" lines 223-231). The polymorphic iteration item from
 * `ThreadManager.fetchActive()` is typed loosely; this is a stricter
 * structural shape suitable for the read-only fields the action emits.
 */
export interface DiscordThreadInfo {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly memberCount: number;
  readonly messageCount: number;
}

/**
 * Narrow a per-thread iteration object to `DiscordThreadInfo`. Returns
 * `null` if any required field is missing or wrong-typed.
 *
 * The function is intentionally defensive — `fetchActive()` returns
 * differently-shaped objects across discord.js minor versions, and the
 * iteration site logs `archived ?? false` / `memberCount ?? 0` /
 * `messageCount ?? 0` defaults. Callers that want the lenient behavior
 * should fall back to `0` / `false` on `null` return per their own policy.
 */
export function asThreadInfo(thread: unknown): DiscordThreadInfo | null {
  if (!thread || typeof thread !== "object") return null;
  const t = thread as Record<string, unknown>;
  if (typeof t.id !== "string") return null;
  if (typeof t.name !== "string") return null;
  if (typeof t.archived !== "boolean") return null;
  if (typeof t.memberCount !== "number") return null;
  if (typeof t.messageCount !== "number") return null;
  return {
    id: t.id,
    name: t.name,
    archived: t.archived,
    memberCount: t.memberCount,
    messageCount: t.messageCount,
  };
}
