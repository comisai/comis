// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the interactive OAuth login orchestrator.
 *
 * Focused on the catch-block logging contract — the full happy-path round-trip
 * is exercised end-to-end against the in-process mock OAuth server in
 * test/integration/mcp-oauth-roundtrip.test.ts (the build-first integration
 * tier). This file verifies that the catch block logs `err` as an Error OBJECT
 * (so the Pino serializer can emit `type`/`message`/`stack` together), not
 * `err.message` (which discards stack traces and any custom error properties).
 *
 * Coverage:
 *   1. When discovery rejects with an Error carrying a stack + a custom
 *      property, the catch's `logger.warn` payload's `err` field is the Error
 *      OBJECT (not the message string). Asserts `err instanceof Error` so a
 *      future regression to `err.message` (a string) fails loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { createTokenStore, type TokenStore } from "./token-store.js";
import { runOauthLogin } from "./login.js";
import type { BrowserCallbackHandle } from "./browser-callback.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Build a fake {@link BrowserCallbackHandle} with spy-able close/waitForCode.
 * The orchestrator binds the callback FIRST (to learn the loopback port +
 * headless decision), then drives the SDK auth() flow, then awaits the code.
 */
function makeHandle(
  overrides: Partial<BrowserCallbackHandle> = {},
): BrowserCallbackHandle & { close: ReturnType<typeof vi.fn> } {
  return {
    redirectUri: "http://127.0.0.1:54321/callback",
    headless: false,
    portForwardHint: undefined,
    waitForCode: vi.fn(async () => "auth-code-xyz"),
    close: vi.fn(),
    ...overrides,
  } as BrowserCallbackHandle & { close: ReturnType<typeof vi.fn> };
}

describe("runOauthLogin — catch-block logging contract", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-login-"));
    logger = makeLogger();
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: false,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs the Error OBJECT (not err.message) when discovery fails — Pino serializer requirement", async () => {
    // Force the catch path by failing discovery. The orchestrator awaits
    // discovery before binding the callback server; throwing here lands in
    // the orchestrator's catch.
    const discoveryError = Object.assign(
      new Error("discovery cascade failed: no metadata endpoint reachable"),
      {
        // A non-message field that ONLY survives if `err` is logged as an
        // OBJECT — the Pino serializer reads it but `err.message` discards it.
        customField: "discovery-cascade-evidence",
      },
    );

    const result = await runOauthLogin({
      serverName: "test-server",
      serverUrl: "http://127.0.0.1:0",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      resolveDiscovery: vi.fn(async () => {
        throw discoveryError;
      }),
      logger,
    });

    // The orchestrator NEVER throws.
    expect(result.status).toBe("failed");

    // Exactly one WARN — the catch block's "OAuth login failed".
    const warnCalls = logger.warn.mock.calls;
    const failureWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("OAuth login failed"),
    );
    expect(failureWarn).toBeDefined();
    const payload = failureWarn?.[0] as Record<string, unknown>;

    // `err` MUST be the Error object so Pino's serializer emits
    // `type` + `message` + `stack` + custom fields. Logging `err.message` (a
    // string) discards the stack trace and the customField evidence above.
    expect(payload.err).toBeInstanceOf(Error);
    expect(payload.err).toBe(discoveryError);
    // Confirms the custom field survived (it would NOT survive `err.message`).
    expect((payload.err as Error & { customField?: string }).customField).toBe(
      "discovery-cascade-evidence",
    );

    // The other canonical fields stay intact.
    expect(payload.errorKind).toBe("auth");
    expect(payload.serverName).toBe("test-server");
    expect(payload.submodule).toBe("oauth-login");
  });
});

describe("runOauthLogin — full orchestration flow", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-login-flow-"));
    logger = makeLogger();
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: false,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("non-headless happy path: opens the URL, awaits the code, exchanges → authorized", async () => {
    const handle = makeHandle({ headless: false });
    // The real callback module invokes its injected openUrl on listen; the
    // orchestrator passes a NO-OP openUrl here (it opens the browser itself
    // later). Invoke it so that no-op arrow is exercised.
    const runBrowserCallback = vi.fn(async (opts: { openUrl: (u: string) => void }) => {
      opts.openUrl("ignored-placeholder");
      return handle;
    });
    const openUrl = vi.fn();
    let authCalls = 0;
    let observedRedirectUrl: string | URL | undefined;

    // First pass: SDK reads provider.redirectUrl (loopback), calls
    // redirectToAuthorization(url), then returns REDIRECT.
    // Second pass (with authorizationCode): returns AUTHORIZED.
    const auth = vi.fn(
      async (provider: OAuthClientProvider, opts: { authorizationCode?: string }) => {
        authCalls += 1;
        if (opts.authorizationCode === undefined) {
          // Reading the getter exercises the wrappedProvider redirectUrl accessor.
          observedRedirectUrl = provider.redirectUrl;
          await provider.redirectToAuthorization(
            new URL("https://idp.example/authorize?state=abc&client_id=x"),
          );
          return "REDIRECT" as const;
        }
        expect(opts.authorizationCode).toBe("auth-code-xyz");
        return "AUTHORIZED" as const;
      },
    );

    const result = await runOauthLogin({
      serverName: "srv-happy",
      serverUrl: "https://mcp.example",
      oauthConfig: { scope: "read write" },
      createTokenStore: () => store,
      openUrl,
      auth: auth as never,
      runBrowserCallback: runBrowserCallback as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("authorized");
    expect(result.authUrl).toContain("idp.example/authorize");
    // The provider exposed the loopback redirect URI to the SDK via the getter.
    expect(observedRedirectUrl).toBe("http://127.0.0.1:54321/callback");
    // Browser was opened CLI-side with the captured URL (the redirectTo URL).
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0]?.[0]).toContain("idp.example/authorize");
    // Two auth() passes: REDIRECT then code exchange.
    expect(authCalls).toBe(2);
    // The handle must be closed (finally block) — no lingering loopback port.
    expect(handle.close).toHaveBeenCalled();
    // The captured URL never appears in any log payload (it carries `state`).
    for (const call of logger.info.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("idp.example/authorize");
    }
  });

  it("headless host: returns headless_hint with the port-forward hint and never opens a browser", async () => {
    const handle = makeHandle({
      headless: true,
      portForwardHint: "ssh -L 54321:localhost:54321 vps",
    });
    const openUrl = vi.fn();
    const auth = vi.fn(async (provider: OAuthClientProvider) => {
      await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=z"));
      return "REDIRECT" as const;
    });

    const result = await runOauthLogin({
      serverName: "srv-headless",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("headless_hint");
    expect(result.portForwardHint).toBe("ssh -L 54321:localhost:54321 vps");
    expect(result.authUrl).toContain("idp.example/authorize");
    // NEVER open a browser that isn't there.
    expect(openUrl).not.toHaveBeenCalled();
    // The (unused) callback server is closed immediately on the headless return.
    expect(handle.close).toHaveBeenCalled();
    // waitForCode is never awaited on the headless path.
    expect(handle.waitForCode).not.toHaveBeenCalled();
  });

  it("first auth() returns AUTHORIZED (valid creds already present) → authorized, no browser", async () => {
    const handle = makeHandle();
    const openUrl = vi.fn();
    // No redirectToAuthorization call → capturedAuthUrl stays undefined → AUTHORIZED branch.
    const auth = vi.fn(async () => "AUTHORIZED" as const);

    const result = await runOauthLogin({
      serverName: "srv-already-auth",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("authorized");
    expect(result.authUrl).toBeUndefined();
    expect(openUrl).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
    expect(handle.waitForCode).not.toHaveBeenCalled();
    // Logged the "no browser needed" INFO.
    const infoMsg = logger.info.mock.calls.find(([, m]) =>
      typeof m === "string" && m.includes("no browser needed"),
    );
    expect(infoMsg).toBeDefined();
  });

  it("REDIRECT without a captured authorization URL is a flow bug → failed (config WARN)", async () => {
    const handle = makeHandle();
    // Returns REDIRECT but never calls redirectToAuthorization → capturedAuthUrl undefined.
    const auth = vi.fn(async () => "REDIRECT" as const);

    const result = await runOauthLogin({
      serverName: "srv-bug",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("failed");
    expect(handle.close).toHaveBeenCalled();
    const warn = logger.warn.mock.calls.find(([p]) =>
      (p as Record<string, unknown>).errorKind === "config",
    );
    expect(warn).toBeDefined();
    expect(warn?.[1]).toContain("without an authorization URL");
  });

  it("second auth() pass not AUTHORIZED → failed with the authUrl preserved (auth WARN)", async () => {
    const handle = makeHandle({ headless: false });
    const openUrl = vi.fn();
    const auth = vi.fn(
      async (provider: OAuthClientProvider, opts: { authorizationCode?: string }) => {
        if (opts.authorizationCode === undefined) {
          await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=q"));
          return "REDIRECT" as const;
        }
        // Exchange did not authorize (e.g. server rejected the code).
        return "REDIRECT" as const;
      },
    );

    const result = await runOauthLogin({
      serverName: "srv-exchange-fail",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("failed");
    expect(result.authUrl).toContain("idp.example/authorize");
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(handle.waitForCode).toHaveBeenCalled();
    const warn = logger.warn.mock.calls.find(([p]) =>
      (p as Record<string, unknown>).errorKind === "auth",
    );
    expect(warn).toBeDefined();
    expect(warn?.[1]).toContain("did not authorize");
  });

  it("skips pre-flight discovery when a discovery state already exists", async () => {
    // Seed the store with discovery state so the orchestrator skips the cold load.
    await store.saveDiscoveryState("srv-warm", {
      authorizationServers: ["https://idp.example"],
    } as never);

    const handle = makeHandle();
    const resolveDiscovery = vi.fn(async () => ({}) as never);
    const auth = vi.fn(async (provider: OAuthClientProvider) => {
      await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=w"));
      return "REDIRECT" as const;
    });

    const result = await runOauthLogin({
      serverName: "srv-warm",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: resolveDiscovery as never,
      logger,
    });

    // Discovery is NOT re-run because a state was already persisted.
    expect(resolveDiscovery).not.toHaveBeenCalled();
    // Flow still proceeds (REDIRECT path) — non-headless → opens + awaits code.
    expect(result.authUrl).toContain("idp.example/authorize");
  });
});
