// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: LINE × DM — Messaging API wire roundtrip against the 127.0.0.1 mock.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09 Wave D).
 *
 * Scope: drives the production `validateLineCredentials` (from
 * @comis/channels) and a raw @line/bot-sdk MessagingApiClient against
 * the mock LINE Messaging API server. Asserts:
 *   1. The apiRoot redirection from Wave A5 flows through @line/bot-sdk
 *      — calling getBotInfo() hits the 127.0.0.1 mock, not api.line.me.
 *   2. The mock's POST /v2/bot/message/push endpoint captures bot
 *      outbound messages with the correct recipient + text.
 *
 * Why no full LineChannelAdapter test: LineChannelAdapter's inbound
 * path requires the daemon's gateway to host a webhook endpoint at the
 * configured `webhookPath`. The Messaging API outbound surface tested
 * here is the load-bearing surface for push-message dispatch. Inbound
 * webhook events are covered by the mock's `injectInboundMessage`
 * helper, which returns the webhook payload for test-level dispatch.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockLineServer, type MockLineServer } from "./mocks/line/mock-line-server.js";
import { validateLineCredentials } from "@comis/channels";

describe("E2E: line × dm — Messaging API wire roundtrip against the 127.0.0.1 mock (COV-15)", () => {
  let mock: MockLineServer;
  let baseUrl: string;

  beforeEach(async () => {
    mock = createMockLineServer();
    const handle = await mock.start();
    baseUrl = handle.baseUrl;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it("validates LINE credentials by hitting /v2/bot/info through the redirected MessagingApiClient", async () => {
    const result = await validateLineCredentials({
      channelAccessToken: "mock-line-access-token",
      channelSecret: "mock-line-channel-secret",
      apiRoot: baseUrl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.basicId).toBe("@testbot");
      expect(result.value.userId).toBe("U_BOT_LINE_123");
    }
    expect(mock.getRequestCount("bot-info")).toBeGreaterThanOrEqual(1);
  });

  it("captures bot outbound POSTs on /v2/bot/message/push with recipient + text payload", async () => {
    const { messagingApi } = await import("@line/bot-sdk");
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: "mock-line-access-token",
      baseURL: baseUrl,
    });
    await client.pushMessage({
      to: "U_LINE_USER_123",
      messages: [{ type: "text", text: "Hello line user from comis-bot" }],
    });

    expect(mock.getRequestCount("push-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const pushEvent = events.find((e) => e.type === "push-message");
    expect(pushEvent).toBeDefined();
    expect(pushEvent!.payload.to).toBe("U_LINE_USER_123");
    expect(pushEvent!.payload.text).toContain("Hello line user from comis-bot");
  });

  it("produces a realistic webhookEvent payload via injectInboundMessage for gateway dispatch", () => {
    // LINE inbound events arrive via webhook (HTTPS POST to the daemon's
    // configured webhookPath). The mock returns the event payload for
    // the test to POST to the daemon's gateway endpoint directly.
    const { webhookEvent } = mock.injectInboundMessage({
      from: "U_LINE_USER_123",
      channel: "U_LINE_USER_123",
      content: "Hi bot from line user",
    });
    const events = webhookEvent.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("message");
    const message = event.message as Record<string, unknown>;
    expect(message.type).toBe("text");
    expect(message.text).toBe("Hi bot from line user");
    expect(event.replyToken).toBeTruthy();
    expect(event.webhookEventId).toBeTruthy();
  });
});
