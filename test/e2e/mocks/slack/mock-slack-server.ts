// SPDX-License-Identifier: Apache-2.0
/**
 * Mock Slack Web API server for E2E flow-matrix coverage.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09).
 *
 * Wire surface: an HTTP server speaking just enough of Slack's Web API
 * (https://api.slack.com/methods) to satisfy a @slack/bolt App running
 * in `mode='http'` (the E2E path; Socket Mode connects to
 * wss-primary.slack.com directly and cannot be redirected).
 *
 *   - POST /api/auth.test — bot identity for validateSlackCredentials
 *   - POST /api/chat.postMessage — captures bot outbound messages
 *   - POST /api/* — generic accept-and-record fallback so adapter calls
 *     to chat.update, reactions.add, conversations.info, etc. don't fail.
 *
 *   Inbound events: instead of mocking Slack's Events API webhook (which
 *   would require the daemon's gateway to be running on a known port and
 *   the mock to POST to it), `injectInboundMessage` returns the event
 *   payload as a getCapturedEvents entry of type 'pending-inbound' for
 *   the test to dispatch to the gateway directly. This matches Slack's
 *   HTTP/Events mode pattern (events arrive via webhook, not poll).
 *
 * Security posture (T-MOCK-EXPOSED-PORT): binds to loopback (127.0.0.1)
 * only; listen(0) for kernel-allocated ephemeral port.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";

export interface CapturedSlackEvent {
  readonly type: "auth-test" | "post-message" | "pending-inbound" | "other";
  readonly payload: {
    readonly method?: string;
    readonly url?: string;
    readonly channel?: string;
    readonly text?: string;
    readonly userId?: string;
    readonly rawBody?: string;
  };
  readonly timestamp: number;
}

export interface MockSlackServer {
  start(): Promise<{ port: number; baseUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedSlackEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedSlackEvent>;
  /**
   * Queue an inbound Slack `event_callback` payload. Returns the payload
   * the caller can POST to the daemon's gateway events endpoint (Slack
   * HTTP mode pattern).
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): {
    eventCallback: Record<string, unknown>;
  };
  reset(): void;
}

export function createMockSlackServer(): MockSlackServer {
  let server: Server | undefined;
  const captured: CapturedSlackEvent[] = [];
  const counters = new Map<string, number>();
  const openSockets = new Set<NetSocket>();
  let nextTs = 1_700_000_000;

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

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  function parseBody(body: string, contentType: string | undefined): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    if (contentType?.includes("application/json")) {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return parsed;
      }
    }
    // application/x-www-form-urlencoded
    for (const part of body.split("&")) {
      const [k, v] = part.split("=");
      if (k && v !== undefined) {
        parsed[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
      }
    }
    return parsed;
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const body = await readBody(req);

    if (method === "POST" && /^\/api\/auth\.test(?:\?.*)?$/.test(url)) {
      bump("auth-test");
      captured.push({
        type: "auth-test",
        payload: { method, url },
        timestamp: Date.now(),
      });
      send(res, 200, {
        ok: true,
        url: "https://test-workspace.slack.com/",
        team: "test-workspace",
        team_id: "T12345",
        user: "test_bot",
        user_id: "U_BOT_123",
        bot_id: "B_BOT_123",
      });
      return;
    }

    if (method === "POST" && /^\/api\/chat\.postMessage(?:\?.*)?$/.test(url)) {
      bump("post-message");
      const parsed = parseBody(body, req.headers["content-type"]);
      const channel = (parsed["channel"] as string | undefined) ?? "";
      const text = (parsed["text"] as string | undefined) ?? "";
      captured.push({
        type: "post-message",
        payload: { channel, text, method, url, rawBody: body },
        timestamp: Date.now(),
      });
      nextTs += 1;
      send(res, 200, {
        ok: true,
        channel,
        ts: `${nextTs}.000100`,
        message: { type: "message", text, user: "U_BOT_123", ts: `${nextTs}.000100` },
      });
      return;
    }

    // Catch-all for any other Slack Web API method.
    bump("other");
    captured.push({
      type: "other",
      payload: { method, url, rawBody: body },
      timestamp: Date.now(),
    });
    send(res, 200, { ok: true });
  }

  const api: MockSlackServer = {
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
      nextTs += 1;
      const eventCallback = {
        token: "test-verification-token",
        team_id: "T12345",
        api_app_id: "A12345",
        event: {
          type: "message",
          channel: opts.channel,
          user: opts.from,
          text: opts.content,
          ts: `${nextTs}.000100`,
          event_ts: `${nextTs}.000100`,
        },
        type: "event_callback",
        event_id: `Ev${nextTs}`,
        event_time: nextTs,
      };
      captured.push({
        type: "pending-inbound",
        payload: { channel: opts.channel, userId: opts.from, text: opts.content },
        timestamp: Date.now(),
      });
      return { eventCallback };
    },
    reset() {
      captured.length = 0;
      counters.clear();
      nextTs = 1_700_000_000;
    },
  };

  return Object.freeze(api);
}
