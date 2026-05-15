// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: IRC × DM — wire-level adapter roundtrip against the 127.0.0.1 mock.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09 Wave D).
 *
 * Scope: spawns the production `@comis/channels` IRC adapter against the
 * mock IRC server, drives an inbound PRIVMSG through the mock to the
 * adapter's `MessageHandler`, and asserts the production adapter's
 * outbound `sendMessage()` arrives on the mock's captured-PRIVMSG stream.
 *
 * What this proves end-to-end:
 *   1. Production credential validation (RFC 1459 NICK + USER → 001 welcome)
 *      reaches the mock server.
 *   2. The production wire-decoding path (`mapIrcToNormalized`) handles the
 *      mock's `:from!from@host PRIVMSG <channel> :<content>` frames.
 *   3. The production wire-encoding path (`PRIVMSG <channel> :<text>`)
 *      arrives at the mock's `captured` stream with the correct shape.
 *
 * What this does NOT prove: the full daemon → agent → LLM → response
 * loop. The full loop is covered by the channel-agnostic integration
 * tests under test/integration/ (background-completion-runner, etc.)
 * via the echo adapter. The E2E tier at this granularity owns the
 * adapter↔platform wire surface only.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockIrcServer, type MockIrcServer } from "./mocks/irc/mock-irc-server.js";
import { createIrcPlugin } from "@comis/channels";
import { createMockLogger } from "../support/mock-logger.js";
import type { ChannelPort, NormalizedMessage } from "@comis/core";

describe("E2E: irc × dm — IRC adapter wire roundtrip against the 127.0.0.1 mock (COV-15)", () => {
  let mock: MockIrcServer;
  let adapter: ChannelPort;
  let receivedInbound: NormalizedMessage[];

  beforeEach(async () => {
    mock = createMockIrcServer();
    const handle = await mock.start();
    const plugin = createIrcPlugin({
      host: handle.host,
      port: handle.port,
      nick: "testbot",
      tls: false,
      channels: ["#test"],
      logger: createMockLogger(),
    });
    adapter = plugin.adapter;
    receivedInbound = [];
    adapter.onMessage(async (msg) => {
      receivedInbound.push(msg);
    });
    // Start the IRC adapter — registers NICK+USER, gets 001 welcome from mock.
    const startRes = await adapter.start();
    if (!startRes.ok) {
      throw startRes.error;
    }
    // Wait for the post-001 JOIN to settle (mock echoes JOIN + sends NAMREPLY).
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("captures bot outbound PRIVMSG with the correct channel + content on the mock", async () => {
    const sendRes = await adapter.sendMessage("#test", "Hello from comis-bot");
    expect(sendRes.ok).toBe(true);

    // Give the TCP write a tick to flush to the mock.
    await new Promise((r) => setTimeout(r, 100));
    const events = mock.getCapturedEvents();
    const privmsgs = events.filter((e) => e.type === "privmsg");
    expect(privmsgs.length).toBeGreaterThanOrEqual(1);
    expect(privmsgs[0].payload.target).toBe("#test");
    expect(privmsgs[0].payload.text).toContain("Hello from comis-bot");
  });

  it("delivers an inbound PRIVMSG from the mock to the production adapter's MessageHandler", async () => {
    mock.injectInboundMessage({
      from: "alice",
      channel: "#test",
      content: "Hello bot from alice",
    });

    // Poll-wait until the handler receives it, capped at 2s.
    const start = Date.now();
    while (receivedInbound.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedInbound.length).toBeGreaterThanOrEqual(1);
    const msg = receivedInbound[0]!;
    expect(msg.text).toContain("Hello bot from alice");
    expect(msg.channelType).toBe("irc");
  });

  it("registers the bot identity by completing the NICK + USER handshake at start time", () => {
    // The mock's `join` counter only increments when the adapter sends JOIN
    // — which only happens AFTER the 001 RPL_WELCOME from registration.
    // A non-zero join count therefore proves the registration handshake
    // round-tripped end-to-end through the mock.
    expect(mock.getRequestCount("join")).toBeGreaterThanOrEqual(1);
  });
});
