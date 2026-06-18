// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Discord reaction-add binder (REACT-01, Verified Learning WS1).
 *
 * The binder is co-located out of discord-adapter.ts to hold the 800-line cap.
 * It registers a single `MessageReactionAdd` listener that mints a
 * NormalizedReaction and fans it out to the registered reaction handlers,
 * filtering the bot's own reactions and skipping uncached PARTIAL reactions
 * non-fatally (discord.js v14 partials, RESEARCH Pitfall 3).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";

import type { NormalizedReaction, ReactionHandler } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { bindDiscordReactions } from "./discord-reaction-binder.js";

// ---------------------------------------------------------------------------
// Hand-built discord.js client mock — captures the registered listener so the
// test can drive it directly (mirrors discord-inbound.test.ts's eventHandlers
// pattern, scoped to this binder).
// ---------------------------------------------------------------------------

interface CapturedClient {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  handlers: Map<string, (...args: unknown[]) => void>;
}

function makeClient(): CapturedClient {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return this;
    },
  };
}

function makeReaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    partial: false,
    message: { id: "msg-100", channelId: "chan-1" },
    emoji: { name: "👍", toString: () => "👍" },
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "user-7", bot: false, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bindDiscordReactions -- MessageReactionAdd fanout", () => {
  it("fans out a NormalizedReaction for a non-bot reaction on a cached message", async () => {
    const client = makeClient();
    const captured: NormalizedReaction[] = [];
    const reactionHandlers: ReactionHandler[] = [(r) => { captured.push(r); }];

    // discord.js Events.MessageReactionAdd === "messageReactionAdd"
    // The binder uses the Events enum; we drive the captured handler directly.
    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      reactionHandlers,
      createMockLogger(),
    );

    const handler = client.handlers.get("messageReactionAdd");
    expect(handler).toBeDefined();
    await handler!(makeReaction(), makeUser());
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      messageId: "msg-100",
      reactorId: "user-7",
      emoji: "👍",
      channelType: "discord",
      channelId: "chan-1",
    });
  });

  it("does NOT fan out when the reactor is a bot (bot-own filter)", async () => {
    const client = makeClient();
    const captured: NormalizedReaction[] = [];
    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = client.handlers.get("messageReactionAdd");
    await handler!(makeReaction(), makeUser({ bot: true }));
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(0);
  });

  it("fetches a PARTIAL reaction before reading and fans out on success", async () => {
    const client = makeClient();
    const captured: NormalizedReaction[] = [];
    const fetched = makeReaction();
    const fetch = vi.fn().mockResolvedValue(fetched);
    const partial = makeReaction({
      partial: true,
      fetch,
      // Pre-fetch fields are present here too in discord.js, but the binder
      // re-reads from the resolved reaction; supply the same ids.
    });

    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = client.handlers.get("messageReactionAdd");
    await handler!(partial, makeUser());
    await new Promise((r) => setTimeout(r, 5));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messageId).toBe("msg-100");
  });

  it("skips non-fatally when a PARTIAL reaction fetch rejects (no throw, no fanout)", async () => {
    const client = makeClient();
    const captured: NormalizedReaction[] = [];
    const fetch = vi.fn().mockRejectedValue(new Error("uncached message gone"));
    const partial = makeReaction({ partial: true, fetch });

    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = client.handlers.get("messageReactionAdd");
    // Must NOT throw.
    await expect(handler!(partial, makeUser())).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });

  it("falls back to emoji.toString() when emoji.name is null (custom emoji)", async () => {
    const client = makeClient();
    const captured: NormalizedReaction[] = [];
    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = client.handlers.get("messageReactionAdd");
    await handler!(
      makeReaction({ emoji: { name: null, toString: () => "<:custom:42>" } }),
      makeUser(),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.emoji).toBe("<:custom:42>");
  });

  it("dispatches to every registered handler and isolates a throwing handler (non-fatal)", async () => {
    const client = makeClient();
    const good: NormalizedReaction[] = [];
    const logger = createMockLogger();
    const throwing: ReactionHandler = () => { throw new Error("handler boom"); };
    bindDiscordReactions(
      client as unknown as Parameters<typeof bindDiscordReactions>[0],
      [throwing, (r) => { good.push(r); }],
      logger,
    );

    const handler = client.handlers.get("messageReactionAdd");
    await expect(handler!(makeReaction(), makeUser())).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));

    // The throwing handler did not block the good handler.
    expect(good).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});
