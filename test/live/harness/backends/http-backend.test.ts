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
