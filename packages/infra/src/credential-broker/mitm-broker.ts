// SPDX-License-Identifier: Apache-2.0
/**
 * NodeMitmBroker — HTTP CONNECT proxy with per-request credential injection.
 *
 * Accepts HTTP CONNECT tunnels from driven CLIs, validates single-use proxy
 * tokens via SessionManager, resolves secrets per-request from SecretManager,
 * injects credentials via the injection engine (applyInjections), and fails
 * closed in all error scenarios (407/403/502, zero upstream bytes on failure).
 *
 * CONNECT handler pipeline (strict ordering — no upstream socket until all gates pass):
 *   1. Validate Proxy-Authorization Bearer token → 407 + destroy on fail
 *   2. Send 200 Connection established (tunnel open)
 *   3. Read inner HTTP/1.1 headers from tunnel socket (8 KB cap)
 *   4. Resolve binding (host + path matching) → 403 + destroy on no-match
 *   5. Resolve secret from SecretManager → 502 + destroy on miss
 *   6. Inject credentials (applyInjections) → forward to upstream
 *   6.5 Finalizer stage (body-aware) → buffer body + dispatch → forward OR 413 fail-closed
 *
 * TLS seam: accepts optional CaManagerPort; when undefined, passes
 * TCP stream opaque. When wired, it terminates TLS and injects on the
 * decrypted HTTP/1.1 layer.
 *
 * Security invariants:
 *   - Every fail-closed exit (407/403/502) calls clientSocket.destroy() BEFORE
 *     any upstream net.connect — zero upstream bytes are sent on any gate failure.
 *   - secret variable is NEVER passed to logger or event payloads.
 *   - broker:injected carries ruleKind + host, NOT the secret value.
 *   - secret:accessed is emitted on BOTH success and miss paths.
 *   - No Date.now() — all timestamps via deps.clock.now().
 *
 * @module
 */
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { chmodSync, unlinkSync } from "node:fs";
import type {
  TypedEventBus,
  SecretManager,
  BrokerBinding,
  HostRule,
  InjectionRule,
  InjectionInput,
  ClockPort,
  TimerPort,
  CaManagerPort,
  ComisLogger,
} from "@comis/core";
import { resolveBinding, applyInjections, normalizeHost } from "@comis/core";
import type { SessionManager, SessionInfo } from "./session-manager.js";
import { bufferBody, runFinalizer, MAX_BODY_BYTES } from "./finalizer-stage.js";
import { emitSessionOpened, emitSessionClosed, emitRequest, emitInjected, emitDenied, emitCredentialUnavailable, emitEgressBlocked } from "./broker-events.js";

// ── Max header size for tunnel inner-request parsing (request smuggling prevention) ──
const MAX_HEADER_BYTES = 8192;

// ── Module-level no-op error handler ─────────────────────────────────────────
// Absorbs "error" events on clientSocket before + during the 200 write.
// Named constant so V8 function coverage tracks it correctly.
function noopErrorHandler(): void { /* absorbs EPIPE / ECONNRESET on the raw socket */ }

// ── Exported types ────────────────────────────────────────────────────────────

export interface MitmBrokerDeps {
  sessionManager: SessionManager;
  secretManager: SecretManager;
  bindings: readonly BrokerBinding[];
  eventBus: TypedEventBus;
  logger: ComisLogger;
  clock: ClockPort;
  timers: TimerPort;
  caManager?: CaManagerPort; // undefined when TLS termination is not wired
}

export interface MitmBrokerPort {
  /** Start the proxy server on a loopback port. Resolves with the bound port number. */
  start(port?: number): Promise<number>;
  /** Stop the proxy server and close all connections. */
  stop(): Promise<void>;
  /**
   * Start a second listener on a Unix-domain socket path.
   * Uses the same handleConnect handler as the TCP listener.
   * ADDITIVE — does not change start() signature.
   * Call after start() to enable broker-only egress in the sandbox.
   */
  startUnixSocket(socketPath: string): Promise<void>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Extract the port number from a CONNECT authority string like "host:port".
 * Defaults to 443 if no port is present (HTTPS convention).
 */
function extractPort(authority: string): number {
  if (authority.startsWith("[")) {
    // Bracketed IPv6: [::1]:8080
    const closeBracket = authority.indexOf("]");
    if (closeBracket === -1) return 443;
    const afterBracket = authority.slice(closeBracket + 1);
    if (afterBracket.startsWith(":")) {
      const parsed = parseInt(afterBracket.slice(1), 10);
      return isNaN(parsed) ? 443 : parsed;
    }
    return 443;
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) return 443;
  const parsed = parseInt(authority.slice(lastColon + 1), 10);
  return isNaN(parsed) ? 443 : parsed;
}

/**
 * Write a raw HTTP status line + headers to a socket and destroy it.
 * Used for error responses written directly to the tunnel socket (after 200).
 */
function destroyWithStatus(
  socket: net.Socket,
  statusLine: string,
): void {
  try {
    socket.write(`${statusLine}\r\n\r\n`);
  } catch {
    // Socket may already be closed — ignore write errors
  }
  socket.destroy();
}

/**
 * Parse the first HTTP/1.1 request headers from a raw buffer string.
 * Returns { method, path, headers } or null on parse failure.
 */
function parseInnerRequest(rawHeaders: string): {
  method: string;
  path: string;
  headers: Map<string, string>;
} | null {
  const lines = rawHeaders.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length < 2) return null;

  // parts.length >= 2 is guaranteed by the guard above.
  const method = String(parts[0]);
  const path = String(parts[1]);

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    // RFC 7230 §3.2.2 comma-join duplicates — prevents Upgrade header
    // bypass where a second value would overwrite "websocket" via Map.set().
    const existing = headers.get(name);
    headers.set(name, existing !== undefined ? `${existing}, ${value}` : value);
  }

  return { method, path, headers };
}

/**
 * Read from a socket until \r\n\r\n is found, with an 8 KB cap.
 * Returns { headers, tail } where `headers` is the headers section (without
 * the terminator) and `tail` is any bytes that arrived after the terminator
 * in the same read buffers (e.g., a request body that arrived in the same
 * TCP segment as the headers). Returns null on error/overflow.
 * Resolves immediately if enough data is buffered from the initial dataChunk.
 *
 * The `tail` must be written to the upstream socket BEFORE piping, so that
 * body bytes that co-arrived with headers are not silently discarded.
 */
function readTunnelHeaders(
  socket: net.Socket,
  initialChunk: Buffer,
): Promise<{ headers: string; tail: string } | null> {
  return new Promise((resolve) => {
    let finished = false;
    let buf = initialChunk.toString("latin1");

    function onData(chunk: Buffer): void {
      buf += chunk.toString("latin1");
      check();
    }

    // Both error and close resolve with null (fail closed).
    // Using a shared handler so both events trigger the same cleanup path.
    function onTerminate(): void {
      finish(null);
    }

    function finish(result: { headers: string; tail: string } | null): void {
      if (finished) return;
      finished = true;
      // Pause before removing "data" listener so body bytes arriving after
      // \r\n\r\n are buffered until pipe() resumes the stream.
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onTerminate);
      socket.off("close", onTerminate);
      resolve(result);
    }

    function check(): void {
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        finish({ headers: buf.slice(0, idx), tail: buf.slice(idx + 4) });
        return;
      }
      if (buf.length > MAX_HEADER_BYTES) {
        finish(null); // overflow — fail closed
      }
    }

    socket.on("data", onData);
    socket.on("error", onTerminate);
    socket.on("close", onTerminate);

    // Process any initial data already buffered (_head non-empty path).
    check();
  });
}

// ── createMitmBroker ──────────────────────────────────────────────────────────

export function createMitmBroker(deps: MitmBrokerDeps): MitmBrokerPort {
  const log = deps.logger.child({ submodule: "mitm-broker" });
  let server: http.Server | null = null;
  let unixServer: http.Server | null = null;
  let unixSocketPath: string | null = null;
  // Track open sockets so stop() can destroy them immediately
  const openSockets = new Set<net.Socket>();
  // Upstream sockets are NOT captured by "connection" (net.connect creates them).
  // Track them separately so stop() can destroy them for clean exit.
  const openUpstreamSockets = new Set<net.Socket>();

  function handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    _head: Buffer,
  ): void {
    // ── Step 1: Validate Proxy-Authorization ──────────────────────────────
    const auth = req.headers["proxy-authorization"];
    const authority = req.url ?? "";
    const host = normalizeHost(authority);

    if (!auth?.startsWith("Bearer ")) {
      log.debug({ step: "auth-gate", host }, "CONNECT missing or non-Bearer auth");
      emitDenied(deps.eventBus, { sessionId: "unknown", host, reason: "bad_token", statusCode: 407, timestamp: deps.clock.now() });
      try {
        clientSocket.write(
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            'Proxy-Authenticate: Bearer realm="comis-broker"\r\n' +
            "\r\n",
        );
      } catch {
        // Ignore write errors — socket may be closing
      }
      clientSocket.destroy();
      return;
    }

    const rawToken = auth.slice(7); // strip "Bearer "
    const session: SessionInfo | null = deps.sessionManager.consumeToken(rawToken);

    if (!session) {
      log.debug({ step: "auth-gate", host }, "CONNECT invalid or consumed token");
      emitDenied(deps.eventBus, { sessionId: "unknown", host, reason: "bad_token", statusCode: 407, timestamp: deps.clock.now() });
      try {
        clientSocket.write(
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            'Proxy-Authenticate: Bearer realm="comis-broker"\r\n' +
            "\r\n",
        );
      } catch {
        // Ignore write errors
      }
      clientSocket.destroy();
      return;
    }

    const sessionId = session.sessionId;
    const agentId = session.agentId;

    // ── Step 2: Send 200 Connection established (tunnel open) ────────────
    // Extract target port from the CONNECT authority
    const targetPort = extractPort(authority);

    // Attach a no-op error listener to clientSocket BEFORE writing the 200
    // response. On Node.js, socket.write() to a closed socket does NOT throw
    // synchronously — it emits an "error" event on the socket instead. Without
    // a listener attached, an unhandled "error" event on a socket throws
    // uncaughtException. The no-op here absorbs those errors;
    // the async IIFE's outer try/catch handles cleanup for all other errors.
    // The handler is a module-level constant to ensure V8 function coverage
    // tracks it correctly (avoids anonymous-function coverage gaps).
    clientSocket.on("error", noopErrorHandler);

    // ── Session-closed guard ──────────────────────────────────────────────────
    // Declared outside the try/catch so both the success path and the catch block
    // can call it. Ensures broker:session_closed is emitted EXACTLY ONCE for every
    // connection where broker:session_opened fired — across ALL exit paths.
    // Guard flag prevents double-emit if both teardownUpstream and an error path
    // fire concurrently (e.g. upstreamSocket.on("error") destroys innerSocket,
    // which triggers the "close" listener on innerSocket).
    // sessionStartedAt is set immediately after emitSessionOpened — the guard
    // captures it via closure. It is 0 before emitSessionOpened fires (the
    // outer try/catch path only calls emitSessionClosedOnce after session_opened
    // has run, so the 0 default is never used in a real payload).
    let sessionClosedEmitted = false;
    let sessionStartedAt = 0;
    const emitSessionClosedOnce = (reason: "teardown" | "error"): void => {
      if (sessionClosedEmitted) return;
      sessionClosedEmitted = true;
      const closedAt = deps.clock.now();
      emitSessionClosed(deps.eventBus, {
        sessionId,
        agentId,
        durationMs: closedAt - sessionStartedAt,
        reason,
        timestamp: closedAt,
      });
    };

    void (async () => {
      try {
        clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");

        log.debug(
          { step: "tunnel-open", sessionId, agentId, host },
          "CONNECT tunnel established",
        );
        sessionStartedAt = deps.clock.now();
        emitSessionOpened(deps.eventBus, { sessionId, agentId, host, timestamp: sessionStartedAt });

        // ── Step 2.5: TLS upgrade (when caManager is wired) ─────────────────
        // Pre-flight host check: when caManager is wired, verify
        // the CONNECT host appears in at least one binding BEFORE minting any
        // leaf cert. A client with a valid (but single-use) token must not be
        // able to cause the CA to sign and cache certs for arbitrary hostnames.
        // This is a host-only check (path policy is enforced later in Step 4).
        if (deps.caManager) {
          const openBindings = deps.bindings.map((b) => ({
            ...b,
            hostRules: b.hostRules.map((r: HostRule) => ({
              ...r,
              pathPolicy: undefined,
            })),
          }));
          const hostKnown = resolveBinding(openBindings, host, "/") !== undefined;
          if (!hostKnown) {
            log.debug(
              {
                step: "preflight-host",
                sessionId,
                host,
                errorKind: "precondition" as const,
                hint: "Host has no binding; rejecting before TLS upgrade (no cert minted)",
              },
              "Pre-flight host check failed — no binding for host",
            );
            emitEgressBlocked(deps.eventBus, { sessionId, host, timestamp: deps.clock.now() });
            emitDenied(deps.eventBus, { sessionId, host, reason: "no_binding", statusCode: 403, timestamp: deps.clock.now() });
            emitSessionClosedOnce("error");
            destroyWithStatus(clientSocket, "HTTP/1.1 403 Forbidden");
            return;
          }
        }

        // When deps.caManager is wired and returns a SecureContext for this host,
        // we upgrade the raw TCP socket to a TLS server socket BEFORE reading
        // inner headers. When caManager is undefined, innerSocket
        // remains clientSocket and the code path is identical to the opaque-TCP case.
        let innerSocket: net.Socket | tls.TLSSocket = clientSocket;
        if (deps.caManager) {
          const secureCtx = await deps.caManager.serverContextForHost(host);
          if (secureCtx !== undefined) {
            const tlsSocket = new tls.TLSSocket(clientSocket, {
              isServer: true,
              secureContext: secureCtx,
              ALPNProtocols: ["http/1.1"],
            });
            // Wait for the TLS handshake to complete before reading inner headers
            await new Promise<void>((resolve, reject) => {
              tlsSocket.on("secure", resolve);
              tlsSocket.on("error", reject);
            });
            innerSocket = tlsSocket;
            log.debug(
              { step: "tls-upgrade", sessionId, agentId, host },
              "TLS upgrade complete — reading inner HTTP/1.1 headers",
            );
          }
        }

        // ── Step 3: Read inner HTTP request headers (8 KB cap) ──────────────
        // Pass _head as the initial chunk; it is typically empty but may carry
        // early bytes on edge-case clients. readTunnelHeaders handles it.
        const tunnelResult = await readTunnelHeaders(innerSocket, _head);

        if (tunnelResult === null) {
          log.debug({ step: "header-parse", sessionId, agentId, hint: "Header overflow or parse error; fail closed", errorKind: "validation" as const }, "Inner request header overflow");
          // malformed_request (not path_policy — avoid misclassification).
          emitDenied(deps.eventBus, { sessionId, host, reason: "malformed_request", statusCode: 400, timestamp: deps.clock.now() });
          emitSessionClosedOnce("error");
          destroyWithStatus(innerSocket, "HTTP/1.1 400 Bad Request");
          return;
        }

        // `tail` = bytes after \r\n\r\n (body prefix); must be forwarded before
        // piping to avoid silent discard.
        const { headers: rawHeaders, tail: bodyPrefix } = tunnelResult;

        const parsed = parseInnerRequest(rawHeaders);
        if (parsed === null) {
          log.debug({ step: "header-parse", sessionId, agentId, hint: "Malformed inner HTTP request; fail closed", errorKind: "validation" as const }, "Malformed inner request");
          // Emit audit event on every consumed-token exit path.
          emitDenied(deps.eventBus, { sessionId, host, reason: "malformed_request", statusCode: 400, timestamp: deps.clock.now() });
          emitSessionClosedOnce("error");
          destroyWithStatus(innerSocket, "HTTP/1.1 400 Bad Request");
          return;
        }

        const { method, path } = parsed;

        log.debug(
          { step: "inner-request", sessionId, agentId, host, method },
          "Inner HTTP request received",
        );
        emitRequest(deps.eventBus, { sessionId, host, path, method, timestamp: deps.clock.now() });

        // ── WebSocket upgrade guard ─────────────────────────────────────
        // Fail closed on WS upgrade (support is not yet implemented). Split the
        // comma-joined multi-value Upgrade header so duplicate headers cannot
        // shadow "websocket".
        const upgradeHeader = parsed.headers.get("upgrade");
        const upgradeValues = (upgradeHeader ?? "").split(",").map((v) => v.trim().toLowerCase());
        if (upgradeValues.some((v) => v === "websocket")) {
          log.warn(
            {
              step: "ws-guard",
              sessionId,
              agentId,
              host,
              errorKind: "precondition" as const,
              hint: "WebSocket upgrades are not supported; use an HTTPS REST endpoint instead.",
            },
            "WebSocket upgrade rejected by credential broker",
          );
          emitDenied(deps.eventBus, { sessionId, host, reason: "ws_upgrade_not_supported", statusCode: 501, timestamp: deps.clock.now() });
          emitSessionClosedOnce("error");
          destroyWithStatus(innerSocket, "HTTP/1.1 501 Not Implemented");
          return;
        }

        // ── Step 4: Resolve binding ──────────────────────────────────────
        // resolveBinding returns undefined for both "unknown host" and "known
        // host, path rejected". Strip pathPolicy to test host-only match.
        const resolved = resolveBinding(deps.bindings, host, path);

        if (!resolved) {
          const openBindings = deps.bindings.map((b) => ({
            ...b,
            hostRules: b.hostRules.map((r: HostRule) => {
              const openRule: HostRule = { ...r, pathPolicy: undefined };
              return openRule;
            }),
          }));

          const hostKnown = resolveBinding(openBindings, host, "/") !== undefined;
          const denialReason: "no_binding" | "path_policy" = hostKnown
            ? "path_policy"
            : "no_binding";

          log.debug(
            {
              step: "binding-resolve",
              sessionId,
              agentId,
              host,
              denialReason,
              errorKind: "precondition" as const,
              hint: "Request denied by binding lookup; fail closed with 403",
            },
            "Broker binding denied",
          );
          if (denialReason === "no_binding") {
            emitEgressBlocked(deps.eventBus, { sessionId, host, timestamp: deps.clock.now() });
          }
          emitDenied(deps.eventBus, { sessionId, host, reason: denialReason, statusCode: 403, timestamp: deps.clock.now() });
          emitSessionClosedOnce("error");
          destroyWithStatus(innerSocket, "HTTP/1.1 403 Forbidden");
          return;
        }

        const { binding, rule } = resolved;

        // ── Step 5: Resolve secret (BEFORE net.connect) ─────────────────
        const secretValue = deps.secretManager.get(binding.secretRef);

        deps.eventBus.emit("secret:accessed", {
          secretName: binding.secretRef,
          agentId,
          outcome: secretValue !== undefined ? "success" : "not_found",
          timestamp: deps.clock.now(),
        });

        if (secretValue === undefined) {
          log.warn(
            {
              step: "secret-resolve",
              sessionId,
              agentId,
              secretRef: binding.secretRef,
              errorKind: "precondition" as const,
              hint: "SecretManager returned undefined for secretRef; fail closed with 502",
            },
            "Secret not available for broker request",
          );
          emitCredentialUnavailable(deps.eventBus, { sessionId, secretRef: binding.secretRef, agentId, timestamp: deps.clock.now() });
          emitSessionClosedOnce("error");
          destroyWithStatus(innerSocket, "HTTP/1.1 502 Bad Gateway");
          return;
        }

        // ── Step 6: Inject + forward (ALL gates passed) ──────────────────
        // Build mutable WHATWG Headers from the parsed inner request headers
        const whatwgHeaders = new Headers();
        for (const [name, value] of parsed.headers) {
          whatwgHeaders.set(name, value);
        }

        // Build mutable WHATWG URL for setParam injection.
        // Use the host as the base; path may contain query string.
        // IPv6 literals need brackets in the URL: http://[::1]/path.
        // NUL/control bytes are stripped from path before parsing.
        const hostForUrl = host.includes(":") ? `[${host}]` : host;
        const baseUrl = `http://${hostForUrl}`;
        // Strip ASCII control characters (0x00-0x1F and 0x7F) from the path.
        // eslint-disable-next-line no-control-regex
        const safePath = path.replace(/[\x00-\x1f\x7f]/g, "");
        const targetUrl = new URL(safePath !== "" ? safePath : "/", baseUrl);

        // Build the typed InjectionInput — secretValue MUST NOT be logged
        const injectionInput: InjectionInput = {
          headers: whatwgHeaders,
          url: targetUrl,
          secret: secretValue,
        };

        // Apply injections — this mutates whatwgHeaders and targetUrl
        applyInjections(rule.inject, injectionInput);

        // Emit broker:injected — ruleKind ONLY, never the secret value
        const primaryRule: InjectionRule | undefined = rule.inject[0];
        const ruleKind: InjectionRule["kind"] = primaryRule !== undefined ? primaryRule.kind : "setHeader";
        emitInjected(deps.eventBus, { sessionId, host, ruleKind, timestamp: deps.clock.now() });

        log.debug(
          { step: "inject", sessionId, agentId, host, ruleKind },
          "Credentials injected into tunnel request",
        );

        // ── Step 6.5: Finalizer stage (after injection, before upstream connect) ──
        // When rule has no finalizer, keep the existing streaming pipe path.
        // When a finalizer is configured, buffer the full body before upstream.
        if (rule.finalizer !== undefined) {
          // Helper: emit broker:denied 413, close session, and destroy the tunnel socket.
          function deny413(hint: string): void {
            log.debug({ step: "finalizer_body_cap", sessionId, agentId, errorKind: "validation" as const, hint }, "Body 413 — fail closed");
            emitDenied(deps.eventBus, { sessionId, host, reason: "body_too_large", statusCode: 413, timestamp: deps.clock.now() });
            emitSessionClosedOnce("error");
            destroyWithStatus(innerSocket, "HTTP/1.1 413 Content Too Large");
          }

          // Parse CL with explicit isNaN+non-negative guard — 0 is valid.
          const rawContentLength = whatwgHeaders.get("content-length");
          const declaredContentLength = (() => {
            if (rawContentLength === null) return undefined;
            const parsed = parseInt(rawContentLength, 10);
            return !isNaN(parsed) && parsed >= 0 ? parsed : undefined;
          })();

          // Reject chunked TE without CL — bufferBody cannot decode frames
          // and keep-alive never sends EOF. 411 Length Required.
          const transferEncoding = whatwgHeaders.get("transfer-encoding");
          if (transferEncoding?.toLowerCase().includes("chunked") && declaredContentLength === undefined) {
            emitSessionClosedOnce("error");
            destroyWithStatus(innerSocket, "HTTP/1.1 411 Length Required");
            return;
          }

          // Early 413 when declared CL already exceeds cap — no buffering.
          if (declaredContentLength !== undefined && declaredContentLength > MAX_BODY_BYTES) {
            deny413("Declared Content-Length exceeds cap; returning 413 before buffering");
            return;
          }

          // Inject timer from deps.timers so bufferBody has a read-deadline.
          const scheduleTimeout = (cb: () => void, ms: number): (() => void) => {
            const h = deps.timers.setTimeout(cb, ms);
            return () => h.cancel();
          };

          const bodyBuf = await bufferBody(
            innerSocket, bodyPrefix, MAX_BODY_BYTES, declaredContentLength, scheduleTimeout,
          );
          if (bodyBuf === null) {
            deny413("Request body exceeds body-size cap or read-timeout; returning 413");
            return;
          }

          const result = runFinalizer(rule.finalizer, bodyBuf, whatwgHeaders, log);

          // Rebuild request path (same logic as the no-finalizer path below)
          let requestPath = targetUrl.pathname;
          if (targetUrl.search) {
            requestPath += targetUrl.search;
          }

          // Reconstruct request headers from the finalizer result (alphabetical — acceptable here).
          let requestStr = `${method} ${requestPath} HTTP/1.1\r\n`;
          result.headers.forEach((value, name) => {
            requestStr += `${name}: ${value}\r\n`;
          });
          requestStr += "\r\n";

          // Open upstream only after body is fully known and finalizer has run.
          const upstreamSocket = net.connect(targetPort, "127.0.0.1", () => {
            upstreamSocket.write(requestStr);
            upstreamSocket.write(result.body);
            // Signal EOF on the client→upstream direction — body is fully buffered,
            // no more bytes will arrive from innerSocket.
            upstreamSocket.end();
          });

          openUpstreamSockets.add(upstreamSocket);
          upstreamSocket.unref();

          upstreamSocket.on("error", (err) => {
            log.debug(
              { step: "upstream", sessionId, agentId, err, errorKind: "network" as const, hint: "Upstream connection failed; destroying tunnel" },
              "Upstream socket error",
            );
            innerSocket.destroy();
          });

          upstreamSocket.pipe(innerSocket);

          const teardownUpstream = (): void => {
            openUpstreamSockets.delete(upstreamSocket);
            emitSessionClosedOnce("teardown");
            upstreamSocket.destroy();
          };
          innerSocket.on("close", teardownUpstream);

        } else {
          // No finalizer — existing streaming path (byte-identical pass-through).
          const upstreamSocket = net.connect(targetPort, "127.0.0.1", () => {
            let requestPath = targetUrl.pathname;
            if (targetUrl.search) {
              requestPath += targetUrl.search;
            }
            // WHATWG Headers.forEach is alphabetical — acceptable here.
            let requestStr = `${method} ${requestPath} HTTP/1.1\r\n`;
            whatwgHeaders.forEach((value, name) => {
              requestStr += `${name}: ${value}\r\n`;
            });
            requestStr += "\r\n";

            upstreamSocket.write(requestStr);

            if (bodyPrefix.length > 0) {
              upstreamSocket.write(bodyPrefix, "latin1");
            }

            // Pipe client request body to upstream (client → upstream direction).
            innerSocket.pipe(upstreamSocket);
          });

          openUpstreamSockets.add(upstreamSocket);
          upstreamSocket.unref();

          upstreamSocket.on("error", (err) => {
            log.debug(
              { step: "upstream", sessionId, agentId, err, errorKind: "network" as const, hint: "Upstream connection failed; destroying tunnel" },
              "Upstream socket error",
            );
            innerSocket.destroy();
          });

          upstreamSocket.pipe(innerSocket);

          const teardownUpstream = (): void => {
            openUpstreamSockets.delete(upstreamSocket);
            emitSessionClosedOnce("teardown");
            upstreamSocket.destroy();
          };
          innerSocket.on("close", teardownUpstream);
        }
      } catch (err) {
        log.error(
          { step: "connect-handler", sessionId, err, errorKind: "internal" as const, hint: "Unexpected error in CONNECT handler; destroying socket" },
          "Unexpected CONNECT handler error",
        );
        // Only emit session_closed if session_opened already fired (sessionStartedAt > 0).
        // Guards against the unlikely case of an error before the 200 write completes.
        if (sessionStartedAt > 0) emitSessionClosedOnce("error");
        clientSocket.destroy();
      }
    })();
  }

  /** Shared server setup: connection tracking + CONNECT handler + error log. */
  function attachServerHandlers(srv: http.Server, step: string): void {
    srv.on("connection", (socket: net.Socket) => {
      openSockets.add(socket);
      socket.on("close", () => { openSockets.delete(socket); });
    });
    srv.on("connect", handleConnect);
    srv.on("error", (err: Error) => {
      log.error(
        { step, err, errorKind: "network" as const, hint: "Broker HTTP server error" },
        "Broker server error",
      );
    });
  }

  return {
    start(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server = http.createServer();
        attachServerHandlers(server, "server");
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
          // server.address() is non-null inside the "listening" callback.
          const addr = (server as http.Server).address() as net.AddressInfo;
          log.info({ step: "start", port: addr.port }, "NodeMitmBroker started");
          resolve(addr.port);
        });
      });
    },

    startUnixSocket(socketPath: string): Promise<void> {
      return new Promise((resolve, reject) => {
        unixServer = http.createServer();
        attachServerHandlers(unixServer, "unix-socket");
        unixServer.on("error", reject);
        // Unlink stale socket file before binding (prevents EADDRINUSE).
        try { unlinkSync(socketPath); } catch { /* not present — ok */ }
        unixServer.listen({ path: socketPath }, () => {
          // Restrict socket to owner-only (rw-------). The daemon umask
          // (0o022) would yield 0o755 (world-accessible). Best-effort catch
          // prevents chmod failure from blocking startup on non-POSIX FS.
          try { chmodSync(socketPath, 0o600); } catch { /* non-POSIX FS — ok */ }
          unixSocketPath = socketPath;
          log.info({ step: "start-unix", socketPath }, "NodeMitmBroker Unix socket started");
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        // Destroy ALL tracked sockets FIRST — before the !server
        // early-return — so Unix client sockets are always cleaned up.
        for (const socket of openSockets) { socket.destroy(); }
        openSockets.clear();
        for (const socket of openUpstreamSockets) { socket.destroy(); }
        openUpstreamSockets.clear();

        // Close Unix socket server and unlink socket file.
        if (unixServer) {
          const uSrv = unixServer;
          unixServer = null;
          uSrv.close(); // connections already destroyed above
          if (unixSocketPath) {
            try { unlinkSync(unixSocketPath); } catch { /* already gone — ok */ }
            unixSocketPath = null;
          }
        }

        if (!server) { resolve(); return; }
        const srv = server;
        server = null;
        srv.close(() => {
          log.info({ step: "stop" }, "NodeMitmBroker stopped");
          resolve();
        });
      });
    },
  };
}
