// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the 401 refresh-deduper (Phase 66 OAUTH-05 + OAUTH-11 rotation).
 *
 * RED→GREEN coverage (against the in-process mock OAuth server from 66-01 —
 * `test/support/mock-oauth-server.ts` — plus a tmpdir token store from 66-02):
 *
 *   1. dedup stress (OAUTH-05 / 66-P4 — THE HEADLINE): fire 100 concurrent
 *      dedupedRefresh(...) calls for the SAME expired access token through ONE
 *      concurrency-1 critical-section queue. Assert getRefreshCount() === 1
 *      (exactly one refresh_token POST) and all 100 callers resolve to the same
 *      new access token.
 *   2. distinct tokens not deduped: two concurrent refreshes for DIFFERENT
 *      access tokens → getRefreshCount() === 2 (the dedup key is the access
 *      token, not the server).
 *   3. 5s straggler cache: after a refresh resolves, a follow-up dedupedRefresh
 *      with the same (old) access token within 5s reuses the cached result
 *      WITHOUT a new POST; after the injected clock advances past the TTL a new
 *      refresh fires.
 *   4. rotation persist (OAUTH-11 / 66-P11 — Notion): with
 *      setRotateRefreshToken(true) the refresh returns a NEW refresh_token; the
 *      token store's <server>.json must then hold the NEW refresh_token
 *      (saveTokens was called with the SDK result) and a subsequent refresh
 *      using the NEW token must succeed (the mock rejects a rotated-away token
 *      with 400 — assert no lockout).
 *   5. failure eviction (66-P13): a refresh that rejects (mock 400) removes the
 *      entry from inflightRefreshes so a later attempt can retry (no poisoned
 *      shared future).
 *
 * The deduper delegates the actual refresh to the SDK `refreshAuthorization`
 * (the production default). Tests exercise the real SDK against the mock for the
 * rotation/failure/cache paths; the stress test injects a thin counting wrapper
 * around a fast refresh so 100 concurrent callers are observable without real
 * network fan-out, while still asserting the mock's single POST.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";

import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { createMockOAuthServer, type MockOAuthServer } from "../../../../../../../test/support/mock-oauth-server.js";
import { createTokenStore, type TokenStore } from "./token-store.js";
import {
  createRefreshDeduper,
  type RefreshDeduper,
  type RefreshResult,
} from "./refresh-deduper.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Minimal client information the SDK `refreshAuthorization` requires. The mock
 * /token endpoint does not validate the client_id, but the SDK needs a value to
 * select a client-auth method.
 */
const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "mock-client-id",
  redirect_uris: ["http://127.0.0.1:0/callback"],
};

describe("createRefreshDeduper", () => {
  let mock: MockOAuthServer;
  let baseUrl: string;
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;
  let nowMs: number;
  let queue: PQueue;
  let deduper: RefreshDeduper;

  beforeEach(async () => {
    mock = createMockOAuthServer();
    ({ baseUrl } = await mock.start());
    dir = mkdtempSync(join(tmpdir(), "comis-refresh-deduper-"));
    logger = makeLogger();
    nowMs = 1_700_000_000_000;
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => nowMs,
      logger,
      watchPersistent: false,
    });
    // A concurrency-1 critical section: the dedup map check+set runs serialized
    // through this queue, the same serialization model as the per-server
    // callQueues.
    queue = new PQueue({ concurrency: 1 });
    deduper = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue,
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

  it("100 concurrent same-token refreshes → exactly ONE refresh POST (OAUTH-05 / 66-P4)", async () => {
    // Seed an existing token so saveTokens has a server to persist under.
    const calls: number[] = [];
    // Inject a counting refreshFn that drives the mock once and shares the
    // result — the dedup MUST collapse 100 callers into a single underlying
    // refresh, observable both via this counter AND the mock's getRefreshCount.
    const countingRefresh = vi.fn(async (): Promise<OAuthTokens> => {
      calls.push(Date.now());
      const res = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "RT0" }).toString(),
      });
      return (await res.json()) as OAuthTokens;
    });

    const dd = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: new PQueue({ concurrency: 1 }),
      tokenStore: store,
      now: () => nowMs,
      cacheTtlMs: 5000,
      logger,
      refreshFn: countingRefresh,
    });

    const promises = Array.from({ length: 100 }, () =>
      dd.dedupedRefresh({
        serverName: "notion",
        authServerUrl: baseUrl,
        accessToken: "EXPIRED_AT",
        refreshToken: "RT0",
        clientInformation: CLIENT_INFO,
      }),
    );
    const results = await Promise.all(promises);

    // Exactly one underlying refresh, both in our wrapper and at the mock.
    expect(countingRefresh).toHaveBeenCalledTimes(1);
    expect(mock.getRefreshCount()).toBe(1);
    // All 100 callers resolve to the SAME new access token.
    const tokens = new Set(results.map((r) => r.tokens.access_token));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toBeTruthy();
  });

  it("distinct access tokens are NOT deduped → two refresh POSTs", async () => {
    const [a, b] = await Promise.all([
      deduper.dedupedRefresh({
        serverName: "srvA",
        authServerUrl: baseUrl,
        accessToken: "AT_A",
        refreshToken: "RT_A",
        clientInformation: CLIENT_INFO,
      }),
      deduper.dedupedRefresh({
        serverName: "srvB",
        authServerUrl: baseUrl,
        accessToken: "AT_B",
        refreshToken: "RT_B",
        clientInformation: CLIENT_INFO,
      }),
    ]);
    expect(mock.getRefreshCount()).toBe(2);
    expect(a.tokens.access_token).toBeTruthy();
    expect(b.tokens.access_token).toBeTruthy();
  });

  it("caches a successful refresh ~5s for stragglers; a new refresh fires after the TTL", async () => {
    // First refresh.
    await deduper.dedupedRefresh({
      serverName: "svc",
      authServerUrl: baseUrl,
      accessToken: "OLD_AT",
      refreshToken: "RT_C",
      clientInformation: CLIENT_INFO,
    });
    expect(mock.getRefreshCount()).toBe(1);

    // A straggler within the 5s window reuses the cache — no new POST.
    nowMs += 4_000;
    await deduper.dedupedRefresh({
      serverName: "svc",
      authServerUrl: baseUrl,
      accessToken: "OLD_AT",
      refreshToken: "RT_C",
      clientInformation: CLIENT_INFO,
    });
    expect(mock.getRefreshCount()).toBe(1);

    // Past the TTL, the same (old) access token triggers a fresh refresh.
    nowMs += 2_000; // total +6s > 5s TTL
    await deduper.dedupedRefresh({
      serverName: "svc",
      authServerUrl: baseUrl,
      accessToken: "OLD_AT",
      refreshToken: "RT_C",
      clientInformation: CLIENT_INFO,
    });
    expect(mock.getRefreshCount()).toBe(2);
  });

  it("persists a ROTATED refresh_token and reuses the new one — Notion (OAUTH-11 / 66-P11)", async () => {
    mock.setRotateRefreshToken(true);
    // Seed the store so we have an initial refresh token on disk.
    await store.saveTokens("notion", {
      access_token: "AT_INIT",
      refresh_token: "RT_INIT",
      token_type: "Bearer",
      expires_in: 3600,
    });

    // First refresh with the seeded token → the mock rotates it OUT and issues
    // a NEW refresh_token. The deduper MUST persist the result.
    const first = await deduper.dedupedRefresh({
      serverName: "notion",
      authServerUrl: baseUrl,
      accessToken: "AT_INIT",
      refreshToken: "RT_INIT",
      clientInformation: CLIENT_INFO,
    });
    const rotated = first.tokens.refresh_token;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe("RT_INIT");

    // The NEW refresh_token is on disk (saveTokens captured the rotation).
    const raw = JSON.parse(readFileSync(join(dir, "notion.json"), "utf8")) as Record<string, unknown>;
    expect(raw["refreshToken"]).toBe(rotated);

    // A subsequent refresh using the NEW token succeeds (re-presenting RT_INIT
    // would be a 400 lockout — assert we use the rotated one and do NOT throw).
    nowMs += 10_000; // past the straggler cache so a real refresh fires
    const second = await deduper.dedupedRefresh({
      serverName: "notion",
      authServerUrl: baseUrl,
      accessToken: first.tokens.access_token,
      refreshToken: rotated as string,
      clientInformation: CLIENT_INFO,
    });
    expect(second.tokens.access_token).toBeTruthy();
    expect(mock.getRefreshCount()).toBe(2);

    // Re-presenting the original (now rotated-away) token IS a 400 at the mock —
    // proving the rotation invalidated it (so persisting the new one mattered).
    const replay = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "RT_INIT" }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it("evicts the inflight entry on failure so a later refresh can retry (66-P13)", async () => {
    // Force the first refresh to fail (mock 400).
    mock.setNextResponse({ status: 400, body: { error: "temporarily_unavailable" } });
    await expect(
      deduper.dedupedRefresh({
        serverName: "svc",
        authServerUrl: baseUrl,
        accessToken: "AT_FAIL",
        refreshToken: "RT_FAIL",
        clientInformation: CLIENT_INFO,
      }),
    ).rejects.toBeTruthy();

    // No poisoned shared future: a retry for the SAME access token fires a new
    // POST and succeeds (the mock's next response is the default success bundle).
    const retry = await deduper.dedupedRefresh({
      serverName: "svc",
      authServerUrl: baseUrl,
      accessToken: "AT_FAIL",
      refreshToken: "RT_FAIL",
      clientInformation: CLIENT_INFO,
    });
    expect(retry.tokens.access_token).toBeTruthy();
    // Two POSTs total: the failed one + the successful retry.
    expect(mock.getRefreshCount()).toBe(2);
  });
});
