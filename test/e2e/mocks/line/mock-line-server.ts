// SPDX-License-Identifier: Apache-2.0
/**
 * Mock LINE Messaging API server for E2E flow-matrix coverage.
 *
 * Wire surface: an HTTP server speaking just enough of LINE's Messaging
 * API to satisfy a @line/bot-sdk MessagingApiClient configured with
 * baseURL='http://127.0.0.1:<port>'. Endpoints:
 *
 *   - GET  /v2/bot/info                — bot identity for validateLineCredentials
 *   - POST /v2/bot/message/push        — captures bot outbound push messages
 *   - POST /v2/bot/message/reply       — captures bot outbound reply messages
 *   - generic accept-and-record fallback for unknown endpoints
 *
 * Inbound events: LINE pushes events via webhook to the daemon's gateway.
 * `injectInboundMessage` returns the webhook payload for the test to POST
 * to the gateway directly (matches LINE's webhook-only inbound pattern).
 *
 * Security posture: binds loopback only; listen(0) for kernel-allocated
 * port.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";

export interface CapturedLineEvent {
  readonly type: "bot-info" | "push-message" | "reply-message" | "pending-inbound" | "other";
  readonly payload: {
    readonly method?: string;
    readonly url?: string;
    readonly to?: string;
    readonly text?: string;
    readonly rawBody?: string;
  };
  readonly timestamp: number;
}

export interface MockLineServer {
  start(): Promise<{ port: number; baseUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedLineEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedLineEvent>;
  injectInboundMessage(opts: { from: string; channel: string; content: string }): {
    webhookEvent: Record<string, unknown>;
  };
  reset(): void;
}

export function createMockLineServer(): MockLineServer {
  let server: Server | undefined;
  const captured: CapturedLineEvent[] = [];
  const counters = new Map<string, number>();
  const openSockets = new Set<NetSocket>();
  let nextMessageId = 1_700_000_000;

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      req.on("end", () => resolve(body));
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const body = await readBody(req);

    if (method === "GET" && /^\/v2\/bot\/info(?:\?.*)?$/.test(url)) {
      bump("bot-info");
      captured.push({
        type: "bot-info",
        payload: { method, url },
        timestamp: Date.now(),
      });
      sendJson(res, 200, {
        userId: "U_BOT_LINE_123",
        basicId: "@testbot",
        displayName: "TestBot",
        chatMode: "bot",
        markAsReadMode: "auto",
      });
      return;
    }

    if (method === "POST" && /^\/v2\/bot\/message\/push(?:\?.*)?$/.test(url)) {
      bump("push-message");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // Tolerate malformed body.
      }
      const to = (parsed["to"] as string | undefined) ?? "";
      const msgs = (parsed["messages"] as Array<{ text?: string }> | undefined) ?? [];
      const text = msgs[0]?.text ?? "";
      captured.push({
        type: "push-message",
        payload: { method, url, to, text, rawBody: body },
        timestamp: Date.now(),
      });
      // LINE returns 200 with empty body on push success.
      sendJson(res, 200, {});
      return;
    }

    if (method === "POST" && /^\/v2\/bot\/message\/reply(?:\?.*)?$/.test(url)) {
      bump("reply-message");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // Tolerate.
      }
      const msgs = (parsed["messages"] as Array<{ text?: string }> | undefined) ?? [];
      const text = msgs[0]?.text ?? "";
      captured.push({
        type: "reply-message",
        payload: { method, url, text, rawBody: body },
        timestamp: Date.now(),
      });
      sendJson(res, 200, {});
      return;
    }

    bump("other");
    captured.push({
      type: "other",
      payload: { method, url, rawBody: body },
      timestamp: Date.now(),
    });
    sendJson(res, 200, {});
  }

  const api: MockLineServer = {
    async start() {
      server = createServer((req, res) => {
        void handler(req, res);
      });
      server.on("connection", (sock) => {
        openSockets.add(sock);
        sock.once("close", () => openSockets.delete(sock));
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      return { port, baseUrl: `http://127.0.0.1:${port}` };
    },
    async stop() {
      if (!server) return;
      const local = server;
      server = undefined;
      for (const s of openSockets) {
        s.destroy();
      }
      openSockets.clear();
      await new Promise<void>((resolve, reject) => {
        local.close((err) => {
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
      nextMessageId += 1;
      const webhookEvent = {
        destination: "U_BOT_LINE_123",
        events: [
          {
            type: "message",
            mode: "active",
            timestamp: Date.now(),
            source: {
              type: opts.channel.startsWith("C_") ? "group" : "user",
              userId: opts.from,
              ...(opts.channel.startsWith("C_") ? { groupId: opts.channel } : {}),
            },
            webhookEventId: `01HABCDEFGHIJK${nextMessageId}`,
            deliveryContext: { isRedelivery: false },
            message: {
              id: `${nextMessageId}`,
              type: "text",
              text: opts.content,
            },
            replyToken: `RT_${nextMessageId}`,
          },
        ],
      };
      captured.push({
        type: "pending-inbound",
        payload: {
          to: opts.channel,
          text: opts.content,
        },
        timestamp: Date.now(),
      });
      return { webhookEvent };
    },
    reset() {
      captured.length = 0;
      counters.clear();
      nextMessageId = 1_700_000_000;
    },
  };

  return Object.freeze(api);
}
