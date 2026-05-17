// SPDX-License-Identifier: Apache-2.0
/**
 * Mock signal-cli REST/SSE server for E2E flow-matrix coverage.
 *
 * Wire surface: an HTTP server speaking the subset of signal-cli's
 * JSON-RPC + SSE interface that the signal adapter consumes:
 *
 *   - GET  /api/v1/check                  — health probe (returns {ok:true})
 *   - POST /api/v1/rpc                    — JSON-RPC 2.0; supported methods:
 *       - listAccounts → returns the configured account(s)
 *       - send         → captures outbound message, returns {id:"<uuid>"}
 *       - others (sendReaction, sendReceipt, version) → generic ok
 *   - GET  /api/v1/events?account=<n>     — SSE; emits queued inbound
 *                                            envelopes from injectInbound...
 *
 * The signal adapter's `baseUrl` config already accepts a 127.0.0.1 URL
 * verbatim (no apiRoot redirection needed — baseUrl IS the redirection
 * seam for signal-cli channels).
 *
 * Security posture: binds loopback only; listen(0) for kernel-allocated
 * port.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";

export interface CapturedSignalEvent {
  readonly type: "rpc-send" | "rpc-list-accounts" | "rpc-other" | "sse-connect" | "check";
  readonly payload: {
    readonly method?: string;
    /**
     * signal-cli accepts EITHER a single recipient string OR an array of
     * recipients. The production signal adapter wraps single-recipient DMs
     * as a one-element array (`recipient: [chatId]`). Group sends use
     * `groupId` instead and leave `recipient` undefined.
     */
    readonly recipient?: string | ReadonlyArray<string>;
    readonly groupId?: string;
    readonly text?: string;
    readonly rawBody?: string;
  };
  readonly timestamp: number;
}

export interface MockSignalServer {
  start(): Promise<{ port: number; baseUrl: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedSignalEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedSignalEvent>;
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  reset(): void;
}

export function createMockSignalServer(): MockSignalServer {
  let server: Server | undefined;
  const captured: CapturedSignalEvent[] = [];
  const counters = new Map<string, number>();
  const openSockets = new Set<NetSocket>();
  // SSE clients (long-poll). Send queued envelopes when a client connects.
  const sseClients = new Set<ServerResponse>();
  const queuedEnvelopes: Array<Record<string, unknown>> = [];
  let nextTimestamp = 1_700_000_000_000;

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

  function sendSseFrame(res: ServerResponse, eventType: string, data: unknown): void {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "GET" && /^\/api\/v1\/check(?:\?.*)?$/.test(url)) {
      bump("check");
      captured.push({
        type: "check",
        payload: { method },
        timestamp: Date.now(),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && /^\/api\/v1\/events(?:\?.*)?$/.test(url)) {
      bump("sse-connect");
      captured.push({
        type: "sse-connect",
        payload: { method },
        timestamp: Date.now(),
      });
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.write("\n"); // Initial flush
      sseClients.add(res);
      // Drain any pre-queued envelopes.
      for (const env of queuedEnvelopes) {
        sendSseFrame(res, "receive", env);
      }
      queuedEnvelopes.length = 0;
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (method === "POST" && /^\/api\/v1\/rpc(?:\?.*)?$/.test(url)) {
      const body = await readBody(req);
      let parsed: { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: number };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return;
      }
      const rpcMethod = parsed.method ?? "";

      if (rpcMethod === "listAccounts") {
        bump("rpc-list-accounts");
        captured.push({
          type: "rpc-list-accounts",
          payload: { method: rpcMethod, rawBody: body },
          timestamp: Date.now(),
        });
        sendJson(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, result: [{ account: "+15555550100" }] });
        return;
      }

      if (rpcMethod === "send") {
        bump("rpc-send");
        const params = parsed.params ?? {};
        // signal-cli accepts both shapes; preserve verbatim so the test can
        // assert on whichever the production adapter produced.
        const recipient = (params["recipient"] as string | ReadonlyArray<string> | undefined);
        const groupId = (params["groupId"] as string | undefined);
        const text = (params["message"] as string | undefined) ?? "";
        captured.push({
          type: "rpc-send",
          payload: {
            method: rpcMethod,
            ...(recipient !== undefined ? { recipient } : {}),
            ...(groupId !== undefined ? { groupId } : {}),
            text,
            rawBody: body,
          },
          timestamp: Date.now(),
        });
        nextTimestamp += 1;
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: parsed.id ?? 1,
          result: { timestamp: nextTimestamp },
        });
        return;
      }

      bump("rpc-other");
      captured.push({
        type: "rpc-other",
        payload: { method: rpcMethod, rawBody: body },
        timestamp: Date.now(),
      });
      sendJson(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, result: {} });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const api: MockSignalServer = {
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
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          // Swallow.
        }
      }
      sseClients.clear();
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
      nextTimestamp += 1;
      // Signal-cli envelope shape per the adapter's SignalEnvelope interface
      // (packages/channels/src/signal/signal-client.ts:30). Flat keys (source,
      // sourceUuid, dataMessage) — NOT wrapped in an outer `envelope:` key.
      const envelope = {
        source: opts.from,
        sourceNumber: opts.from,
        sourceUuid: "00000000-0000-0000-0000-000000000000",
        sourceName: opts.from,
        timestamp: nextTimestamp,
        dataMessage: {
          timestamp: nextTimestamp,
          message: opts.content,
          ...(opts.channel.startsWith("group:")
            ? { groupInfo: { groupId: opts.channel.slice("group:".length) } }
            : {}),
        },
      };
      // If any SSE clients are connected, push immediately; else queue.
      if (sseClients.size > 0) {
        const json = JSON.stringify(envelope);
        for (const res of sseClients) {
          res.write(`event: receive\n`);
          res.write(`data: ${json}\n\n`);
        }
      } else {
        queuedEnvelopes.push(envelope);
      }
    },
    reset() {
      captured.length = 0;
      counters.clear();
      queuedEnvelopes.length = 0;
      nextTimestamp = 1_700_000_000_000;
    },
  };

  return Object.freeze(api);
}
