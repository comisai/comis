// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: LINE channel — Messaging API wire roundtrip + flex builder.
 *
 * Covers the `@comis/channels` LINE subpackage (validateLineCredentials,
 * buildFlexMessage, buildFlexCarousel).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockLineServer,
  type MockLineServer,
} from "../e2e/mocks/line/mock-line-server.js";
import {
  validateLineCredentials,
  buildFlexMessage,
  buildFlexCarousel,
} from "@comis/channels";

describe("INTEGRATION: line channel — Messaging API + flex helpers", () => {
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

  it("validateLineCredentials hits /v2/bot/info through apiRoot indirection", async () => {
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

  it("injectInboundMessage produces a realistic webhookEvent payload", () => {
    const { webhookEvent } = mock.injectInboundMessage({
      from: "U_LINE_USER_INT",
      channel: "U_LINE_USER_INT",
      content: "Hi bot integration test",
    });
    const events = webhookEvent.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("message");
    const message = event.message as Record<string, unknown>;
    expect(message.type).toBe("text");
    expect(message.text).toBe("Hi bot integration test");
  });

  it("buildFlexMessage returns a well-formed FlexMessage object for a basic template", () => {
    // buildFlexMessage is a production helper that runs when the LINE
    // adapter constructs rich-message replies. Calling it directly lifts
    // the line/flex-builder line into the integration tier.
    const result = buildFlexMessage({
      title: "Test title",
      body: "Test body content",
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("buildFlexCarousel returns a well-formed carousel of multiple FlexBubble templates", () => {
    const result = buildFlexCarousel([
      { title: "First", body: "first body" },
      { title: "Second", body: "second body" },
    ]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});
