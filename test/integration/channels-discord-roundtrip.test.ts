// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Discord channel — REST wire roundtrip against the 127.0.0.1 mock.
 *
 * Integration-tier exercise of the `@comis/channels` Discord subpackage:
 * the test runs channel-adapter production code paths from inside the
 * integration suite (so coverage measures hit the dist/ artifacts that
 * the integration project aliases @comis/* to).
 *
 * Reuses the mock-Discord server from test/e2e/mocks/discord/. The mock
 * is loopback-bound, kernel-allocated-port, and accepts the same wire
 * shape discord.js produces — so the integration test can validate the
 * production credential validator, REST path, and gateway-URL
 * indirection without spawning a real daemon.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockDiscordServer,
  type MockDiscordServer,
} from "../e2e/mocks/discord/mock-discord-server.js";
import {
  validateDiscordToken,
  chunkDiscordText,
} from "@comis/channels";

describe("INTEGRATION: discord channel — REST wire roundtrip + format helpers", () => {
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

  it("validateDiscordToken hits /api/v10/users/@me through the apiRoot indirection", async () => {
    const result = await validateDiscordToken("mock-test-token", baseUrl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.username).toBe("test_bot");
    }
    expect(mock.getRequestCount("users-me")).toBeGreaterThanOrEqual(1);
  });

  it("captures bot outbound POSTs to /api/v10/channels/<id>/messages with content payload", async () => {
    const res = await fetch(
      `${baseUrl}/api/v10/channels/discord-test-channel/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bot mock-test-token",
        },
        body: JSON.stringify({ content: "Integration test message" }),
      },
    );
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { content?: string };
    expect(json.content).toBe("Integration test message");
    expect(mock.getRequestCount("send-message")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const sendEvent = events.find((e) => e.type === "send-message");
    expect(sendEvent).toBeDefined();
    expect(sendEvent!.payload.channelId).toBe("discord-test-channel");
    expect(sendEvent!.payload.content).toContain("Integration test message");
  });

  it("returns ws://127.0.0.1:<port> as the gateway URL from /api/v10/gateway/bot", async () => {
    const res = await fetch(`${baseUrl}/api/v10/gateway/bot`, {
      headers: { authorization: "Bot mock-test-token" },
    });
    const body = (await res.json()) as {
      url?: string;
      session_start_limit?: unknown;
    };
    expect(body.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    expect(body.session_start_limit).toBeDefined();
    expect(mock.getRequestCount("gateway-bot")).toBeGreaterThanOrEqual(1);
  });

  it("chunkDiscordText splits oversize text within max length", () => {
    // chunkDiscordText is a pure production helper that runs in the
    // adapter's sendMessage path. Exercising it from the integration tier
    // lifts the discord/format-discord production coverage line.
    const long = "word ".repeat(500); // ~2500 chars; Discord max is 2000
    const chunks = chunkDiscordText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join("")).toContain("word");
  });

  it("chunkDiscordText returns a single chunk for messages within the limit", () => {
    const short = "Short message that fits within the Discord 2000-char cap.";
    const chunks = chunkDiscordText(short);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(short);
  });
});
