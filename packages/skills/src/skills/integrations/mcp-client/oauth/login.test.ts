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

  // Fix 6 (2026-05-28). Observed against the live Higgsfield install: the
  // operator clicked "Allow" on the consent screen, Higgsfield redirected to
  // http://127.0.0.1:61089/callback?code=…&state=…, and the browser hit a
  // dead socket — `lsof -nP -iTCP:61089 -sTCP:LISTEN` returned nothing. The
  // headless branch at login.ts:313 called `handle.close()` BEFORE returning,
  // so the loopback server was torn down 712 ms after mcp_login returned —
  // long before the operator could click Allow. The author's own comment
  // (login.ts:303-307) caught the intent ("The callback server STAYS UP") but
  // the code matched the second half ("is closed here"). Fix: keep the
  // loopback alive, return the authUrl immediately, and run the
  // second-pass token exchange in a background task that closes the handle
  // when the operator's redirect arrives (or the callback times out).
  it("headless host: returns immediately with authUrl + portForwardHint AND keeps the loopback OPEN for the operator's redirect", async () => {
    const handle = makeHandle({
      headless: true,
      portForwardHint: "ssh -L 54321:localhost:54321 vps",
      // Background task awaits this — control it so the synchronous return
      // is observable BEFORE the code arrives.
      waitForCode: vi.fn(() => new Promise<string>(() => { /* never resolves in this test */ })),
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
    // CRITICAL: the loopback is alive at return time so the redirect can be
    // delivered. The background task closes it later (success / failure /
    // timeout).
    expect(handle.close).not.toHaveBeenCalled();
    // The background task has started awaiting the code.
    expect(handle.waitForCode).toHaveBeenCalledTimes(1);
  });

  it("headless host: background task exchanges the code, persists tokens, fires onAuthorized, and closes the handle", async () => {
    let resolveCode!: (code: string) => void;
    const codePromise = new Promise<string>((res) => { resolveCode = res; });
    const handle = makeHandle({
      headless: true,
      waitForCode: vi.fn(() => codePromise),
    });

    let authCalls = 0;
    const auth = vi.fn(async (provider: OAuthClientProvider, opts: { authorizationCode?: string }) => {
      authCalls += 1;
      if (opts.authorizationCode === undefined) {
        await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=bg"));
        return "REDIRECT" as const;
      }
      expect(opts.authorizationCode).toBe("background-code-xyz");
      return "AUTHORIZED" as const;
    });

    const onAuthorized = vi.fn(async () => undefined);

    const result = await runOauthLogin({
      serverName: "srv-headless-bg",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      onAuthorized,
      logger,
    });

    // Synchronous return — operator's redirect hasn't arrived yet.
    expect(result.status).toBe("headless_hint");
    expect(authCalls).toBe(1);              // only the first pass (URL build) so far
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();

    // Simulate the operator's browser hitting the loopback callback.
    resolveCode("background-code-xyz");
    // Flush microtasks so the background task observes the code, runs the
    // second auth pass, and fires onAuthorized + close.
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));

    expect(authCalls).toBe(2);              // second pass (code exchange) ran
    expect(onAuthorized).toHaveBeenCalledWith("srv-headless-bg");
    expect(handle.close).toHaveBeenCalled(); // background task cleaned up
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

  // Bug discovered 2026-05-28 in daemon.1.log:865 against Higgsfield: the
  // wrappedProvider at login.ts:207 used `{...provider, ...}` to override
  // `redirectToAuthorization` for URL capture. That spread evaluated the
  // provider's `clientMetadata` getter ONCE at spread time — BEFORE
  // `redirectUrl` was set (line 256, after the loopback server binds) —
  // and froze the resulting `{ redirect_uris: [] }` object as a regular
  // property. The SDK then called DCR with `redirect_uris: []`, which
  // every spec-compliant authorization server (RFC 7591) rejects with
  // 400 `invalid_redirect_uri` ("at least one redirect_uri is required"
  // from Higgsfield). The fix is to override `clientMetadata` on
  // wrappedProvider as a LIVE getter that re-reads `provider.clientMetadata`
  // on each access so the loopback URL flows through to DCR.
  it("wrappedProvider.clientMetadata.redirect_uris carries the loopback URL when the SDK reads it during DCR", async () => {
    const handle = makeHandle({ headless: true, redirectUri: "http://127.0.0.1:60938/callback" });
    let capturedClientMetadata: { redirect_uris: string[] } | undefined;

    // The SDK reads `provider.clientMetadata` synchronously when it calls
    // registerClient (DCR). Mirror that read here so we capture exactly
    // what the SDK would see at DCR time.
    const auth = vi.fn(async (provider: OAuthClientProvider) => {
      capturedClientMetadata = provider.clientMetadata as { redirect_uris: string[] };
      await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=x"));
      return "REDIRECT" as const;
    });

    await runOauthLogin({
      serverName: "srv-redirect-bug",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(capturedClientMetadata).toBeDefined();
    // Pre-fix: redirect_uris was [] because spread froze the getter.
    // Post-fix: re-reading the live getter returns the loopback URL.
    expect(capturedClientMetadata!.redirect_uris).toEqual(["http://127.0.0.1:60938/callback"]);
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

  // DEVAUTH-03 regression guard from the PKCE side: the 3 device-flow-only
  // optional fields stay undefined on every PKCE-path return so contract
  // mirroring (mcp-oauth.ts) stays clean.
  it("PKCE path leaves verificationUri userCode and expiresIn undefined on returned result", async () => {
    const handle = makeHandle({ headless: false });
    const auth = vi.fn(
      async (provider: OAuthClientProvider, opts: { authorizationCode?: string }) => {
        if (opts.authorizationCode === undefined) {
          await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=pkce"));
          return "REDIRECT" as const;
        }
        return "AUTHORIZED" as const;
      },
    );

    const result = await runOauthLogin({
      serverName: "srv-pkce-clean",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: vi.fn(async () => ({}) as never),
      logger,
    });

    expect(result.status).toBe("authorized");
    expect(result.verificationUri).toBeUndefined();
    expect(result.userCode).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
  });
});

// ===========================================================================
// DEVAUTH-02 selection heuristic (plan 09-02).
//
// Five behavior-named cases pinning the dispatcher's selection matrix:
//   1. headless + device-code advertised      → device-flow
//   2. headless + device-code NOT advertised  → PKCE
//   3. operator override "auth_code" beats heuristic toward PKCE
//   4. operator override "device_code" beats heuristic toward device-flow
//   5. non-headless + device-code advertised  → PKCE (simpler UX)
//
// `runDeviceFlow` is injected as a `vi.fn()`; SDK `auth()` is NOT called on
// the device-flow path (the loopback handle.close() runs first).
// ===========================================================================
describe("runOauthLogin device-flow selection heuristic (DEVAUTH-02)", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-select-"));
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

  /** Fake discovery with the device_authorization_endpoint field populated. */
  function discoveryAdvertisingDeviceFlow() {
    return vi.fn(async () => ({
      authorizationServerMetadata: {
        device_authorization_endpoint: "https://idp.example/device_authorization",
        token_endpoint: "https://idp.example/token",
        grant_types_supported: [
          "authorization_code",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
      },
    }) as never);
  }

  /** Fake discovery WITHOUT device-flow support. */
  function discoveryWithoutDeviceFlow() {
    return vi.fn(async () => ({
      authorizationServerMetadata: {
        token_endpoint: "https://idp.example/token",
        grant_types_supported: ["authorization_code", "refresh_token"],
      },
    }) as never);
  }

  it("headless plus device-code advertised dispatches device-flow path", async () => {
    const handle = makeHandle({ headless: true, portForwardHint: "ssh -L 60000:localhost:60000 vps" });
    const auth = vi.fn(async () => "REDIRECT" as const);
    const runDeviceFlow = vi.fn(async () => ({
      status: "device_code_pending" as const,
      verificationUri: "https://example.com/device",
      userCode: "WDJB-MJHT",
      expiresIn: 600,
    }));

    const result = await runOauthLogin({
      serverName: "srv-heuristic-headless-dev",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: discoveryAdvertisingDeviceFlow() as never,
      runDeviceFlow,
      logger,
    });

    expect(runDeviceFlow).toHaveBeenCalledTimes(1);
    // SDK auth() first pass MUST NOT run on the device-flow path.
    expect(auth).not.toHaveBeenCalled();
    expect(result.status).toBe("device_code_pending");
    expect(result.verificationUri).toBe("https://example.com/device");
    expect(result.userCode).toBe("WDJB-MJHT");
    expect(result.expiresIn).toBe(600);
    // The loopback handle was released (device-flow needs no callback).
    expect(handle.close).toHaveBeenCalled();
  });

  it("headless without device-code stays on PKCE loopback path", async () => {
    const handle = makeHandle({ headless: true, portForwardHint: "ssh -L 60001:localhost:60001 vps" });
    let observedRedirectFromAuth = false;
    const auth = vi.fn(async (provider: OAuthClientProvider) => {
      observedRedirectFromAuth = true;
      await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=hp"));
      return "REDIRECT" as const;
    });
    const runDeviceFlow = vi.fn(async () => ({ status: "device_code_pending" as const }));

    const result = await runOauthLogin({
      serverName: "srv-heuristic-headless-nodev",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: discoveryWithoutDeviceFlow() as never,
      runDeviceFlow,
      logger,
    });

    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(observedRedirectFromAuth).toBe(true);
    expect(result.status).toBe("headless_hint");
    expect(result.authUrl).toContain("idp.example/authorize");
  });

  it("operator override oauth.flow auth_code beats heuristic toward PKCE", async () => {
    const handle = makeHandle({ headless: true, portForwardHint: "ssh -L 60002:localhost:60002 vps" });
    let observedRedirectFromAuth = false;
    const auth = vi.fn(async (provider: OAuthClientProvider) => {
      observedRedirectFromAuth = true;
      await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=ov-pkce"));
      return "REDIRECT" as const;
    });
    const runDeviceFlow = vi.fn(async () => ({ status: "device_code_pending" as const }));

    const result = await runOauthLogin({
      serverName: "srv-override-auth-code",
      serverUrl: "https://mcp.example",
      // Heuristic would dispatch device-flow (headless + advertised);
      // operator forces PKCE.
      oauthConfig: { flow: "auth_code" },
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: discoveryAdvertisingDeviceFlow() as never,
      runDeviceFlow,
      logger,
    });

    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(observedRedirectFromAuth).toBe(true);
    expect(result.status).toBe("headless_hint");
  });

  it("operator override oauth.flow device_code beats heuristic toward device-flow on non-headless host", async () => {
    const handle = makeHandle({ headless: false });
    const auth = vi.fn(async () => "REDIRECT" as const);
    const runDeviceFlow = vi.fn(async () => ({
      status: "device_code_pending" as const,
      verificationUri: "https://operator.example/device",
      userCode: "ABCD-1234",
      expiresIn: 300,
    }));

    const result = await runOauthLogin({
      serverName: "srv-override-device-code",
      serverUrl: "https://mcp.example",
      oauthConfig: {
        flow: "device_code",
        deviceAuthorizationEndpoint: "https://operator.example/device",
      },
      createTokenStore: () => store,
      openUrl: () => undefined,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      // Discovery does NOT advertise device-flow — heuristic alone would skip;
      // operator override forces dispatch.
      resolveDiscovery: discoveryWithoutDeviceFlow() as never,
      runDeviceFlow,
      logger,
    });

    expect(runDeviceFlow).toHaveBeenCalledTimes(1);
    expect(auth).not.toHaveBeenCalled();
    expect(result.status).toBe("device_code_pending");
    expect(result.verificationUri).toBe("https://operator.example/device");
    expect(result.userCode).toBe("ABCD-1234");
  });

  it("non-headless host with device-code advertised prefers PKCE for simpler UX", async () => {
    const handle = makeHandle({ headless: false });
    const openUrl = vi.fn();
    const auth = vi.fn(
      async (provider: OAuthClientProvider, opts: { authorizationCode?: string }) => {
        if (opts.authorizationCode === undefined) {
          await provider.redirectToAuthorization(new URL("https://idp.example/authorize?state=nh-pkce"));
          return "REDIRECT" as const;
        }
        return "AUTHORIZED" as const;
      },
    );
    const runDeviceFlow = vi.fn(async () => ({ status: "device_code_pending" as const }));

    const result = await runOauthLogin({
      serverName: "srv-nonheadless-pkce",
      serverUrl: "https://mcp.example",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl,
      auth: auth as never,
      runBrowserCallback: vi.fn(async () => handle) as never,
      resolveDiscovery: discoveryAdvertisingDeviceFlow() as never,
      runDeviceFlow,
      logger,
    });

    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0]?.[0]).toContain("idp.example/authorize");
    expect(result.status).toBe("authorized");
  });
});
