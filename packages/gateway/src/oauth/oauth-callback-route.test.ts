// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for oauth-callback-route.ts (Phase 11 SC11-2 + SC11-4).
 *
 * RED stubs created in Plan 11-01 (wave 0) and turned GREEN in Plan 11-03 (wave 1).
 *
 * Coverage:
 *   1. SC11-2: 400 when state query param is missing
 *   2. SC11-2: 400 when code query param is missing
 *   3. SC11-2: 400 when state is not in pendingFlows map (stale/forged state)
 *   4. SC11-2: 400 when state's flow.provider does not match URL provider param
 *   5. SC11-4: pendingFlows entry deleted BEFORE token exchange (verified on
 *      exchange-failure path — store.set throws, but pendingFlows.has(state)
 *      is still false because delete fired before the exchange try block)
 *   6. SC11-4: insertPendingFlow auto-deletes the map entry after
 *      PENDING_FLOW_TIMEOUT_MS (vi.useFakeTimers + advanceTimersByTime)
 *   7. (todo) Full happy-path with fetch mocking — covered by Plan 11-05
 *      integration test; stays it.todo here per plan acceptance criteria.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OAuthCallbackDeps, PendingFlow } from "./oauth-callback-route.js";
import {
  createOAuthCallbackRoute,
  insertPendingFlow,
  PENDING_FLOW_TIMEOUT_MS,
} from "./oauth-callback-route.js";
import type { OAuthProfile, TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockLogger(): OAuthCallbackDeps["logger"] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMockEventBus(): TypedEventBus {
  return { emit: vi.fn() } as unknown as TypedEventBus;
}

function makeMockCredentialStore(): OAuthCallbackDeps["credentialStore"] {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    has: vi.fn().mockResolvedValue({ ok: true, value: false }),
    list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    delete: vi.fn().mockResolvedValue({ ok: true, value: false }),
  };
}

function makeDeps(overrides: Partial<OAuthCallbackDeps> = {}): OAuthCallbackDeps {
  return {
    credentialStore: makeMockCredentialStore(),
    eventBus: makeMockEventBus(),
    logger: makeMockLogger(),
    pendingFlows: new Map<string, PendingFlow>(),
    ...overrides,
  };
}

function makeCallbackRequest(
  app: ReturnType<typeof createOAuthCallbackRoute>,
  provider: string,
  query: Record<string, string>,
): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  const url = qs.length === 0
    ? `/callback/${provider}`
    : `/callback/${provider}?${qs}`;
  return app.request(url, { method: "GET" });
}

/**
 * Seed a pending-flow map directly (without using insertPendingFlow's timer)
 * so tests can control the entry shape precisely.
 */
function seedPendingFlow(
  map: Map<string, PendingFlow>,
  state: string,
  flow: Omit<PendingFlow, "timer">,
): void {
  // Use a no-op timer so clearTimeout in the handler does not affect real timers.
  const timer = setTimeout(() => {
    /* noop — test cleanup */
  }, 60_000_000);
  map.set(state, { ...flow, timer });
}

// ---------------------------------------------------------------------------
// createOAuthCallbackRoute
// ---------------------------------------------------------------------------

describe("createOAuthCallbackRoute", () => {
  it("returns 400 when state query parameter is missing", async () => {
    const deps = makeDeps();
    const app = createOAuthCallbackRoute(deps);
    const res = await makeCallbackRequest(app, "openai-codex", {
      code: "test-code",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Login Failed");
    // No store mutation
    expect(deps.credentialStore.set).not.toHaveBeenCalled();
  });

  it("returns 400 when code query parameter is missing", async () => {
    const deps = makeDeps();
    const app = createOAuthCallbackRoute(deps);
    const res = await makeCallbackRequest(app, "openai-codex", {
      state: "test-state",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Login Failed");
    expect(deps.credentialStore.set).not.toHaveBeenCalled();
  });

  it("returns 400 when state is not in pendingFlows (stale/forged state)", async () => {
    const deps = makeDeps();
    const app = createOAuthCallbackRoute(deps);
    const res = await makeCallbackRequest(app, "openai-codex", {
      code: "test-code",
      state: "unknown-state",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Login Failed");
    expect(deps.credentialStore.set).not.toHaveBeenCalled();
  });

  it("returns 400 when flow.provider does not match URL provider param", async () => {
    const pendingFlows = new Map<string, PendingFlow>();
    const state = "state-bound-to-codex";
    seedPendingFlow(pendingFlows, state, {
      verifier: "test-verifier",
      provider: "openai-codex",
      createdAt: Date.now(),
    });
    const deps = makeDeps({ pendingFlows });
    const app = createOAuthCallbackRoute(deps);

    const res = await makeCallbackRequest(app, "anthropic", {
      code: "test-code",
      state,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Login Failed");
    // Provider-mismatch preserves the entry (legitimate provider may still
    // consume) per RESEARCH §Pattern 3.
    expect(pendingFlows.has(state)).toBe(true);
    expect(deps.credentialStore.set).not.toHaveBeenCalled();
  });

  it("SC11-4: pendingFlows entry deleted before token exchange (verified on exchange-failure)", async () => {
    // Stub fetch so the token exchange fails — but the state must still be
    // removed from pendingFlows because the delete fires BEFORE the try
    // block per the one-time-use invariant.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    try {
      const pendingFlows = new Map<string, PendingFlow>();
      const state = "state-will-be-consumed";
      seedPendingFlow(pendingFlows, state, {
        verifier: "test-verifier",
        provider: "openai-codex",
        createdAt: Date.now(),
      });
      const deps = makeDeps({ pendingFlows });
      const app = createOAuthCallbackRoute(deps);

      const res = await makeCallbackRequest(app, "openai-codex", {
        code: "test-code",
        state,
      });

      // Status is 500 (exchange failure routed via rewriteOAuthError)
      expect(res.status).toBe(500);
      const html = await res.text();
      expect(html).toContain("Login Failed");

      // CRITICAL: state was removed BEFORE the exchange (one-time-use)
      expect(pendingFlows.has(state)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SC11-4: insertPendingFlow auto-deletes entry after PENDING_FLOW_TIMEOUT_MS", () => {
    vi.useFakeTimers();
    try {
      const map = new Map<string, PendingFlow>();
      const logger = makeMockLogger();
      const state = "state-to-expire";
      insertPendingFlow(
        map,
        state,
        { verifier: "test-verifier", provider: "openai-codex", createdAt: Date.now() },
        logger,
      );

      // Entry exists immediately
      expect(map.has(state)).toBe(true);

      // Advance just below the timeout — entry still present
      vi.advanceTimersByTime(PENDING_FLOW_TIMEOUT_MS - 1);
      expect(map.has(state)).toBe(true);

      // Cross the timeout — entry removed
      vi.advanceTimersByTime(2);
      expect(map.has(state)).toBe(false);

      // Debug log fired
      expect(logger.debug).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.todo("happy path: validates state, exchanges code, stores profile, emits event, returns 200 HTML");
});

// ---------------------------------------------------------------------------
// PENDING_FLOW_TIMEOUT_MS sanity
// ---------------------------------------------------------------------------

describe("PENDING_FLOW_TIMEOUT_MS", () => {
  it("is exactly 5 minutes (5 * 60_000 ms)", () => {
    expect(PENDING_FLOW_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
