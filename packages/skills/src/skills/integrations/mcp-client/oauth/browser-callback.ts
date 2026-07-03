// SPDX-License-Identifier: Apache-2.0
/**
 * Loopback OAuth browser-callback server (guarded by the no-module-globals AST gate).
 *
 * One ephemeral `node:http` server per interactive login. It binds
 * `listen(0, "127.0.0.1")` (kernel-assigned port, loopback IP only), serves a
 * SINGLE `GET /callback?code=&state=`, validates the CSRF `state` in constant
 * time, captures the authorization code, replies with a "close this tab" page,
 * and resolves. Then it closes — on success, on a 300s timeout, and on
 * rejection — so no port or file descriptor lingers.
 *
 * ── ZERO module-scope mutables ──────────────────────────────────────────────
 * A module-global callback port (e.g. `_oauth_port`) would let two concurrent
 * logins clobber each other's port — a TOCTOU that could mis-route an
 * authorization code. THIS file therefore has NO module-scope
 * `let`/`var`. Every piece of mutable state — the server handle, the port, the
 * `state`, the `code_verifier`, the resolve/reject, the timeout timer, the
 * "already settled" guard — lives inside the closure of a single
 * {@link runBrowserCallback} call. The only module-level bindings are `const`
 * (the timeout default, the close-tab HTML, and the const-bound helper arrows),
 * which are immutable and pose no TOCTOU risk. `test/architecture/
 * mcp-no-module-globals.test.ts` AST-asserts this on exactly this file.
 *
 * ── CSRF state ───────────────────────────────────────────────────────────────
 * The caller generates `state = randomBytes(32).toString("hex")` (upstream, in
 * the adapter's `state()`); it is passed in, held in the closure, NEVER written
 * to disk. The callback compares the returned `state` against it via
 * `crypto.timingSafeEqual`. `timingSafeEqual` THROWS on a length mismatch, so a
 * length-guard runs first and treats any length difference as a (non-throwing)
 * mismatch. A mismatch → HTTP 400 + an `errorKind:"auth"` WARN (CSRF is an
 * code is NOT resolved (the attacker's code is dropped; the server stays up for
 * the legitimate redirect or the timeout).
 *
 * ── Redirect-URI allowlist ───────────────────────────────────────────────────
 * The redirect URI is `http://127.0.0.1:<port>/callback` — the IP literal, NOT
 * `localhost` (DNS-rebindable per RFC 8252). {@link validateRedirectHost}
 * rejects `localhost` and `[::1]`/`::1` (the latter unless an explicit opt-in)
 * BEFORE any browser launch.
 *
 * ── Headless detection ───────────────────────────────────────────────────────
 * The shared `isRemoteEnvironment` helper checks only `SSH_CLIENT`/`SSH_TTY`/
 * `!DISPLAY` — too narrow for this flow. {@link isHeadless} DELEGATES to it and
 * ORs the four missing signals (`SSH_CONNECTION || !isTTY || CONTAINER ||
 * existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')`). On headless, the server
 * does NOT call `openUrl` — it surfaces a `ssh -L <port>:localhost:<port>`
 * port-forward hint for the RPC layer (the operator forwards the port and opens
 * the URL themselves). The shared helper is intentionally NOT widened
 * (rule-of-three: one consumer).
 *
 * ── `open` dependency ────────────────────────────────────────────────────────
 * `open` is NOT a skills dependency. The browser launch is an INJECTED
 * `openUrl: (url) => void` (a no-op spy in tests; the real `open` is wired
 * CLI-side). This module only hosts the callback server + headless decision;
 * it never imports `open`.
 *
 * ── code_verifier ────────────────────────────────────────────────────────────
 * The PKCE `code_verifier` is held in memory only — never written to any file,
 * never logged. After the caller exchanges the code, it zeroes the verifier
 * buffer via {@link zeroVerifier} (`Buffer.fill(0)`). An architecture-grep
 * (in the sibling test) asserts `code_verifier` never reaches a write call site.
 *
 * SECURITY: the `state`, the `code_verifier`, and the authorization `code` are
 * NEVER logged at any level — only the server name, the port, and the headless
 * decision. Pino redaction is a safety net, not a license.
 *
 * @module
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync as nodeExistsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

import {
  isRemoteEnvironment,
  systemSetTimeout,
  systemClearTimeout,
  systemEnvSnapshot,
  type SystemTimeoutHandle,
} from "@comis/core";

/**
 * Default callback timeout (RFC-style native-app loopback flow). After this an
 * abandoned login rejects and the server closes (no lingering port/fd).
 * Module-level `const` is permitted by the no-module-globals gate (it forbids
 * only `let`/`var`).
 */
const CALLBACK_TIMEOUT_MS = 300_000;

/** Loopback IP literal — the ONLY accepted redirect host (RFC 8252). */
const LOOPBACK_IPV4 = "127.0.0.1";

/** Path to the WSL interop marker — its presence means "no local browser". */
const WSL_INTEROP_MARKER = "/proc/sys/fs/binfmt_misc/WSLInterop";

/** The single-use "you may close this tab" page returned on a successful callback. */
const CLOSE_TAB_HTML =
  "<!doctype html><html><head><meta charset=utf-8>" +
  "<title>Authorized</title></head><body>" +
  "<p>Authorized. You may close this tab and return to your terminal.</p>" +
  "</body></html>";

/** Structural logger — matches the token store / discovery / deduper contract. */
export interface BrowserCallbackLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Options accepted by {@link validateRedirectHost}. */
export interface ValidateRedirectHostOptions {
  /**
   * Allow the IPv6 loopback (`::1` / `[::1]`). Default false. `localhost` is
   * NEVER accepted regardless of this flag (it is DNS-rebindable).
   */
  readonly allowIpv6Loopback?: boolean;
}

/** Inputs to the {@link isHeadless} predicate (fully injectable for tests). */
export interface HeadlessInput {
  /** The env block to inspect — typically `process.env` at the call site. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether stdout is a TTY — typically `process.stdout.isTTY`. */
  readonly isTTY: boolean;
  /** Filesystem existence probe — typically `node:fs` `existsSync`. */
  readonly existsSync: (path: string) => boolean;
}

/** Options for {@link runBrowserCallback}. */
export interface RunBrowserCallbackOptions {
  /** Validated server name (logged; identifies the in-flight login). */
  readonly serverName: string;
  /**
   * The authorization URL to open in the browser. The caller has already built
   * it with this flow's `redirect_uri` + `state` + PKCE `code_challenge`.
   */
  readonly authorizationUrl: string;
  /**
   * CSRF state (`randomBytes(32).toString("hex")`), generated upstream and held
   * in this closure for the `timingSafeEqual` comparison. NEVER written to disk.
   */
  readonly state: string;
  /**
   * The PKCE `code_verifier`. Held here ONLY so the success path can hand it to
   * {@link zeroVerifier} contract docs — it is NOT written or logged. (The SDK
   * exchange reads the verifier from the adapter's in-memory holder; this field
   * documents the memory-only ownership.)
   */
  readonly codeVerifier: string;
  /**
   * Browser-launch side effect (injected; `open` is not a skills dep). Called
   * with {@link authorizationUrl} on a non-headless host; NOT called when
   * headless.
   */
  readonly openUrl: (url: string) => void;
  /** Structural logger. */
  readonly logger: BrowserCallbackLogger;
  /** Env block for headless detection. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** stdout TTY flag for headless detection. Defaults to `!!process.stdout.isTTY`. */
  readonly isTTY?: boolean;
  /** Filesystem probe for headless detection. Defaults to `node:fs` `existsSync`. */
  readonly existsSync?: (path: string) => boolean;
  /** Callback timeout in ms. Defaults to {@link CALLBACK_TIMEOUT_MS} (300s). */
  readonly timeoutMs?: number;
}

/**
 * A live callback server. Resolved by {@link runBrowserCallback} once the
 * server is listening. All fields are read-only snapshots; the only mutable
 * state lives in the closure that produced this handle (no module-scope mutables).
 */
export interface BrowserCallbackHandle {
  /** The kernel-assigned loopback port. */
  readonly port: number;
  /** `http://127.0.0.1:<port>/callback` — the IP literal, never "localhost". */
  readonly redirectUri: string;
  /** True when the host is headless (no browser was opened). */
  readonly headless: boolean;
  /**
   * On a headless host, the `ssh -L <port>:localhost:<port> <vps>` hint for the
   * operator. Undefined on a non-headless host.
   */
  readonly portForwardHint?: string;
  /**
   * Await the authorization code. Resolves with the `code` once a callback with
   * a matching `state` arrives; rejects on timeout. A CSRF mismatch does NOT
   * settle this promise (the bad code is dropped).
   */
  waitForCode(): Promise<string>;
  /**
   * Close the server and cancel the timeout. Idempotent. Called automatically
   * on success/timeout; expose it so the RPC layer can close on its own
   * rejection (finally block).
   */
  close(): void;
}

/**
 * Reject `localhost` and (by default) the IPv6 loopback; accept only the IPv4
 * loopback literal `127.0.0.1`. `localhost` is DNS-rebindable (RFC 8252) and is
 * NEVER accepted, even with {@link ValidateRedirectHostOptions.allowIpv6Loopback}.
 *
 * Const-bound arrow → an immutable module binding (only `let`/`var` are prohibited).
 */
export const validateRedirectHost = (
  host: string,
  options: ValidateRedirectHostOptions = {},
): boolean => {
  if (host === LOOPBACK_IPV4) return true;
  if (options.allowIpv6Loopback === true && (host === "::1" || host === "[::1]")) {
    return true;
  }
  return false;
};

/**
 * True when the current host has no usable local browser. DELEGATES to the
 * shared `isRemoteEnvironment` (SSH_CLIENT/SSH_TTY/!DISPLAY) then ORs the four
 * signals that helper misses: an SSH_CONNECTION env var, a non-TTY
 * stdout, a CONTAINER marker, or the WSL interop marker on disk.
 *
 * The shared helper is delegated-to, not widened (rule-of-three).
 */
export const isHeadless = (input: HeadlessInput): boolean => {
  if (isRemoteEnvironment({ env: input.env })) return true;
  if (input.env.SSH_CONNECTION) return true;
  if (!input.isTTY) return true;
  if (input.env.CONTAINER) return true;
  if (input.existsSync(WSL_INTEROP_MARKER)) return true;
  return false;
};

/**
 * Zero a PKCE `code_verifier` buffer in place after the code exchange.
 * `Buffer.fill(0)` overwrites the secret so a later heap inspection cannot
 * recover it. Idempotent and safe on an already-zeroed or empty buffer.
 */
export const zeroVerifier = (verifier: Buffer): void => {
  verifier.fill(0);
};

/**
 * Build the `ssh -L <port>:localhost:<port> <vps>` port-forward hint. The host
 * placeholder is `<vps>` (the operator substitutes their host) since this
 * module does not know the daemon's external address. Const-bound arrow.
 */
const buildPortForwardHint = (port: number): string =>
  `ssh -L ${port}:localhost:${port} <vps>`;

/**
 * Start an ephemeral loopback callback server for ONE interactive OAuth login.
 *
 * Resolves once the server is listening, with a {@link BrowserCallbackHandle}
 * exposing the redirect URI, the headless decision, and `waitForCode()`. On a
 * non-headless host it has already called `openUrl(authorizationUrl)`; on a
 * headless host it left `openUrl` untouched and populated `portForwardHint`.
 *
 * ALL mutable state below is closure-local — there is no module-scope `let`/
 * `var` anywhere in this file (no module-scope mutables). The `code_verifier` is referenced only
 * to document memory-only ownership; it is never written or logged.
 */
export function runBrowserCallback(
  options: RunBrowserCallbackOptions,
): Promise<BrowserCallbackHandle> {
  const {
    serverName,
    authorizationUrl,
    state,
    openUrl,
    logger,
    timeoutMs = CALLBACK_TIMEOUT_MS,
  } = options;
  // Reference codeVerifier so the memory-only contract is explicit at the call
  // boundary without ever writing or logging it.
  void options.codeVerifier;

  // Pattern B: env via the sanctioned `systemEnvSnapshot()` from
  // @comis/core/runtime instead of a direct `process.env` global, satisfying
  // the architecture globals gate (no new direct-global call sites outside
  // BOOTSTRAP_PATH_PATTERNS). Tests inject `options.env`; production reads
  // the snapshot once per invocation, which is the right semantic anyway —
  // the headless decision is per-login and should not observe later env
  // mutations within the same process lifetime.
  const env = options.env ?? systemEnvSnapshot();
  // Defensive `process.stdout?.isTTY` access. Some platforms (worker
  // threads, stubbed-process shims, certain test environments) expose
  // `process` without a `stdout` property; a non-optional read would throw a
  // TypeError before the headless decision could even reach the four extended
  // signals. With optional chaining a missing `process.stdout` falls back to
  // `undefined` → coerced to `false` → "no TTY" → `isHeadless` returns true,
  // which is the safe default (suppresses the browser open, surfaces the
  // port-forward hint). Tests still inject `options.isTTY` for determinism.
  const isTTY = options.isTTY ?? Boolean(process.stdout?.isTTY);
  const existsSync = options.existsSync ?? nodeExistsSync;

  return new Promise<BrowserCallbackHandle>((resolveHandle, rejectHandle) => {
    // ── Closure-local mutable state (the ENTIRE reason for no module-scope mutables). ─
    // `let`/`const` HERE is fine — these bindings live in the Promise executor
    // scope, not module scope. The no-module-globals walker only inspects top-level
    // statements, so these are intentionally invisible to it.
    let settled = false;
    let codeResolve: ((code: string) => void) | undefined;
    let codeReject: ((err: Error) => void) | undefined;

    // The code promise is created eagerly so a synchronous callback (tests fire
    // the GET immediately) cannot race a not-yet-assigned resolver.
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const server: Server = createServer((req, res) => {
      // Parse against the loopback origin; only the path + query matter.
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_IPV4}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const gotState = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";

      if (!timingSafeStateEqual(gotState, state)) {
        // CSRF mismatch: 400 + security WARN, do NOT resolve. The
        // attacker's code is dropped; the server stays up for the legitimate
        // redirect or the timeout. NEVER log the state values themselves.
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("state mismatch");
        logger.warn(
          // CSRF state mismatch is an authentication-domain violation (the
          // attacker's redirect is the OAuth handshake failing the integrity
          // check). Maps to the closed errorKind union's "auth" member; the
          // "security" semantic is preserved in the log message ("possible
          // CSRF") + the submodule ("oauth-browser-callback").
          //
          // The canonical `submodule` field is required so structured-log
          // dashboards can filter this high-priority security event by
          // subsystem.
          {
            submodule: "oauth-browser-callback",
            errorKind: "auth" as const,
            serverName,
          },
          "OAuth callback state mismatch — rejected (possible CSRF)",
        );
        return;
      }

      // Valid callback → reply, THEN close + resolve (single-use). The close
      // is deferred to the `res.end` flush callback so `closeAllConnections()`
      // cannot destroy the socket before the "close this tab" body reaches the
      // browser; the timeout/reject paths (no in-flight response) close at once.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CLOSE_TAB_HTML, () => {
        finish(() => codeResolve?.(code));
      });
    });

    // ── Cleanup: idempotent close + timer cancel (success/timeout/reject). ──
    // `closeAllConnections()` (Node 18.2+) forcibly destroys keep-alive sockets
    // so the loopback port is RELEASED promptly — `server.close()` alone only
    // stops accepting NEW connections and waits for existing ones to drain,
    // which would leave the port held (no lingering port/fd).
    const cleanup = (): void => {
      systemClearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    };

    // Settle exactly once: cancel the timer, close the server, run the action.
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    }

    const timer: SystemTimeoutHandle = systemSetTimeout(() => {
      finish(() =>
        codeReject?.(
          new Error(`OAuth browser callback timeout after ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    // Do not keep the event loop alive solely for the callback timer.
    timer.unref?.();

    server.on("error", (err: Error) => {
      finish(() => {
        rejectHandle(err);
        codeReject?.(err);
      });
    });

    server.listen(0, LOOPBACK_IPV4, () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        finish(() => {
          const err = new Error("callback server failed to bind a loopback port");
          rejectHandle(err);
          codeReject?.(err);
        });
        return;
      }
      const port = addr.port;
      const redirectUri = `http://${LOOPBACK_IPV4}:${port}/callback`;
      const headless = isHeadless({ env, isTTY, existsSync });

      if (headless) {
        const portForwardHint = buildPortForwardHint(port);
        // Surface the hint via the handle; do NOT open a browser that isn't
        // there. NEVER log the auth URL (it carries the state param).
        logger.info(
          { serverName, port, headless: true },
          "headless host — suppressing browser open; port-forward hint surfaced",
        );
        resolveHandle({
          port,
          redirectUri,
          headless: true,
          portForwardHint,
          waitForCode: () => codePromise,
          close: () => finish(() => undefined),
        });
        return;
      }

      logger.info(
        { serverName, port, headless: false },
        "opening browser for OAuth authorization",
      );
      openUrl(authorizationUrl);
      resolveHandle({
        port,
        redirectUri,
        headless: false,
        waitForCode: () => codePromise,
        close: () => finish(() => undefined),
      });
    });
  });
}

/**
 * Constant-time `state` comparison. `crypto.timingSafeEqual` THROWS
 * when the two buffers differ in length, which would (a) leak length via the
 * exception path and (b) turn a forged callback into an HTTP 500. So we
 * length-guard first and treat any length difference as a non-throwing
 * mismatch. Equal-length inputs go through `timingSafeEqual` so a same-length
 * forgery cannot be distinguished by timing.
 *
 * Const-bound function declaration is a `const`-equivalent immutable binding;
 * declared as a `function` here only for hoisting clarity within the module
 * (still not a `let`/`var`, so the no-module-globals invariant is satisfied).
 */
function timingSafeStateEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
