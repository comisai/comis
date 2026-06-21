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

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  toFailure,
  exitCodeFor,
  tryParseJson,
  type FailureKind,
} from "./chan.js";

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
