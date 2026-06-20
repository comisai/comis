// SPDX-License-Identifier: Apache-2.0
/**
 * grammy-typed Telegram `Update` / `Message` builders (TEST-01 / invariant I4,
 * Phase 204).
 *
 * The emulator's `getUpdates` (Plan 03) serves these builder-produced `Update`
 * values, and the scenario contract test (Plan 05) round-trips them through the
 * REAL production Telegram adapter (`mapGrammyToNormalized`). Because the
 * builders import grammy 1.43's OWN exported `Update` / `Message` / `User`
 * types and return-annotate against them, every emitted payload is *guaranteed*
 * to be exactly the shape the adapter parses — a grammy shape drift becomes a
 * COMPILE error here, not a silent runtime mismatch. That is the whole point:
 * it forecloses the hand-rolled Go-emulator drift problem this milestone exists
 * to avoid (design §1.3, threat T-204-04).
 *
 * Analog (the untyped literal this replaces): `injectInboundMessage` in
 * `test/e2e/mocks/telegram/mock-telegram-server.ts:227-245`. Same runtime
 * shape — now grammy-typed.
 *
 * Scope (Phase 204): only the `message` Update is load-bearing (the DM text
 * round-trip). Reaction (`message_reaction`) and callback builders are deferred
 * (REACT-01 Phase 206 / INTERACT-01 Phase 207) and intentionally NOT built
 * here — the §4.2 scope guard asserts no unhandled-kind literal appears.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture rule.
 *
 * @module
 */

import type { Update, User } from "grammy/types";

/**
 * Options for {@link makeUser} / {@link makeBotUser}.
 */
export interface MakeUserOptions {
  /** Telegram user id (numeric). */
  readonly id: number;
  /** Display first name. */
  readonly firstName: string;
  /** Optional @username (without the leading `@`). */
  readonly username?: string;
}

/**
 * Build a grammy `User` for a HUMAN sender (`is_bot: false`).
 *
 * The return type is grammy's own `User` — a shape drift is a compile error
 * (I4). `username` is included only when supplied (exact-optional-safe).
 */
export function makeUser(opts: MakeUserOptions): User {
  const user: User = {
    id: opts.id,
    is_bot: false,
    first_name: opts.firstName,
  };
  return opts.username === undefined ? user : { ...user, username: opts.username };
}

/**
 * Build a grammy `User` for the BOT (`is_bot: true`) — used where a bot-sender
 * is needed (e.g. echoing an outbound author). Same I4 typing guarantee.
 */
export function makeBotUser(opts: MakeUserOptions): User {
  const user: User = {
    id: opts.id,
    is_bot: true,
    first_name: opts.firstName,
  };
  return opts.username === undefined ? user : { ...user, username: opts.username };
}

/**
 * Options for {@link makeMessageUpdate}.
 */
export interface MakeMessageUpdateOptions {
  /** The Update's unique, monotonically-increasing id (the caller owns the counter; see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The message's id inside the chat. */
  readonly messageId: number;
  /** The (human) sender — built via {@link makeUser}. */
  readonly from: User;
  /** The private-chat id this DM belongs to. */
  readonly chatId: number;
  /** The message text. */
  readonly text: string;
}

/**
 * Build a well-formed grammy `message` `Update` for the 204 DM round-trip.
 *
 * The return annotation IS grammy's `Update` (I4 tripwire). The literal
 * satisfies `Update.message: Message & Update.NonChannel` — a `private` chat
 * (`Chat.PrivateChat`) and a mandatory `from` `User`, which is exactly what the
 * adapter's `mapGrammyToNormalized` reads.
 *
 * `date` is `Math.floor(Date.now() / 1000)` — Telegram unix SECONDS, not
 * milliseconds; the adapter's message-mapper multiplies ×1000 to recover the
 * timestamp (message-mapper.ts:207, design §4.2). Emitting ms here would make
 * the mapped timestamp ~1000× too large.
 *
 * Only the `message` kind is populated — no other (channel-post, inline-query,
 * reaction, callback) kinds (those are deferred to Phases 206/207; §4.2 scope
 * guard — the AC greps the whole file, so even a comment must avoid those
 * exact update-kind tokens).
 */
export function makeMessageUpdate(opts: MakeMessageUpdateOptions): Update {
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId,
      from: opts.from,
      // grammy's `Chat.PrivateChat` REQUIRES `first_name` (the other party in a
      // DM). In a private chat the chat IS the sender, so it mirrors `from`.
      // (The untyped mock omits this and compiles by accident — exactly the
      // drift the `: Update` annotation surfaces; I4.)
      chat: { id: opts.chatId, type: "private", first_name: opts.from.first_name },
      // Telegram unix SECONDS (NOT ms) — the mapper multiplies ×1000 (§4.2).
      date: Math.floor(Date.now() / 1000),
      text: opts.text,
    },
  };
}

/**
 * Module-level strictly-monotonic update-id source.
 *
 * The emulator (Plan 03) relies on strictly-increasing `update_id`s for its
 * long-poll offset/ack (drop pending `update_id < offset`). Starting at 1
 * mirrors the proven mock (`mock-telegram-server.ts:231,250`). Callers pass the
 * value into {@link makeMessageUpdate} (the builder echoes it verbatim) so the
 * counter lives in one place.
 */
let updateIdCounter = 0;

/**
 * Return the next strictly-increasing `update_id` (1, 2, 3, …).
 */
export function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

/**
 * Reset the {@link nextUpdateId} counter to its initial state (so it returns 1
 * next). For per-test isolation if a suite needs a deterministic sequence.
 */
export function resetUpdateIdCounter(): void {
  updateIdCounter = 0;
}
