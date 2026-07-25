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
import { getOriginalInboundMessages, tryGetContext } from "@comis/core";
import type { NormalizedMessage, NormalizedReaction } from "@comis/core";
import type { TelegramAdapterState, TelegramAdapterDeps } from "./telegram-adapter-types.js";
import {
  bindInboundHandlers,
  handleInboundMessage,
  registerReactionHandler,
} from "./telegram-inbound.js";
import type { Message } from "grammy/types";
import type { TelegramBotIdentity } from "../message-mapper.js";

const TEST_BOT_IDENTITY: TelegramBotIdentity = { id: 42, username: "testbot" };

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeDeps(): TelegramAdapterDeps {
  return {
    getBotToken: () => "test-bot-token",
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
    createBot: vi.fn(),
    handlers,
    reactionHandlers: [],
    channelId: "telegram-pending",
    pollingTask: null,
    pollingGeneration: 0,
    lifecycleTail: Promise.resolve(),
    inFlightUpdates: new Set(),
    acceptingUpdates: true,
    stopGateTriggered: false,
    inboundHandlersBound: false,
    botIdentity: TEST_BOT_IDENTITY,
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
  on(name: string, handler: (ctx: unknown) => unknown): void;
  handlers: Map<string, (ctx: unknown) => unknown>;
}

function makeCapturingState(
  messageHandlers: Array<(m: NormalizedMessage) => Promise<void>> = [],
): TelegramAdapterState & { bot: CapturingBot } {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const bot: CapturingBot = {
    handlers,
    on(name: string, handler: (ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
  };
  const state = makeState(messageHandlers);
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
    await handleInboundMessage(state, deps, makeMsg(), 12345, "message", TEST_BOT_IDENTITY);
    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"telegram\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const handler = async (m: NormalizedMessage) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId;
    };
    const state = makeState([handler]);
    const deps = makeDeps();
    await handleInboundMessage(state, deps, makeMsg(), 12345, "message", TEST_BOT_IDENTITY);
    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("telegram");
    expect(ctxTrustLevel).toBe("user");
  });

  it("redacts credentials from rejected message-handler errors before logging", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    const deps = makeDeps();
    const state = makeState([
      async () => { throw new Error(`handler failed with ${credential}`); },
    ]);

    await expect(
      handleInboundMessage(state, deps, makeMsg(), 12345, "message", TEST_BOT_IDENTITY),
    ).rejects.toThrow("handler failed");

    const errorLog = deps.logger.error as unknown as ReturnType<typeof vi.fn>;
    expect(errorLog).toHaveBeenCalledOnce();
    const payload = errorLog.mock.calls[0]?.[0] as { err?: unknown };
    expect(typeof payload.err).toBe("string");
    expect(String(payload.err)).not.toContain(credential);
  });
});

describe("bindInboundHandlers -- Telegram edit identity", () => {
  it("dispatches an original and one stable edited revision identity", async () => {
    const captured: NormalizedMessage[] = [];
    const fullState = makeCapturingState([
      async (message) => { captured.push(message); },
    ]);
    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);

    const original = makeMsg();
    const edited = {
      ...original,
      text: "updated text",
      edit_date: original.date + 10,
    } as Message;
    fullState.bot.handlers.get("message")?.({ message: original });
    fullState.bot.handlers.get("edited_message")?.({ editedMessage: edited });
    fullState.bot.handlers.get("edited_message")?.({ editedMessage: edited });
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toHaveLength(3);
    expect(captured[0]?.id).not.toBe(captured[1]?.id);
    expect(captured[1]?.id).toBe(captured[2]?.id);
    expect(captured.map((message) => message.metadata.telegramUpdateKind)).toEqual([
      "message",
      "edited_message",
      "edited_message",
    ]);
  });

  it("scopes identical inbound updates to each bound bot account", async () => {
    const firstMessages: NormalizedMessage[] = [];
    const secondMessages: NormalizedMessage[] = [];
    const firstState = makeCapturingState([
      async (message) => { firstMessages.push(message); },
    ]);
    const secondState = makeCapturingState([
      async (message) => { secondMessages.push(message); },
    ]);
    const firstIdentity = { id: 7001, username: "first_bot" };
    const secondIdentity = { id: 7002, username: "second_bot" };
    bindInboundHandlers(firstState, makeDeps(), firstIdentity);
    bindInboundHandlers(secondState, makeDeps(), secondIdentity);

    firstState.bot.handlers.get("message")?.({ message: makeMsg() });
    secondState.bot.handlers.get("message")?.({ message: makeMsg() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(firstMessages).toHaveLength(1);
    expect(secondMessages).toHaveLength(1);
    expect(firstMessages[0]?.id).not.toBe(secondMessages[0]?.id);
  });
});

describe("bindInboundHandlers -- callback query identity", () => {
  it("forwards callback data without waiting for a stalled acknowledgement", async () => {
    const captured: NormalizedMessage[] = [];
    const fullState = makeCapturingState([
      async (message) => { captured.push(message); },
    ]);
    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
    const callback = fullState.bot.handlers.get("callback_query:data");
    const acknowledgement = new Promise<never>(() => undefined);

    const dispatch = Promise.resolve(callback?.({
      answerCallbackQuery: vi.fn(() => acknowledgement),
      callbackQuery: { id: "callback-query-stalled-ack", data: "approve" },
      from: { id: 99, username: "user_a", first_name: "User" },
    }));
    const outcome = await Promise.race([
      dispatch.then(() => "forwarded" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ]);

    expect(outcome).toBe("forwarded");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.text).toBe("approve");
  });

  it("maps replay of one Telegram callback query id to one stable normalized identity", async () => {
    const captured: NormalizedMessage[] = [];
    const fullState = makeCapturingState([
      async (message) => { captured.push(message); },
    ]);
    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
    const callback = fullState.bot.handlers.get("callback_query:data");
    const makeContext = () => ({
      answerCallbackQuery: vi.fn(async () => undefined),
      callbackQuery: {
        id: "callback-query-stable-id",
        data: "approve",
        message: {
          message_id: 51,
          date: 1_700_000_000,
          chat: { id: 12345, type: "private" },
        },
      },
      from: { id: 99, username: "user_a", first_name: "User" },
    });

    await callback?.(makeContext());
    await callback?.(makeContext());

    expect(captured).toHaveLength(2);
    expect(captured[0]!.id).toBe(captured[1]!.id);
    expect(captured[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(captured[0]!.timestamp).toBe(1_700_000_000_000);
    expect(captured[1]!.timestamp).toBe(captured[0]!.timestamp);
    expect(getOriginalInboundMessages(captured[1]!)).toEqual(
      getOriginalInboundMessages(captured[0]!),
    );
  });

  it("assigns a replay-stable timestamp when an inline callback has no source message date", async () => {
    vi.useFakeTimers();
    try {
      const captured: NormalizedMessage[] = [];
      const fullState = makeCapturingState([
        async (message) => { captured.push(message); },
      ]);
      bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
      const callback = fullState.bot.handlers.get("callback_query:data");
      const makeContext = () => ({
        answerCallbackQuery: vi.fn(async () => undefined),
        callbackQuery: {
          id: "inline-callback-stable-timestamp",
          data: "approve",
        },
        from: { id: 99, username: "user_a", first_name: "User" },
      });

      vi.setSystemTime(1_700_000_000_000);
      await callback?.(makeContext());
      await Promise.resolve();
      vi.setSystemTime(1_700_086_400_000);
      await callback?.(makeContext());
      await Promise.resolve();

      expect(captured).toHaveLength(2);
      expect(captured[0]!.id).toBe(captured[1]!.id);
      expect(captured[0]!.timestamp).toBe(captured[1]!.timestamp);
      expect(captured[0]!.timestamp).toBeGreaterThan(0);
      expect(getOriginalInboundMessages(captured[1]!)).toEqual(
        getOriginalInboundMessages(captured[0]!),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes identical callback query ids to the receiving bot account", async () => {
    const firstMessages: NormalizedMessage[] = [];
    const secondMessages: NormalizedMessage[] = [];
    const firstState = makeCapturingState([
      async (message) => { firstMessages.push(message); },
    ]);
    const secondState = makeCapturingState([
      async (message) => { secondMessages.push(message); },
    ]);
    bindInboundHandlers(firstState, makeDeps(), { id: 7001, username: "first_bot" });
    bindInboundHandlers(secondState, makeDeps(), { id: 7002, username: "second_bot" });
    const context = {
      answerCallbackQuery: vi.fn(async () => undefined),
      callbackQuery: {
        id: "callback-query-shared-id",
        data: "approve",
        message: {
          message_id: 51,
          chat: { id: 12345, type: "private" },
        },
      },
      from: { id: 99, username: "user_a", first_name: "User" },
    };

    await firstState.bot.handlers.get("callback_query:data")?.(context);
    await secondState.bot.handlers.get("callback_query:data")?.(context);

    expect(firstMessages[0]?.id).not.toBe(secondMessages[0]?.id);
  });

  it("redacts credentials from callback acknowledgement failures before logging", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    const deps = makeDeps();
    const captured: NormalizedMessage[] = [];
    const fullState = makeCapturingState([
      async (message) => { captured.push(message); },
    ]);
    bindInboundHandlers(fullState, deps, TEST_BOT_IDENTITY);

    await fullState.bot.handlers.get("callback_query:data")?.({
      answerCallbackQuery: vi.fn(async () => { throw new Error(`callback failed with ${credential}`); }),
      callbackQuery: { id: "callback-query-error", data: "approve" },
      from: { id: 99, username: "user_a", first_name: "User" },
    });
    const warnLog = deps.logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnLog).toHaveBeenCalledOnce();
    const payload = warnLog.mock.calls[0]?.[0] as { err?: unknown };
    expect(typeof payload.err).toBe("string");
    expect(String(payload.err)).not.toContain(credential);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.text).toBe("approve");
  });
});

describe("bindInboundHandlers -- stopping gate", () => {
  it("rejects an update that arrives after shutdown stops accepting work", async () => {
    const handler = vi.fn(async () => undefined);
    const fullState = makeCapturingState([handler]);
    (fullState as unknown as { acceptingUpdates: boolean }).acceptingUpdates = false;
    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);

    const dispatch = fullState.bot.handlers.get("message")?.({ message: makeMsg() });

    await expect(dispatch).rejects.toThrow(/stopping/i);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// message_reaction binder
// ---------------------------------------------------------------------------

describe("bindInboundHandlers -- message_reaction fanout", () => {
  it("fans out a NormalizedReaction when new_reaction adds an emoji absent from old_reaction", async () => {
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    const captured: NormalizedReaction[] = [];
    registerReactionHandler(fullState, (r) => { captured.push(r); });

    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
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

    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
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

    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
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

    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
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

    bindInboundHandlers(fullState, makeDeps(), TEST_BOT_IDENTITY);
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

  it("redacts credentials from rejected reaction-handler errors before logging", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    const deps = makeDeps();
    const { bot, ...state } = makeCapturingState();
    const fullState = { ...state, bot } as unknown as TelegramAdapterState;
    registerReactionHandler(fullState, async () => {
      throw new Error(`reaction failed with ${credential}`);
    });
    bindInboundHandlers(fullState, deps, TEST_BOT_IDENTITY);

    bot.handlers.get("message_reaction")?.(makeReactionCtx({
      message_id: 555,
      chat: { id: 12345, type: "private" },
      user: { id: 99, is_bot: false, first_name: "Alice" },
      old_reaction: [],
      new_reaction: [emojiReaction("👍")],
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const warnLog = deps.logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnLog).toHaveBeenCalledOnce();
    const payload = warnLog.mock.calls[0]?.[0] as { err?: unknown };
    expect(typeof payload.err).toBe("string");
    expect(String(payload.err)).not.toContain(credential);
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
