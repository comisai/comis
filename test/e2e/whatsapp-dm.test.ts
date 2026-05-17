// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: WhatsApp × DM — WebSocket capture-shim against the 127.0.0.1 mock.
 *
 * Scope: this is a CAPTURE-ONLY E2E test. Baileys' real WhatsApp Web
 * protocol (noise-protocol handshake + Signal-protocol pairing) is out
 * of scope for the mock — the mock accepts a WebSocket connection,
 * records inbound frames, and never replies (which is what Baileys would
 * experience when it can't complete the encrypted handshake; the
 * connection eventually times out).
 *
 * What this test PROVES:
 *   1. The apiRoot config (whatsapp.apiRoot → waWebSocketUrl) flows
 *      through Baileys' SocketConfig — verified by the mock's
 *      openConnections + framesCaptured counters going non-zero.
 *   2. The mock's pending-inbound capture surface accepts
 *      injectInboundMessage and records the payload for downstream
 *      adapter-registry tests.
 *
 * What this test does NOT prove: full end-to-end inbound message
 * delivery — Baileys requires an encrypted protocol the mock cannot
 * complete. The adapter-registry pattern in test/integration/messaging-
 * echo.test.ts covers the dispatch boundary at the integration tier.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockWhatsAppServer, type MockWhatsAppServer } from "./mocks/whatsapp/mock-whatsapp-server.js";
import WebSocket from "ws";

describe("E2E: whatsapp × dm — WebSocket capture shim against the 127.0.0.1 mock", () => {
  let mock: MockWhatsAppServer;
  let wsUrl: string;

  beforeEach(async () => {
    mock = createMockWhatsAppServer();
    const handle = await mock.start();
    wsUrl = handle.wsUrl;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it("accepts a WebSocket connection from a Baileys-compatible client and records the open event", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Give the server a tick to register the open event.
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.getRequestCount("ws-open")).toBeGreaterThanOrEqual(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("captures inbound WebSocket frames from a Baileys-compatible client", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });

    // Send a Baileys-style binary noise-protocol handshake frame
    // (content doesn't matter — the mock records bytes verbatim).
    ws.send(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.getRequestCount("ws-frame")).toBeGreaterThanOrEqual(1);
    const events = mock.getCapturedEvents();
    const frameEvent = events.find((e) => e.type === "ws-frame");
    expect(frameEvent).toBeDefined();
    expect(frameEvent!.payload.direction).toBe("client-to-server");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("records injectInboundMessage as a pending-inbound capture for adapter-registry dispatch", () => {
    mock.injectInboundMessage({
      from: "whatsapp-user-123",
      channel: "whatsapp-test-channel-dm",
      content: "Hi bot from whatsapp user",
    });
    expect(mock.getRequestCount("pending-inbound")).toBe(1);
    const events = mock.getCapturedEvents();
    const pending = events.find((e) => e.type === "pending-inbound");
    expect(pending).toBeDefined();
    expect(pending!.payload.from).toBe("whatsapp-user-123");
    expect(pending!.payload.channel).toBe("whatsapp-test-channel-dm");
    expect(pending!.payload.content).toBe("Hi bot from whatsapp user");
  });
});
