// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OAuthClientProvider adapter (Phase 66 OAUTH-11 / 66d).
 *
 * The adapter is the seam between the MCP SDK's `auth()`/transport layer and
 * Comis's storage. It implements the SDK `OAuthClientProvider` interface by
 * delegating to the token store (66a), holds the PKCE `code_verifier` in memory
 * only, and threads a `Stripe-Account` header via `addClientAuthentication`
 * (66-P12). RED→GREEN coverage (against a tmpdir token store from 66a + the
 * in-process mock OAuth server from 66-01):
 *
 *   1. interface conformance: the adapter is assignable to `OAuthClientProvider`
 *      (compile-time `const p: OAuthClientProvider = adapter`).
 *   2. saveTokens absolute expiry: saveTokens({ expires_in: 3600 }) with a pinned
 *      clock → the stored <server>.json holds absolute `expiresAt` and NO
 *      `expiresIn`/`expires_in` (delegated to the store); tokens() round-trips.
 *   3. verifier in memory: saveCodeVerifier("V") then codeVerifier() === "V";
 *      NO file under the tokens dir contains "V" (grep) — never persisted
 *      (OAUTH-12 / T-66-20).
 *   4. Stripe-Account header (OAUTH-11 / 66-P12): with stripeAccount="acct_1",
 *      addClientAuthentication(headers, ...) sets "Stripe-Account" === "acct_1";
 *      an end-to-end refresh through the deduper asserts the mock captured the
 *      header on the refresh POST (getTokenRequests()). Without stripeAccount the
 *      header is absent.
 *   5. discovery delegation: saveDiscoveryState / discoveryState round-trip
 *      <server>.meta.json via the store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

import { createMockOAuthServer, type MockOAuthServer } from "../../../../../../../test/support/mock-oauth-server.js";
import { createTokenStore, type TokenStore } from "./token-store.js";
import {
  createRefreshDeduper,
  type RefreshDeduper,
  type RefreshResult,
} from "./refresh-deduper.js";
import { createOAuthClientProvider } from "./provider.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Minimal DCR client information the SDK refresh requires. */
const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "mock-client-id",
  redirect_uris: ["http://127.0.0.1:0/callback"],
};

/** Recursively read every file under `dir`, returning their utf8 contents. */
function readAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllFiles(full));
    } else {
      out.push(readFileSync(full, "utf8"));
    }
  }
  return out;
}

describe("createOAuthClientProvider", () => {
  let mock: MockOAuthServer;
  let baseUrl: string;
  let dir: string;
  let store: TokenStore;
  let deduper: RefreshDeduper;
  let logger: ReturnType<typeof makeLogger>;
  let nowMs: number;

  beforeEach(async () => {
    mock = createMockOAuthServer();
    ({ baseUrl } = await mock.start());
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-provider-"));
    logger = makeLogger();
    nowMs = 1_700_000_000_000;
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => nowMs,
      logger,
      watchPersistent: false,
    });
    deduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: new PQueue({ concurrency: 1 }),
      tokenStore: store,
      now: () => nowMs,
      cacheTtlMs: 5000,
      logger,
    });
  });

  afterEach(async () => {
    await store.close();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is assignable to the SDK OAuthClientProvider interface (conformance)", () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    // Compile-time conformance: if the adapter is missing a required member or
    // a signature drifts, this assignment fails `tsc` (the load-bearing check).
    const p: OAuthClientProvider = adapter;
    expect(typeof p.tokens).toBe("function");
    expect(typeof p.saveTokens).toBe("function");
    expect(typeof p.clientInformation).toBe("function");
    expect(typeof p.codeVerifier).toBe("function");
    expect(typeof p.saveCodeVerifier).toBe("function");
  });

  it("saveTokens stores ABSOLUTE expiresAt (delegated to the store), no relative field (OAUTH-02)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    const sdkTokens: OAuthTokens = {
      access_token: "AT1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "RT1",
    };
    await adapter.saveTokens(sdkTokens);

    const raw = JSON.parse(readFileSync(join(dir, "notion.json"), "utf8")) as Record<string, unknown>;
    // Absolute expiresAt computed from the pinned clock + relative expires_in.
    expect(raw["expiresAt"]).toBe(nowMs + 3600 * 1000);
    // No relative field leaked into storage (66-P3).
    expect(raw).not.toHaveProperty("expiresIn");
    expect(raw).not.toHaveProperty("expires_in");

    // tokens() returns a usable SDK-shaped object.
    const back = await adapter.tokens();
    expect(back?.access_token).toBe("AT1");
    expect(back?.refresh_token).toBe("RT1");
  });

  it("holds the PKCE code_verifier in memory ONLY — never on disk (OAUTH-12 / T-66-20)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    const SECRET_VERIFIER = "VERIFIER_THAT_MUST_NEVER_TOUCH_DISK_abc123";
    await adapter.saveCodeVerifier(SECRET_VERIFIER);
    expect(await adapter.codeVerifier()).toBe(SECRET_VERIFIER);

    // Also save tokens + client info + discovery so the tmpdir has real files to
    // grep — the verifier must appear in NONE of them.
    await adapter.saveTokens({ access_token: "AT", token_type: "Bearer", expires_in: 60, refresh_token: "RT" });
    await adapter.saveClientInformation(CLIENT_INFO);
    await adapter.saveDiscoveryState?.({ authorizationServerUrl: baseUrl } as OAuthDiscoveryState);

    for (const content of readAllFiles(dir)) {
      expect(content).not.toContain(SECRET_VERIFIER);
    }
  });

  it("addClientAuthentication sets the Stripe-Account header when configured (66-P12)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "stripe",
      oauthConfig: { stripeAccount: "acct_1" },
      tokenStore: store,
      deduper,
      logger,
    });
    expect(typeof adapter.addClientAuthentication).toBe("function");
    const headers = new Headers();
    await adapter.addClientAuthentication!(headers, new URLSearchParams(), baseUrl, undefined);
    expect(headers.get("Stripe-Account")).toBe("acct_1");
  });

  it("does NOT set a Stripe-Account header when stripeAccount is unconfigured", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    // When no stripeAccount is configured the hook is harmless: either absent or
    // a no-op that leaves the header unset.
    if (adapter.addClientAuthentication) {
      const headers = new Headers();
      await adapter.addClientAuthentication(headers, new URLSearchParams(), baseUrl, undefined);
      expect(headers.get("Stripe-Account")).toBeNull();
    }
  });

  it("threads the Stripe-Account header onto the refresh POST end-to-end (OAUTH-11 / 66-P12)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "stripe",
      oauthConfig: { stripeAccount: "acct_e2e" },
      tokenStore: store,
      deduper,
      logger,
    });
    // Seed a token so the server has a record to persist under.
    await adapter.saveTokens({
      access_token: "AT_SEED",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "RT_SEED",
    });

    // Drive a real refresh through the deduper using the adapter's
    // addClientAuthentication hook — the SDK refresh calls it for the POST.
    await deduper.dedupedRefresh({
      serverName: "stripe",
      authServerUrl: baseUrl,
      accessToken: "AT_SEED",
      refreshToken: "RT_SEED",
      clientInformation: CLIENT_INFO,
      ...(adapter.addClientAuthentication
        ? { addClientAuthentication: adapter.addClientAuthentication }
        : {}),
    });

    const tokenReqs = mock.getTokenRequests();
    const refreshReq = tokenReqs.find((r) => r.grantType === "refresh_token");
    expect(refreshReq).toBeDefined();
    expect(refreshReq?.stripeAccount).toBe("acct_e2e");
  });

  it("delegates discoveryState / saveDiscoveryState round-trip to the store (<server>.meta.json)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "linear",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    const state: OAuthDiscoveryState = {
      authorizationServerUrl: baseUrl,
    } as OAuthDiscoveryState;
    await adapter.saveDiscoveryState?.(state);
    const back = await adapter.discoveryState?.();
    expect(back?.authorizationServerUrl).toBe(baseUrl);
    // Persisted to the meta file specifically.
    const meta = JSON.parse(readFileSync(join(dir, "linear.meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta["authorizationServerUrl"]).toBe(baseUrl);
  });

  it("delegates clientInformation / saveClientInformation round-trip to the store (<server>.client.json)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "linear",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    await adapter.saveClientInformation?.(CLIENT_INFO);
    const back = await adapter.clientInformation();
    expect(back?.client_id).toBe("mock-client-id");
  });

  it("invalidateCredentials('all') deletes the stored files (logout path / OAUTH-10)", async () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: {},
      tokenStore: store,
      deduper,
      logger,
    });
    await adapter.saveTokens({ access_token: "AT", token_type: "Bearer", expires_in: 60 });
    expect(await adapter.tokens()).toBeDefined();
    await adapter.invalidateCredentials?.("all");
    expect(await adapter.tokens()).toBeUndefined();
  });

  it("exposes clientMetadata with the loopback redirect URI when a redirect URL is provided", () => {
    const adapter = createOAuthClientProvider({
      serverName: "notion",
      oauthConfig: { scope: "read write" },
      tokenStore: store,
      deduper,
      logger,
      getRedirectUrl: () => "http://127.0.0.1:5599/callback",
    });
    expect(adapter.redirectUrl).toBe("http://127.0.0.1:5599/callback");
    expect(adapter.clientMetadata.redirect_uris).toContain("http://127.0.0.1:5599/callback");
    expect(adapter.clientMetadata.scope).toBe("read write");
  });
});
