// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for telegram-inbound runWithContext wrap.
 *
 * Asserts that handleInboundMessage and the callback_query:data handler
 * both stamp msg.metadata.traceId and run handlers inside runWithContext
 * so the traceId propagates via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage, NormalizedReaction } from "@comis/core";
import type { TelegramAdapterState, TelegramAdapterDeps } from "./telegram-adapter-types.js";
import {
  bindInboundHandlers,
  handleInboundMessage,
  registerReactionHandler,
} from "./telegram-inbound.js";
import type { Message } from "grammy/types";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeDeps(): TelegramAdapterDeps {
  return {
    botToken: "test-bot-token",
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as TelegramAdapterDeps["logger"],
  };
}

function makeState(handlers: Array<(m: NormalizedMessage) => Promise<void>>): TelegramAdapterState {
  return {
    bot: {} as TelegramAdapterState["bot"],
    handlers,
    reactionHandlers: [],
    channelId: "telegram-pending",
    runnerHandle: null,
    botIdentity: { id: 42, username: "testbot" },
    connected: false,
    startedAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };
}

// ---------------------------------------------------------------------------
// Reaction-binder helpers — a bot mock that captures bot.on(name, handler).
// ---------------------------------------------------------------------------

interface CapturingBot {
  on(name: string, handler: (ctx: unknown) => void): void;
  handlers: Map<string, (ctx: unknown) => void>;
}

function makeCapturingState(): TelegramAdapterState & { bot: CapturingBot } {
  const handlers = new Map<string, (ctx: unknown) => void>();
  const bot: CapturingBot = {
    handlers,
    on(name: string, handler: (ctx: unknown) => void) {
      handlers.set(name, handler);
    },
  };
  const state = makeState([]);
  return { ...state, bot } as TelegramAdapterState & { bot: CapturingBot };
}

/** A grammy message_reaction Context with the messageReaction update populated. */
function makeReactionCtx(mr: Record<string, unknown>): { messageReaction: Record<string, unknown> } {
  return { messageReaction: mr };
}

function emojiReaction(emoji: string): { type: "emoji"; emoji: string } {
  return { type: "emoji", emoji };
}

function makeMsg(): Message {
  return {
    message_id: 100,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 12345, type: "private" },
    from: { id: 99, is_bot: false, first_name: "Alice" },
    text: "hello",
  } as Message;
}

// ---------------------------------------------------------------------------
// handleInboundMessage — runWithContext wrap
// ---------------------------------------------------------------------------

describe("telegram-inbound -- handleInboundMessage runWithContext wrap", () => {
  it("stamps msg.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const handler = async (m: NormalizedMessage) => { captured = m; };
    const state = makeState([handler]);
    const deps = makeDeps();
    handleInboundMessage(state, deps, makeMsg(), 12345);
    await new Promise((r) => setImmediate(r)); // drain fire-and-forget
    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"telegram\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let stampedTraceId: string | undefined;
    const handler = async (m: NormalizedMessage) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      stampedTraceId = m.metadata.traceId;
    };
    const state = makeState([handler]);
    const deps = makeDeps();
    handleInboundMessage(state, deps, makeMsg(), 12345);
    await new Promise((r) => setImmediate(r));
    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("telegram");
  });
});

// ---------------------------------------------------------------------------
// message_reaction binder (REACT-01)
// ---------------------------------------------------------------------------

describe("bindInboundHandlers -- message_reaction fanout", () => {
  it("fans out a NormalizedReaction when new_reaction adds an emoji absent from old_reaction", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps());
    const handler = bot.handlers.get("message_reaction");
    expect(handler).toBeDefined();

    handler!(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      user: { id: 99, is_bot: false, first_name: "Alice" },
      old_reaction: [],
      new_reaction: [emojiReaction("👍")],
    }));
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      messageId: "555",
      reactorId: "99",
      emoji: "👍",
      channelType: "telegram",
      channelId: "12345",
    });
  });

  it("does NOT fan out when the reactor is the bot's own identity (bot-own filter)", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps());
    const handler = bot.handlers.get("message_reaction");
    // botIdentity.id === 42 (from makeState).
    handler!(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      user: { id: 42, is_bot: true, first_name: "testbot" },
      old_reaction: [],
      new_reaction: [emojiReaction("👍")],
    }));
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(0);
  });

  it("does NOT fan out a removal-only update (an emoji left old_reaction, no net new emoji)", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps());
    const handler = bot.handlers.get("message_reaction");
    handler!(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      user: { id: 99, is_bot: false, first_name: "Alice" },
      old_reaction: [emojiReaction("👍")],
      new_reaction: [],
    }));
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(0);
  });

  it("skips a reaction with no user (anonymous channel reaction) without throwing", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps());
    const handler = bot.handlers.get("message_reaction");
    expect(() => handler!(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      old_reaction: [],
      new_reaction: [emojiReaction("👍")],
    }))).not.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(0);
  });

  it("ignores custom_emoji reactions (only plain emoji adds count)", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps());
    const handler = bot.handlers.get("message_reaction");
    handler!(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      user: { id: 99, is_bot: false, first_name: "Alice" },
      old_reaction: [],
      new_reaction: [{ type: "custom_emoji", custom_emoji_id: "abc" }],
    }));
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(0);
  });
});

describe("registerReactionHandler", () => {
  it("appends the handler to state.reactionHandlers", () => {
    const state = makeState([]);
    expect(state.reactionHandlers).toHaveLength(0);
    registerReactionHandler(state, () => {});
    expect(state.reactionHandlers).toHaveLength(1);
  });
});
