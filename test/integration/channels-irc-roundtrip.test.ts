// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: IRC channel — wire-level adapter roundtrip against the 127.0.0.1 mock.
 *
 * Lifts coverage on the `@comis/channels` IRC subpackage.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockIrcServer,
  type MockIrcServer,
} from "../e2e/mocks/irc/mock-irc-server.js";
import { createIrcPlugin } from "@comis/channels";
import { createMockLogger } from "../support/mock-logger.js";
import type { ChannelPort, NormalizedMessage } from "@comis/core";

describe("INTEGRATION: irc channel — adapter wire roundtrip", () => {
  let mock: MockIrcServer;
  let adapter: ChannelPort | undefined;
  let receivedInbound: NormalizedMessage[];

  beforeEach(async () => {
    mock = createMockIrcServer();
    const handle = await mock.start();
    const plugin = createIrcPlugin({
      host: handle.host,
      port: handle.port,
      nick: "intbot",
      tls: false,
      channels: ["#int"],
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
    await new Promise((r) => setTimeout(r, 200));
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

  it("adapter.sendMessage emits PRIVMSG with correct channel + content", async () => {
    const sendRes = await adapter!.sendMessage(
      "#int",
      "Integration test PRIVMSG",
    );
    expect(sendRes.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const events = mock.getCapturedEvents();
    const privmsgs = events.filter((e) => e.type === "privmsg");
    expect(privmsgs.length).toBeGreaterThanOrEqual(1);
    expect(privmsgs[0]!.payload.target).toBe("#int");
    expect(privmsgs[0]!.payload.text).toContain("Integration test PRIVMSG");
  });

  it("inbound PRIVMSG reaches adapter's MessageHandler", async () => {
    mock.injectInboundMessage({
      from: "alice-int",
      channel: "#int",
      content: "Hi bot from alice-int",
    });

    const start = Date.now();
    while (receivedInbound.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedInbound.length).toBeGreaterThanOrEqual(1);
    const msg = receivedInbound[0]!;
    expect(msg.text).toContain("Hi bot from alice-int");
    expect(msg.channelType).toBe("irc");
  });

  it("NICK + USER handshake completes through the mock (JOIN count > 0)", () => {
    expect(mock.getRequestCount("join")).toBeGreaterThanOrEqual(1);
  });
});
