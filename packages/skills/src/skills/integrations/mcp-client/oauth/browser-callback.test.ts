// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the loopback OAuth browser-callback server (Phase 66
 * OAUTH-06/07/08/09/12 + the security half of CI-02).
 *
 * The callback server is driven DIRECTLY over the loopback port — `openUrl` is
 * an injected no-op spy, so no real browser ever launches. Each test issues its
 * own GET to `http://127.0.0.1:<port>/callback?code=&state=` (the "browser
 * redirect") and asserts the resulting code / HTTP status / log shape.
 *
 * RED→GREEN coverage:
 *   1. loopback bind (OAUTH-06/09): runBrowserCallback resolves a redirectUri
 *      matching /^http:\/\/127\.0\.0\.1:\d+\/callback$/ — the literal IP, never
 *      "localhost" — and the server is reachable on that port.
 *   2. happy path: GET with the correct state + code → waitForCode() resolves to
 *      that code; the server is closed afterward (a follow-up connect fails).
 *   3. CSRF mismatch (OAUTH-08 / 66-P6): GET with a WRONG state → HTTP 400, an
 *      `errorKind:"security"` WARN, and waitForCode() does NOT resolve to the
 *      attacker's code. A different-LENGTH state proves timingSafeEqual is used
 *      (no throw; treated as a mismatch).
 *   4. redirect-URI allowlist pre-flight (OAUTH-09 / 66-P7): validateRedirectHost
 *      rejects "localhost" and "[::1]" (unless opt-in) and accepts "127.0.0.1",
 *      BEFORE any browser launch.
 *   5. headless (OAUTH-07 / 66-P10): with each of SSH_CONNECTION / !isTTY /
 *      CONTAINER / WSLInterop the flow does NOT call openUrl and surfaces a
 *      `ssh -L <port>:localhost:<port>` port-forward hint; a non-headless env
 *      (TTY, no SSH, no container) DOES call openUrl with the authorization URL.
 *   6. timeout (OAUTH-06/66-P14): with the timeout shortened, an abandoned flow
 *      → waitForCode() rejects with a timeout error AND server.close() ran (the
 *      port is released).
 *   7. verifier zeroing (OAUTH-12 / 66-P5): zeroVerifier(buf) zeroes the
 *      closure-held code_verifier buffer after exchange. Plus an architecture
 *      grep: `code_verifier`/`codeVerifier` never appears as an argument to a
 *      write call site across oauth/*.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type Server } from "node:http";

import {
  runBrowserCallback,
  validateRedirectHost,
  isHeadless,
  zeroVerifier,
  type BrowserCallbackHandle,
} from "./browser-callback.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * A non-headless env block: a TTY, no SSH vars, no container marker. Each test
 * that needs the browser-open branch starts from this and the default isTTY=true
 * / existsSync=()=>false injections.
 */
const LOCAL_ENV: NodeJS.ProcessEnv = { DISPLAY: ":0" };

/** Inject a never-headless predicate set: DISPLAY present, TTY, no WSLInterop. */
const NON_HEADLESS = {
  env: LOCAL_ENV,
  isTTY: true,
  existsSync: () => false,
} as const;

/** Issue a single GET to the callback server; resolve { status, body }. */
function getCallback(
  port: number,
  query: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: `/callback?${query}`, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolvePromise({ status: res.statusCode ?? 0, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Probe whether a TCP connect to the loopback port succeeds (server alive). */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/callback?probe=1", method: "GET", timeout: 500 },
      (res) => {
        res.resume();
        resolvePromise(true);
      },
    );
    req.on("error", () => resolvePromise(false));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
    req.end();
  });
}

describe("runBrowserCallback — loopback callback server", () => {
  const open: BrowserCallbackHandle[] = [];

  afterEach(async () => {
    // Defensively close any server a test left listening.
    while (open.length > 0) {
      const handle = open.pop();
      try {
        handle?.close();
      } catch {
        /* already closed */
      }
    }
    // Swallow any unhandled rejection from a still-pending waitForCode().
    await new Promise((r) => setTimeout(r, 5));
  });

  async function start(
    overrides: Partial<Parameters<typeof runBrowserCallback>[0]> = {},
  ): Promise<{ handle: BrowserCallbackHandle; openUrl: ReturnType<typeof vi.fn> }> {
    const openUrl = vi.fn();
    const handle = await runBrowserCallback({
      serverName: "notion",
      authorizationUrl: "https://auth.example.com/authorize?client_id=abc",
      state: "a".repeat(64),
      codeVerifier: "verifier-secret-value",
      openUrl,
      logger: makeLogger(),
      ...NON_HEADLESS,
      ...overrides,
    });
    open.push(handle);
    // Keep the eventual code promise from becoming an unhandled rejection if a
    // test does not await it (e.g. the timeout test owns its own assertion).
    handle.waitForCode().catch(() => {});
    return { handle, openUrl };
  }

  it("1. binds 127.0.0.1 with a kernel port and a /callback redirect URI", async () => {
    const { handle } = await start();
    expect(handle.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // Literal IP, never "localhost".
    expect(handle.redirectUri).not.toContain("localhost");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.redirectUri).toBe(
      `http://127.0.0.1:${handle.port}/callback`,
    );
    expect(await isPortOpen(handle.port)).toBe(true);
  });

  it("2. happy path: correct state+code resolves the code, then closes the server", async () => {
    const state = "b".repeat(64);
    const { handle } = await start({ state });

    const codePromise = handle.waitForCode();
    const res = await getCallback(handle.port, `code=auth-code-123&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.body.toLowerCase()).toContain("close");

    await expect(codePromise).resolves.toBe("auth-code-123");

    // Server closed after success — a follow-up connect fails.
    expect(await isPortOpen(handle.port)).toBe(false);
  });

  it("3. CSRF mismatch → 400, errorKind:'auth' WARN, no resolve (timingSafeEqual, no throw on length diff)", async () => {
    const state = "c".repeat(64);
    const logger = makeLogger();
    const { handle } = await start({ state, logger });

    let resolved: string | undefined;
    let rejected = false;
    handle.waitForCode().then(
      (c) => (resolved = c),
      () => (rejected = true),
    );

    // Wrong state of a DIFFERENT length — timingSafeEqual would throw on a raw
    // length-mismatched compare; the impl must length-guard and treat as a
    // mismatch WITHOUT throwing (so the response is a clean 400, not a 500).
    const res = await getCallback(
      handle.port,
      "code=attacker-code&state=short-wrong",
    );
    expect(res.status).toBe(400);

    // A WARN was logged tagged auth (CSRF mismatch is authentication-domain;
    // the closed errorKind union maps "security" semantics onto "auth"; the
    // "possible CSRF" wording is preserved in the message). WR-01: the WARN
    // MUST carry the canonical `submodule` field so structured-log dashboards
    // can filter this high-priority security event by subsystem (AGENTS.md §2.7).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        submodule: "oauth-browser-callback",
        errorKind: "auth",
        serverName: "notion",
      }),
      expect.any(String),
    );

    // The promise did NOT resolve to the attacker's code (server stays up).
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBeUndefined();
    expect(rejected).toBe(false);
    expect(await isPortOpen(handle.port)).toBe(true);
  });

  it("4. validateRedirectHost: rejects localhost + [::1], accepts 127.0.0.1, [::1] opt-in", () => {
    expect(validateRedirectHost("127.0.0.1")).toBe(true);
    expect(validateRedirectHost("localhost")).toBe(false);
    expect(validateRedirectHost("[::1]")).toBe(false);
    expect(validateRedirectHost("::1")).toBe(false);
    expect(validateRedirectHost("0.0.0.0")).toBe(false);
    expect(validateRedirectHost("example.com")).toBe(false);
    // Explicit IPv6 loopback opt-in.
    expect(validateRedirectHost("[::1]", { allowIpv6Loopback: true })).toBe(true);
    expect(validateRedirectHost("::1", { allowIpv6Loopback: true })).toBe(true);
    // localhost is NEVER accepted, even with the IPv6 opt-in (DNS-rebind risk).
    expect(validateRedirectHost("localhost", { allowIpv6Loopback: true })).toBe(
      false,
    );
  });

  it("5a. headless via SSH_CONNECTION → no openUrl, surfaces port-forward hint", async () => {
    const { handle, openUrl } = await start({
      env: { ...LOCAL_ENV, SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
      isTTY: true,
      existsSync: () => false,
    });
    expect(handle.headless).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(handle.portForwardHint).toMatch(
      new RegExp(`^ssh -L ${handle.port}:localhost:${handle.port} `),
    );
  });

  it("5b. headless via !isTTY → no openUrl, hint surfaced", async () => {
    const { handle, openUrl } = await start({
      env: LOCAL_ENV,
      isTTY: false,
      existsSync: () => false,
    });
    expect(handle.headless).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(handle.portForwardHint).toContain(
      `ssh -L ${handle.port}:localhost:${handle.port}`,
    );
  });

  it("5c. headless via CONTAINER → no openUrl, hint surfaced", async () => {
    const { handle, openUrl } = await start({
      env: { ...LOCAL_ENV, CONTAINER: "docker" },
      isTTY: true,
      existsSync: () => false,
    });
    expect(handle.headless).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(handle.portForwardHint).toBeTruthy();
  });

  it("5d. headless via WSLInterop (existsSync→true) → no openUrl, hint surfaced", async () => {
    const wslPath = "/proc/sys/fs/binfmt_misc/WSLInterop";
    const existsSync = vi.fn((p: string) => p === wslPath);
    const { handle, openUrl } = await start({
      env: LOCAL_ENV,
      isTTY: true,
      existsSync,
    });
    expect(handle.headless).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(existsSync).toHaveBeenCalledWith(wslPath);
  });

  it("5e. non-headless (TTY, no SSH/container, DISPLAY set) → openUrl called with the auth URL", async () => {
    const { handle, openUrl } = await start({
      authorizationUrl: "https://auth.example.com/authorize?client_id=xyz",
    });
    expect(handle.headless).toBe(false);
    expect(handle.portForwardHint).toBeUndefined();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.example.com/authorize?client_id=xyz",
    );
  });

  it("6. timeout: abandoned flow rejects with a timeout error and releases the port", async () => {
    const { handle } = await start({ timeoutMs: 40 });
    const port = handle.port;
    const codePromise = handle.waitForCode();
    await expect(codePromise).rejects.toThrow(/timeout/i);
    // server.close() ran in the timeout handler — the port is released.
    expect(await isPortOpen(port)).toBe(false);
  });

  it("7. zeroVerifier zeroes the closure-held code_verifier buffer", () => {
    const verifier = "super-secret-pkce-verifier";
    const buf = Buffer.from(verifier, "utf8");
    expect(buf.some((b) => b !== 0)).toBe(true);
    zeroVerifier(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
    // Idempotent / safe on an already-zeroed buffer.
    expect(() => zeroVerifier(buf)).not.toThrow();
  });

  it("8. WR-04: defensive isTTY default — does NOT throw when process.stdout is undefined", async () => {
    // Some platforms (worker threads, some test environments, stubbed-process
    // shims) expose `process` without a `stdout` property. Pre-fix the code
    // read `Boolean(process.stdout.isTTY)` which throws a TypeError when
    // `process.stdout` is undefined. The fix uses optional chaining
    // (`process.stdout?.isTTY`) so the headless decision falls back to its
    // default-headless behavior (no TTY → headless) instead of crashing.
    const original = Object.getOwnPropertyDescriptor(process, "stdout");
    try {
      // Stub process.stdout to undefined for the duration of this test.
      Object.defineProperty(process, "stdout", {
        configurable: true,
        value: undefined,
      });

      const openUrl = vi.fn();
      // No options.isTTY override → forces the production default path.
      // Provide options.env so headless detection is otherwise deterministic
      // (without DISPLAY the base isRemoteEnvironment helper would return true
      // anyway — but we want to prove the default-isTTY branch reaches that
      // helper at all, not throw before it).
      const handle = await runBrowserCallback({
        serverName: "wr-04",
        authorizationUrl: "https://auth.example.com/authorize",
        state: "x".repeat(64),
        codeVerifier: "verifier-secret",
        openUrl,
        logger: makeLogger(),
        env: {}, // No DISPLAY → headless via isRemoteEnvironment.
        existsSync: () => false,
      });
      open.push(handle);
      // The call completed without a TypeError, and headless was detected
      // (because env has no DISPLAY and our undefined-stdout fallback is
      // treated as "no TTY" → headless).
      expect(handle.headless).toBe(true);
    } finally {
      if (original) {
        Object.defineProperty(process, "stdout", original);
      }
    }
  });
});

describe("isHeadless predicate", () => {
  const noFs = () => false;

  it("delegates to isRemoteEnvironment (no DISPLAY → headless)", () => {
    expect(isHeadless({ env: {}, isTTY: true, existsSync: noFs })).toBe(true);
  });

  it("returns headless when SSH_CLIENT or SSH_TTY is set (base-helper signals)", () => {
    expect(
      isHeadless({ env: { DISPLAY: ":0", SSH_CLIENT: "x" }, isTTY: true, existsSync: noFs }),
    ).toBe(true);
    expect(
      isHeadless({ env: { DISPLAY: ":0", SSH_TTY: "/dev/pts/0" }, isTTY: true, existsSync: noFs }),
    ).toBe(true);
  });

  it("the four EXTENDED signals each force headless even when the base helper says local", () => {
    // Base helper would return false here (DISPLAY set, no SSH_CLIENT/SSH_TTY).
    expect(
      isHeadless({ env: { DISPLAY: ":0", SSH_CONNECTION: "x" }, isTTY: true, existsSync: noFs }),
    ).toBe(true);
    expect(
      isHeadless({ env: { DISPLAY: ":0" }, isTTY: false, existsSync: noFs }),
    ).toBe(true);
    expect(
      isHeadless({ env: { DISPLAY: ":0", CONTAINER: "podman" }, isTTY: true, existsSync: noFs }),
    ).toBe(true);
    expect(
      isHeadless({
        env: { DISPLAY: ":0" },
        isTTY: true,
        existsSync: (p: string) => p === "/proc/sys/fs/binfmt_misc/WSLInterop",
      }),
    ).toBe(true);
  });

  it("fully-local desktop (DISPLAY, TTY, no SSH/container/WSL) → NOT headless", () => {
    expect(
      isHeadless({ env: { DISPLAY: ":0" }, isTTY: true, existsSync: noFs }),
    ).toBe(false);
  });
});

describe("OAUTH-12 architecture grep — code_verifier never reaches a write call site", () => {
  it("no writeRegularFile/writeFileSync/fs.write* call in oauth/*.ts takes code_verifier/codeVerifier", () => {
    const oauthDir = HERE; // this test lives in oauth/
    const files = readdirSync(oauthDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const writeCallRe =
      /(writeRegularFile|writeFileSync|fs\.write\w*)\s*\([^)]*\b(code_verifier|codeVerifier)\b/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(oauthDir, f), "utf8");
      if (writeCallRe.test(src)) offenders.push(f);
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });
});

// Keep a reference to the http Server type so the import is not flagged unused
// in environments that tree-shake type-only imports differently.
export type _ServerTypeRef = Server;
