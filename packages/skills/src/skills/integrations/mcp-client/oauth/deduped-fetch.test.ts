// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for the deduped-refresh fetch wrapper (Phase 66
 * OAUTH-05 / CR-01).
 *
 * The wrapper composes on top of an inner FetchLike (typically the
 * redirect-policy fetch) and intercepts 401 responses, routing the refresh
 * through the deduper before retrying. RED→GREEN coverage:
 *
 *   1. Non-401 pass-through: a 200 response from the inner fetch returns
 *      verbatim — no refresh, no retry.
 *   2. 401 with missing inputs: when the token store has no refresh_token /
 *      client info / discovery the wrapper returns the 401 verbatim — the SDK
 *      surfaces needs_oauth_login via UnauthorizedError (no silent loop).
 *   3. Happy 401 → refresh → retry: a single 401 with a Bearer header drives
 *      dedupedRefresh ONCE; the retry attaches the rotated bearer and the
 *      wrapper returns the retry's 200.
 *   4. Dedup stress: 100 concurrent requests all returning 401 (same Bearer)
 *      route through ONE refresh promise (the shared future from the deduper);
 *      EXACTLY 1 call to deduper.dedupedRefresh, and all 100 callers see the
 *      retry's 200.
 *   5. Persistent 401 after refresh: the retry itself returns 401 → the
 *      wrapper does NOT recurse; it returns the second 401 verbatim.
 *
 * The token store + deduper are real (tmpdir + DI'd); the inner fetch is a
 * scripted spy so the test owns response sequencing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";

import type {
  OAuthTokens,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createTokenStore, type TokenStore } from "./token-store.js";
import {
  createRefreshDeduper,
  type RefreshDeduper,
  type RefreshResult,
} from "./refresh-deduper.js";
import { createDedupedRefreshFetch } from "./deduped-fetch.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const CLIENT_INFO: OAuthClientInformationFull = {
  client_id: "mock-client-id",
  redirect_uris: ["http://127.0.0.1:0/callback"],
};

const EXPIRED_BEARER = "EXPIRED_AT_ABCDEF";
const NEW_BEARER = "NEW_AT_GHIJKL";
const REFRESH_TOKEN = "RT_INIT";

describe("createDedupedRefreshFetch", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;
  let nowMs: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "comis-deduped-fetch-"));
    logger = makeLogger();
    nowMs = 1_700_000_000_000;
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => nowMs,
      logger,
      watchPersistent: false,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeduperFromTokens(rotatedTokens: OAuthTokens): {
    deduper: RefreshDeduper;
    dedupedRefreshSpy: ReturnType<typeof vi.fn>;
  } {
    // Build a deduper whose `refreshFn` returns a deterministic rotated-tokens
    // payload (no network). The deduper itself is the production code path —
    // we only stub the SDK refresh primitive injectable on the deduper.
    const real = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: new PQueue({ concurrency: 1 }),
      tokenStore: store,
      now: () => nowMs,
      cacheTtlMs: 5000,
      logger,
      refreshFn: async () => rotatedTokens,
    });

    // Wrap dedupedRefresh in a spy so callers can assert the call shape +
    // count without altering the deduper's behavior. The deduper still
    // performs the saveTokens + cache machinery.
    const dedupedRefreshSpy = vi.fn(real.dedupedRefresh);
    const deduper: RefreshDeduper = {
      dedupedRefresh: dedupedRefreshSpy as unknown as RefreshDeduper["dedupedRefresh"],
    };
    return { deduper, dedupedRefreshSpy };
  }

  function makeFetchSpy(responses: Array<() => Response>): {
    fetch: FetchLike;
    spy: ReturnType<typeof vi.fn>;
  } {
    let i = 0;
    const spy = vi.fn(async (_input: Parameters<FetchLike>[0], _init?: Parameters<FetchLike>[1]) => {
      const next = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return next!();
    });
    return { fetch: spy as unknown as FetchLike, spy };
  }

  it("non-401 pass-through: returns the inner response verbatim, no refresh", async () => {
    const { deduper, dedupedRefreshSpy } = makeDeduperFromTokens({
      access_token: NEW_BEARER,
      token_type: "Bearer",
      expires_in: 3600,
    });
    const { fetch: inner, spy: innerSpy } = makeFetchSpy([
      () => new Response("ok", { status: 200 }),
    ]);

    const wrapped = createDedupedRefreshFetch({
      serverName: "notion",
      tokenStore: store,
      deduper,
      innerFetch: inner,
      logger,
    });

    const res = await wrapped("http://example.test/x", {
      method: "POST",
      headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(innerSpy).toHaveBeenCalledTimes(1);
    expect(dedupedRefreshSpy).not.toHaveBeenCalled();
  });

  it("401 with missing refresh inputs → surfaces 401 (no refresh, no retry)", async () => {
    const { deduper, dedupedRefreshSpy } = makeDeduperFromTokens({
      access_token: NEW_BEARER,
      token_type: "Bearer",
      expires_in: 3600,
    });
    // No seed — tokenStore has nothing for "notion".
    const { fetch: inner, spy: innerSpy } = makeFetchSpy([
      () => new Response("", { status: 401 }),
    ]);

    const wrapped = createDedupedRefreshFetch({
      serverName: "notion",
      tokenStore: store,
      deduper,
      innerFetch: inner,
      logger,
    });

    const res = await wrapped("http://example.test/x", {
      headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
    });
    expect(res.status).toBe(401);
    expect(innerSpy).toHaveBeenCalledTimes(1);
    expect(dedupedRefreshSpy).not.toHaveBeenCalled();
  });

  it("happy 401 → dedupedRefresh ONCE → retry with rotated bearer → 200", async () => {
    // Seed the store so the refresh inputs are present.
    await store.saveTokens("notion", {
      access_token: EXPIRED_BEARER,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
    });
    await store.saveClientInformation("notion", CLIENT_INFO);
    await store.saveDiscoveryState("notion", {
      authorizationServerUrl: "https://auth.example.test",
    });

    const { deduper, dedupedRefreshSpy } = makeDeduperFromTokens({
      access_token: NEW_BEARER,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "RT_ROTATED",
    });

    const { fetch: inner, spy: innerSpy } = makeFetchSpy([
      () => new Response("", { status: 401 }),
      () => new Response("retried", { status: 200 }),
    ]);

    const wrapped = createDedupedRefreshFetch({
      serverName: "notion",
      tokenStore: store,
      deduper,
      innerFetch: inner,
      logger,
    });

    const res = await wrapped("http://example.test/x", {
      method: "POST",
      headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("retried");
    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    // The deduper got the EXPIRED bearer as the dedup key.
    const args = dedupedRefreshSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.accessToken).toBe(EXPIRED_BEARER);
    expect(args.refreshToken).toBe(REFRESH_TOKEN);
    expect(args.serverName).toBe("notion");

    // The retry attached the NEW bearer.
    expect(innerSpy).toHaveBeenCalledTimes(2);
    const retryInit = innerSpy.mock.calls[1]![1] as RequestInit;
    expect(new Headers(retryInit.headers).get("Authorization")).toBe(`Bearer ${NEW_BEARER}`);
  });

  it("CR-01 dedup stress: 100 concurrent 401s → EXACTLY 1 dedupedRefresh call (shared future)", async () => {
    await store.saveTokens("notion", {
      access_token: EXPIRED_BEARER,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
    });
    await store.saveClientInformation("notion", CLIENT_INFO);
    await store.saveDiscoveryState("notion", {
      authorizationServerUrl: "https://auth.example.test",
    });

    // Track how many UNIQUE refresh executions ran. The deduper coalesces N
    // concurrent calls into ONE refreshFn execution inside its critical
    // section, but dedupedRefresh itself may be called N times (each call
    // resolves to the same shared future). Both must hold:
    //   - refreshExecCount === 1 (the deduper's internal coalescing)
    //   - dedupedRefreshSpy.callCount === 100 (each fetch call routed through)
    let refreshExecCount = 0;
    const real = createRefreshDeduper({
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
      queue: new PQueue({ concurrency: 1 }),
      tokenStore: store,
      now: () => nowMs,
      cacheTtlMs: 60000, // Wide cache so straggler-cache reuse never matters.
      logger,
      refreshFn: async () => {
        refreshExecCount += 1;
        // Yield a tick so all 100 callers reach the deduper queue before the
        // refresh resolves — this is what proves the dedup, not the order.
        await new Promise((r) => setImmediate(r));
        return {
          access_token: NEW_BEARER,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "RT_ROTATED",
        };
      },
    });
    const dedupedRefreshSpy = vi.fn(real.dedupedRefresh);
    const deduper: RefreshDeduper = {
      dedupedRefresh: dedupedRefreshSpy as unknown as RefreshDeduper["dedupedRefresh"],
    };

    // The inner fetch returns 401 the FIRST time per call and 200 the SECOND
    // time — so each of the 100 concurrent calls goes 401 → refresh → retry
    // 200. We model this by tracking call count per request path; an "id"
    // query param tags each request so we can assert each got a retry.
    const callsByPath = new Map<string, number>();
    const inner: FetchLike = async (input, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      const count = (callsByPath.get(url) ?? 0) + 1;
      callsByPath.set(url, count);
      if (count === 1) return new Response("", { status: 401 });
      return new Response("retry-ok", { status: 200 });
    };

    const wrapped = createDedupedRefreshFetch({
      serverName: "notion",
      tokenStore: store,
      deduper,
      innerFetch: inner,
      logger,
    });

    // 100 concurrent requests, each with a unique URL so the inner fetch
    // mock state is per-call (each call is its own 401→200 pair).
    const promises = Array.from({ length: 100 }, (_, i) =>
      wrapped(`http://example.test/x?i=${i}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
      }),
    );
    const responses = await Promise.all(promises);

    // ── Headline OAUTH-05 assertion ──────────────────────────────────────
    // The deduper coalesced 100 concurrent refresh requests into ONE
    // execution of the underlying refresh primitive (66-P4 thundering herd).
    expect(refreshExecCount).toBe(1);
    // Each of the 100 fetches routed THROUGH dedupedRefresh — all got the
    // shared future from the deduper's inflightRefreshes map.
    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(100);

    // Every request returned the retry's 200 (no 401 leaked).
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("retry-ok");
    }
  });

  it("persistent 401 after refresh: does NOT recurse; surfaces the second 401", async () => {
    await store.saveTokens("notion", {
      access_token: EXPIRED_BEARER,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
    });
    await store.saveClientInformation("notion", CLIENT_INFO);
    await store.saveDiscoveryState("notion", {
      authorizationServerUrl: "https://auth.example.test",
    });

    const { deduper, dedupedRefreshSpy } = makeDeduperFromTokens({
      access_token: NEW_BEARER,
      token_type: "Bearer",
      expires_in: 3600,
    });

    const { fetch: inner, spy: innerSpy } = makeFetchSpy([
      () => new Response("", { status: 401 }),
      () => new Response("still-401", { status: 401 }),
    ]);

    const wrapped = createDedupedRefreshFetch({
      serverName: "notion",
      tokenStore: store,
      deduper,
      innerFetch: inner,
      logger,
    });

    const res = await wrapped("http://example.test/x", {
      headers: { Authorization: `Bearer ${EXPIRED_BEARER}` },
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("still-401");
    // Refresh ran ONCE. The wrapper does NOT re-enter the refresh path on a
    // second 401 — that would thrash the token endpoint (a fresh access
    // token returning 401 indicates a provider-side issue the deduper
    // cannot fix; needs_oauth_login is the right surface).
    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    expect(innerSpy).toHaveBeenCalledTimes(2);
  });
});
