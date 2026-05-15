// SPDX-License-Identifier: Apache-2.0
/**
 * Mock Discord server for E2E flow-matrix coverage.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09).
 *
 * Wire surface: an HTTP server (REST API) PLUS a WebSocket server (gateway)
 * speaking just enough of Discord's wire protocol to satisfy a discord.js
 * Client. Implemented endpoints/events:
 *
 *   REST (https://discord.com/api/v10 → http://127.0.0.1:<port>/api/v10):
 *     - GET  /api/v10/users/@me — bot identity (validateDiscordToken)
 *     - GET  /api/v10/gateway/bot — returns ws://127.0.0.1:<port> as gateway URL
 *     - POST /api/v10/channels/<id>/messages — captures bot outbound messages
 *     - generic accept-and-record fallback for unknown REST endpoints
 *
 *   Gateway (WebSocket, hosted on the SAME http server):
 *     - On client connect: send op:10 HELLO with heartbeat_interval=45000
 *     - On op:1 (HEARTBEAT) and op:2 (IDENTIFY): reply op:11 (HEARTBEAT_ACK)
 *       and op:0 t=READY respectively
 *     - injectInboundMessage → send op:0 t=MESSAGE_CREATE to the bot
 *
 * Security posture (T-MOCK-EXPOSED-PORT, mirrors mock-oauth-server.ts):
 * binds to loopback (127.0.0.1) only — never a wildcard host. Kernel
 * allocates the port via `server.listen(0)` to avoid port collisions.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface CapturedDiscordEvent {
  readonly type: "send-message" | "users-me" | "gateway-bot" | "ws-identify" | "ws-heartbeat" | "other";
  readonly payload: {
    readonly channelId?: string;
    readonly content?: string;
    readonly method?: string;
    readonly url?: string;
    readonly rawBody?: string;
  };
  readonly timestamp: number;
}

export interface MockDiscordServer {
  start(): Promise<{ port: number; baseUrl: string; wsUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedDiscordEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedDiscordEvent>;
  /**
   * Inject an inbound MESSAGE_CREATE event to every connected gateway client.
   * Picks Discord-style snowflake IDs to be realistic.
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  reset(): void;
}

export function createMockDiscordServer(): MockDiscordServer {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  const captured: CapturedDiscordEvent[] = [];
  const counters = new Map<string, number>();
  const openWsClients = new Set<WebSocket>();
  const openSockets = new Set<NetSocket>();
  let nextSnowflake = 1000n;

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }
  function nextId(): string {
    nextSnowflake += 1n;
    return nextSnowflake.toString();
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

  async function httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const body = await readBody(req);

    // GET /api/v10/users/@me — bot identity for validateDiscordToken.
    if (method === "GET" && /^\/api\/v\d+\/users\/@me$/.test(url)) {
      bump("users-me");
      captured.push({
        type: "users-me",
        payload: { method, url },
        timestamp: Date.now(),
      });
      send(res, 200, {
        id: "9999999999999",
        username: "test_bot",
        discriminator: "0",
        bot: true,
      });
      return;
    }

    // GET /api/v10/gateway/bot — returns the gateway URL.
    if (method === "GET" && /^\/api\/v\d+\/gateway\/bot$/.test(url)) {
      bump("gateway-bot");
      captured.push({
        type: "gateway-bot",
        payload: { method, url },
        timestamp: Date.now(),
      });
      const addr = server!.address() as AddressInfo;
      send(res, 200, {
        url: `ws://127.0.0.1:${addr.port}`,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 0,
          max_concurrency: 1,
        },
      });
      return;
    }

    // GET /api/v10/gateway — public gateway URL (no auth).
    if (method === "GET" && /^\/api\/v\d+\/gateway$/.test(url)) {
      bump("gateway-bot");
      const addr = server!.address() as AddressInfo;
      send(res, 200, { url: `ws://127.0.0.1:${addr.port}` });
      return;
    }

    // POST /api/v10/channels/<id>/messages — bot outbound capture.
    const sendMatch = url.match(/^\/api\/v\d+\/channels\/([^/]+)\/messages(?:\?.*)?$/);
    if (method === "POST" && sendMatch) {
      bump("send-message");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // Multipart for attachments — partial parse: extract content if present.
        const m = body.match(/"content"\s*:\s*"([^"]*)"/);
        if (m) parsed["content"] = m[1];
      }
      const content = (parsed["content"] as string | undefined) ?? "";
      const channelId = sendMatch[1];
      captured.push({
        type: "send-message",
        payload: { channelId, content, method, url, rawBody: body },
        timestamp: Date.now(),
      });
      // Discord returns the created message; minimal-viable shape.
      const msgId = nextId();
      send(res, 200, {
        id: msgId,
        channel_id: channelId,
        type: 0,
        content,
        author: { id: "9999999999999", username: "test_bot", bot: true, discriminator: "0" },
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
      });
      return;
    }

    // Generic accept-and-record fallback.
    bump("other");
    captured.push({
      type: "other",
      payload: { method, url, rawBody: body },
      timestamp: Date.now(),
    });
    // Most discord.js error paths tolerate a generic 200 OK with empty body.
    send(res, 200, {});
  }

  function onWsConnection(ws: WebSocket): void {
    openWsClients.add(ws);
    ws.on("close", () => openWsClients.delete(ws));
    ws.on("error", () => {
      // Suppress — tests may close connections mid-flight.
    });

    // Send HELLO (op 10) immediately so discord.js starts heartbeating.
    ws.send(
      JSON.stringify({
        op: 10,
        d: { heartbeat_interval: 45000, _trace: ["mock-discord"] },
      }),
    );

    ws.on("message", (data) => {
      let payload: { op?: number; t?: string; d?: unknown };
      try {
        payload = JSON.parse(data.toString()) as { op?: number; t?: string; d?: unknown };
      } catch {
        return;
      }
      const op = payload.op;
      if (op === 1) {
        // Client HEARTBEAT — reply HEARTBEAT_ACK.
        bump("ws-heartbeat");
        ws.send(JSON.stringify({ op: 11 }));
        return;
      }
      if (op === 2) {
        // IDENTIFY — reply READY (op 0, t=READY) with minimal user shape.
        bump("ws-identify");
        captured.push({
          type: "ws-identify",
          payload: {},
          timestamp: Date.now(),
        });
        ws.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              v: 10,
              user: {
                id: "9999999999999",
                username: "test_bot",
                discriminator: "0",
                bot: true,
                mfa_enabled: false,
                verified: true,
                flags: 0,
              },
              user_settings: {},
              guilds: [],
              relationships: [],
              private_channels: [],
              presences: [],
              session_id: "mock-session-id",
              session_type: "normal",
              resume_gateway_url: `ws://127.0.0.1:${(server!.address() as AddressInfo).port}`,
              shard: [0, 1],
              application: { id: "9999999999999", flags: 0 },
              geo_ordered_rtc_regions: [],
            },
          }),
        );
      }
      // op 3 (PRESENCE_UPDATE), op 4 (VOICE_STATE_UPDATE), op 6 (RESUME),
      // op 7 (RECONNECT), op 8 (REQUEST_GUILD_MEMBERS) — silently accept.
    });
  }

  let sequenceNumber = 1;

  const api: MockDiscordServer = {
    async start() {
      server = createServer((req, res) => {
        void httpHandler(req, res);
      });
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
        wsUrl: `ws://127.0.0.1:${port}`,
      };
    },
    async stop() {
      if (!server) return;
      const localServer = server;
      const localWss = wss;
      server = undefined;
      wss = undefined;
      // Close all WS clients first so the WSS close() returns.
      for (const ws of openWsClients) {
        try {
          ws.terminate();
        } catch {
          // Swallow — connection may already be torn down.
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
      const messageId = nextId();
      const userId = nextId();
      const event = {
        op: 0,
        s: ++sequenceNumber,
        t: "MESSAGE_CREATE",
        d: {
          id: messageId,
          channel_id: opts.channel,
          guild_id: null,
          author: {
            id: userId,
            username: opts.from,
            discriminator: "0",
            bot: false,
          },
          content: opts.content,
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          type: 0,
        },
      };
      const json = JSON.stringify(event);
      for (const ws of openWsClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(json);
        }
      }
    },
    reset() {
      captured.length = 0;
      counters.clear();
      sequenceNumber = 1;
      nextSnowflake = 1000n;
    },
  };

  return Object.freeze(api);
}
