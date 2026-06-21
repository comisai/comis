// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for the `chan`/`tg` CLI pure core (Phase 205, Plan 05):
 *   - `parseArgs` (verb / --channel / tg-default / --json / --endpoint / positionals)
 *   - the honest-exit reason-code mapping (`toFailure` + `exitCodeFor`, the four
 *     closed FailureKind classes → distinct non-zero exit codes — CLI-04)
 *   - the `tg rpc` malformed-json reject (`tryParseJson`, validated BEFORE the
 *     passthrough — V5 / T-205-15)
 *
 * Task-1 scope: the PURE, side-effect-free core only — NO subprocess, NO daemon
 * boot. (Task 2 adds the `runVerb` dispatch with injected seams.)
 *
 * Run under the LIVE vitest config — the bare root config excludes `test/live`
 * (0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/bin/chan.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  parseArgs,
  contextFromParsed,
  toFailure,
  exitCodeFor,
  tryParseJson,
  runVerb,
  VerbFailure,
  type FailureKind,
  type ChanliveHandle,
  type VerbContext,
} from "./chan.js";

// ---------------------------------------------------------------------------
// Test helpers for the runVerb dispatch (Task 2). The seams are injected via
// `ctx` so the dispatch is unit-testable WITHOUT booting a daemon: a fake `rpc`
// (a vi.fn() returning a canned result) and a throwaway loopback `/control/*`
// server that records the POST + returns canned outbound.
// ---------------------------------------------------------------------------

/** A minimal fake handle (no real rig) for the dispatch units. */
function fakeHandle(over: Partial<ChanliveHandle> = {}): ChanliveHandle {
  return {
    channel: "telegram",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:1",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayToken: "test-token-0000000000000000000000000000",
    chatId: 424242,
    dataDir: "/tmp/does-not-exist",
    memoryDbPath: "/tmp/does-not-exist/memory.db",
    ...over,
  };
}

/**
 * Stand up a throwaway loopback `/control/*` server. `outbound` is the canned
 * array the GET /outbound reply-wait returns (empty → honest no-reply). Records
 * every POST body for assertion. Returns the base URL + a close().
 */
async function startControlStub(outbound: Array<{ messageId: number; text?: string }>): Promise<{
  base: string;
  posts: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}> {
  const posts: Array<{ path: string; body: unknown }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const path = req.url ?? "";
      if (req.method === "POST" && /\/control\/chats\/-?\d+\/messages/.test(path)) {
        posts.push({ path, body: raw.length > 0 ? JSON.parse(raw) : {} });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messageId: 1001 }));
        return;
      }
      if (req.method === "GET" && /\/control\/chats\/-?\d+\/outbound/.test(path)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(outbound));
        return;
      }
      res.writeHead(404);
      res.end("[]");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("chan/tg CLI — parseArgs (pure)", () => {
  it("extracts an explicit --channel, the verb, positional args, and --json", () => {
    const parsed = parseArgs(["--channel", "telegram", "send", "hello", "--json"]);
    expect(parsed).toEqual({
      channel: "telegram",
      verb: "send",
      args: ["hello"],
      json: true,
    });
  });

  it("defaults the channel to telegram (the `tg` alias) when --channel is absent", () => {
    const parsed = parseArgs(["send", "hi"]);
    expect(parsed.channel).toBe("telegram");
    expect(parsed.verb).toBe("send");
    expect(parsed.args).toEqual(["hi"]);
    expect(parsed.json).toBe(false);
  });

  it("captures --endpoint as a string flag (not a positional)", () => {
    const parsed = parseArgs(["--endpoint", "http://x", "status"]);
    expect(parsed.endpoint).toBe("http://x");
    expect(parsed.verb).toBe("status");
    expect(parsed.args).toEqual([]);
  });

  it("keeps multi-arg rpc passthrough positionals together (method + json)", () => {
    const parsed = parseArgs(["rpc", "channels.health", '{"x":1}']);
    expect(parsed.verb).toBe("rpc");
    expect(parsed.args).toEqual(["channels.health", '{"x":1}']);
  });

  it("strips surrounding quotes from a positional (runner.ts shape)", () => {
    const parsed = parseArgs(["send", '"hello world"']);
    expect(parsed.args).toEqual(["hello world"]);
  });

  it("with no verb at all, verb is undefined and args empty (honest, not a crash)", () => {
    const parsed = parseArgs([]);
    expect(parsed.verb).toBeUndefined();
    expect(parsed.args).toEqual([]);
    expect(parsed.channel).toBe("telegram");
  });
});

describe("chan/tg CLI — parseArgs captures value-bearing + boolean sub-flags", () => {
  it("captures --event / --tool / --timeout as typed fields (not dropped, not positionals)", () => {
    const parsed = parseArgs(["wait", "s.jsonl", "--event", "model.completed", "--timeout", "1500"]);
    expect(parsed.verb).toBe("wait");
    // The flag VALUES must NOT leak into the positionals — only the trajectory file is.
    expect(parsed.args).toEqual(["s.jsonl"]);
    expect(parsed.event).toBe("model.completed");
    expect(parsed.timeout).toBe(1500);
    expect(parsed.tool).toBeUndefined();
  });

  it("captures --tool as a typed field", () => {
    const parsed = parseArgs(["wait", "s.jsonl", "--tool", "web_search"]);
    expect(parsed.args).toEqual(["s.jsonl"]);
    expect(parsed.tool).toBe("web_search");
    expect(parsed.event).toBeUndefined();
  });

  it("captures --deep as a typed boolean field (reset --deep is distinguishable)", () => {
    const parsed = parseArgs(["reset", "--deep"]);
    expect(parsed.verb).toBe("reset");
    expect(parsed.deep).toBe(true);
    // The bare `reset` form leaves deep falsy.
    expect(parseArgs(["reset"]).deep).toBeFalsy();
  });

  it("resolves --event/--tool/--timeout regardless of their position relative to the trajectory file", () => {
    // CR-01 / IN-01: a flag BEFORE the positional must not shadow the trajectory file.
    const parsed = parseArgs(["wait", "--event", "model.completed", "s.jsonl"]);
    expect(parsed.args).toEqual(["s.jsonl"]);
    expect(parsed.event).toBe("model.completed");
  });
});

describe("chan/tg CLI — parseArgs → runVerb integration seam (CR-01: the real CLI path)", () => {
  it("tg wait <file> --event <type> reaches the waiter through the FULL parse→dispatch path", async () => {
    // Drive the REAL entry path: parseArgs → contextFromParsed → runVerb. The
    // earlier suite called the waiter in isolation, MASKING the parseArgs flag-strip
    // that made `tg wait` non-functional through `runMain` (CR-01).
    const waitFn = vi.fn().mockResolvedValue({ matched: true, type: "model.completed", reason: "matched" });
    const parsed = parseArgs(["wait", "s.jsonl", "--event", "model.completed"]);
    const ctx = contextFromParsed(parsed, fakeHandle());
    const result = (await runVerb(parsed.verb as string, parsed.args, { ...ctx, waitFn })) as Record<
      string,
      unknown
    >;
    expect(waitFn).toHaveBeenCalledTimes(1);
    // The waiter is called with the trajectory file AND the event — not "supply exactly one".
    expect(waitFn).toHaveBeenCalledWith(
      expect.objectContaining({ trajectoryFile: "s.jsonl", event: "model.completed" }),
    );
    expect(result["matched"]).toBe(true);
  });

  it("tg wait <file> --tool <name> [--timeout ms] threads tool + timeoutMs to the waiter", async () => {
    const waitFn = vi.fn().mockResolvedValue({ matched: true, type: "tool.result", reason: "matched" });
    const parsed = parseArgs(["wait", "s.jsonl", "--tool", "web_search", "--timeout", "2000"]);
    const ctx = contextFromParsed(parsed, fakeHandle());
    await runVerb(parsed.verb as string, parsed.args, { ...ctx, waitFn });
    expect(waitFn).toHaveBeenCalledWith(
      expect.objectContaining({ trajectoryFile: "s.jsonl", tool: "web_search", timeoutMs: 2000 }),
    );
  });

  it("tg reset --deep reports the deep verb through the FULL parse→dispatch path", async () => {
    const parsed = parseArgs(["reset", "--deep"]);
    const ctx = contextFromParsed(parsed, fakeHandle());
    const result = (await runVerb(parsed.verb as string, parsed.args, ctx)) as Record<string, unknown>;
    expect(result["verb"]).toBe("reset --deep");
  });

  it("tg reset (no --deep) reports the plain verb (distinct from reset --deep)", async () => {
    const parsed = parseArgs(["reset"]);
    const ctx = contextFromParsed(parsed, fakeHandle());
    const result = (await runVerb(parsed.verb as string, parsed.args, ctx)) as Record<string, unknown>;
    expect(result["verb"]).toBe("reset");
  });

  it("tg rpc <method> <json> threads the method + params through the full parse→dispatch path", async () => {
    // A second value-flag-free verb proven end-to-end through the same seam.
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const parsed = parseArgs(["rpc", "channels.health", '{"detail":true}']);
    const ctx = contextFromParsed(parsed, fakeHandle());
    await runVerb(parsed.verb as string, parsed.args, { ...ctx, rpc });
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "channels.health",
      { detail: true },
      expect.any(String),
    );
  });
});

describe("chan/tg CLI — honest-exit reason codes (CLI-04)", () => {
  const kinds: FailureKind[] = ["no_reply", "rpc_error", "dead_handle", "bad_json"];

  it("toFailure builds an { error: <kind> } body carrying the detail", () => {
    expect(toFailure("no_reply", { waitedMs: 45000 })).toEqual({
      error: "no_reply",
      waitedMs: 45000,
    });
    expect(toFailure("rpc_error", { code: -32601, message: "Method not found" })).toEqual({
      error: "rpc_error",
      code: -32601,
      message: "Method not found",
    });
    expect(toFailure("dead_handle", { endpoint: "http://127.0.0.1:4766" })).toEqual({
      error: "dead_handle",
      endpoint: "http://127.0.0.1:4766",
    });
    expect(toFailure("bad_json", { detail: "Unexpected token" })).toEqual({
      error: "bad_json",
      detail: "Unexpected token",
    });
  });

  it("toFailure works with no detail (just the error code)", () => {
    expect(toFailure("dead_handle")).toEqual({ error: "dead_handle" });
  });

  it("every FailureKind maps to a DISTINCT NON-ZERO exit code", () => {
    const codes = kinds.map((k) => exitCodeFor(k));
    // All non-zero (a false success would be exit 0).
    for (const code of codes) {
      expect(code).toBeGreaterThan(0);
      expect(Number.isInteger(code)).toBe(true);
    }
    // All distinct so a driving agent can tell the classes apart.
    expect(new Set(codes).size).toBe(kinds.length);
  });
});

describe("chan/tg CLI — tryParseJson (the rpc bad-json guard, V5)", () => {
  it("parses valid JSON into { ok: true, value }", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects malformed JSON as { ok: false } (NOT a throw / crash)", () => {
    const result = tryParseJson("{not json");
    expect(result.ok).toBe(false);
  });

  it("an empty / whitespace string is treated as the empty-params default {}", () => {
    expect(tryParseJson("")).toEqual({ ok: true, value: {} });
    expect(tryParseJson("   ")).toEqual({ ok: true, value: {} });
  });

  it("a malformed `tg rpc` json arg routes to bad_json via tryParseJson, never a crash", () => {
    // The dispatch-prep path: a `tg rpc <method> <malformed>` validates the json
    // BEFORE any passthrough; tryParseJson returning ok:false is what the verb
    // turns into toFailure("bad_json") + exitCodeFor("bad_json").
    const parsed = parseArgs(["rpc", "agents.create", '{"name":']);
    const jsonArg = parsed.args[1] ?? "{}";
    const validated = tryParseJson(jsonArg);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      const failure = toFailure("bad_json", { detail: "parse failed" });
      expect(failure.error).toBe("bad_json");
      expect(exitCodeFor("bad_json")).toBeGreaterThan(0);
    }
  });
});

describe("chan/tg CLI — runVerb: rpc passthrough (AUTO-01)", () => {
  it("forwards method + params VERBATIM to the injected rpc and returns the result", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true, status: "healthy" });
    const ctx: VerbContext = { handle: fakeHandle(), rpc };
    const result = await runVerb("rpc", ["channels.health", '{"detail":true}'], ctx);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "channels.health",
      { detail: true },
      "test-token-0000000000000000000000000000",
    );
    expect(result).toEqual({ ok: true, status: "healthy" });
  });

  it("defaults params to {} when no json arg is given", async () => {
    const rpc = vi.fn().mockResolvedValue({ id: "agt_1" });
    await runVerb("rpc", ["agents.create"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith("http://127.0.0.1:1", "agents.create", {}, expect.any(String));
  });

  it("a malformed json arg throws a VerbFailure(bad_json) — validated BEFORE the passthrough", async () => {
    const rpc = vi.fn();
    await expect(
      runVerb("rpc", ["agents.create", "{not json"], { handle: fakeHandle(), rpc }),
    ).rejects.toMatchObject({ kind: "bad_json" });
    // The passthrough was NEVER called — V5 validates first.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an RPC error throw maps to a VerbFailure(rpc_error) carrying code + message", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("RPC error -32601: Method not found"));
    const err = await runVerb("rpc", ["nope.method"], { handle: fakeHandle(), rpc }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("rpc_error");
    expect((err as VerbFailure).body["message"]).toContain("Method not found");
  });

  it("explain routes a colon-keyed ref to { sessionKey } (matches the comis explain CLI)", async () => {
    const rpc = vi.fn().mockResolvedValue({ outcome: "ok" });
    // A sessionKey is tenant:user:channel:ts (contains ':'); production routes by shape.
    await runVerb("explain", ["default:user1:telegram:1717"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "obs.explain",
      expect.objectContaining({ sessionKey: "default:user1:telegram:1717" }),
      expect.any(String),
    );
  });

  it("explain routes a colon-less ref to { traceId } (a UUID — matches the comis explain CLI)", async () => {
    const rpc = vi.fn().mockResolvedValue({ outcome: "ok" });
    await runVerb("explain", ["6ba7b810-9dad-11d1-80b4-00c04fd430c8"], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "obs.explain",
      expect.objectContaining({ traceId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
      expect.any(String),
    );
  });

  it("fleet is a curated rpc call to obs.fleet.health", async () => {
    const rpc = vi.fn().mockResolvedValue({ degraded: 0 });
    await runVerb("fleet", [], { handle: fakeHandle(), rpc });
    expect(rpc).toHaveBeenCalledWith(
      "http://127.0.0.1:1",
      "obs.fleet.health",
      expect.any(Object),
      expect.any(String),
    );
  });
});

describe("chan/tg CLI — runVerb: dead handle (CLI-04)", () => {
  it("a non-up verb with NO resolved handle throws VerbFailure(dead_handle) suggesting tg up", async () => {
    const err = await runVerb("send", ["hi"], { handle: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    // The honest hint points at `tg up` — never a silent spawn.
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });

  it("rpc with no handle is also a dead_handle (it needs the gateway token)", async () => {
    const err = await runVerb("rpc", ["channels.health"], { handle: undefined }).catch(
      (e: unknown) => e,
    );
    expect((err as VerbFailure).kind).toBe("dead_handle");
  });
});

describe("chan/tg CLI — runVerb: drive verbs over /control/* (CLI-02)", () => {
  it("send POSTs the message then returns the reply when outbound is non-empty", async () => {
    const stub = await startControlStub([{ messageId: 1002, text: "pong" }]);
    try {
      const ctx: VerbContext = { handle: fakeHandle({ controlEndpoint: stub.base }) };
      const result = (await runVerb("send", ["ping"], ctx)) as Record<string, unknown>;
      // The inbound was POSTed to /control/chats/:id/messages with the text.
      expect(stub.posts).toHaveLength(1);
      expect(stub.posts[0]?.body).toMatchObject({ text: "ping" });
      // The reply was surfaced (honest reply, not fabricated).
      expect(result["reply"]).toBe("pong");
    } finally {
      await stub.close();
    }
  });

  it("send with an EMPTY outbound throws VerbFailure(no_reply) with waitedMs — no false success", async () => {
    const stub = await startControlStub([]); // honest no-reply
    try {
      const ctx: VerbContext = { handle: fakeHandle({ controlEndpoint: stub.base }) };
      const err = await runVerb("send", ["ping"], ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerbFailure);
      expect((err as VerbFailure).kind).toBe("no_reply");
      expect((err as VerbFailure).body).toHaveProperty("waitedMs");
    } finally {
      await stub.close();
    }
  });

  it("last reads the outbound oracle (the most recent recorded reply)", async () => {
    const stub = await startControlStub([
      { messageId: 1, text: "older" },
      { messageId: 2, text: "newest" },
    ]);
    try {
      const ctx: VerbContext = { handle: fakeHandle({ controlEndpoint: stub.base }) };
      const result = (await runVerb("last", [], ctx)) as Record<string, unknown>;
      expect(result["text"]).toBe("newest");
    } finally {
      await stub.close();
    }
  });
});

describe("chan/tg CLI — runVerb: control-response shape guard (WR-03: no exit-0 false success)", () => {
  /** A fake fetch whose responses are scripted per (method, url-substring). */
  function fakeFetch(
    handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const { status = 200, body } = handler(url, init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
  }

  it("readOutbound on a NON-ARRAY control body fails honestly — NOT an exit-0 { reply: undefined }", async () => {
    // The most worrying branch: a 200 with a NON-array object (e.g. an error
    // object) used to make outbounds.length undefined -> !== 0 -> the last
    // element undefined -> send returned { reply: undefined } as a SUCCESS.
    const controlFetch = fakeFetch((url) => {
      if (url.includes("/outbound")) return { status: 200, body: { ok: false, error: "boom" } };
      return { status: 200, body: { messageId: 7 } }; // the POST is fine
    });
    const err = await runVerb("send", ["ping"], { handle: fakeHandle(), controlFetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_bad_shape");
  });

  it("readOutbound on a non-2xx control response fails honestly (control_http_error)", async () => {
    const controlFetch = fakeFetch((url) => {
      if (url.includes("/outbound")) return { status: 500, body: { error: "internal" } };
      return { status: 200, body: { messageId: 7 } };
    });
    const err = await runVerb("last", [], { handle: fakeHandle(), controlFetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_http_error");
  });

  it("send on a non-2xx POST (no messageId) fails honestly BEFORE the reply-wait", async () => {
    const controlFetch = fakeFetch((url) => {
      // The POST itself 400s — there is no messageId to wait on.
      if (url.includes("/messages")) return { status: 400, body: { ok: false, error: "bad input" } };
      return { status: 200, body: [] };
    });
    const err = await runVerb("send", ["ping"], { handle: fakeHandle(), controlFetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    // Reason names the POST failure, not a downstream no_reply after the full wait.
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
  });

  it("send on a 200 POST with a NON-numeric messageId fails honestly (not a 45s no_reply)", async () => {
    const controlFetch = fakeFetch((url) => {
      if (url.includes("/messages")) return { status: 200, body: { ok: true } }; // no messageId
      return { status: 200, body: [] };
    });
    const err = await runVerb("send", ["ping"], { handle: fakeHandle(), controlFetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
  });
});

describe("chan/tg CLI — runVerb: react correlates to the botReplyId arg (REACT-02 / attribution)", () => {
  /**
   * A recording fake fetch: captures every (method, url, parsed-body) and
   * returns a scripted status/body per url-substring. Lets the react tests
   * assert the EXACT POST the verb makes (the attribution body) AND that no
   * `/outbound` GET (a `tg last` re-read) happens.
   */
  function recordingFetch(script: (url: string) => { status?: number; body?: unknown }): {
    fetch: typeof fetch;
    calls: Array<{ method: string; url: string; body: unknown }>;
  } {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      let parsedBody: unknown;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      calls.push({ method, url, body: parsedBody });
      const { status = 200, body = { ok: true } } = script(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
    return { fetch: fn, calls };
  }

  it("POSTs {fromUserId:111, botMessageId:<arg>, emoji} to /reactions and returns { reacted } — the ARG, not tg last", async () => {
    const rec = recordingFetch((url) => {
      if (url.includes("/reactions")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    // botReplyId = 42 (the id `tg send` returned as the agent-authored reply).
    const result = (await runVerb("react", ["42", "👍"], ctx)) as Record<string, unknown>;

    // Exactly one control call: the POST to /reactions (no /outbound re-read).
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.method).toBe("POST");
    // ATTRIBUTION: the URL is the reactions route on the handle's chat.
    expect(call.url.endsWith(`/control/chats/${fakeHandle().chatId}/reactions`)).toBe(true);
    // ATTRIBUTION: the body reacts to the ARG id (42), NOT a re-read `last`.
    expect(call.body).toEqual({ fromUserId: 111, botMessageId: 42, emoji: "👍" });
    // The honest result echoes the attributed reply id + emoji.
    expect(result).toEqual({ reacted: { botReplyId: 42, emoji: "👍" } });
  });

  it("does NOT consult tg last / readOutbound — no GET to /outbound is made", async () => {
    const rec = recordingFetch((url) => {
      if (url.includes("/reactions")) return { status: 200, body: { ok: true } };
      // If the verb ever read the oracle, this /outbound GET would be recorded.
      return { status: 200, body: [{ messageId: 9999, text: "a DIFFERENT, more-recent message" }] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    await runVerb("react", ["42", "👍"], ctx);
    // The map is keyed on the agent-authored reply's id — the verb reacts to
    // args[0] ONLY; a `/outbound` re-read could pick a non-attributed message.
    expect(rec.calls.some((c) => c.url.includes("/outbound"))).toBe(false);
    expect(rec.calls.every((c) => c.url.includes("/reactions"))).toBe(true);
  });

  it("bad args (missing both) → VerbFailure(bad_json); the control fetch is NEVER called", async () => {
    const rec = recordingFetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("react", [], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a non-numeric botReplyId → VerbFailure(bad_json), no fetch", async () => {
    const rec = recordingFetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("react", ["not-a-number", "👍"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a missing emoji (only the id) → VerbFailure(bad_json), no fetch", async () => {
    const rec = recordingFetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("react", ["42"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a control POST !ok (502) → VerbFailure(dead_handle, control_post_error) — no false success", async () => {
    const rec = recordingFetch((url) => {
      if (url.includes("/reactions")) return { status: 502, body: { ok: false } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("react", ["42", "👍"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
    expect((err as VerbFailure).body["status"]).toBe(502);
  });

  it("react with NO resolved handle is a dead_handle (it drives a live rig) — never a silent no-op", async () => {
    const err = await runVerb("react", ["42", "👍"], { handle: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });
});

// ---------------------------------------------------------------------------
// Phase 207: the four wired verbs (tap / edit / send-photo / send-voice). A
// shared recording fetch captures every (method, url, parsed-body) and returns a
// scripted status/body per url-substring — the same shape the react suite uses,
// lifted to module scope for re-use across the 207 suites.
// ---------------------------------------------------------------------------

/** A recording fake fetch (lifted from the react suite) for the 207 verb suites. */
function recording207Fetch(script: (url: string) => { status?: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ method, url, body: parsedBody });
    const { status = 200, body = { ok: true } } = script(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("chan/tg CLI — runVerb: tap drives the callbacks route (INTERACT-01 / attribution)", () => {
  it("POSTs {fromUserId:111, botMessageId:<arg>, data} to /callbacks and returns { tapped } — the ARG, not tg last", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/callbacks")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    // botReplyId = 42 (the id `tg send` returned as the agent-authored reply).
    const result = (await runVerb("tap", ["42", "page=2"], ctx)) as Record<string, unknown>;

    // Exactly one control call: the POST to /callbacks (no /outbound re-read).
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.method).toBe("POST");
    // ATTRIBUTION: the URL is the callbacks route on the handle's chat.
    expect(call.url.endsWith(`/control/chats/${fakeHandle().chatId}/callbacks`)).toBe(true);
    // ATTRIBUTION (T-207-15): the body taps the ARG id (42), NOT a re-read `last`.
    expect(call.body).toEqual({ fromUserId: 111, botMessageId: 42, data: "page=2" });
    // The honest result echoes the attributed reply id + the callback data.
    expect(result).toEqual({ tapped: { botReplyId: 42, data: "page=2" } });
  });

  it("does NOT consult tg last / readOutbound — no GET to /outbound is made", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/callbacks")) return { status: 200, body: { ok: true } };
      // If the verb ever read the oracle, this /outbound GET would be recorded.
      return { status: 200, body: [{ messageId: 9999, text: "a DIFFERENT, more-recent message" }] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    await runVerb("tap", ["42", "page=2"], ctx);
    // The map is keyed on the agent-authored reply's id — the verb taps args[0]
    // ONLY; a `/outbound` re-read could pick a non-attributed message.
    expect(rec.calls.some((c) => c.url.includes("/outbound"))).toBe(false);
    expect(rec.calls.every((c) => c.url.includes("/callbacks"))).toBe(true);
  });

  it("the scalar callback data survives verbatim (a &-laden value is IN-04 safe on the JSON path)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/callbacks")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    await runVerb("tap", ["7", "page=2&sort=asc"], ctx);
    expect(rec.calls[0]?.body).toEqual({ fromUserId: 111, botMessageId: 7, data: "page=2&sort=asc" });
  });

  it("bad args (missing both) → VerbFailure(bad_json); the control fetch is NEVER called", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("tap", [], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a non-numeric botReplyId → VerbFailure(bad_json), no fetch", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("tap", ["not-a-number", "page=2"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a missing data (only the id) → VerbFailure(bad_json), no fetch", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("tap", ["42"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a control POST !ok (502) → VerbFailure(dead_handle, control_post_error) — no false exit-0 (T-207-14)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/callbacks")) return { status: 502, body: { ok: false } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("tap", ["42", "page=2"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
    expect((err as VerbFailure).body["status"]).toBe(502);
  });

  it("tap with NO resolved handle is a dead_handle (it drives a live rig) — never a silent no-op", async () => {
    const err = await runVerb("tap", ["42", "page=2"], { handle: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });
});

describe("chan/tg CLI — runVerb: edit drives the edits route (INTERACT-02)", () => {
  it("POSTs {messageId:<arg>, newText} to /edits and returns { edited } on a 2xx", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/edits")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const result = (await runVerb("edit", ["55", "corrected text"], ctx)) as Record<string, unknown>;

    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.endsWith(`/control/chats/${fakeHandle().chatId}/edits`)).toBe(true);
    expect(call.body).toEqual({ messageId: 55, newText: "corrected text" });
    expect(result).toEqual({ edited: { messageId: 55 } });
  });

  it("bad args (missing both) → VerbFailure(bad_json); no fetch", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("edit", [], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a non-numeric messageId → VerbFailure(bad_json), no fetch", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("edit", ["nope", "x"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a missing newText (only the id) → VerbFailure(bad_json), no fetch", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("edit", ["55"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a control POST !ok (500) → VerbFailure(dead_handle, control_post_error) — no false exit-0 (T-207-14)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/edits")) return { status: 500, body: { ok: false } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("edit", ["55", "x"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
    expect((err as VerbFailure).body["status"]).toBe(500);
  });

  it("edit with NO resolved handle is a dead_handle — never a silent no-op", async () => {
    const err = await runVerb("edit", ["55", "x"], { handle: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });
});

describe("chan/tg CLI — runVerb: send-photo / send-voice drive the media route (MEDIA-01)", () => {
  /** A tiny base64 payload the tests POST as the media bytes. */
  const PHOTO_B64 = Buffer.from("\x89PNG\r\n\x1a\n-fake-photo-bytes").toString("base64");
  const VOICE_B64 = Buffer.from("OggS-fake-voice-bytes").toString("base64");

  it("send-photo POSTs {kind:'photo', fromUserId:111, fileBase64} to /media then reply-waits and returns the reply", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/media")) return { status: 200, body: { ok: true, messageId: 2001 } };
      if (url.includes("/outbound")) return { status: 200, body: [{ messageId: 2002, text: "nice photo" }] };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const result = (await runVerb("send-photo", [PHOTO_B64], ctx)) as Record<string, unknown>;

    const post = rec.calls.find((c) => c.url.includes("/media"))!;
    expect(post.method).toBe("POST");
    expect(post.url.endsWith(`/control/chats/${fakeHandle().chatId}/media`)).toBe(true);
    expect(post.body).toMatchObject({ kind: "photo", fromUserId: 111, fileBase64: PHOTO_B64 });
    // The reply-wait surfaced the bot reply (honest, not fabricated) keyed on the
    // minted media messageId (2001).
    const wait = rec.calls.find((c) => c.url.includes("/outbound"))!;
    expect(wait.url).toContain("afterMessageId=2001");
    expect(result).toMatchObject({ inboundId: 2001, botReplyId: 2002, reply: "nice photo" });
  });

  it("send-voice POSTs {kind:'voice', …} to /media (the same reply-wait shape as send)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/media")) return { status: 200, body: { ok: true, messageId: 3001 } };
      if (url.includes("/outbound")) return { status: 200, body: [{ messageId: 3002, text: "got it" }] };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const result = (await runVerb("send-voice", [VOICE_B64], ctx)) as Record<string, unknown>;
    const post = rec.calls.find((c) => c.url.includes("/media"))!;
    expect(post.body).toMatchObject({ kind: "voice", fromUserId: 111, fileBase64: VOICE_B64 });
    expect(result).toMatchObject({ inboundId: 3001, botReplyId: 3002, reply: "got it" });
  });

  it("send-photo with an EMPTY outbound throws VerbFailure(no_reply) — no false success (T-207-14)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/media")) return { status: 200, body: { ok: true, messageId: 4001 } };
      if (url.includes("/outbound")) return { status: 200, body: [] }; // honest no-reply
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("send-photo", [PHOTO_B64], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("no_reply");
    expect((err as VerbFailure).body).toHaveProperty("inboundId", 4001);
  });

  it("a missing bytes arg → VerbFailure(bad_json); the control fetch is NEVER called", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("send-photo", [], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("an @<path> arg reads a fixture file off disk and base64-encodes it for /media", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-chan-media-"));
    const fixture = join(dir, "pic.bin");
    const raw = Buffer.from("\x89PNG-fixture-on-disk");
    writeFileSync(fixture, raw);
    try {
      const rec = recording207Fetch((url) => {
        if (url.includes("/media")) return { status: 200, body: { ok: true, messageId: 5001 } };
        if (url.includes("/outbound")) return { status: 200, body: [{ messageId: 5002, text: "seen" }] };
        return { status: 200, body: [] };
      });
      const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
      const result = (await runVerb("send-photo", [`@${fixture}`], ctx)) as Record<string, unknown>;
      const post = rec.calls.find((c) => c.url.includes("/media"))!;
      // The disk bytes were re-encoded to base64 (NO form-data upload).
      expect((post.body as Record<string, unknown>)["fileBase64"]).toBe(raw.toString("base64"));
      expect(result).toMatchObject({ inboundId: 5001, reply: "seen" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an @<path> to a MISSING file → VerbFailure(bad_json); the control fetch is NEVER called", async () => {
    const rec = recording207Fetch(() => ({ status: 200, body: { ok: true } }));
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("send-voice", ["@/tmp/sv-no-such-fixture.ogg"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("bad_json");
    expect(rec.calls).toHaveLength(0);
  });

  it("a media POST !ok (500) → VerbFailure(dead_handle, control_post_error) BEFORE the reply-wait", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/media")) return { status: 500, body: { ok: false } };
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("send-photo", [PHOTO_B64], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
    // The reply-wait was never reached (the POST failed fast).
    expect(rec.calls.some((c) => c.url.includes("/outbound"))).toBe(false);
  });

  it("a media POST 200 with NO numeric messageId fails honestly (not a 45s no_reply)", async () => {
    const rec = recording207Fetch((url) => {
      if (url.includes("/media")) return { status: 200, body: { ok: true } }; // no messageId
      return { status: 200, body: [] };
    });
    const ctx: VerbContext = { handle: fakeHandle(), controlFetch: rec.fetch };
    const err = await runVerb("send-photo", [PHOTO_B64], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("control_post_error");
  });

  it("send-photo with NO resolved handle is a dead_handle — never a silent no-op", async () => {
    const err = await runVerb("send-photo", [PHOTO_B64], { handle: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/tg up/);
  });
});

describe("chan/tg CLI — runVerb: oracle-read reason codes (WR-02: not rpc_error)", () => {
  it("db against a MISSING memory.db is a dead_handle (db_unavailable), NOT rpc_error", async () => {
    // A freshly-spawned rig before its first write: the db path does not exist.
    // better-sqlite3 throws "unable to open database file" — that is an I/O
    // condition, not an RPC failure. It must reason-code as dead_handle.
    const ctx: VerbContext = { handle: fakeHandle({ memoryDbPath: "/tmp/sv-no-such-dir/memory.db" }) };
    const err = await runVerb("db", ["SELECT 1"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("db_unavailable");
  });

  it("db with MALFORMED SQL against a real db is a bad_json, NOT rpc_error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-chan-db-"));
    const dbPath = join(dir, "memory.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE t (id INTEGER)");
    seed.close();
    try {
      const ctx: VerbContext = { handle: fakeHandle({ memoryDbPath: dbPath }) };
      const err = await runVerb("db", ["SELECT bogus syntax FROM"], ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerbFailure);
      expect((err as VerbFailure).kind).toBe("bad_json");
      expect(JSON.stringify((err as VerbFailure).body)).toMatch(/SQL/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirror surfaces a reader sqlite/fs throw as dead_handle (mirror_unavailable), NOT rpc_error", async () => {
    const readMirror = vi.fn(() => {
      throw new Error("unable to open database file");
    });
    const ctx: VerbContext = { handle: fakeHandle(), readMirror };
    const err = await runVerb("mirror", ["default:user1:telegram:1717"], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("dead_handle");
    expect((err as VerbFailure).body["reason"]).toBe("mirror_unavailable");
  });
});

describe("chan/tg CLI — runVerb: lifecycle (CLI-01)", () => {
  it("down with an explicit --endpoint REFUSES to wipe (never destroy what you didn't spawn)", async () => {
    const err = await runVerb("down", [], {
      handle: fakeHandle(),
      flagEndpoint: "http://127.0.0.1:9999",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    // A refusal is an honest non-zero exit, reason-coded.
    expect(JSON.stringify((err as VerbFailure).body)).toMatch(/refus|endpoint/i);
  });

  it("down with an explicit --endpoint refuses (reason: refused) even when NO local handle resolved (WR-04)", async () => {
    // The --endpoint refusal is independent of whether a handle file exists; it
    // must fire BEFORE the generic dead-handle guard so the reason code is the
    // precise "refused", not a generic "dead_handle".
    const err = await runVerb("down", [], {
      handle: undefined,
      flagEndpoint: "http://127.0.0.1:9999",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).body["reason"]).toBe("refused");
  });

  it("up calls the injected discover-or-spawn launcher and reports reused/spawned", async () => {
    const startStandaloneRigFn = vi.fn().mockResolvedValue({
      reused: true,
      handle: fakeHandle(),
    });
    const result = (await runVerb("up", [], {
      handle: undefined,
      startStandaloneRigFn,
    })) as Record<string, unknown>;
    expect(startStandaloneRigFn).toHaveBeenCalledTimes(1);
    expect(result["reused"]).toBe(true);
    // The token is NOT surfaced in the up result (no secret leak).
    expect(JSON.stringify(result)).not.toContain("test-token-0000");
  });
});

describe("chan/tg CLI — runVerb: deferred verbs exit honestly (Deferred-Ideas boundary)", () => {
  // Phase 207 wired send-photo/send-voice/tap/edit to the control routes — ONLY
  // `group` remains deferred (Phase 208). The four 207 verbs are covered by the
  // wired-verb suites below; they must NO LONGER throw not_implemented_in_phase.
  it.each([["group", "208"]])(
    "%s throws VerbFailure with not_implemented_in_phase pointing at phase %s",
    async (verb, phase) => {
      const err = await runVerb(verb, [], { handle: fakeHandle() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerbFailure);
      const bodyStr = JSON.stringify((err as VerbFailure).body);
      expect(bodyStr).toMatch(/not_implemented_in_phase/);
      expect(bodyStr).toContain(phase);
    },
  );

  it.each([
    ["send-photo"],
    ["send-voice"],
    ["tap"],
    ["edit"],
  ])("%s is NO LONGER a not_implemented_in_phase stub (wired in Phase 207)", async (verb) => {
    // It must reach the verb body (which then fails honestly on the fake handle's
    // dead control endpoint / bad args) — NOT short-circuit to the deferred stub.
    const err = await runVerb(verb, ["1", "x"], { handle: fakeHandle() }).catch((e: unknown) => e);
    // Whatever it throws (a real control error), it must NOT be the deferral.
    if (err instanceof VerbFailure) {
      expect(err.kind).not.toBe("not_implemented_in_phase");
    }
  });
});

describe("chan/tg CLI — runVerb: unknown verb", () => {
  it("an unknown verb throws an honest VerbFailure (never a silent no-op)", async () => {
    const err = await runVerb("frobnicate", [], { handle: fakeHandle() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbFailure);
  });
});
