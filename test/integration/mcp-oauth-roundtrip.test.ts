// SPDX-License-Identifier: Apache-2.0
/**
 * FULL-CYCLE OAuth 2.1 + PKCE integration test. Drives the entire flow against
 * the in-process mock authorization server through the PUBLIC @comis/skills
 * package barrel (dist), exercising end-to-end:
 *
 *   discovery (RFC 9728/8414)
 *     → DCR (POST /register)
 *     → PKCE authorize + loopback callback
 *     → token exchange → 3-file store
 *     → bearer-attached path
 *     → force-expiry → deduped refresh
 *     → rotation persist (Notion)
 *     → Stripe-Account header on refresh
 *     → 100-concurrent → 1 refresh POST
 *
 * Every assertion hits the in-process mock (createMockOAuthServer, bound
 * listen(0,"127.0.0.1")). The browser launch is an INJECTED openUrl spy —
 * NEVER a real browser, NEVER a real provider. The spy doubles as the "browser
 * driver": when the SDK hands it the authorization URL, the test follows the
 * mock's /authorize 302 to the loopback /callback, completing the redirect
 * leg the way a real browser would. The real-provider round-trip
 * (Notion + Linear + GitHub Enterprise) requires real creds + interactive
 * login and does NOT block pnpm test.
 *
 * Integration tests import from dist/ via the vitest @comis/* aliases. Run
 * pnpm build before pnpm test:integration — stale dist silently masks src.
 * This file uses BARE @comis/skills imports only (never ../packages/src).
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";

import type {
  OAuthTokens,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// PUBLIC barrel imports (dist via the @comis/skills alias) — the architecture
// boundary this gate proves: the full OAuth surface is reachable through the
// package barrel, not src internals. createRefreshDeduper / RefreshDeduper /
// RefreshResult are surfaced on the barrel specifically for this gate
// (integration tests may not reach src internals — missing re-exports are
// added to the barrel and the dist rebuilt).
import {
  runOauthLogin,
  createTokenStore,
  createRefreshDeduper,
  type TokenStore,
  type RefreshDeduper,
  type RefreshResult,
} from "@comis/skills";

// The in-process mock authorization server. Imported from the shared
// fixture dir relative to this integration test — matches the support-fixture
// convention for the integration project.
import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Minimal DCR client information the SDK refreshAuthorization requires to pick
 * a client-auth method. The mock /token endpoint does not validate it.
 */
const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "mock-client-id",
  redirect_uris: ["http://127.0.0.1:0/callback"],
};

/**
 * Follow the mock's /authorize 302 (→ loopback /callback?code=&state=) by
 * issuing the callback GET, the way a real browser would. The mock 302s the
 * authorization request straight back to the loopback redirect_uri; fetch
 * with redirect: "manual" lets us read the Location and then drive the
 * callback hop ourselves so the loopback server's waitForCode() resolves.
 *
 * Returns once the callback GET has been issued (fire-and-forget against the
 * loopback server — the login orchestrator awaits the code internally).
 */
async function driveBrowser(authUrl: string): Promise<void> {
  // Hop 1: the authorization endpoint 302s to the loopback redirect_uri.
  const authRes = await fetch(authUrl, { redirect: "manual" });
  const location = authRes.headers.get("location");
  if (location === null) {
    throw new Error(
      `mock /authorize did not 302 (status ${authRes.status}) — cannot drive callback`,
    );
  }
  // Hop 2: GET the loopback callback so the browser-callback server captures the
  // code + validates the CSRF state and resolves waitForCode().
  const cbRes = await fetch(location, { redirect: "manual" });
  // The callback server replies 200 with the "close this tab" page on a valid
  // state; a CSRF mismatch would be 400. Surface a bad status loudly.
  if (cbRes.status !== 200) {
    throw new Error(`loopback callback returned ${cbRes.status} (expected 200)`);
  }
  // Drain the body so the socket can close promptly.
  await cbRes.text();
}

describe("MCP OAuth full-cycle roundtrip (mock server)", () => {
  let mock: MockOAuthServer;
  let baseUrl: string;
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(async () => {
    mock = createMockOAuthServer();
    ({ baseUrl } = await mock.start());
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-roundtrip-"));
    logger = makeLogger();
    // A tmpdir-backed token store so the exchanged tokens + DCR result + the
    // discovery metadata land in a temp dir we can assert on. watchPersistent:
    // false keeps SIGTERM-clean (production default); this test does not rely on
    // the chokidar external-edit path.
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: false,
    });
  });

  afterEach(async () => {
    await store.close();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // (a) Full cycle: discovery → DCR → authorize → callback → store → bearer →
  //     force-expiry → deduped refresh → NEW bearer. Each stage asserted.
  // --------------------------------------------------------------------------
  it("drives discovery → DCR → authorize → callback → token store → refresh → new bearer", async () => {
    const serverName = "linear";

    // The injected openUrl IS the browser driver: when the SDK produces the
    // authorization URL, follow the mock's /authorize 302 to the loopback
    // /callback so the orchestrator's waitForCode() resolves. We capture the
    // URL too so we can assert it targets the mock's /authorize (PKCE
    // challenge + loopback redirect_uri).
    let openedUrl: string | undefined;
    const openUrl = vi.fn((url: string): void => {
      openedUrl = url;
      // Fire-and-forget; runOauthLogin awaits the code after this returns.
      void driveBrowser(url);
    });

    const result = await runOauthLogin({
      serverName,
      serverUrl: baseUrl,
      oauthConfig: { scope: "read write" },
      createTokenStore: () => store,
      openUrl,
      // Force the NON-headless path so openUrl is invoked and the code awaited.
      // (CI runners are headless; without this the flow would return a hint.)
      // isHeadless ORs isRemoteEnvironment which returns true when !env.DISPLAY,
      // so a synthetic DISPLAY value is needed to pass that check; the four
      // other signals (SSH_CONNECTION / !isTTY / CONTAINER / WSLInterop) are
      // suppressed by an empty env + isTTY:true + existsSync:()=>false.
      isTTY: true,
      env: { DISPLAY: ":0" },
      existsSync: () => false,
      logger,
    });

    // ── Stage: AUTHORIZED (the full exchange completed). ────────────────────
    expect(result.status).toBe("authorized");

    // ── Stage: the browser was driven via the injected openUrl (no real one). ─
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openedUrl).toBeDefined();
    // The authorization URL targets the mock's /authorize and carries the PKCE
    // challenge + the loopback (127.0.0.1) redirect_uri.
    const authUrl = new URL(openedUrl as string);
    expect(authUrl.pathname).toBe("/authorize");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(new URL(redirectUri as string).hostname).toBe("127.0.0.1");

    // ── Stage: discovery hit (RFC 9728/8414) + <server>.meta.json persisted. ─
    const meta = await store.discoveryState(serverName);
    expect(meta).toBeDefined();
    // Persisted to disk specifically.
    expect(existsSync(join(dir, `${serverName}.meta.json`))).toBe(true);

    // ── Stage: DCR — /register hit + <server>.client.json persisted. ─────────
    expect(mock.getRequestCount("register")).toBeGreaterThanOrEqual(1);
    const clientInfo = await store.clientInformation(serverName);
    expect(clientInfo?.client_id).toBeTruthy();
    expect(existsSync(join(dir, `${serverName}.client.json`))).toBe(true);

    // ── Stage: /authorize was reached (the browser-leg drove it). ────────────
    expect(mock.getRequestCount("authorize")).toBeGreaterThanOrEqual(1);

    // ── Stage: token store has <server>.json with an ABSOLUTE expiresAt. ─────
    expect(existsSync(join(dir, `${serverName}.json`))).toBe(true);
    const tokenFile = JSON.parse(
      readFileSync(join(dir, `${serverName}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(typeof tokenFile["accessToken"]).toBe("string");
    expect((tokenFile["accessToken"] as string).length).toBeGreaterThan(0);
    // ABSOLUTE epoch-ms expiry — a future absolute timestamp, NEVER a
    // relative expiresIn/expires_in field.
    expect(typeof tokenFile["expiresAt"]).toBe("number");
    expect(tokenFile["expiresAt"] as number).toBeGreaterThan(Date.now());
    expect(tokenFile["expiresIn"]).toBeUndefined();
    expect(tokenFile["expires_in"]).toBeUndefined();
    // The PKCE code_verifier is NEVER persisted.
    expect(JSON.stringify(tokenFile)).not.toContain("code_verifier");
    expect(tokenFile["codeVerifier"]).toBeUndefined();

    // The bearer the first path would attach is the one just stored.
    const firstTokens = await store.tokens(serverName);
    expect(firstTokens?.access_token).toBe(tokenFile["accessToken"]);
    const firstAccessToken = firstTokens?.access_token as string;
    const firstRefreshToken = firstTokens?.refresh_token as string;
    expect(firstRefreshToken).toBeTruthy();

    // ── Stage: force expiry → 401-deduped refresh → a NEW bearer is stored. ──
    // The refresh path is the deduper (the same one connectServer wires to
    // state.callQueues for the live 401 path). Drive it directly here against
    // the just-persisted refresh_token; assert the access token rotates.
    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
    });

    const refreshed = await deduper.dedupedRefresh({
      serverName,
      authServerUrl: baseUrl,
      accessToken: firstAccessToken,
      refreshToken: firstRefreshToken,
      clientInformation: clientInfo as OAuthClientInformationFull,
    });

    // The access token CHANGED across the refresh (a genuinely new bearer).
    expect(refreshed.tokens.access_token).toBeTruthy();
    expect(refreshed.tokens.access_token).not.toBe(firstAccessToken);

    // The second path would attach the NEW bearer — and it is persisted on disk.
    const secondTokens = await store.tokens(serverName);
    expect(secondTokens?.access_token).toBe(refreshed.tokens.access_token);
    expect(secondTokens?.access_token).not.toBe(firstAccessToken);

    // Exactly one refresh POST fired for this single refresh.
    expect(mock.getRefreshCount()).toBe(1);
  });

  // --------------------------------------------------------------------------
  // (b) Notion rotation: a refresh persists the NEW refresh_token; the old
  //     one is not reused (re-presenting it 400s).
  // --------------------------------------------------------------------------
  it("persists a ROTATED refresh_token and never reuses the old one — Notion", async () => {
    const serverName = "notion";
    mock.setRotateRefreshToken(true);

    // Seed an initial token on disk (a prior login's result).
    await store.saveTokens(serverName, {
      access_token: "AT_INIT",
      refresh_token: "RT_INIT",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
    });

    // First refresh: the mock rotates RT_INIT OUT and issues a NEW refresh_token.
    const first = await deduper.dedupedRefresh({
      serverName,
      authServerUrl: baseUrl,
      accessToken: "AT_INIT",
      refreshToken: "RT_INIT",
      clientInformation: CLIENT_INFO,
    });
    const rotated = first.tokens.refresh_token;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe("RT_INIT");

    // The NEW refresh_token is on disk (saveTokens captured the rotation).
    const raw = JSON.parse(
      readFileSync(join(dir, `${serverName}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(raw["refreshToken"]).toBe(rotated);

    // Re-presenting the original (now rotated-away) token IS a 400 at the mock —
    // proving the rotation invalidated it (so persisting the NEW one mattered;
    // not persisting would lock Notion out on the next refresh).
    const replay = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "RT_INIT",
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  // --------------------------------------------------------------------------
  // (c) Stripe-Account header: configured → the header threads onto the
  //     refresh POST; unconfigured → it is absent.
  // --------------------------------------------------------------------------
  it("threads the Stripe-Account header onto the refresh POST when configured", async () => {
    const serverName = "stripe";
    await store.saveTokens(serverName, {
      access_token: "AT_SEED",
      refresh_token: "RT_SEED",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
    });

    // The Stripe-Account header is threaded via addClientAuthentication, the
    // same hook the provider sets when oauth.stripeAccount is configured.
    const STRIPE_ACCOUNT = "acct_roundtrip";
    await deduper.dedupedRefresh({
      serverName,
      authServerUrl: baseUrl,
      accessToken: "AT_SEED",
      refreshToken: "RT_SEED",
      clientInformation: CLIENT_INFO,
      addClientAuthentication: (headers: Headers): void => {
        headers.set("Stripe-Account", STRIPE_ACCOUNT);
      },
    });

    const tokenReqs = mock.getTokenRequests();
    const refreshReq = tokenReqs.find((r) => r.grantType === "refresh_token");
    expect(refreshReq).toBeDefined();
    expect(refreshReq?.stripeAccount).toBe(STRIPE_ACCOUNT);
  });

  it("omits the Stripe-Account header on refresh when unconfigured", async () => {
    const serverName = "no-stripe";
    await store.saveTokens(serverName, {
      access_token: "AT_SEED",
      refresh_token: "RT_SEED",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
    });

    // No addClientAuthentication → no Stripe-Account header on the POST.
    await deduper.dedupedRefresh({
      serverName,
      authServerUrl: baseUrl,
      accessToken: "AT_SEED",
      refreshToken: "RT_SEED",
      clientInformation: CLIENT_INFO,
    });

    const tokenReqs = mock.getTokenRequests();
    const refreshReq = tokenReqs.find((r) => r.grantType === "refresh_token");
    expect(refreshReq).toBeDefined();
    expect(refreshReq?.stripeAccount).toBe("");
  });

  // --------------------------------------------------------------------------
  // (c2) MCP TokenStore read-on-use after saveTokens write.
  //
  // After an mcp_login write (saveTokens), the TokenStore resolves the NEW
  // token on the next tokens() call without any daemon restart. The process PID
  // is stable across the write — proving no restart occurred.
  //
  // This test is the explicit read-on-use acceptance gate: MCP creds resolve
  // read-on-use after a write, not from a boot-cached snapshot.
  // --------------------------------------------------------------------------
  it("MCP TokenStore resolves newly-written token read-on-use without daemon restart", async () => {
    const serverName = "req08-d4-provider";
    const pidBefore = process.pid;

    // Write a token — simulates what mcp_login does via the MCP handler.
    await store.saveTokens(serverName, {
      access_token: "mcp-test-token-v1",
      refresh_token: "mcp-refresh-v1",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // No restart should have occurred.
    expect(process.pid).toBe(pidBefore);

    // Read-on-use: the token written above must resolve without restart.
    const resolved = await store.tokens(serverName);
    expect(resolved).toBeDefined();
    expect(resolved?.access_token).toBe("mcp-test-token-v1");

    // Rotation: write a second token and verify the new value is resolved.
    await store.saveTokens(serverName, {
      access_token: "mcp-test-token-v2",
      refresh_token: "mcp-refresh-v2",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // No restart should have occurred.
    expect(process.pid).toBe(pidBefore);

    // The rotated token is immediately visible without restart.
    const resolvedV2 = await store.tokens(serverName);
    expect(resolvedV2?.access_token).toBe("mcp-test-token-v2");
    expect(resolvedV2?.access_token).not.toBe("mcp-test-token-v1");
  });

  // --------------------------------------------------------------------------
  // (d) Dedup stress: 100 concurrent calls sharing ONE expired access token
  //     → exactly 1 refresh POST.
  // --------------------------------------------------------------------------
  it("100 concurrent same-token refreshes collapse to exactly ONE refresh POST", async () => {
    const serverName = "dedup-svc";
    await store.saveTokens(serverName, {
      access_token: "AT_EXPIRED",
      refresh_token: "RT0",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
    });

    // 100 concurrent dedupedRefresh calls for the SAME expired access token.
    const promises = Array.from({ length: 100 }, () =>
      deduper.dedupedRefresh({
        serverName,
        authServerUrl: baseUrl,
        accessToken: "AT_EXPIRED",
        refreshToken: "RT0",
        clientInformation: CLIENT_INFO,
      }),
    );
    const results = await Promise.all(promises);

    // Exactly ONE refresh POST reached the mock (the thundering herd collapsed).
    expect(mock.getRefreshCount()).toBe(1);
    // All 100 callers resolved to the SAME new access token (the shared future).
    const distinct = new Set(results.map((r) => r.tokens.access_token));
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBeTruthy();
  });
});
