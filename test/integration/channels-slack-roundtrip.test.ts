// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Slack channel — Web API wire roundtrip + format helpers.
 *
 * Covers the `@comis/channels` Slack subpackage:
 * validateSlackCredentials, escapeSlackMrkdwn, slack-resolver.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockSlackServer,
  type MockSlackServer,
} from "../e2e/mocks/slack/mock-slack-server.js";
import {
  validateSlackCredentials,
  escapeSlackMrkdwn,
} from "@comis/channels";

describe("INTEGRATION: slack channel — Web API wire roundtrip + mrkdwn helpers", () => {
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

  it("validateSlackCredentials hits /api/auth.test through apiRoot redirection", async () => {
    const result = await validateSlackCredentials({
      botToken: "test-bot-token",
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

  it("injectInboundMessage produces a realistic event_callback payload", () => {
    const { eventCallback } = mock.injectInboundMessage({
      from: "U_SLACK_USER_123",
      channel: "C_SLACK_TEST",
      content: "Hi bot integration test",
    });
    expect(eventCallback.type).toBe("event_callback");
    expect((eventCallback.event as Record<string, unknown>).channel).toBe(
      "C_SLACK_TEST",
    );
    expect((eventCallback.event as Record<string, unknown>).text).toBe(
      "Hi bot integration test",
    );
  });

  it("escapeSlackMrkdwn escapes ampersand, less-than, greater-than", () => {
    const result = escapeSlackMrkdwn("foo & bar <baz>");
    expect(result).not.toContain(" & ");
    expect(result).not.toContain("<baz>");
  });

  it("escapeSlackMrkdwn passes plain text unchanged", () => {
    const result = escapeSlackMrkdwn("plain text without specials");
    expect(result).toBe("plain text without specials");
  });
});
