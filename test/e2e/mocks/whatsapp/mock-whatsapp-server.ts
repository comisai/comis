// SPDX-License-Identifier: Apache-2.0
/**
 * Mock WhatsApp WebSocket server for E2E flow-matrix coverage.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09).
 *
 * Wire surface: a WebSocket server emulating WhatsApp Web's gateway
 * endpoint (wss://web.whatsapp.com/ws/chat → ws://127.0.0.1:<port>/ws/chat).
 *
 * IMPORTANT — minimal-viable scope: Baileys' real WhatsApp Web protocol
 * uses encrypted noise-protocol handshakes, Signal-protocol pairing,
 * pre-keys, and a complex multi-device protocol. Faithfully reproducing
 * this in a mock is out of scope for E2E coverage (Plan 40-09 minimal-
 * viable per Wave A operator decision).
 *
 * Instead, this mock provides a TYPED CAPTURE SHIM: a stand-in WebSocket
 * endpoint that records connection attempts + outgoing frames. Tests
 * that need to drive WhatsApp E2E flows MUST use the daemon's existing
 * `EchoChannelAdapter` (channel-agnostic adapterRegistry pattern) for
 * inbound — the daemon dispatches through whatsapp.adapter.sendMessage,
 * which is the boundary this mock captures.
 *
 * Security posture (T-MOCK-EXPOSED-PORT): binds loopback only;
 * listen(0) for kernel-allocated port.
 *
 * @module
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface CapturedWhatsAppEvent {
  readonly type: "ws-open" | "ws-frame" | "ws-close" | "pending-inbound";
  readonly payload: {
    readonly direction?: "client-to-server" | "server-to-client";
    readonly data?: Buffer | string;
    readonly from?: string;
    readonly channel?: string;
    readonly content?: string;
  };
  readonly timestamp: number;
}

export interface MockWhatsAppServer {
  start(): Promise<{ port: number; baseUrl: string; wsUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedWhatsAppEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedWhatsAppEvent>;
  /**
   * Inject an inbound message. Records as 'pending-inbound' for the test
   * to dispatch through the daemon's adapterRegistry pattern (Baileys'
   * real wire format requires Signal-protocol crypto that is out of
   * scope for this minimal-viable mock).
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  reset(): void;
}

export function createMockWhatsAppServer(): MockWhatsAppServer {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  const captured: CapturedWhatsAppEvent[] = [];
  const counters = new Map<string, number>();
  const openWsClients = new Set<WebSocket>();
  const openSockets = new Set<NetSocket>();

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function onWsConnection(ws: WebSocket): void {
    openWsClients.add(ws);
    bump("ws-open");
    captured.push({
      type: "ws-open",
      payload: { direction: "client-to-server" },
      timestamp: Date.now(),
    });
    ws.on("message", (data) => {
      bump("ws-frame");
      captured.push({
        type: "ws-frame",
        payload: {
          direction: "client-to-server",
          data: typeof data === "string" ? data : Buffer.from(data as ArrayBuffer),
        },
        timestamp: Date.now(),
      });
      // Don't reply — Baileys would expect a noise-protocol handshake
      // which we do not implement. The connection will eventually time
      // out from the client's perspective.
    });
    ws.on("close", () => {
      openWsClients.delete(ws);
      bump("ws-close");
      captured.push({
        type: "ws-close",
        payload: {},
        timestamp: Date.now(),
      });
    });
    ws.on("error", () => {
      // Suppress.
    });
  }

  const api: MockWhatsAppServer = {
    async start() {
      server = createServer();
      server.on("connection", (sock) => {
        openSockets.add(sock);
        sock.once("close", () => openSockets.delete(sock));
      });
      wss = new WebSocketServer({ server });
      wss.on("connection", onWsConnection);
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws/chat`,
      };
    },
    async stop() {
      if (!server) return;
      const localServer = server;
      const localWss = wss;
      server = undefined;
      wss = undefined;
      for (const ws of openWsClients) {
        try {
          ws.terminate();
        } catch {
          // Swallow.
        }
      }
      openWsClients.clear();
      if (localWss) {
        await new Promise<void>((resolve) => {
          localWss.close(() => resolve());
        });
      }
      for (const s of openSockets) {
        s.destroy();
      }
      openSockets.clear();
      await new Promise<void>((resolve, reject) => {
        localServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    getRequestCount(eventType) {
      if (eventType !== undefined) {
        return counters.get(eventType) ?? 0;
      }
      let total = 0;
      for (const c of counters.values()) total += c;
      return total;
    },
    getCapturedEvents() {
      return captured;
    },
    injectInboundMessage(opts) {
      // Recorded; tests dispatch through the daemon's adapterRegistry.
      bump("pending-inbound");
      captured.push({
        type: "pending-inbound",
        payload: {
          from: opts.from,
          channel: opts.channel,
          content: opts.content,
        },
        timestamp: Date.now(),
      });
    },
    reset() {
      captured.length = 0;
      counters.clear();
    },
  };

  return Object.freeze(api);
}
