// SPDX-License-Identifier: Apache-2.0
/**
 * `http-backend` — the shared HTTP-protocol base for channel emulators.
 *
 * ONE `node:http` server bound to `127.0.0.1` only (kernel-allocated free port)
 * that hosts THREE route surfaces on the same loopback port:
 *
 *   1. the per-channel NATIVE wire surface — `/bot<token>/<method>` for
 *      Telegram's Bot API (the channel registers its method table via
 *      `registerNativeRoute`);
 *   2. the generic CONTROL surface — `/control/*` (the control API registers
 *      its routes via `registerControlRoute`);
 *   3. the FILE surface — `GET /file/bot<token>/<path>` (the channel registers
 *      its file route shape via `registerFileRoute`).
 *
 * The server core (loopback bind + kernel free-port + JSON responder + raw body
 * reader + path routing + 404-on-unmatched) is extracted VERBATIM from the
 * proven `test/e2e/mocks/telegram/mock-telegram-server.ts` (which already
 * round-trips against the production grammy adapter). This base knows NOTHING
 * about Telegram — Signal/LINE reuse it unchanged (channel-agnostic).
 *
 * Security posture (mirrors the mock): binds loopback ONLY — never a wildcard
 * host — so the (admin-scoped) control surface is unreachable from the
 * LAN. Malformed/unmatched requests return a 404 envelope
 * instead of crashing: handlers receive the RAW body string and
 * are never forced to parse, and the body reader fails closed on a socket error.
 * The `/control/*` branch is SEPARATE from the `/bot<token>/<method>` matcher so
 * the two surfaces can never be confused.
 *
 * This file lives under `test/` — outside every `packages` source-tree
 * ESLint/architecture rule — so it may use `node:http` and the catch-all
 * route-table freely, exactly as the existing mock + daemon-harness do.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The request context every route handler receives.
 *
 * `body` is the RAW request body as a string — handlers do their own
 * JSON/form-encoded parsing (a dual parse) so the base never crashes on
 * a malformed body.
 */
export interface RouteContext {
  /** The HTTP method (`GET`/`POST`/…). */
  readonly httpMethod: string;
  /** The full request path (no host), e.g. `/control/chats/42/messages`. */
  readonly path: string;
  /** The raw query string (after `?`), empty when absent. */
  readonly query: string;
  /** The RAW request body as a string (handlers parse it themselves). */
  readonly body: string;
}

/**
 * A route handler returns the HTTP status + a body.
 *
 * The body is normally a JSON-serializable value (the default path:
 * `application/json` + `JSON.stringify`). For the FILE route a body that is a
 * `Buffer` is written RAW — the stored file bytes
 * are served verbatim with `contentType` (defaulting to
 * `application/octet-stream`), NOT JSON-wrapped (`JSON.stringify(Buffer)` would
 * emit `{"type":"Buffer",...}`). A non-Buffer body is unaffected.
 */
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  /**
   * The `content-type` to send when `body` is a `Buffer` (the binary file
   * route). Ignored for a non-Buffer (JSON) body. Defaults to
   * `application/octet-stream` when a Buffer body omits it.
   */
  readonly contentType?: string;
}

/**
 * A native (Bot-API) route handler. Receives the matched method name
 * (`botMatch[1]`, e.g. `getMe`) plus the request context. The channel registers the
 * Telegram method table here.
 */
export type NativeRouteHandler = (
  method: string,
  ctx: RouteContext,
) => RouteResult | Promise<RouteResult>;

/**
 * A path predicate a channel supplies to `registerPathRoute` to claim an
 * ARBITRARY native-wire surface. Either a string
 * PREFIX (`path.startsWith(prefix)`) or a PREDICATE over the request path
 * (no query string). Lets a second HTTP-class channel (Signal serves
 * `/api/v1/{check,rpc,events}`) register its own surface WITHOUT the base
 * hard-coding any channel's path shape beyond the preserved Telegram
 * `BOT_PATH` default. The base owns surface discrimination; the channel owns
 * its internal sub-routing.
 */
export type PathMatcher = string | ((path: string) => boolean);

/**
 * A generalized path-route handler. Receives the base request context (the full
 * request path is on `ctx.path`). Registered with an arbitrary `PathMatcher`
 * so a channel's non-Telegram wire surface
 * (e.g. Signal's `/api/v1/rpc`) dispatches on the same loopback base.
 */
export type PathRouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

/**
 * A streaming (SSE) route handler. Unlike the
 * JSON/Buffer `RouteResult` handlers, it receives the RAW `IncomingMessage` +
 * `ServerResponse` so it can set `content-type: text/event-stream`, write SSE
 * frames over time (`event: …\ndata: …\n\n`), and register `res.on("close", …)`
 * for cleanup — the dispatcher does NOT route the response through `send()`, so
 * the connection stays OPEN. Signal's `GET /api/v1/events` inbound stream is the
 * driver. The base tracks the live response so `stop()` can drain it (the
 * handler should NOT call `res.end()` itself for a long-lived stream). The
 * handler runs synchronously on connect (it captures `res` for later writes).
 */
export type StreamRouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * A `/control/*` route handler. Receives the request context (the full
 * `/control/...` path is on `ctx.path`). The control API registers the control routes
 * here.
 */
export type ControlRouteHandler = (ctx: ControlRouteContext) => RouteResult | Promise<RouteResult>;

/** Control context — the base context (the `/control/...` path is on `ctx.path`). */
export type ControlRouteContext = RouteContext;

/**
 * A file route handler for `GET /file/bot<token>/<path>`. Receives the file
 * path AFTER `/file/bot<token>/` (e.g. `photos/file_1.jpg`) plus the context.
 * The channel registers the file route shape here.
 */
export type FileRouteHandler = (ctx: FileRouteContext) => RouteResult | Promise<RouteResult>;

/** File context — the base context plus the extracted post-token file path. */
export interface FileRouteContext extends RouteContext {
  /** The path after `/file/bot<token>/`, e.g. `photos/file_1.jpg`. */
  readonly filePath: string;
}

/**
 * The shared HTTP-protocol base. `start()`/`stop()` own the loopback server;
 * the `register*Route` verbs let the channel + control API attach their routes
 * to the SAME server.
 */
export interface HttpBackend {
  /** Boot the loopback server; returns `{ apiRoot: "http://127.0.0.1:<port>", port }`. */
  start(): Promise<{ apiRoot: string; port: number }>;
  /** Close the server, releasing the port. */
  stop(): Promise<void>;
  /** Register the native Bot-API method dispatch (`/bot<token>/<method>`). */
  registerNativeRoute(handler: NativeRouteHandler): void;
  /**
   * Register a generalized native-wire route under an ARBITRARY path
   * (`matcher` = a string prefix or a path predicate). A second HTTP-class
   * channel (Signal) registers its
   * `/api/v1/{check,rpc,…}` surface here. Path routes are checked BEFORE the
   * Telegram `BOT_PATH` default; registration order among them is preserved.
   */
  registerPathRoute(matcher: PathMatcher, handler: PathRouteHandler): void;
  /**
   * Register a kept-open SSE (`text/event-stream`) route under an arbitrary
   * `matcher`. Signal's `GET /api/v1/events`
   * inbound stream. The handler receives the raw `(req, res)` to write frames
   * over time; the dispatcher does NOT call `send()` for it (the connection
   * stays open). The base tracks the live response and drains it on `stop()`.
   * Stream routes are checked alongside path routes, BEFORE the Telegram
   * `BOT_PATH` default.
   */
  registerStreamRoute(matcher: PathMatcher, handler: StreamRouteHandler): void;
  /** Register the `/control/*` dispatch. */
  registerControlRoute(handler: ControlRouteHandler): void;
  /** Register the `GET /file/bot<token>/<path>` dispatch. */
  registerFileRoute(handler: FileRouteHandler): void;
}

/**
 * Create the shared loopback HTTP backend.
 *
 * No route is registered by default — an unmatched path 404s. The channel and
 * control API register their surfaces before (or after) `start()`; routing is
 * resolved per-request so registration order is flexible.
 */
export function createHttpBackend(): HttpBackend {
  let server: Server | undefined;
  let nativeHandler: NativeRouteHandler | undefined;
  let controlHandler: ControlRouteHandler | undefined;
  let fileHandler: FileRouteHandler | undefined;
  // Generalized native-wire path routes. Each
  // entry is a channel-supplied { matcher, handler }; the dispatcher checks
  // these (in registration order) BEFORE the Telegram BOT_PATH default, so a
  // second channel's arbitrary surface (Signal's /api/v1/*) dispatches without
  // baking its path shape into the base. Empty by default → the base behaves
  // exactly as the Telegram-only base until a channel registers one.
  const pathRoutes: Array<{ matcher: PathMatcher; handler: PathRouteHandler }> = [];
  // Generalized SSE stream routes. Each entry is a
  // channel-supplied { matcher, handler }; a matching request is handed the raw
  // (req, res) and the connection is kept open. `openStreams` tracks every live
  // SSE response so `stop()` can end them (mirrors mock-signal-server.ts:212-219)
  // — without this drain a kept-open connection keeps the server from closing
  // and `stop()` hangs.
  const streamRoutes: Array<{ matcher: PathMatcher; handler: StreamRouteHandler }> = [];
  const openStreams = new Set<ServerResponse>();

  function pathMatches(matcher: PathMatcher, path: string): boolean {
    return typeof matcher === "string" ? path.startsWith(matcher) : matcher(path);
  }

  // Bot API path shape — grammy builds `${apiRoot}/bot${token}/${method}`
  // (mock-telegram-server.ts:90). The token segment is `bot[^/]+`.
  const BOT_PATH = /^\/bot[^/]+\/([^?]+)(?:\?(.*))?$/;
  // File path shape — `GET /file/bot<token>/<path>`. Capture the path AFTER the token.
  const FILE_PATH = /^\/file\/bot[^/]+\/([^?]+)(?:\?(.*))?$/;

  // Raw body reader (mock-telegram-server.ts:71-79) + a fail-closed `error`
  // handler so a socket reset mid-body resolves (empty) instead of hanging the
  // request forever — the server must stay up.
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      req.on("end", () => resolve(body));
      req.on("error", () => resolve(body));
    });
  }

  // Responder. The JSON path is the mock-telegram-server.ts:81-85 behavior,
  // UNCHANGED. The binary path serves a `Buffer` body
  // RAW with the supplied `contentType` (default `application/octet-stream`),
  // so the file route can return stored bytes byte-for-byte — `JSON.stringify`
  // on a Buffer would corrupt it into `{"type":"Buffer",...}`. A non-Buffer
  // body keeps the `application/json` + `JSON.stringify` path exactly.
  function send(res: ServerResponse, status: number, body: unknown, contentType?: string): void {
    res.statusCode = status;
    if (Buffer.isBuffer(body)) {
      res.setHeader("content-type", contentType ?? "application/octet-stream");
      res.end(body);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  function notFound(res: ServerResponse): void {
    // 404 envelope — copied from mock-telegram-server.ts:91-93.
    send(res, 404, { ok: false, error_code: 404, description: "Not found" });
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const httpMethod = req.method ?? "GET";
    const qIdx = url.indexOf("?");
    const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";
    const body = await readBody(req);
    const baseCtx: RouteContext = { httpMethod, path, query, body };

    // (a) /control/* — SEPARATE branch from the Bot-API matcher, checked first.
    if (path.startsWith("/control/") || path === "/control") {
      if (!controlHandler) {
        notFound(res);
        return;
      }
      const result = await controlHandler(baseCtx);
      send(res, result.status, result.body);
      return;
    }

    // (b) GET /file/bot<token>/<path> — the file route shape.
    const fileMatch = url.match(FILE_PATH);
    if (fileMatch) {
      if (!fileHandler) {
        notFound(res);
        return;
      }
      const fileCtx: FileRouteContext = { ...baseCtx, filePath: fileMatch[1] ?? "" };
      const result = await fileHandler(fileCtx);
      // The file route is the one surface that may return RAW bytes — pass its
      // contentType so a Buffer body is served verbatim. A JSON
      // (404 not-found) body ignores contentType and keeps application/json.
      send(res, result.status, result.body, result.contentType);
      return;
    }

    // (c) Generalized SSE stream routes — checked
    // BEFORE the Telegram BOT_PATH default. A matching request is handed the raw
    // (req, res); the connection is kept OPEN (NOT routed through send()), the
    // live response is tracked for stop()-drain, and it is auto-untracked when
    // the socket closes. This is the Signal GET /api/v1/events inbound stream.
    for (const route of streamRoutes) {
      if (pathMatches(route.matcher, path)) {
        openStreams.add(res);
        res.on("close", () => {
          openStreams.delete(res);
        });
        route.handler(req, res);
        return;
      }
    }

    // (d) Generalized native-wire path routes —
    // checked BEFORE the Telegram BOT_PATH default so a second channel's
    // arbitrary surface (Signal's /api/v1/{check,rpc}) dispatches. The matcher is
    // matched against the path WITHOUT the query string; the handler receives the
    // same base context (raw body + query) as the native route.
    for (const route of pathRoutes) {
      if (pathMatches(route.matcher, path)) {
        const result = await route.handler(baseCtx);
        send(res, result.status, result.body, result.contentType);
        return;
      }
    }

    // (e) /bot<token>/<method> — the channel's native Bot-API method table.
    const botMatch = url.match(BOT_PATH);
    if (botMatch) {
      if (!nativeHandler) {
        notFound(res);
        return;
      }
      const method = botMatch[1] ?? "";
      const result = await nativeHandler(method, baseCtx);
      send(res, result.status, result.body);
      return;
    }

    // 404 on any unmatched path — malformed/unknown requests never crash (V5).
    notFound(res);
  }

  const backend: HttpBackend = {
    async start() {
      // Loopback bind + kernel-allocated free port (mock-telegram-server.ts:196-203)
      // — 127.0.0.1 ONLY, never a wildcard host.
      server = createServer((req, res) => {
        void handler(req, res).catch(() => {
          // A handler/serialization failure must not crash the server — answer 500 and stay up.
          if (!res.writableEnded) {
            try {
              send(res, 500, { ok: false, error_code: 500, description: "Internal error" });
            } catch {
              // Response already partially written; nothing more we can do — keep the server up.
            }
          }
        });
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      return { apiRoot: `http://127.0.0.1:${port}`, port };
    },
    async stop() {
      if (!server) return;
      const local = server;
      server = undefined;
      // Drain any kept-open SSE responses BEFORE closing the server.
      // `server.close()` waits for in-flight
      // connections to end; a long-lived `text/event-stream` would never end on
      // its own → `stop()` would hang. End each tracked stream so the server
      // closes cleanly (mirrors mock-signal-server.ts:212-219). `closeAllConnections`
      // is a belt-and-suspenders sweep for any non-stream keep-alive socket.
      for (const streamRes of openStreams) {
        try {
          streamRes.end();
        } catch {
          // Already ended/destroyed — nothing to do.
        }
      }
      openStreams.clear();
      local.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        local.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    registerNativeRoute(h) {
      nativeHandler = h;
    },
    registerPathRoute(matcher, h) {
      pathRoutes.push({ matcher, handler: h });
    },
    registerStreamRoute(matcher, h) {
      streamRoutes.push({ matcher, handler: h });
    },
    registerControlRoute(h) {
      controlHandler = h;
    },
    registerFileRoute(h) {
      fileHandler = h;
    },
  };

  return Object.freeze(backend);
}
