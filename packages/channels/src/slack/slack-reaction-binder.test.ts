// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Slack reaction-add binder.
 *
 * Co-located out of slack-adapter.ts. Registers `app.event("reaction_added")`,
 * mints a NormalizedReaction from the Slack `reaction_added` payload
 * (event.user / event.reaction short-name / event.item.ts / event.item.channel),
 * and fans it out, filtering the bot's own-user reactions.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";

import type { NormalizedReaction, ReactionHandler } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { bindSlackReactions } from "./slack-reaction-binder.js";

// ---------------------------------------------------------------------------
// Hand-built @slack/bolt App mock — captures the registered event handler.
// ---------------------------------------------------------------------------

interface CapturedApp {
  event(name: string, handler: (args: { event: unknown }) => Promise<void> | void): void;
  handlers: Map<string, (args: { event: unknown }) => Promise<void> | void>;
}

function makeApp(): CapturedApp {
  const handlers = new Map<string, (args: { event: unknown }) => Promise<void> | void>();
  return {
    handlers,
    event(name: string, handler: (args: { event: unknown }) => Promise<void> | void) {
      handlers.set(name, handler);
    },
  };
}

function makeReactionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: "U_REACTOR",
    reaction: "thumbsup",
    item: { ts: "1700000000.000100", channel: "C_CHAN" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bindSlackReactions -- reaction_added fanout", () => {
  it("fans out a NormalizedReaction for a non-own-user reaction with the raw short name", async () => {
    const app = makeApp();
    const captured: NormalizedReaction[] = [];
    const reactionHandlers: ReactionHandler[] = [(r) => { captured.push(r); }];

    bindSlackReactions(
      app as unknown as Parameters<typeof bindSlackReactions>[0],
      () => "U_OWNBOT",
      reactionHandlers,
      createMockLogger(),
    );

    const handler = app.handlers.get("reaction_added");
    expect(handler).toBeDefined();
    await handler!({ event: makeReactionEvent() });
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      messageId: "1700000000.000100",
      reactorId: "U_REACTOR",
      emoji: "thumbsup",
      channelType: "slack",
      channelId: "C_CHAN",
    });
  });

  it("does NOT fan out when the reactor is the bot's own user id (own-user filter)", async () => {
    const app = makeApp();
    const captured: NormalizedReaction[] = [];
    bindSlackReactions(
      app as unknown as Parameters<typeof bindSlackReactions>[0],
      () => "U_OWNBOT",
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = app.handlers.get("reaction_added");
    await handler!({ event: makeReactionEvent({ user: "U_OWNBOT" }) });
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(0);
  });

  it("resolves the own-user id lazily via the getter on every event", async () => {
    const app = makeApp();
    const captured: NormalizedReaction[] = [];
    let ownId = "";
    bindSlackReactions(
      app as unknown as Parameters<typeof bindSlackReactions>[0],
      () => ownId,
      [(r) => { captured.push(r); }],
      createMockLogger(),
    );

    const handler = app.handlers.get("reaction_added");
    // Own id resolves AFTER bind (start() sets _ownUserId post-auth).
    ownId = "U_REACTOR";
    await handler!({ event: makeReactionEvent({ user: "U_REACTOR" }) });
    await new Promise((r) => setTimeout(r, 5));

    expect(captured).toHaveLength(0);
  });

  it("isolates a throwing handler and still dispatches the rest (non-fatal)", async () => {
    const app = makeApp();
    const good: NormalizedReaction[] = [];
    const logger = createMockLogger();
    const throwing: ReactionHandler = () => { throw new Error("slack handler boom"); };
    bindSlackReactions(
      app as unknown as Parameters<typeof bindSlackReactions>[0],
      () => "U_OWNBOT",
      [throwing, (r) => { good.push(r); }],
      logger,
    );

    const handler = app.handlers.get("reaction_added");
    // The binder fire-and-forgets synchronously — a throwing handler must NOT
    // escape (no sync throw out of the listener).
    expect(() => handler!({ event: makeReactionEvent() })).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));

    expect(good).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});
