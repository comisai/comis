// SPDX-License-Identifier: Apache-2.0
/**
 * Mock Telegram Bot API server for E2E flow-matrix coverage.
 *
 * Wire surface: an HTTP server speaking just enough of Telegram's Bot API
 * (https://core.telegram.org/bots/api) to satisfy the grammy adapter under
 * test. Implemented endpoints:
 *
 *   - POST /bot<TOKEN>/getMe — returns a stub bot identity for the
 *     adapter's start-time credential check (`validateBotToken`).
 *   - GET  /bot<TOKEN>/getUpdates — long-poll endpoint; returns queued
 *     inbound updates from `injectInboundMessage` and clears the queue.
 *   - POST /bot<TOKEN>/sendMessage — captures bot outbound messages.
 *   - POST /bot<TOKEN>/* — generic accept-and-record fallback so unknown
 *     method calls (setMyCommands, getChat, etc.) don't crash the adapter.
 *
 * Security posture (mirrors mock-oauth-server.ts): binds to loopback
 * (127.0.0.1) only — never a wildcard host — so the mock is unreachable
 * from the LAN. Kernel allocates the port via `server.listen(0)` to avoid
 * port-collision races between parallel test runs.
 *
 * The telegram adapter's `apiRoot` config field accepts a URL like
 * `http://127.0.0.1:<port>` and grammy uses it as the API root — no
 * path-prefix needed. The mock therefore matches paths of shape
 * `/bot<TOKEN>/<method>`.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedTelegramEvent {
  readonly type: "send-message" | "get-updates" | "get-me" | "set-my-commands" | "other";
  readonly payload: {
    readonly method: string;
    readonly chatId?: string | number;
    readonly text?: string;
    readonly rawBody: string;
  };
  readonly timestamp: number;
}

export interface MockTelegramServer {
  start(): Promise<{ port: number; baseUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedTelegramEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedTelegramEvent>;
  /**
   * Queue an inbound update for the next getUpdates poll. The mock auto-
   * assigns sequential `update_id` and `message_id` values so each call
   * produces a fresh, ordered update.
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  reset(): void;
}

export function createMockTelegramServer(): MockTelegramServer {
  let server: Server | undefined;
  const captured: CapturedTelegramEvent[] = [];
  const counters = new Map<string, number>();
  // Each entry is a Telegram Update object queued for the next getUpdates poll.
  const queuedUpdates: Array<Record<string, unknown>> = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;

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

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    // Path shape: /bot<TOKEN>/<method>[?qs]
    const match = url.match(/^\/bot[^/]+\/([^?]+)(?:\?(.*))?$/);
    if (!match) {
      send(res, 404, { ok: false, error_code: 404, description: "Not found" });
      return;
    }
    const method = match[1];
    const body = await readBody(req);

    if (method === "getMe") {
      bump("get-me");
      captured.push({
        type: "get-me",
        payload: { method: "getMe", rawBody: body },
        timestamp: Date.now(),
      });
      send(res, 200, {
        ok: true,
        result: {
          id: 12345,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      });
      return;
    }

    if (method === "getUpdates") {
      bump("get-updates");
      captured.push({
        type: "get-updates",
        payload: { method: "getUpdates", rawBody: body },
        timestamp: Date.now(),
      });
      // Drain the queue per long-poll convention. Grammy's runner will
      // re-poll quickly so a per-poll drain is the right semantics.
      const result = [...queuedUpdates];
      queuedUpdates.length = 0;
      send(res, 200, { ok: true, result });
      return;
    }

    if (method === "sendMessage") {
      bump("send-message");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // Form-encoded fallback if grammy didn't switch to JSON.
        for (const part of body.split("&")) {
          const [k, v] = part.split("=");
          if (k && v !== undefined) {
            parsed[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
          }
        }
      }
      const chatId = (parsed["chat_id"] as string | number | undefined) ?? "";
      const text = (parsed["text"] as string | undefined) ?? "";
      captured.push({
        type: "send-message",
        payload: { method: "sendMessage", chatId, text, rawBody: body },
        timestamp: Date.now(),
      });
      // Telegram echoes the sent message back; grammy uses message_id from
      // the response. Return a realistic shape so the adapter's send-path
      // success branch fires.
      const msgId = nextMessageId++;
      send(res, 200, {
        ok: true,
        result: {
          message_id: msgId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId) || 0, type: "private" },
          text,
        },
      });
      return;
    }

    if (method === "setMyCommands") {
      bump("set-my-commands");
      captured.push({
        type: "set-my-commands",
        payload: { method: "setMyCommands", rawBody: body },
        timestamp: Date.now(),
      });
      send(res, 200, { ok: true, result: true });
      return;
    }

    // Catch-all for any other method (getChat, getFile, etc.) — record
    // and reply with a generic success so the adapter doesn't fail.
    bump("other");
    captured.push({
      type: "other",
      payload: { method, rawBody: body },
      timestamp: Date.now(),
    });
    send(res, 200, { ok: true, result: {} });
  }

  const api: MockTelegramServer = {
    async start() {
      server = createServer((req, res) => {
        void handler(req, res);
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
      const chatNum = Number(opts.channel) || 100;
      const fromId = Number(opts.from.replace(/\D/g, "")) || 200;
      queuedUpdates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: nextMessageId++,
          from: {
            id: fromId,
            is_bot: false,
            first_name: opts.from,
            username: opts.from,
          },
          chat: { id: chatNum, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: opts.content,
        },
      });
    },
    reset() {
      captured.length = 0;
      counters.clear();
      queuedUpdates.length = 0;
      nextUpdateId = 1;
      nextMessageId = 100;
    },
  };

  return Object.freeze(api);
}
