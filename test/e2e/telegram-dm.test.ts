// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: Telegram × DM — Bot API wire roundtrip against the 127.0.0.1 mock.
 *
 * Scope: spawns the production `@comis/channels` Telegram adapter via
 * `createTelegramPlugin({ apiRoot: <mock-base-url>, ... })` and asserts:
 *   1. validateBotToken hits the mock /bot<TOKEN>/getMe at startup.
 *   2. Adapter outbound sendMessage POSTs to /bot<TOKEN>/sendMessage with
 *      the correct chat_id and text.
 *   3. The mock's getUpdates long-poll delivers inbound updates to the
 *      adapter's MessageHandler (the grammY polling loop reads from the mock).
 *
 * Uses a stub bot token (`12345:test`) — no real credentials in tests.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockTelegramServer, type MockTelegramServer } from "./mocks/telegram/mock-telegram-server.js";
import { createTelegramPlugin } from "@comis/channels";
import { createMockLogger } from "../support/mock-logger.js";
import type { ChannelPort, NormalizedMessage } from "@comis/core";

describe("E2E: telegram × dm — Bot API wire roundtrip against the 127.0.0.1 mock", () => {
  let mock: MockTelegramServer;
  let adapter: ChannelPort;
  let receivedInbound: NormalizedMessage[];

  beforeEach(async () => {
    mock = createMockTelegramServer();
    const handle = await mock.start();
    const plugin = createTelegramPlugin({
      getBotToken: () => "12345:test",
      apiRoot: handle.baseUrl,
      logger: createMockLogger(),
    });
    adapter = plugin.adapter;
    receivedInbound = [];
    adapter.onMessage(async (msg) => {
      receivedInbound.push(msg);
    });
    const startRes = await adapter.start();
    if (!startRes.ok) {
      throw startRes.error;
    }
    // Wait briefly for the grammy runner's first poll to complete.
    await new Promise((r) => setTimeout(r, 300));
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("hits /bot<TOKEN>/getMe during adapter startup credential validation", () => {
    // validateBotToken (called from setup-channels-adapters.ts production
    // path, or directly from the adapter's plugin if testing in isolation)
    // hits the mock's /getMe endpoint at startup. Adapter's start() also
    // calls getMe internally to populate botIdentity.
    expect(mock.getRequestCount("get-me")).toBeGreaterThanOrEqual(1);
  });

  it("posts to /bot<TOKEN>/sendMessage with chat_id and text when adapter.sendMessage is invoked", async () => {
    const sendRes = await adapter.sendMessage("987654321", "Hello telegram user");
    expect(sendRes.ok).toBe(true);

    expect(mock.getRequestCount("send-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "send-message");
    expect(sendEvent).toBeDefined();
    expect(String(sendEvent!.payload.chatId)).toBe("987654321");
    expect(sendEvent!.payload.text).toContain("Hello telegram user");
  });

  it("polls /bot<TOKEN>/getUpdates and delivers inbound messages to the adapter's MessageHandler", async () => {
    mock.injectInboundMessage({
      from: "100",
      channel: "987654321",
      content: "Hi bot from telegram user",
    });

    // Wait for the next grammy-runner poll cycle (typically <1s).
    const start = Date.now();
    while (receivedInbound.length === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(receivedInbound.length).toBeGreaterThanOrEqual(1);
    const msg = receivedInbound[0]!;
    expect(msg.channelType).toBe("telegram");
    expect(msg.text).toContain("Hi bot from telegram user");
  });
});
