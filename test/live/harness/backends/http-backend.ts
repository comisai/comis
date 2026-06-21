// SPDX-License-Identifier: Apache-2.0
/**
 * `http-backend` — the shared HTTP-protocol base for channel emulators
 * (FOUND-02 + SEC-01 bind half, Phase 204).
 *
 * ONE `node:http` server bound to `127.0.0.1` only (kernel-allocated free port)
 * that hosts THREE route surfaces on the same loopback port:
 *
 *   1. the per-channel NATIVE wire surface — `/bot<token>/<method>` for
 *      Telegram's Bot API (the channel registers its method table via
 *      `registerNativeRoute`, Plan 03);
 *   2. the generic CONTROL surface — `/control/*` (the control API registers
 *      its routes via `registerControlRoute`, Plan 04);
 *   3. the FILE surface — `GET /file/bot<token>/<path>` (the channel registers
 *      its EMU-05 route shape via `registerFileRoute`, Plan 03).
 *
 * The server core (loopback bind + kernel free-port + JSON responder + raw body
 * reader + path routing + 404-on-unmatched) is extracted VERBATIM from the
 * proven `test/e2e/mocks/telegram/mock-telegram-server.ts` (which already
 * round-trips against the production grammy adapter). This base knows NOTHING
 * about Telegram — Signal/LINE in Phase 209 reuse it unchanged (channel-agnostic).
 *
 * Security posture (mirrors the mock): binds loopback ONLY — never a wildcard
 * host — so the (later, Plan 04 admin-scoped) control surface is unreachable from the
 * LAN (SEC-01 / T-204-01). Malformed/unmatched requests return a 404 envelope
 * instead of crashing (V5 / T-204-02): handlers receive the RAW body string and
 * are never forced to parse, and the body reader fails closed on a socket error.
 * The `/control/*` branch is SEPARATE from the `/bot<token>/<method>` matcher so
 * the two surfaces can never be confused (T-204-03).
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
 * JSON/form-encoded parsing (Plan 03's dual parse) so the base never crashes on
 * a malformed body (V5).
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
 * `application/json` + `JSON.stringify`). For the FILE route (MEDIA-01/02,
 * Phase 207) a body that is a `Buffer` is written RAW — the stored file bytes
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
 * (`botMatch[1]`, e.g. `getMe`) plus the request context. Plan 03 registers the
 * Telegram method table here.
 */
export type NativeRouteHandler = (
  method: string,
  ctx: RouteContext,
) => RouteResult | Promise<RouteResult>;

/**
 * A path predicate a channel supplies to `registerPathRoute` to claim an
 * ARBITRARY native-wire surface (Phase 209, CHAN2-02 FIX #1). Either a string
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
 * (Phase 209, CHAN2-02 FIX #1) so a channel's non-Telegram wire surface
 * (e.g. Signal's `/api/v1/rpc`) dispatches on the same loopback base.
 */
export type PathRouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

/**
 * A `/control/*` route handler. Receives the request context (the full
 * `/control/...` path is on `ctx.path`). Plan 04 registers the control routes
 * here.
 */
export type ControlRouteHandler = (ctx: ControlRouteContext) => RouteResult | Promise<RouteResult>;

/** Control context — the base context (the `/control/...` path is on `ctx.path`). */
export type ControlRouteContext = RouteContext;

/**
 * A file route handler for `GET /file/bot<token>/<path>`. Receives the file
 * path AFTER `/file/bot<token>/` (e.g. `photos/file_1.jpg`) plus the context.
 * Plan 03 registers the EMU-05 route shape here.
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
  /** Register the native Bot-API method dispatch (`/bot<token>/<method>`). Plan 03. */
  registerNativeRoute(handler: NativeRouteHandler): void;
  /**
   * Register a generalized native-wire route under an ARBITRARY path
   * (`matcher` = a string prefix or a path predicate). Phase 209 (CHAN2-02
   * FIX #1) — a second HTTP-class channel (Signal) registers its
   * `/api/v1/{check,rpc,…}` surface here. Path routes are checked BEFORE the
   * Telegram `BOT_PATH` default; registration order among them is preserved.
   */
  registerPathRoute(matcher: PathMatcher, handler: PathRouteHandler): void;
  /** Register the `/control/*` dispatch. Plan 04. */
  registerControlRoute(handler: ControlRouteHandler): void;
  /** Register the `GET /file/bot<token>/<path>` dispatch. Plan 03. */
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
  // Generalized native-wire path routes (Phase 209, CHAN2-02 FIX #1). Each
  // entry is a channel-supplied { matcher, handler }; the dispatcher checks
  // these (in registration order) BEFORE the Telegram BOT_PATH default, so a
  // second channel's arbitrary surface (Signal's /api/v1/*) dispatches without
  // baking its path shape into the base. Empty by default → the base behaves
  // exactly as the 204 Telegram-only base until a channel registers one.
  const pathRoutes: Array<{ matcher: PathMatcher; handler: PathRouteHandler }> = [];

  function pathMatches(matcher: PathMatcher, path: string): boolean {
    return typeof matcher === "string" ? path.startsWith(matcher) : matcher(path);
  }

  // Bot API path shape — grammy builds `${apiRoot}/bot${token}/${method}`
  // (mock-telegram-server.ts:90). The token segment is `bot[^/]+`.
  const BOT_PATH = /^\/bot[^/]+\/([^?]+)(?:\?(.*))?$/;
  // File path shape — `GET /file/bot<token>/<path>` (EMU-05). Capture the path AFTER the token.
  const FILE_PATH = /^\/file\/bot[^/]+\/([^?]+)(?:\?(.*))?$/;

  // Raw body reader (mock-telegram-server.ts:71-79) + a fail-closed `error`
  // handler so a socket reset mid-body resolves (empty) instead of hanging the
  // request forever — the server must stay up (V5 / T-204-02).
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
  // UNCHANGED. The binary path (MEDIA-01/02, Phase 207) serves a `Buffer` body
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
    // 404 envelope — copied from mock-telegram-server.ts:91-93 (V5).
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

    // (a) /control/* — SEPARATE branch from the Bot-API matcher (T-204-03), checked first.
    if (path.startsWith("/control/") || path === "/control") {
      if (!controlHandler) {
        notFound(res);
        return;
      }
      const result = await controlHandler(baseCtx);
      send(res, result.status, result.body);
      return;
    }

    // (b) GET /file/bot<token>/<path> — the EMU-05 file route shape.
    const fileMatch = url.match(FILE_PATH);
    if (fileMatch) {
      if (!fileHandler) {
        notFound(res);
        return;
      }
      const fileCtx: FileRouteContext = { ...baseCtx, filePath: fileMatch[1] ?? "" };
      const result = await fileHandler(fileCtx);
      // The file route is the one surface that may return RAW bytes — pass its
      // contentType so a Buffer body is served verbatim (MEDIA-01/02). A JSON
      // (404 not-found) body ignores contentType and keeps application/json.
      send(res, result.status, result.body, result.contentType);
      return;
    }

    // (c) Generalized native-wire path routes (Phase 209, CHAN2-02 FIX #1) —
    // checked BEFORE the Telegram BOT_PATH default so a second channel's
    // arbitrary surface (Signal's /api/v1/{check,rpc,events}) dispatches. The
    // matcher is matched against the path WITHOUT the query string; the handler
    // receives the same base context (raw body + query) as the native route.
    for (const route of pathRoutes) {
      if (pathMatches(route.matcher, path)) {
        const result = await route.handler(baseCtx);
        send(res, result.status, result.body, result.contentType);
        return;
      }
    }

    // (d) /bot<token>/<method> — the channel's native Bot-API method table.
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
      // — 127.0.0.1 ONLY, never a wildcard host (SEC-01 / T-204-01).
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
    registerControlRoute(h) {
      controlHandler = h;
    },
    registerFileRoute(h) {
      fileHandler = h;
    },
  };

  return Object.freeze(backend);
}
