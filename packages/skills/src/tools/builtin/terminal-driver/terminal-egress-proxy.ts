// SPDX-License-Identifier: Apache-2.0
/**
 * The host-side no-secret allowlist CONNECT proxy — the production
 * {@link EgressControlPort} impl for the terminal driver's `network: listed-hosts`
 * egress filter. It is the proven host side of the egress
 * transport (demonstrated live on a VPS: allowlisted ->
 * 200, non-listed -> 403, direct `--unshare-net` bypass -> rc=7).
 *
 * Transport recap:
 *   in-jail loopback relay (`HTTPS_PROXY=http://127.0.0.1:<port>`)
 *     -> bind-mounted unix socket
 *       -> THIS host-side allowlist CONNECT proxy
 *         -> the real `host:443` (only if host ∈ scope.hosts[])
 *
 * `materialize(hosts)` stands up a `net.createServer` on a transient per-session
 * unix socket (`<socketDir>/comis-egress-<id>.sock`), parses the `CONNECT
 * host:port` request line of each inbound connection, gates the target host
 * against `hosts` (exact host match), and on ALLOW forwards the raw TCP stream to
 * `host:port`. A non-listed host gets `HTTP/1.1 403 Forbidden` and the connection
 * is closed with NO upstream dial (no SSRF, no leak). The proxy injects NOTHING
 * into the stream — it is a pure CONNECT relay, DISTINCT from the optional
 * credential-injecting egress tier: there is NO secret-injection code
 * path here (no auth header, no token mint) by construction. The "no-secret"
 * acceptance grep enforces the absence of any credential-injection token in this
 * file — keep it that way.
 *
 * It is daemon-side (the composition root), so a value-import of `@comis/infra`
 * would be allowed — but the proxy needs only Node `net`/`fs`, so it stays
 * infra-free for portability + macOS-testability (the allowlist DECISION is fully
 * exercisable over a plain unix socket with no netns; the LIVE relay-as-init is
 * VPS-only). The upstream dial, the socket dir, and the id generator are
 * injected so the macOS test asserts allow/deny WITHOUT real egress.
 *
 * No module-global mutable state: each `materialize` owns its own server + socket;
 * `dispose()` closes the server and unlinks the socket (idempotent).
 *
 * @module
 */

import * as net from "node:net";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { EgressControlPort, EgressMaterialization } from "@comis/core";

/** The minimal structural logger the proxy needs (a subset of `ComisLogger`). */
export interface EgressProxyLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Dependencies for the host-side allowlist proxy (all injectable for testing). */
export interface TerminalEgressProxyDeps {
  /** Structural logger (the daemon's real logger in production). */
  readonly logger: EgressProxyLogger;
  /**
   * The upstream dial seam: `(host, port) => net.Socket`. Defaults to
   * `net.connect` in production; injected as a stub in the macOS test so the
   * allowlist decision is asserted WITHOUT real egress.
   */
  readonly dialUpstream?: (host: string, port: number) => net.Socket;
  /**
   * Directory for the transient per-session unix socket. Defaults to the OS temp
   * dir; injected in tests. The socket is `<socketDir>/comis-egress-<id>.sock`.
   */
  readonly socketDir?: string;
  /** Id generator for the socket filename (injected in tests for determinism). */
  readonly genId?: () => string;
}

/** The longest CONNECT request line we will buffer before giving up (anti-DoS). */
const MAX_CONNECT_LINE_BYTES = 8 * 1024;

/** Parse a `CONNECT host:port ...` request line; returns null if malformed. */
function parseConnect(line: string): { host: string; port: number } | null {
  const m = /^CONNECT\s+([^:\s]+):(\d+)\b/i.exec(line);
  if (!m) return null;
  const port = Number.parseInt(m[2]!, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1]!, port };
}

/**
 * Wire one inbound client connection: buffer until the CR-LF-terminated CONNECT
 * request line is complete (it may arrive split across TCP segments — the spike's
 * single-chunk parse silently dropped fragmented preambles), then gate + forward
 * or 403.
 */
function handleClient(
  client: net.Socket,
  allow: ReadonlySet<string>,
  dial: (host: string, port: number) => net.Socket,
  logger: EgressProxyLogger,
): void {
  let preamble = "";
  let routed = false;

  const onData = (chunk: Buffer): void => {
    if (routed) return;
    preamble += chunk.toString("latin1");
    const eol = preamble.indexOf("\r\n");
    if (eol === -1) {
      if (preamble.length > MAX_CONNECT_LINE_BYTES) {
        routed = true;
        client.removeListener("data", onData);
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      }
      return; // wait for more — the request line is not complete yet.
    }
    routed = true;
    client.removeListener("data", onData);

    const requestLine = preamble.slice(0, eol);
    const target = parseConnect(requestLine);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!allow.has(target.host)) {
      // DENY — 403, no upstream dial (no SSRF, no exfil to a non-listed host).
      logger.warn(
        // `auth` (closed ErrorKind union): a host-not-in-allowlist CONNECT is an
        // authorization denial — the allowlist is the operator's egress policy.
        { toolName: "terminal_egress_proxy", hint: "egress denied (host not in allowlist)", errorKind: "auth" as const },
        "egress CONNECT blocked",
      );
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    // ALLOW — forward the raw TCP stream to the real host:port. Inject NOTHING
    // (no-secret CONNECT relay; NOT the credential-injecting tier).
    logger.debug(
      { toolName: "terminal_egress_proxy", step: "connect_allow" },
      "egress CONNECT allowed",
    );
    const upstream = dial(target.host, target.port);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      try {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        /* client already gone */
      }
    });
    client.on("error", () => {
      try {
        upstream.destroy();
      } catch {
        /* upstream already gone */
      }
    });
  };

  client.on("data", onData);
  client.on("error", () => {
    /* a peer reset before the CONNECT line completed — drop quietly. */
  });
}

/**
 * Construct the host-side no-secret allowlist CONNECT proxy as an
 * {@link EgressControlPort}. The daemon (composition root) calls this once and
 * injects the returned port into the terminal worker path; the worker calls
 * `materialize(hosts)` for `network: listed-hosts` and bind-mounts the returned
 * `socketPath` into the jail (via `buildScopeArgs`' `relaySocketPath`).
 */
export function createTerminalEgressProxy(
  deps: TerminalEgressProxyDeps,
): EgressControlPort {
  const dial = deps.dialUpstream ?? ((host: string, port: number) => net.connect(port, host));
  const socketDir = deps.socketDir ?? tmpdir();
  const genId = deps.genId ?? (() => randomUUID());

  return {
    async materialize(hosts: string[]): Promise<EgressMaterialization> {
      const allow = new Set(hosts);
      const socketPath = join(socketDir, `comis-egress-${genId()}.sock`);

      // A stale socket file at this path would make listen() EADDRINUSE — unlink
      // a leftover first (the path is per-session, so this only clears OUR debris).
      try {
        await unlink(socketPath);
      } catch {
        /* no stale socket — the common case */
      }

      const server = net.createServer((client) => handleClient(client, allow, dial, deps.logger));

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener("error", onError);
          reject(err);
        };
        server.once("error", onError);
        // Await 'listening' so the socket file exists before bwrap evaluates its
        // --bind argument (binding a not-yet-bound socket -> ENOENT).
        server.listen(socketPath, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });

      deps.logger.info(
        { toolName: "terminal_egress_proxy", step: "materialized" },
        "egress allowlist proxy listening",
      );

      let disposed = false;
      return {
        socketPath,
        async dispose(): Promise<void> {
          if (disposed) return; // idempotent
          disposed = true;
          await new Promise<void>((resolve) => server.close(() => resolve()));
          try {
            await unlink(socketPath);
          } catch {
            /* already unlinked — idempotent teardown */
          }
        },
      };
    },
  };
}
