// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OAuth metadata discovery cascade.
 *
 * Coverage (against an in-process mock OAuth server serving the RFC
 * 8414 + RFC 9728 well-known routes — the same surface as
 * `test/support/mock-oauth-server.ts`, inlined here so this stays a hermetic
 * skills-package UNIT test):
 *   1. happy path (RFC 8414 present): resolveDiscovery resolves metadata with
 *      token_endpoint + authorization_endpoint + registration_endpoint and calls
 *      the token store's saveDiscoveryState exactly once. A SECOND resolve with
 *      discoveryState already on disk does NOT re-fetch (well-known request count
 *      unchanged) — warm-load short-circuit.
 *   2. cascade to RFC 9728: with 8414 absent at the resource origin but the 9728
 *      protected-resource doc pointing at a separate authorization server (whose
 *      8414 IS present), resolution still succeeds via the 9728→8414 chain.
 *   3. user-provided fallback: with BOTH well-known endpoints 404 but a configured
 *      oauth.authorizationEndpoint whose 8414 resolves, resolution uses it.
 *   4. fail-closed actionable error: with all THREE absent, resolveDiscovery
 *      rejects with an Error whose message NAMES the three endpoints attempted
 *      (the RFC 8414 well-known URL, the RFC 9728 well-known URL, and the
 *      user-provided oauth.authorizationEndpoint) and carries errorKind:"config".
 *   5. fetch injection: the injected redirect-safe fetchFn is the one the
 *      SDK discovery actually uses — asserted via a wrapping spy that observes the
 *      well-known requests it makes.
 *
 * The "browser" is never involved; discovery is pure metadata fetching. All HTTP
 * is loopback-only (127.0.0.1) in-process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { createRedirectPolicyFetch } from "../mcp-client-redirect-policy.js";
import { resolveDiscovery } from "./discovery.js";
import type { TokenStore } from "./token-store.js";

// ---------------------------------------------------------------------------
// In-process mock authorization/resource server. Serves the RFC 8414 + 9728
// well-known routes, with per-route 404 toggles so each cascade stage can be
// exercised, and a well-known request counter for the warm-load assertion.
// ---------------------------------------------------------------------------

interface MockServer {
  baseUrl: string;
  /** Count of /.well-known/* GETs since the last reset. */
  wellKnownCount(): number;
  /** When false, RFC 8414 (/.well-known/oauth-authorization-server) returns 404. */
  setRfc8414(present: boolean): void;
  /** When false, RFC 9728 (/.well-known/oauth-protected-resource) returns 404. */
  setRfc9728(present: boolean): void;
  /** Override the authorization_servers[0] the 9728 doc advertises (default: self). */
  setAuthorizationServer(url: string | undefined): void;
  reset(): void;
  stop(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  let wellKnown = 0;
  let rfc8414 = true;
  let rfc9728 = false;
  let authorizationServer: string | undefined;
  let server: Server | undefined;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const self = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const url = req.url ?? "";

    if (url.startsWith("/.well-known/")) {
      wellKnown++;
    }

    // RFC 9728 — protected-resource metadata; points at the auth server.
    if (url.startsWith("/.well-known/oauth-protected-resource")) {
      if (!rfc9728) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          resource: self,
          authorization_servers: [authorizationServer ?? self],
        }),
      );
      return;
    }

    // RFC 8414 — authorization-server metadata (OIDC served identically).
    if (
      url.startsWith("/.well-known/oauth-authorization-server") ||
      url.startsWith("/.well-known/openid-configuration")
    ) {
      if (!rfc8414) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: self,
          authorization_endpoint: `${self}/authorize`,
          token_endpoint: `${self}/token`,
          registration_endpoint: `${self}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  };

  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wellKnownCount: () => wellKnown,
    setRfc8414: (present) => {
      rfc8414 = present;
    },
    setRfc9728: (present) => {
      rfc9728 = present;
    },
    setAuthorizationServer: (u) => {
      authorizationServer = u;
    },
    reset: () => {
      wellKnown = 0;
      rfc8414 = true;
      rfc9728 = false;
      authorizationServer = undefined;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Silent structural logger. */
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Minimal in-memory TokenStore double — only the discovery-state pair is
 * exercised by resolveDiscovery; the rest throw if touched (they should not be).
 */
function makeTokenStore(): TokenStore & { saved: OAuthDiscoveryState[] } {
  const saved: OAuthDiscoveryState[] = [];
  let current: OAuthDiscoveryState | undefined;
  const notUsed = (name: string) => (): never => {
    throw new Error(`unexpected token-store call: ${name}`);
  };
  return {
    saved,
    discoveryState: async () => current,
    saveDiscoveryState: async (_server: string, state: OAuthDiscoveryState) => {
      saved.push(state);
      current = state;
    },
    tokens: notUsed("tokens") as unknown as (s: string) => Promise<OAuthTokens | undefined>,
    saveTokens: notUsed("saveTokens") as unknown as (
      s: string,
      t: OAuthTokens,
    ) => Promise<void>,
    clientInformation: notUsed("clientInformation") as unknown as (
      s: string,
    ) => Promise<OAuthClientInformationFull | undefined>,
    saveClientInformation: notUsed("saveClientInformation") as unknown as (
      s: string,
      i: OAuthClientInformationFull,
    ) => Promise<void>,
    deleteAll: notUsed("deleteAll") as unknown as (s: string) => Promise<void>,
    startWatch: notUsed("startWatch") as unknown as () => Promise<void>,
    close: notUsed("close") as unknown as () => Promise<void>,
  };
}

describe("resolveDiscovery", () => {
  let mock: MockServer;
  let logger: ReturnType<typeof makeLogger>;
  const fetchFn: FetchLike = createRedirectPolicyFetch({ maxRedirections: 20 });

  beforeEach(async () => {
    mock = await startMockServer();
    logger = makeLogger();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("happy path: RFC 8414 present → resolves full metadata + persists once; warm load skips re-fetch", async () => {
    mock.setRfc8414(true);
    mock.setRfc9728(false);
    const store = makeTokenStore();

    const state = await resolveDiscovery({
      serverName: "happy",
      serverUrl: mock.baseUrl,
      tokenStore: store,
      fetchFn,
      logger,
    });

    expect(state.authorizationServerMetadata?.token_endpoint).toBe(`${mock.baseUrl}/token`);
    expect(state.authorizationServerMetadata?.authorization_endpoint).toBe(
      `${mock.baseUrl}/authorize`,
    );
    expect(state.authorizationServerMetadata?.registration_endpoint).toBe(
      `${mock.baseUrl}/register`,
    );
    expect(store.saved).toHaveLength(1);

    const countAfterCold = mock.wellKnownCount();
    expect(countAfterCold).toBeGreaterThan(0);

    // Warm load: discoveryState now on disk → no new well-known fetches.
    const warm = await resolveDiscovery({
      serverName: "happy",
      serverUrl: mock.baseUrl,
      tokenStore: store,
      fetchFn,
      logger,
    });
    expect(warm.authorizationServerMetadata?.token_endpoint).toBe(`${mock.baseUrl}/token`);
    expect(mock.wellKnownCount()).toBe(countAfterCold); // unchanged
    expect(store.saved).toHaveLength(1); // no second persist
  });

  it("cascade to RFC 9728: 8414 absent at resource origin, 9728 points at the auth server", async () => {
    // Separate auth server that DOES serve 8414; the resource origin does not.
    const authServer = await startMockServer();
    authServer.setRfc8414(true);
    authServer.setRfc9728(false);

    mock.setRfc8414(false); // resource origin: no 8414
    mock.setRfc9728(true); // resource origin: 9728 present
    mock.setAuthorizationServer(authServer.baseUrl); // → points at the auth server

    const store = makeTokenStore();
    try {
      const state = await resolveDiscovery({
        serverName: "cascade",
        serverUrl: mock.baseUrl,
        tokenStore: store,
        fetchFn,
        logger,
      });
      expect(state.authorizationServerMetadata?.token_endpoint).toBe(`${authServer.baseUrl}/token`);
      expect(store.saved).toHaveLength(1);
    } finally {
      await authServer.stop();
    }
  });

  it("user-provided fallback: both well-known 404 → uses oauth.authorizationEndpoint", async () => {
    // A separate server hosting ONLY the user-pointed authorization server 8414.
    const userAs = await startMockServer();
    userAs.setRfc8414(true);
    userAs.setRfc9728(false);

    mock.setRfc8414(false);
    mock.setRfc9728(false); // resource origin yields nothing

    const store = makeTokenStore();
    try {
      const state = await resolveDiscovery({
        serverName: "user",
        serverUrl: mock.baseUrl,
        userAuthorizationEndpoint: userAs.baseUrl,
        tokenStore: store,
        fetchFn,
        logger,
      });
      expect(state.authorizationServerMetadata?.token_endpoint).toBe(`${userAs.baseUrl}/token`);
      expect(store.saved).toHaveLength(1);
    } finally {
      await userAs.stop();
    }
  });

  it("fail-closed: all three absent → rejects with errorKind:config naming all three endpoints", async () => {
    mock.setRfc8414(false);
    mock.setRfc9728(false);
    const store = makeTokenStore();

    const promise = resolveDiscovery({
      serverName: "broken",
      serverUrl: mock.baseUrl,
      // no userAuthorizationEndpoint
      tokenStore: store,
      fetchFn,
      logger,
    });

    await expect(promise).rejects.toThrow();
    const err = await promise.catch((e: unknown) => e as Error & { errorKind?: string });
    expect(err.errorKind).toBe("config");
    // Message names all three attempted endpoints.
    expect(err.message).toContain("/.well-known/oauth-authorization-server"); // RFC 8414 URL
    expect(err.message).toContain("/.well-known/oauth-protected-resource"); // RFC 9728 URL
    expect(err.message).toContain("user-provided oauth.authorizationEndpoint");
    expect(err.message).toContain("broken"); // names the server
    // user-provided value is reported as unset.
    expect(err.message).toContain("unset");
    expect(store.saved).toHaveLength(0); // nothing persisted on failure
  });

  it("fetch injection: the SDK discovery uses the injected redirect-safe fetchFn", async () => {
    mock.setRfc8414(true);
    mock.setRfc9728(false);
    const store = makeTokenStore();

    // Wrap the redirect-safe fetch in a spy; assert the SDK actually called it
    // for the well-known discovery requests (proves the fetchFn is threaded in).
    const base = createRedirectPolicyFetch({ maxRedirections: 20 });
    const seen: string[] = [];
    const spyFetch: FetchLike = (input, init) => {
      seen.push(typeof input === "string" ? input : input.toString());
      return base(input, init);
    };

    await resolveDiscovery({
      serverName: "spy",
      serverUrl: mock.baseUrl,
      tokenStore: store,
      fetchFn: spyFetch,
      logger,
    });

    expect(seen.some((u) => u.includes("/.well-known/"))).toBe(true);
  });
});
