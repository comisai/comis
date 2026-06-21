// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the shared `http-backend` base (FOUND-02 + SEC-01
 * bind half, Phase 204).
 *
 * Drives a REAL `node:http` loopback server (no daemon, fast). The base is the
 * protocol-class foundation Wave-2's `tg-emulator.ts` composes (it registers
 * its Bot-API method table) and the control API (Plan 04) composes (it
 * registers `/control/*`). These tests assert the load-bearing contract every
 * later plan rests on:
 *   - `start()` binds `127.0.0.1` ONLY (never `0.0.0.0`), kernel-allocated
 *     port, returns `{ apiRoot: "http://127.0.0.1:<port>", port }`; `stop()`
 *     closes the server (SEC-01).
 *   - a registered native (Bot-API) route handler fires for its path; a
 *     registered `/control/*` handler fires for a `/control/...` path; a
 *     registered file route fires for `GET /file/bot<token>/<path>` — all on
 *     the SAME loopback port (FOUND-02 dual+file routing).
 *   - an unmatched path returns HTTP 404 with the `{ ok:false, error_code:404,
 *     description }` envelope, and a malformed/empty body does NOT crash the
 *     server — the next request still succeeds (V5 / T-204-02).
 *   - the handler receives the raw request body as a string (so Plan 03's dual
 *     JSON/form parse can consume it).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { createHttpBackend, type HttpBackend } from "./http-backend.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SOURCE = resolve(HERE, "http-backend.ts");

// Track the backend under test so each case tears down even on assertion failure.
let active: HttpBackend | undefined;
afterEach(async () => {
  if (active) {
    await active.stop();
    active = undefined;
  }
});

// ---------------------------------------------------------------------------
// SEC-01 — loopback bind (the load-bearing assertion)
// ---------------------------------------------------------------------------

describe("http-backend loopback bind (SEC-01)", () => {
  it("binds 127.0.0.1 only and returns a matching apiRoot + kernel-allocated port", async () => {
    const be = createHttpBackend();
    active = be;
    const { apiRoot, port } = await be.start();

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(apiRoot).toBe(`http://127.0.0.1:${port}`);

    // A request to the loopback address connects (proves it is actually bound there).
    const res = await fetch(`${apiRoot}/bot12345:test/getMe`, { method: "POST", body: "{}" });
    // No native route registered → 404 envelope, but the connection itself succeeds.
    expect(res.status).toBe(404);
  });

  it("the source binds 127.0.0.1 and never 0.0.0.0 (structural)", () => {
    const src = readFileSync(BACKEND_SOURCE, "utf8");
    expect(src).toMatch(/listen\(0, *["']127\.0\.0\.1["']/);
    expect(src).not.toContain("0.0.0.0");
  });

  it("stop() closes the server so the port is released", async () => {
    const be = createHttpBackend();
    const { apiRoot } = await be.start();
    // Reachable while up.
    const up = await fetch(`${apiRoot}/control/ping`, { method: "GET" });
    expect(up.status).toBe(404); // no control route registered yet, but reachable
    await be.stop();
    // After stop, a connection to the same port should fail (server closed).
    await expect(fetch(`${apiRoot}/control/ping`, { method: "GET" })).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FOUND-02 — dual (native + /control/*) + file routing on one server
// ---------------------------------------------------------------------------

describe("http-backend dual + file routing on one loopback port (FOUND-02)", () => {
  it("invokes a registered native Bot-API route handler for a matching /bot<token>/<method> path", async () => {
    const be = createHttpBackend();
    active = be;
    let seenMethod: string | undefined;
    let seenBody: string | undefined;
    be.registerNativeRoute((method, ctx) => {
      seenMethod = method;
      seenBody = ctx.body;
      return { status: 200, body: { ok: true, result: { id: 12345, is_bot: true } } };
    });
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/bot12345:test/getMe`, {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    const json = (await res.json()) as { ok: boolean; result: { id: number } };

    expect(res.status).toBe(200);
    expect(seenMethod).toBe("getMe");
    expect(seenBody).toBe(JSON.stringify({ a: 1 })); // raw body string exposed to the handler
    expect(json.ok).toBe(true);
    expect(json.result.id).toBe(12345);
  });

  it("invokes a registered /control/* handler for a /control/... path on the same port", async () => {
    const be = createHttpBackend();
    active = be;
    let seenPath: string | undefined;
    let seenMethod: string | undefined;
    be.registerControlRoute((ctx) => {
      seenPath = ctx.path;
      seenMethod = ctx.httpMethod;
      return { status: 200, body: { ok: true, echoed: ctx.path } };
    });
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/control/chats/42/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    const json = (await res.json()) as { ok: boolean; echoed: string };

    expect(res.status).toBe(200);
    expect(seenPath).toBe("/control/chats/42/messages");
    expect(seenMethod).toBe("POST");
    expect(json.echoed).toBe("/control/chats/42/messages");
  });

  it("invokes a registered file route for GET /file/bot<token>/<path> (EMU-05 shape, no 404 at boot)", async () => {
    const be = createHttpBackend();
    active = be;
    let seenFilePath: string | undefined;
    be.registerFileRoute((ctx) => {
      seenFilePath = ctx.filePath;
      return { status: 200, body: { ok: true } };
    });
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/file/bot12345:test/photos/file_1.jpg`, { method: "GET" });

    expect(res.status).toBe(200);
    expect(seenFilePath).toBe("photos/file_1.jpg");
  });

  it("routes native, control, and file surfaces independently on the SAME port (no namespace confusion)", async () => {
    const be = createHttpBackend();
    active = be;
    be.registerNativeRoute(() => ({ status: 200, body: { ok: true, surface: "native" } }));
    be.registerControlRoute(() => ({ status: 200, body: { ok: true, surface: "control" } }));
    be.registerFileRoute(() => ({ status: 200, body: { ok: true, surface: "file" } }));
    const { apiRoot } = await be.start();

    const native = (await (await fetch(`${apiRoot}/bot1:t/sendMessage`, { method: "POST", body: "{}" })).json()) as {
      surface: string;
    };
    const control = (await (await fetch(`${apiRoot}/control/health`, { method: "GET" })).json()) as {
      surface: string;
    };
    const file = (await (await fetch(`${apiRoot}/file/bot1:t/a.bin`, { method: "GET" })).json()) as {
      surface: string;
    };

    expect(native.surface).toBe("native");
    expect(control.surface).toBe("control");
    expect(file.surface).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// V5 / T-204-02 — malformed input must not crash the server
// ---------------------------------------------------------------------------

describe("http-backend hardening: malformed input does not crash (V5)", () => {
  it("returns a 404 envelope on an unmatched path", async () => {
    const be = createHttpBackend();
    active = be;
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/totally/unknown/path`, { method: "GET" });
    const json = (await res.json()) as { ok: boolean; error_code: number; description: string };

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error_code).toBe(404);
    expect(typeof json.description).toBe("string");
  });

  it("a malformed/empty body to a registered route does not throw out of the server; the server stays up", async () => {
    const be = createHttpBackend();
    active = be;
    let calls = 0;
    be.registerNativeRoute((_method, ctx) => {
      calls += 1;
      // The handler receives the raw (possibly empty/garbage) body as a string and must not be forced to parse.
      return { status: 200, body: { ok: true, len: ctx.body.length } };
    });
    const { apiRoot } = await be.start();

    // First request: empty body.
    const r1 = await fetch(`${apiRoot}/bot1:t/getUpdates`, { method: "POST", body: "" });
    expect(r1.status).toBe(200);

    // Second request: garbage (not JSON, not form). Server must still answer.
    const r2 = await fetch(`${apiRoot}/bot1:t/getUpdates`, { method: "POST", body: "}{not-json%%" });
    const j2 = (await r2.json()) as { ok: boolean; len: number };
    expect(r2.status).toBe(200);
    expect(j2.ok).toBe(true);

    // Third request after the malformed one: server is still up.
    const r3 = await fetch(`${apiRoot}/bot1:t/getUpdates`, { method: "POST", body: "{}" });
    expect(r3.status).toBe(200);

    expect(calls).toBe(3);
  });

  it("exposes the raw request body to handlers as a string", async () => {
    const be = createHttpBackend();
    active = be;
    let captured: unknown;
    be.registerNativeRoute((_method, ctx) => {
      captured = ctx.body;
      return { status: 200, body: { ok: true } };
    });
    const { apiRoot } = await be.start();

    await fetch(`${apiRoot}/bot1:t/sendMessage`, {
      method: "POST",
      body: "chat_id=42&text=hello+world",
    });
    expect(typeof captured).toBe("string");
    expect(captured).toBe("chat_id=42&text=hello+world");
  });
});

// ---------------------------------------------------------------------------
// MEDIA-01/02 (Phase 207) — the BINARY response path.
//
// The 204 `send()` ALWAYS JSON-stringifies + sets `content-type:
// application/json`. Raw file bytes cannot survive that path: `JSON.stringify(a
// Buffer)` yields `{"type":"Buffer","data":[...]}`, not the bytes. The file
// route (`GET /file/bot<token>/<file_path>`) must serve the stored RAW bytes
// with a real media content-type. So a `RouteResult` whose `body` is a `Buffer`
// is written verbatim (with the route-supplied `contentType`), while a non-
// Buffer body keeps the existing JSON path byte-for-byte. (This is test-infra
// under `test/live/` — ZERO product change.)
// ---------------------------------------------------------------------------

describe("http-backend binary response path (MEDIA-01/02 — a Buffer body serves raw bytes)", () => {
  it("serves a Buffer route body as RAW bytes (NOT JSON-wrapped) with the route-supplied content-type", async () => {
    const be = createHttpBackend();
    active = be;
    // The exact bytes the file route would serve (a 1×1 PNG header prefix — not
    // valid JSON; if it were JSON-wrapped the round-trip would NOT be byte-exact).
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);
    be.registerFileRoute(() => ({ status: 200, body: bytes, contentType: "image/png" }));
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/file/bot1:t/photos/file_1.jpg`, { method: "GET" });
    expect(res.status).toBe(200);
    // The content-type is the route-supplied media type, NOT application/json.
    expect(res.headers.get("content-type")).toBe("image/png");

    // The body round-trips byte-for-byte — no `{"type":"Buffer",...}` wrapper.
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(bytes)).toBe(true);
    expect(received.length).toBe(bytes.length);
    // Defensive: it must NOT be the JSON-wrapped form.
    expect(received.toString("utf8")).not.toContain("\"type\":\"Buffer\"");
  });

  it("defaults a Buffer body with no content-type to application/octet-stream", async () => {
    const be = createHttpBackend();
    active = be;
    const bytes = Buffer.from("raw-octets-no-ct", "utf8");
    be.registerFileRoute(() => ({ status: 200, body: bytes }));
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/file/bot1:t/documents/file_2.bin`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(bytes)).toBe(true);
  });

  it("keeps a NON-Buffer (JSON) body on the existing application/json path byte-for-byte", async () => {
    const be = createHttpBackend();
    active = be;
    // A control + native + file route, all JSON — none must be affected by the
    // binary branch (the existing JSON behavior is unchanged).
    be.registerFileRoute(() => ({ status: 404, body: { ok: false, error_code: 404, description: "file not found" } }));
    be.registerNativeRoute(() => ({ status: 200, body: { ok: true, result: { id: 1 } } }));
    const { apiRoot } = await be.start();

    const fileRes = await fetch(`${apiRoot}/file/bot1:t/missing.bin`, { method: "GET" });
    expect(fileRes.status).toBe(404);
    expect(fileRes.headers.get("content-type")).toBe("application/json");
    const fileJson = (await fileRes.json()) as { ok: boolean; error_code: number; description: string };
    expect(fileJson.ok).toBe(false);
    expect(fileJson.error_code).toBe(404);
    expect(fileJson.description).toBe("file not found");

    const nativeRes = await fetch(`${apiRoot}/bot1:t/getMe`, { method: "POST", body: "{}" });
    expect(nativeRes.headers.get("content-type")).toBe("application/json");
    const nativeJson = (await nativeRes.json()) as { ok: boolean; result: { id: number } };
    expect(nativeJson.ok).toBe(true);
    expect(nativeJson.result.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CHAN2-02 FIX #1 (Phase 209) — the native-route matcher is telegram-shaped.
//
// The 204 base discriminates the native surface with a single hard-coded
// `BOT_PATH = /^\/bot[^/]+\/([^?]+).../` matcher — it matches ONLY
// `/bot<token>/<method>`. A second HTTP-class channel (Signal) serves its native
// wire surface under a DIFFERENT path shape — `/api/v1/{check,rpc,events}` — which
// `BOT_PATH` will never match, so it 404s on the pre-patch base. The fix
// generalizes surface discrimination so a channel registers its OWN path
// predicate (`registerPathRoute(matcher, handler)`, RESEARCH Open-Q2), checked
// BEFORE the preserved Telegram `BOT_PATH` default. NO channel's path shape is
// baked into the base beyond the Telegram default (the regression guard).
// (Test-infra under `test/live/` — ZERO product change.)
// ---------------------------------------------------------------------------

describe("http-backend generalized native matcher (CHAN2-02 FIX #1)", () => {
  it("dispatches a channel-registered arbitrary path (Signal POST /api/v1/rpc) with body + query", async () => {
    const be = createHttpBackend();
    active = be;
    let seenPath: string | undefined;
    let seenBody: string | undefined;
    let seenQuery: string | undefined;
    let seenMethod: string | undefined;
    // A channel-supplied matcher: a string PREFIX (the simplest form). The base
    // owns the discrimination; the channel owns its internal sub-routing.
    be.registerPathRoute("/api/v1/", (ctx) => {
      seenPath = ctx.path;
      seenBody = ctx.body;
      seenQuery = ctx.query;
      seenMethod = ctx.httpMethod;
      return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { timestamp: 1700000000001 } } };
    });
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/api/v1/rpc?account=%2B15555550100`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "send", id: 1 }),
    });
    const json = (await res.json()) as { jsonrpc: string; result: { timestamp: number } };

    expect(res.status).toBe(200);
    expect(seenPath).toBe("/api/v1/rpc");
    expect(seenMethod).toBe("POST");
    expect(seenBody).toBe(JSON.stringify({ jsonrpc: "2.0", method: "send", id: 1 }));
    expect(seenQuery).toBe("account=%2B15555550100");
    expect(json.jsonrpc).toBe("2.0");
    expect(json.result.timestamp).toBe(1700000000001);
  });

  it("dispatches a different arbitrary path (Signal GET /api/v1/check) via a predicate matcher", async () => {
    const be = createHttpBackend();
    active = be;
    let hit = false;
    // A channel-supplied matcher can also be a PREDICATE over the request path.
    be.registerPathRoute(
      (path) => path === "/api/v1/check",
      () => {
        hit = true;
        return { status: 200, body: { ok: true } };
      },
    );
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/api/v1/check`, { method: "GET" });
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(hit).toBe(true);
    expect(json.ok).toBe(true);
  });

  it("regression guard: the Telegram /bot<token>/<method> native route still dispatches byte-identically", async () => {
    // The generalization is ADDITIVE — registering a path route must not disturb
    // the preserved Telegram BOT_PATH default. A native route + a path route are
    // registered together; each fires only for its own surface.
    const be = createHttpBackend();
    active = be;
    let nativeMethod: string | undefined;
    be.registerNativeRoute((method) => {
      nativeMethod = method;
      return { status: 200, body: { ok: true, result: { id: 12345, is_bot: true } } };
    });
    be.registerPathRoute("/api/v1/", () => ({ status: 200, body: { jsonrpc: "2.0", result: {} } }));
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/bot12345:test/getMe`, { method: "POST", body: JSON.stringify({ a: 1 }) });
    const json = (await res.json()) as { ok: boolean; result: { id: number; is_bot: boolean } };

    expect(res.status).toBe(200);
    expect(nativeMethod).toBe("getMe"); // the BOT_PATH default still captures the method
    expect(json.ok).toBe(true);
    expect(json.result.id).toBe(12345);
    expect(json.result.is_bot).toBe(true);
  });

  it("does not over-broaden: an unmatched path still 404s even with a path route registered", async () => {
    const be = createHttpBackend();
    active = be;
    be.registerPathRoute("/api/v1/", () => ({ status: 200, body: { ok: true } }));
    const { apiRoot } = await be.start();

    const res = await fetch(`${apiRoot}/some/other/surface`, { method: "GET" });
    const json = (await res.json()) as { ok: boolean; error_code: number };

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error_code).toBe(404);
  });
});
