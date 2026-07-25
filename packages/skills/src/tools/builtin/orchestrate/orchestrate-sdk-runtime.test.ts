// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the orchestrate SDK runtime — the cap-socket CLIENT shim the
 * generated `comis_tools.js` imports (`invoke` + `wrapResultRef`). These run on
 * macOS (no bwrap): the wire is exercised against a REAL in-test unix-socket
 * server that mirrors the capability endpoint's newline-JSON protocol
 * (`{ bearer, method, params, operationId? }` → `{ result }` / `{ error }`), and the env is
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

import { callCapSocket, invoke, wrapResultRef } from "./orchestrate-sdk-runtime.js";
// The GENERATED SDK — exercised here so the shipped proxy bytes (not just the
// runtime shim) are proven: awaiting/inspecting a partial `mcp` namespace must
// NOT fire a spurious cap call.
import { comis_tools } from "./comis_tools.js";

/** One received request line, captured by the fake server for assertions. */
interface CapturedRequest {
  bearer: string;
  method: string;
  params?: Record<string, unknown>;
  operationId?: string;
}

/**
 * A minimal fake of the cap endpoint: one `{ bearer, method, params }`
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

  describe("callCapSocket (the generalized arbitrary-method cap-socket wire)", () => {
    it("sends the method THROUGH verbatim (not wrapped in a tool.invoke envelope) and returns the {result}", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(
        socketPath,
        () => ({ result: { sessionId: "sub-7" } }),
        captured,
      );

      // A DIRECT orchestration method — the very case invoke() cannot serve
      // (invoke("session.spawn", …) would send tool.invoke{tool:"session.spawn"},
      // an unmapped tool → CapabilityDeniedError). callCapSocket passes it raw.
      const out = await callCapSocket("session.spawn", { task: "x" });

      expect(out).toEqual({ sessionId: "sub-7" });
      expect(captured).toHaveLength(1);
      expect(captured[0].bearer).toBe("lease-bearer-xyz");
      // The method is the WIRE method itself — NOT "tool.invoke".
      expect(captured[0].method).toBe("session.spawn");
      // params is passed through verbatim — NO { tool, args } wrapping.
      expect(captured[0].params).toEqual({ task: "x" });
    });

    it("rides the unix cap socket (COMIS_ORCH_SOCKET), never the ws://…:4766 gateway wire", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "ok" }), captured);

      // The fake server is a node:net unix-socket listener on COMIS_ORCH_SOCKET.
      // A reply only arrives if callCapSocket connected to THAT socket — proving
      // the wire is the lease-authenticated unix cap socket, not a WebSocket to
      // ws://…:4766/ws (the forbidden gateway client).
      const out = await callCapSocket("graph.execute", { graph: "g" });

      expect(out).toBe("ok");
      expect(captured[0].method).toBe("graph.execute");
    });

    it("rejects loudly naming both env vars and 'jail' when COMIS_ORCH_SOCKET is absent", async () => {
      delete process.env.COMIS_ORCH_SOCKET;

      const err = await callCapSocket("cron.add", { spec: "* * * * *" }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/COMIS_ORCH_SOCKET/);
      expect(err!.message).toMatch(/COMIS_CAP_LEASE/);
      expect(err!.message).toMatch(/jail/);
    });

    it("rejects loudly naming both env vars and 'jail' when COMIS_CAP_LEASE is absent (never a silent host run)", async () => {
      delete process.env.COMIS_CAP_LEASE;

      const err = await callCapSocket("message.send", { text: "hi" }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/COMIS_ORCH_SOCKET/);
      expect(err!.message).toMatch(/COMIS_CAP_LEASE/);
      expect(err!.message).toMatch(/jail/);
    });

    it("rejects with the server's {error} line (deny surfaces to the caller)", async () => {
      server = await startFakeCapServer(socketPath, () => ({ error: "denied" }), []);

      await expect(callCapSocket("skills.create", { name: "x" })).rejects.toThrow(/denied/);
    });

    it("carries the caller-provided outward operation identity through the generated SDK", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: { sent: true } }), captured);

      await comis_tools.message_send({ channelId: "chat_a", text: "hello" }, "operation-stable");

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        method: "message.send",
        operationId: "operation-stable",
      });
    });

    it("refuses an outward call without a caller-provided operation identity", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: { sent: true } }), captured);

      await expect(
        callCapSocket("message.send", { channelId: "chat_a", text: "hello" }),
      ).rejects.toThrow(/operation identity is required/i);

      expect(captured).toHaveLength(0);
    });

    it("retries an outward response loss once with the same operation identity", async () => {
      const captured: CapturedRequest[] = [];
      const appliedOperations = new Set<string>();
      let appliedCount = 0;
      server = await new Promise<net.Server>((resolve, reject) => {
        const s = net.createServer((socket) => {
          let buf = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            const req = JSON.parse(buf.slice(0, nl)) as CapturedRequest;
            captured.push(req);
            if (!appliedOperations.has(req.operationId ?? "")) {
              appliedOperations.add(req.operationId ?? "");
              appliedCount += 1;
            }
            if (captured.length === 1) {
              socket.end();
              return;
            }
            socket.end(`${JSON.stringify({ result: { sent: true } })}\n`);
          });
        });
        s.on("error", reject);
        s.listen({ path: socketPath }, () => resolve(s));
      });

      await expect(
        callCapSocket("message.send", { channelId: "chat_a", text: "hello" }, "operation-retry"),
      ).resolves.toEqual({ sent: true });

      expect(captured).toHaveLength(2);
      expect(captured.map((request) => request.operationId)).toEqual([
        "operation-retry",
        "operation-retry",
      ]);
      expect(appliedCount).toBe(1);
    });

    it("does not retry an outward application error", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(
        socketPath,
        () => ({ error: "capability_denied: orch:message" }),
        captured,
      );

      await expect(
        callCapSocket("message.reply", { messageId: "msg_a" }, "operation-denied"),
      ).rejects.toThrow(/capability_denied/);

      expect(captured).toHaveLength(1);
      expect(captured[0].operationId).toBe("operation-denied");
    });

    it("rejects with a 'closed before a complete response line' error when the server closes without a newline reply (containment fault)", async () => {
      // The server ends the connection WITHOUT writing a newline-terminated
      // reply line — mirroring a mid-protocol close. callCapSocket must surface
      // the close-before-reply error, never hang.
      server = await new Promise<net.Server>((resolve, reject) => {
        const s = net.createServer((socket) => {
          socket.setEncoding("utf8");
          socket.on("data", () => {
            socket.end(); // close with no reply line
          });
        });
        s.on("error", reject);
        s.listen({ path: socketPath }, () => resolve(s));
      });

      await expect(callCapSocket("session.spawn", { task: "x" })).rejects.toThrow(
        /closed before a complete response line/,
      );
    });
  });

  describe("invoke delegates to callCapSocket (byte-identical tool.invoke wire, zero behavior change)", () => {
    it("invoke('grep', {pattern}) still sends exactly {bearer, method:'tool.invoke', params:{tool, args}}", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "matched" }), captured);

      const out = await invoke("grep", { pattern: "x" });

      expect(out).toBe("matched");
      expect(captured).toHaveLength(1);
      expect(captured[0].bearer).toBe("lease-bearer-xyz");
      expect(captured[0].method).toBe("tool.invoke");
      // The exact pre-refactor envelope: { tool, args } under params.
      expect(captured[0].params).toEqual({ tool: "grep", args: { pattern: "x" } });
    });

    it("invoke('grep') with no args sends params.args as {} (the args ?? {} default is preserved)", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "ok" }), captured);

      await invoke("grep");

      expect(captured[0].method).toBe("tool.invoke");
      expect(captured[0].params).toEqual({ tool: "grep", args: {} });
    });
  });

  describe("wrapResultRef (in-jail extraction)", () => {
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

    it(".sql(query) runs the DuckDB SQL query over the ref file and returns only the slice", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: [{ id: 1 }] }), captured);
      const wrapped = wrapResultRef({
        ref: "results/data.jsonl",
        kind: "jsonl",
        bytes: 9,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      const out = await wrapped.sql("SELECT id FROM data WHERE id = 1");

      expect(out).toEqual([{ id: 1 }]);
      expect(captured[0].params).toEqual({
        tool: "sql",
        args: { path: "results/data.jsonl", query: "SELECT id FROM data WHERE id = 1" },
      });
    });

    it(".jsonpath(expr) extracts the JSONPath slice over the ref file in-jail", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: ["a", "b"] }), captured);
      const wrapped = wrapResultRef({
        ref: "results/data.json",
        kind: "json",
        bytes: 9,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      const out = await wrapped.jsonpath("$.items[*].name");

      expect(out).toEqual(["a", "b"]);
      expect(captured[0].params).toEqual({
        tool: "jsonpath",
        args: { path: "results/data.json", expr: "$.items[*].name" },
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

  // -------------------------------------------------------------------------
  // The `mcp` runtime proxy must NOT be thenable. A common model mistake,
  // `await comis_tools.mcp.server` (awaiting the namespace instead of calling a
  // tool), would otherwise access `.then`, resolve it to a callable, and CALL it
  // — firing a spurious (allowlist-denied) tool:"then" cap dispatch (and, since
  // the returned thenable never resolves, hanging the await). The proxy drops the
  // promise-protocol/inspection names + symbol keys on BOTH namespace levels so a
  // partial-namespace await/inspect is a clean no-op.
  // -------------------------------------------------------------------------
  describe("mcp proxy — not thenable", () => {
    it("returns undefined for then/catch/finally/toJSON + symbol keys on both namespace levels", () => {
      // Cast to a PropertyKey-indexable view: the ComisTools type models mcp as a
      // string-keyed record, but the footgun is precisely the special keys.
      const mcpNs = comis_tools.mcp as unknown as Record<PropertyKey, unknown>;
      const serverNs = comis_tools.mcp.myserver as unknown as Record<PropertyKey, unknown>;
      for (const k of ["then", "catch", "finally", "toJSON"]) {
        expect(mcpNs[k]).toBeUndefined(); // level 1 (server namespace)
        expect(serverNs[k]).toBeUndefined(); // level 2 (tool namespace)
      }
      expect(serverNs[Symbol.iterator]).toBeUndefined();
      expect(mcpNs[Symbol.iterator]).toBeUndefined();
    });

    it("awaiting a partial namespace resolves to the namespace and dispatches NO cap call", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "unexpected" }), captured);

      // `.then` is undefined ⇒ the value is non-thenable ⇒ `await` yields it
      // unchanged and fires NO cap call (the footgun is gone). A short timeout so
      // a regression (a thenable that never resolves) fails fast, never hangs.
      const awaited = await comis_tools.mcp.myserver;

      expect(awaited).toBeDefined();
      expect(captured).toHaveLength(0);
    }, 3000);

    it("still dispatches a REAL mcp tool call as one composed tool.invoke {server,tool,args}", async () => {
      const captured: CapturedRequest[] = [];
      server = await startFakeCapServer(socketPath, () => ({ result: "hello from mcp" }), captured);

      const out = await comis_tools.mcp.ctx7.search({ q: "comis" });

      expect(out).toBe("hello from mcp");
      expect(captured).toHaveLength(1);
      expect(captured[0].method).toBe("tool.invoke");
      expect(captured[0].params).toEqual({
        tool: "mcp",
        args: { server: "ctx7", tool: "search", args: { q: "comis" } },
      });
    });
  });
});
