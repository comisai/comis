// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the host-side no-secret allowlist CONNECT proxy
 * (`createTerminalEgressProxy`, the {@link EgressControlPort} impl).
 *
 * The proxy is the proven host-side allowlist gate (allowlisted host ->
 * 200 + forward; non-listed -> 403, no upstream dial). It listens on a unix
 * socket — so the allowlist DECISION is fully macOS-testable over a plain unix
 * socket WITHOUT netns: we connect a client to the materialized socket, write a
 * `CONNECT host:443` line, and assert (a) the injected upstream-dial is called
 * for an allowlisted host and NOT called for a non-listed host, (b) the 403
 * response on deny, (c) no secret is injected into the stream, (d) dispose()
 * unlinks the socket + closes the server. The LIVE relay-as-init (lo up + netns)
 * is VPS-only, not exercised here.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { createTerminalEgressProxy } from "./terminal-egress-proxy.js";
import type { EgressMaterialization } from "@comis/core";

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Connect to a unix socket, write the CONNECT preamble, collect the first reply chunk. */
function connectAndSendConnect(
  socketPath: string,
  target: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath, () => {
      c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      // The proxy's first write is the status line — enough to assert allow/deny.
      if (buf.includes("\r\n")) {
        c.destroy();
        resolve(buf);
      }
    });
    c.on("error", reject);
    c.on("close", () => resolve(buf));
  });
}

describe("createTerminalEgressProxy — host-side no-secret allowlist CONNECT proxy", () => {
  const live: EgressMaterialization[] = [];

  afterEach(async () => {
    while (live.length > 0) {
      const m = live.pop();
      try {
        await m?.dispose();
      } catch {
        /* idempotent teardown */
      }
    }
  });

  it("materialize() returns a socketPath under the injected temp dir", async () => {
    const dial = vi.fn();
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: dial as never,
      socketDir: tmpdir(),
      genId: () => "abc123",
    });
    const mat = await proxy.materialize(["api.example.com"]);
    live.push(mat);
    expect(mat.socketPath).toContain(tmpdir());
    expect(mat.socketPath).toContain("abc123");
    expect(mat.socketPath.endsWith(".sock")).toBe(true);
    expect(existsSync(mat.socketPath)).toBe(true);
  });

  it("ALLOW: a CONNECT to an allowlisted host dials upstream (the forward path is taken)", async () => {
    // A fake upstream: a net.Socket-like duplex that swallows writes. The proxy
    // must call dialUpstream(host, port) for an allowlisted target.
    const fakeUpstream = new net.Socket();
    const dial = vi.fn(() => {
      // Emit 'connect' asynchronously so the proxy can wire its pipe.
      queueMicrotask(() => fakeUpstream.emit("connect"));
      return fakeUpstream;
    });
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: dial as never,
      socketDir: tmpdir(),
      genId: () => "allow1",
    });
    const mat = await proxy.materialize(["api.example.com"]);
    live.push(mat);

    const reply = await connectAndSendConnect(mat.socketPath, "api.example.com:443");
    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledWith("api.example.com", 443);
    // On allow the proxy writes the 200 Connection established preamble.
    expect(reply).toContain("200");
    fakeUpstream.destroy();
  });

  it("DENY: a CONNECT to a NON-listed host is 403'd and never dials upstream", async () => {
    const dial = vi.fn();
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: dial as never,
      socketDir: tmpdir(),
      genId: () => "deny1",
    });
    const mat = await proxy.materialize(["api.example.com"]);
    live.push(mat);

    const reply = await connectAndSendConnect(mat.socketPath, "evil.example.com:443");
    expect(reply).toContain("403");
    expect(reply).toMatch(/Forbidden/i);
    // The deny branch MUST NOT dial upstream (no SSRF, no leak).
    expect(dial).not.toHaveBeenCalled();
  });

  it("NO-SECRET: the proxy injects nothing — the 200 preamble carries no credential header", async () => {
    const fakeUpstream = new net.Socket();
    const dial = vi.fn(() => {
      queueMicrotask(() => fakeUpstream.emit("connect"));
      return fakeUpstream;
    });
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: dial as never,
      socketDir: tmpdir(),
      genId: () => "nosecret1",
    });
    const mat = await proxy.materialize(["api.example.com"]);
    live.push(mat);

    const reply = await connectAndSendConnect(mat.socketPath, "api.example.com:443");
    // It is a PURE CONNECT relay — distinct from the credential broker. The
    // response the client sees must NOT contain an Authorization/Bearer header.
    expect(reply).not.toMatch(/Authorization/i);
    expect(reply).not.toMatch(/Bearer/i);
    fakeUpstream.destroy();
  });

  it("DISPOSE: the socket file is unlinked + the server closed after dispose()", async () => {
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: vi.fn() as never,
      socketDir: tmpdir(),
      genId: () => "dispose1",
    });
    const mat = await proxy.materialize(["api.example.com"]);
    expect(existsSync(mat.socketPath)).toBe(true);
    await mat.dispose();
    expect(existsSync(mat.socketPath)).toBe(false);
    // Idempotent: a second dispose() resolves (does not throw).
    await expect(mat.dispose()).resolves.toBeUndefined();
  });

  it("two concurrent materializations get distinct sockets (per-session isolation)", async () => {
    let n = 0;
    const proxy = createTerminalEgressProxy({
      logger: silentLogger(),
      dialUpstream: vi.fn() as never,
      socketDir: tmpdir(),
      genId: () => `sess-${n++}`,
    });
    const a = await proxy.materialize(["a.example.com"]);
    const b = await proxy.materialize(["b.example.com"]);
    live.push(a, b);
    expect(a.socketPath).not.toBe(b.socketPath);
  });
});
