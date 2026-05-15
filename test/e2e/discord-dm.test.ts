// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: Discord × DM — REST roundtrip against the 127.0.0.1 mock.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09 Wave D).
 *
 * Scope: drives the production `validateDiscordToken` (from
 * @comis/channels) against the mock Discord REST server. Asserts:
 *   1. The apiRoot redirection from Wave A2 flows through @discordjs/rest
 *      — calling /users/@me hits the 127.0.0.1 mock, not discord.com.
 *   2. The mock's POST /channels/<id>/messages endpoint captures bot
 *      outbound payloads in the same wire shape discord.js produces.
 *   3. The mock's GET /gateway/bot returns ws://127.0.0.1:<same-port>
 *      so discord.js's gateway client would correctly redirect.
 *
 * What this does NOT cover end-to-end: the full Discord gateway WebSocket
 * lifecycle (heartbeat negotiation, READY → MESSAGE_CREATE inbound). The
 * mock supports it (Wave B2), but discord.js's gateway client expects
 * intricate timing that is brittle inside vitest's 60s timeout. A
 * follow-on plan can deepen this coverage; the REST wire surface proven
 * here is the load-bearing surface for outbound dispatch.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockDiscordServer, type MockDiscordServer } from "./mocks/discord/mock-discord-server.js";
import { validateDiscordToken } from "@comis/channels";

describe("E2E: discord × dm — REST wire roundtrip against the 127.0.0.1 mock (COV-15)", () => {
  let mock: MockDiscordServer;
  let baseUrl: string;

  beforeEach(async () => {
    mock = createMockDiscordServer();
    const handle = await mock.start();
    baseUrl = handle.baseUrl;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it("validates a bot token by hitting /api/v10/users/@me through the redirected REST client", async () => {
    // validateDiscordToken is the same function the production daemon
    // calls at startup. Pointing it at the mock proves the apiRoot
    // refactor from Wave A2 actually flows through @discordjs/rest.
    const result = await validateDiscordToken("mock-test-token", baseUrl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.username).toBe("test_bot");
    }
    expect(mock.getRequestCount("users-me")).toBeGreaterThanOrEqual(1);
  });

  it("captures bot outbound POSTs on /api/v10/channels/<id>/messages with content payload", async () => {
    // Drive a direct POST to the mock with a discord.js-style payload.
    // The mock's REST handler accepts the same wire shape the production
    // Discord adapter uses for sendMessage.
    const res = await fetch(`${baseUrl}/api/v10/channels/discord-test-channel-dm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bot mock-test-token",
      },
      body: JSON.stringify({ content: "Hello discord user from comis-bot" }),
    });
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.content).toBe("Hello discord user from comis-bot");

    expect(mock.getRequestCount("send-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "send-message");
    expect(sendEvent).toBeDefined();
    expect(sendEvent!.payload.channelId).toBe("discord-test-channel-dm");
    expect(sendEvent!.payload.content).toContain("Hello discord user from comis-bot");
  });

  it("returns ws://127.0.0.1:<port> as the gateway URL from /api/v10/gateway/bot", async () => {
    // Production discord.js fetches the gateway URL via /gateway/bot at
    // start time. The mock's response steers the client toward the
    // mock's own WebSocket endpoint (hosted on the same HTTP server).
    const res = await fetch(`${baseUrl}/api/v10/gateway/bot`, {
      headers: { authorization: "Bot mock-test-token" },
    });
    const body = await res.json();
    expect(body.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    expect(body.session_start_limit).toBeDefined();
    expect(mock.getRequestCount("gateway-bot")).toBeGreaterThanOrEqual(1);
  });
});
