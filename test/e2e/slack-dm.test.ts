// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: Slack × DM — Web API wire roundtrip against the 127.0.0.1 mock.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09 Wave D).
 *
 * Scope: drives the production `validateSlackCredentials` (from
 * @comis/channels) and a raw @slack/web-api WebClient against the mock
 * Slack Web API server. Asserts:
 *   1. The apiRoot redirection from Wave A3 flows through @slack/web-api
 *      — calling auth.test() hits the 127.0.0.1 mock, not slack.com.
 *   2. The mock's POST /api/chat.postMessage endpoint captures bot
 *      outbound messages with the correct channel + text.
 *
 * Why no full SlackChannelAdapter test: SlackChannelAdapter.start() in
 * mode='http' requires the daemon's gateway port to host webhook endpoints
 * (a daemon-level concern). The Web API surface tested here is the
 * load-bearing outbound surface. Inbound is covered by the mock's
 * 'pending-inbound' marker which test/integration/-tier tests will
 * consume in a future plan.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockSlackServer, type MockSlackServer } from "./mocks/slack/mock-slack-server.js";
import { validateSlackCredentials } from "@comis/channels";

describe("E2E: slack × dm — Web API wire roundtrip against the 127.0.0.1 mock (COV-15)", () => {
  let mock: MockSlackServer;
  let baseUrl: string;

  beforeEach(async () => {
    mock = createMockSlackServer();
    const handle = await mock.start();
    baseUrl = handle.baseUrl;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it("validates Slack credentials by hitting /api/auth.test through the redirected WebClient", async () => {
    const result = await validateSlackCredentials({
      botToken: "xoxb-mock-test-token",
      mode: "http",
      signingSecret: "mock-test-signing-secret",
      apiRoot: baseUrl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe("U_BOT_123");
      expect(result.value.teamId).toBe("T12345");
    }
    expect(mock.getRequestCount("auth-test")).toBeGreaterThanOrEqual(1);
  });

  it("captures bot outbound POSTs on /api/chat.postMessage with channel + text", async () => {
    const { WebClient } = await import("@slack/web-api");
    // The WebClient builds URLs as `<slackApiUrl><method>`. Without a
    // trailing `/api/` the methods appear at the root — the mock accepts
    // either shape (with or without /api/ prefix).
    const client = new WebClient("xoxb-mock-test-token", { slackApiUrl: `${baseUrl}/` });
    const result = await client.chat.postMessage({
      channel: "C_SLACK_TEST_DM",
      text: "Hello slack user from comis-bot",
    });
    expect(result.ok).toBe(true);

    expect(mock.getRequestCount("post-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "post-message");
    expect(sendEvent).toBeDefined();
    expect(sendEvent!.payload.channel).toBe("C_SLACK_TEST_DM");
    expect(sendEvent!.payload.text).toContain("Hello slack user from comis-bot");
  });

  it("captures inbound event_callback payloads via injectInboundMessage for test dispatch", () => {
    // Slack inbound events arrive via webhook (HTTP mode) — the mock
    // returns the event_callback payload for the test to POST to the
    // daemon's gateway events endpoint. We assert the payload shape is
    // correct here without dispatching it.
    const { eventCallback } = mock.injectInboundMessage({
      from: "U_SLACK_USER_123",
      channel: "C_SLACK_TEST_DM",
      content: "Hi bot from slack user",
    });
    expect(eventCallback.type).toBe("event_callback");
    expect((eventCallback.event as Record<string, unknown>).channel).toBe("C_SLACK_TEST_DM");
    expect((eventCallback.event as Record<string, unknown>).text).toBe("Hi bot from slack user");
    expect((eventCallback.event as Record<string, unknown>).user).toBe("U_SLACK_USER_123");
  });
});
