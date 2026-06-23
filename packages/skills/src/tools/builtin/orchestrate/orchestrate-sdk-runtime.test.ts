// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the orchestrate SDK runtime — the cap-socket CLIENT shim the
 * generated `comis_tools.js` imports (`invoke` + `wrapResultRef`). These run on
 * macOS (no bwrap): the wire is exercised against a REAL in-test unix-socket
 * server that mirrors the Phase-211 capability endpoint's newline-JSON protocol
 * (`{ bearer, method, params }` → `{ result }` / `{ error }`), and the env is
 * injected via `COMIS_ORCH_SOCKET`/`COMIS_CAP_LEASE` (read through the
 * `@comis/core` `systemGetEnv` seam in production).
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invoke, wrapResultRef } from "./orchestrate-sdk-runtime.js";

/** One received request line, captured by the fake server for assertions. */
interface CapturedRequest {
  bearer: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * A minimal fake of the Phase-211 cap endpoint: one `{ bearer, method, params }`
 * JSON line per connection → one `{ result }` / `{ error }` line back, then end.
 * The `reply` fn maps the parsed request to the wire-reply object.
 */
function startFakeCapServer(
  socketPath: string,
  reply: (req: CapturedRequest) => Record<string, unknown> | string,
  captured: CapturedRequest[],
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        const req = JSON.parse(line) as CapturedRequest;
        captured.push(req);
        const r = reply(req);
        // A raw string lets a test emit a deliberately MALFORMED (non-JSON) reply.
        socket.end(typeof r === "string" ? r : JSON.stringify(r) + "\n");
      });
    });
    server.on("error", reject);
    server.listen({ path: socketPath }, () => resolve(server));
  });
}

describe("orchestrate-sdk-runtime", () => {
  let tmp: string;
  let socketPath: string;
  let server: net.Server | undefined;
  const prevSocket = process.env.COMIS_ORCH_SOCKET;
  const prevLease = process.env.COMIS_CAP_LEASE;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "comis-orch-runtime-"));
    socketPath = join(tmp, "cap.sock");
    process.env.COMIS_ORCH_SOCKET = socketPath;
    process.env.COMIS_CAP_LEASE = "lease-bearer-xyz";
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    if (prevSocket === undefined) delete process.env.COMIS_ORCH_SOCKET;
    else process.env.COMIS_ORCH_SOCKET = prevSocket;
    if (prevLease === undefined) delete process.env.COMIS_CAP_LEASE;
    else process.env.COMIS_CAP_LEASE = prevLease;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("sends one {bearer, method:'tool.invoke', params:{tool, args}} line and returns the {result}", async () => {
    const captured: CapturedRequest[] = [];
    server = await startFakeCapServer(
      socketPath,
      () => ({ result: { hits: ["a", "b"] } }),
      captured,
    );

    const out = await invoke("memory_search", { q: "x" });

    expect(out).toEqual({ hits: ["a", "b"] });
    expect(captured).toHaveLength(1);
    expect(captured[0].bearer).toBe("lease-bearer-xyz");
    expect(captured[0].method).toBe("tool.invoke");
    expect(captured[0].params).toEqual({ tool: "memory_search", args: { q: "x" } });
  });

  it("throws the server's {error} reply (the error surfaces to the script)", async () => {
    server = await startFakeCapServer(
      socketPath,
      () => ({ error: "capability_denied: orch:web" }),
      [],
    );

    await expect(invoke("web_fetch", { url: "https://x" })).rejects.toThrow(
      /capability_denied: orch:web/,
    );
  });

  it("throws a malformed-response error on a non-JSON reply line", async () => {
    server = await startFakeCapServer(socketPath, () => "not-json-at-all\n", []);

    await expect(invoke("grep", { pattern: "x" })).rejects.toThrow(/malformed/i);
  });

  it("rejects with the socket error when the cap socket connection fails (no listener)", async () => {
    // The env is present (set in beforeEach) so the precondition passes and the
    // runtime reaches `net.connect`. But NO server is started on socketPath, so
    // the connect fails — Node emits the socket `error` event (ENOENT for a
    // missing unix socket), and the runtime's `socket.on("error")` handler must
    // reject with that transport error (a closed/unreachable cap socket is a
    // containment fault — surfaced, never hung).
    let rejected: Error | undefined;
    try {
      await invoke("read", { path: "x" });
    } catch (err) {
      rejected = err as Error;
    }
    expect(rejected).toBeInstanceOf(Error);
    // The rejection is the underlying connect error (ENOENT), NOT the
    // precondition message — proving the `error` handler (not the env guard)
    // produced it.
    const code = (rejected as NodeJS.ErrnoException).code;
    expect(code === "ENOENT" || /ENOENT|connect/i.test(rejected!.message)).toBe(true);
    expect(rejected!.message).not.toMatch(/COMIS_ORCH_SOCKET|orchestrate jail/);
  });

  it("throws a clear precondition error when COMIS_ORCH_SOCKET is absent (only valid in-jail)", async () => {
    delete process.env.COMIS_ORCH_SOCKET;

    await expect(invoke("read", { path: "x" })).rejects.toThrow(
      /COMIS_ORCH_SOCKET|COMIS_CAP_LEASE|orchestrate jail/,
    );
  });

  it("throws a clear precondition error when COMIS_CAP_LEASE is absent (only valid in-jail)", async () => {
    delete process.env.COMIS_CAP_LEASE;

    await expect(invoke("read", { path: "x" })).rejects.toThrow(
      /COMIS_ORCH_SOCKET|COMIS_CAP_LEASE|orchestrate jail/,
    );
  });

  describe("wrapResultRef (REF-02 in-jail extraction)", () => {
    it("preserves the ResultRef handle fields (ref/kind/bytes/preview)", () => {
      const wrapped = wrapResultRef({
        ref: "results/abc.jsonl",
        kind: "jsonl",
        bytes: 1234,
        rows: 10,
        preview: "head…",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      expect(wrapped.ref).toBe("results/abc.jsonl");
      expect(wrapped.kind).toBe("jsonl");
      expect(wrapped.bytes).toBe(1234);
      expect(wrapped.preview).toBe("head…");
      expect(typeof wrapped.grep).toBe("function");
      expect(typeof wrapped.jq).toBe("function");
      expect(typeof wrapped.read).toBe("function");
    });

    it(".grep(pattern) issues an in-jail grep over the ref file and returns only the slice", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(
        socketPath,
        () => ({ result: "matching-line-1\nmatching-line-2" }),
        captured,
      );
      const wrapped = wrapResultRef({
        ref: "results/abc.jsonl",
        kind: "jsonl",
        bytes: 9,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      const slice = await wrapped.grep("needle");

      expect(slice).toBe("matching-line-1\nmatching-line-2");
      expect(captured[0].method).toBe("tool.invoke");
      expect(captured[0].params).toEqual({
        tool: "grep",
        args: { path: "results/abc.jsonl", pattern: "needle" },
      });
    });

    it(".jq(expr) runs the jq expression over the ref file in-jail", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: [1, 2, 3] }), captured);
      const wrapped = wrapResultRef({
        ref: "results/data.json",
        kind: "json",
        bytes: 9,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      const out = await wrapped.jq(".items[].id");

      expect(out).toEqual([1, 2, 3]);
      expect(captured[0].params).toEqual({
        tool: "jq",
        args: { path: "results/data.json", expr: ".items[].id" },
      });
    });

    it(".read(offset, limit) reads a bounded slice of the ref file in-jail", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "line5\nline6" }), captured);
      const wrapped = wrapResultRef({
        ref: "results/big.text",
        kind: "text",
        bytes: 99,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      const out = await wrapped.read(5, 2);

      expect(out).toBe("line5\nline6");
      expect(captured[0].params).toEqual({
        tool: "read",
        args: { path: "results/big.text", offset: 5, limit: 2 },
      });
    });
  });
});
