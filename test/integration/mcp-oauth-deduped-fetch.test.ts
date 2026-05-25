// SPDX-License-Identifier: Apache-2.0
/**
 * Integration coverage that the deduped-refresh fetch wrapper
 * is wired into the production 401 path (NOT calling dedupedRefresh directly).
 *
 * The pre-fix bug: `createOAuthClientProvider` accepted a `RefreshDeduper` in
 * its deps but `dedupedRefresh` was never called from any production source.
 * The SDK transport's own 401 handler routed through its internal `auth()` →
 * `refreshAuthorization` path, BYPASSING the deduper. So the thundering-herd
 * protection (100 concurrent 401s → 1 refresh POST) and the rotation
 * persistence were guaranteed ONLY by the
 * roundtrip test (which calls `dedupedRefresh` directly via the public
 * surface), NOT by the production 401 path.
 *
 * The fix: a fetch wrapper (`createDedupedRefreshFetch`) that composes on top
 * of the redirect-policy fetch and intercepts 401 responses BEFORE the SDK
 * sees them. The wrapper is constructed in `prepareOAuthProvider` alongside
 * the OAuth provider and threaded onto `effectiveConfig.oauthFetch`;
 * `createTransport` installs it as the SSE/HTTP transport's `fetch` option.
 *
 * ── What this test proves (production-path coverage) ──────────────────
 * Compose the SAME deduper + fetch wrapper the production wiring composes —
 * via the PUBLIC `@comis/skills` barrel — and drive 100 concurrent fetches
 * (each returning 401 from the inner fetch) through it. The mock OAuth
 * server's real /token endpoint serves the refresh. Assert:
 *   - `mock.getRefreshCount() === 1` (the 100 concurrent 401s collapsed to
 *     ONE refresh POST against the real provider endpoint).
 *   - All 100 fetches resolved to a 200 (every caller saw the retry succeed).
 *   - The token store's <server>.json now holds the rotated access token
 *     (saveTokens persisted the SDK refreshAuthorization result).
 *
 * Why this is the production path:
 *   - `createDedupedRefreshFetch` is the same factory `prepareOAuthProvider`
 *     calls — same `tokenStore`, same `deduper`, same composition.
 *   - The deduper's critical section is a concurrency-1 PQueue, identical to
 *     `state.callQueues[serverName]` (which prepareOAuthProvider uses via a
 *     late-lookup wrapper). The dedup property holds for both.
 *   - The mock server's real /token endpoint serves the refresh — the
 *     deduper internally calls the SDK's `refreshAuthorization`, the same
 *     function the SDK transport would have called on a 401.
 *
 * What this test does NOT cover (DEFERRED to human UAT / DEF-66-01):
 *   - The literal SDK transport (`StreamableHTTPClientTransport`) chained end
 *     to end. The transport requires a working MCP server; the in-process
 *     mock does NOT implement the MCP wire protocol. Asserting the SAME
 *     wiring composition through the same public API gives equivalent
 *     coverage of the production 401 path.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

// PUBLIC barrel imports — same surface the production wiring uses.
import {
  createTokenStore,
  createRefreshDeduper,
  createDedupedRefreshFetch,
  createRedirectPolicyFetch,
  type TokenStore,
  type RefreshDeduper,
  type RefreshResult,
} from "@comis/skills";

import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "mock-client-id",
  redirect_uris: ["http://127.0.0.1:0/callback"],
};

describe("deduped-refresh fetch wired into the production 401 path (mock-coverage)", () => {
  let mock: MockOAuthServer;
  let baseUrl: string;
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(async () => {
    mock = createMockOAuthServer();
    ({ baseUrl } = await mock.start());
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-deduped-fetch-"));
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
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("100 concurrent in-flight tool-call-like 401s collapse to EXACTLY ONE refresh POST (production-path wiring)", async () => {
    const serverName = "linear";
    const EXPIRED_BEARER = "AT_EXPIRED_FROM_TOOL_CALLS";

    // Seed the token store the way connectServer / runOauthLogin would have
    // (a prior login's result on disk). Discovery + DCR client info point
    // at the mock server's /token endpoint — the deduper's
    // `dedupedRefresh` reads these to drive the SDK refresh primitive.
    await store.saveTokens(serverName, {
      access_token: EXPIRED_BEARER,
      refresh_token: "RT_INIT",
      token_type: "Bearer",
      expires_in: 3600,
    });
    await store.saveClientInformation(serverName, CLIENT_INFO);
    await store.saveDiscoveryState(serverName, {
      authorizationServerUrl: baseUrl,
    });

    // Compose the deduper + fetch wrapper the same way
    // `prepareOAuthProvider` composes them in production. The critical
    // section is a concurrency-1 PQueue — identical semantics to
    // `state.callQueues[serverName]` (which prepareOAuthProvider uses via a
    // late-lookup wrapper). The dedup property holds for both shapes.
    const queue = new PQueue({ concurrency: 1 });
    const deduper: RefreshDeduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
      tokenStore: store,
      logger,
      cacheTtlMs: 60000, // Long enough that straggler-cache reuse is irrelevant.
    });

    // The inner fetch is the redirect-policy fetch (the same one
    // `prepareOAuthProvider` constructs) layered over a 401-on-first-call,
    // 200-on-retry mock origin server. We do NOT need a separate origin
    // listener — a thin custom fetch that toggles 401→200 per URL is enough
    // (the production wrapper sees this as "the SDK transport's fetch saw
    // 401, then a retry succeeded").
    const callsByPath = new Map<string, number>();
    const originFetch: FetchLike = async (input, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      const count = (callsByPath.get(url) ?? 0) + 1;
      callsByPath.set(url, count);
      if (count === 1) return new Response("", { status: 401 });
      return new Response("ok", { status: 200 });
    };

    // The redirect-policy fetch wraps the origin fetch — exactly the
    // production composition (see prepareOAuthProvider in
    // mcp-client-oauth-connect.ts). We inject `baseFetch: originFetch` so
    // the redirect-policy fetch (which itself is the inner of the deduped
    // wrapper) delegates to our 401-toggling origin.
    const innerFetch = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: originFetch as unknown as typeof fetch,
    });

    // The wrapper that intercepts 401s. SAME factory the production wiring
    // calls in `prepareOAuthProvider`.
    const dedupedFetch = createDedupedRefreshFetch({
      serverName,
      tokenStore: store,
      deduper,
      innerFetch,
      logger,
    });

    // ── 100 concurrent tool-call-like requests, each with the same expired
    // bearer (the SDK transport reads `provider.tokens()` once per request
    // and attaches the SAME bearer until refresh; in our test the 100 calls
    // start before the refresh resolves, so they all carry EXPIRED_BEARER).
    const promises = Array.from({ length: 100 }, (_, i) =>
      dedupedFetch(`https://api.linear.test/tools/call?i=${i}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
        body: JSON.stringify({ tool: "list_issues", params: {} }),
      }),
    );
    const responses = await Promise.all(promises);

    // ── Headline assertion ─────────────────────────────────────────────────
    // The mock /token endpoint saw EXACTLY ONE refresh POST — the 100
    // concurrent 401s coalesced into a single refresh via the deduper's
    // shared future. PRE-fix the SDK transport routed each 401 through its
    // own internal refresh, so this would have been 100 (or however many
    // were dispatched before the first one's saveTokens persisted).
    expect(mock.getRefreshCount()).toBe(1);

    // Every fetch returned the retry's 200 (no 401 leaked to the caller).
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // The token store now holds the rotated access token (the deduper's
    // saveTokens persisted the SDK refreshAuthorization result). This is
    // the rotation-persistence guarantee: a subsequent
    // refresh would read THIS access token off disk, not the original
    // EXPIRED_BEARER.
    const persisted = JSON.parse(
      readFileSync(join(dir, `${serverName}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted.accessToken).toBeTruthy();
    expect(persisted.accessToken).not.toBe(EXPIRED_BEARER);

    // Sanity: every URL was hit exactly twice (401 then 200 retry) — every
    // caller routed through the wrapper's 401 → refresh → retry path.
    for (const i of [0, 25, 50, 75, 99]) {
      expect(callsByPath.get(`https://api.linear.test/tools/call?i=${i}`)).toBe(2);
    }
  });

  it("wiring path: prepareOAuthProvider attaches oauthFetch to the runtime config", async () => {
    // White-box assertion that the wiring composition is in place: an
    // auth:"oauth" server with the OAuth seam wired through connectServer
    // has its runtime config carry both `oauthProvider` AND `oauthFetch`.
    // `createTransport` then uses `config.oauthFetch ?? createRedirectPolicyFetch`
    // as the SSE/HTTP transport's `fetch` option (mcp-client-discover.ts).
    //
    // This guards against a regression that removes `oauthFetch` from the
    // runtime config (which would silently drop the dedup wrapper and
    // restore the pre-fix behavior — visible only as the headline 100→1
    // assertion regressing under load, hard to spot pre-merge).
    //
    // We reach into the src path here (not the dist barrel) because
    // `prepareOAuthProvider` is intentionally NOT exported from the
    // public surface — it's an internal seam called by connectServer.
    // The architecture-allowlist treats src-relative imports for
    // production-wiring assertions as a sanctioned exception in test/.
    const { prepareOAuthProvider } = await import(
      "../../packages/skills/src/skills/integrations/mcp-client/mcp-client-oauth-connect.js"
    );

    const callQueues = new Map<string, PQueue>();
    const state = {
      callQueues,
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    } as Parameters<typeof prepareOAuthProvider>[0];

    const oauthDeps = {
      createTokenStore: (): TokenStore => store,
      resolveDiscovery: vi.fn(async () => {
        await store.saveDiscoveryState("test-server", {
          authorizationServerUrl: baseUrl,
        });
        return { authorizationServerUrl: baseUrl };
      }),
    };

    const effectiveConfig = await prepareOAuthProvider(
      state,
      oauthDeps,
      { name: "test-server", transport: "http", url: baseUrl, enabled: true, auth: "oauth" },
      logger,
    );

    // Both runtime-only fields are present (wiring contract).
    expect(effectiveConfig.oauthProvider).toBeDefined();
    expect(effectiveConfig.oauthFetch).toBeDefined();
    expect(typeof effectiveConfig.oauthFetch).toBe("function");
  });
});
