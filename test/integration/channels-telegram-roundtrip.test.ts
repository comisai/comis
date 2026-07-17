// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Telegram channel — Bot API wire roundtrip + adapter integration.
 *
 * Lifts coverage on the `@comis/channels` Telegram subpackage
 * (validateBotToken, telegram-adapter, telegram-plugin) by driving the
 * production code paths against the loopback-bound mock from
 * test/e2e/mocks/telegram/.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockTelegramServer,
  type MockTelegramServer,
} from "../e2e/mocks/telegram/mock-telegram-server.js";
import {
  createTelegramPlugin,
  validateBotToken,
  validateWebhookSecret,
} from "@comis/channels";
import { createMockLogger } from "../support/mock-logger.js";
import type { ChannelPort, NormalizedMessage } from "@comis/core";

describe("INTEGRATION: telegram channel — credential validator + adapter wire roundtrip", () => {
  let mock: MockTelegramServer;
  let adapter: ChannelPort | undefined;
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
      adapter = undefined;
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("adapter.start() hits /bot<TOKEN>/getMe via apiRoot redirection during credential validation", () => {
    expect(mock.getRequestCount("get-me")).toBeGreaterThanOrEqual(1);
  });

  it("adapter.sendMessage POSTs to /bot<TOKEN>/sendMessage with chat_id and text", async () => {
    const sendRes = await adapter!.sendMessage(
      "987654321",
      "Integration test message",
    );
    expect(sendRes.ok).toBe(true);

    expect(mock.getRequestCount("send-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "send-message");
    expect(sendEvent).toBeDefined();
    expect(String(sendEvent!.payload.chatId)).toBe("987654321");
    expect(sendEvent!.payload.text).toContain("Integration test message");
  });

  it("validateBotToken with empty string returns err result without hitting the network", async () => {
    const result = await validateBotToken("");
    expect(result.ok).toBe(false);
  });

  it("validateWebhookSecret accepts a valid secret with allowed characters", () => {
    const r = validateWebhookSecret("abc123-DEF_xyz");
    expect(r.ok).toBe(true);
  });

  it("validateWebhookSecret rejects an empty secret", () => {
    const r = validateWebhookSecret("");
    expect(r.ok).toBe(false);
  });
});
