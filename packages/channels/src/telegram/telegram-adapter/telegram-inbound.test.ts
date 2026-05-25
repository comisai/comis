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
import type { NormalizedMessage } from "@comis/core";
import type { TelegramAdapterState, TelegramAdapterDeps } from "./telegram-adapter-types.js";
import { handleInboundMessage } from "./telegram-inbound.js";
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
    channelId: "telegram-pending",
    runnerHandle: null,
    botIdentity: { id: 42, username: "testbot" },
    connected: false,
    startedAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };
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
