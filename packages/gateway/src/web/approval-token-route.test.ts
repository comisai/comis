// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for approval-token-route.ts (email approval link).
 *
 * The email `[FAILED]` digest carries a single-use, time-bounded, signed approval
 * LINK to this gateway GET handler. The token is the ONLY credential, so it must be:
 *
 *   1. single-use — a second GET with the same token must NOT resolve a second
 *      approval (the pending-token entry is removed at the TOP of the handler).
 *   2. revoke-BEFORE-outcome regardless of HTTP method — a HEAD/preview prefetch
 *      consumes the token (mail clients prefetch links), so a following GET finds
 *      a dead token; and even when the resolution path errors AFTER the revoke,
 *      the token is already gone (no reusable state).
 *   3. 5-min auto-expiry — after APPROVAL_TOKEN_TIMEOUT_MS the entry auto-deletes
 *      and a GET → invalid.
 *   4. unguessable — minted via generateStrongToken() (384-bit) — asserted at the
 *      composition root; here the route consumes whatever token the map holds.
 *   5. the token NEVER appears in any log line.
 *
 * Mirrors oauth-callback-route.test.ts: a Hono `app.request(url, { method })`
 * driver, a fake clock/timer (vi.useFakeTimers), a token `Map`, and a fake
 * resolver that records (and counts) `resolveApproval` calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ApprovalTokenDeps,
  PendingApprovalToken,
} from "./approval-token-route.js";
import {
  createApprovalTokenRoute,
  insertPendingApprovalToken,
  APPROVAL_TOKEN_TIMEOUT_MS,
} from "./approval-token-route.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockLogger(): ApprovalTokenDeps["logger"] {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * A recording resolver. `resolved` controls the success outcome; `throwOnCall`
 * forces the resolution path to reject AFTER the revoke so the no-reusable-state
 * invariant can be asserted. `calls` counts every invocation (single-use proof).
 */
function makeResolver(opts: { resolved?: boolean; throwOnCall?: boolean } = {}) {
  const calls: PendingApprovalToken[] = [];
  const fn = vi.fn(async (entry: PendingApprovalToken): Promise<boolean> => {
    calls.push(entry);
    if (opts.throwOnCall === true) throw new Error("forced resolution failure");
    return opts.resolved ?? true;
  });
  return { fn, calls };
}

function makeEntry(
  overrides: Partial<Omit<PendingApprovalToken, "timer">> = {},
): Omit<PendingApprovalToken, "timer"> {
  return {
    shortId: "abcDEF123456",
    choice: "approve",
    sessionKey: "tenant/user_a/inbox-1",
    channelType: "email",
    channelKey: "inbox-1",
    agentId: "main",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ApprovalTokenDeps> = {},
): ApprovalTokenDeps {
  return {
    tokens: new Map<string, PendingApprovalToken>(),
    resolveApproval: makeResolver().fn,
    logger: makeMockLogger(),
    ...overrides,
  };
}

/**
 * Seed the token map directly (no real timer) so tests control entry shape.
 * A long no-op timer stands in for the auto-expiry timer; the handler clears it.
 */
function seedToken(
  map: Map<string, PendingApprovalToken>,
  token: string,
  entry: Omit<PendingApprovalToken, "timer">,
): void {
  const timer = setTimeout(() => {
    /* noop — test cleanup */
  }, 60_000_000);
  map.set(token, { ...entry, timer });
}

function request(
  app: ReturnType<typeof createApprovalTokenRoute>,
  token: string,
  method = "GET",
): Promise<Response> {
  return app.request(`/${token}`, { method });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApprovalTokenRoute — single-use email approval token", () => {
  it("resolves the matching approval on the first GET and returns a success page", async () => {
    const resolver = makeResolver({ resolved: true });
    const deps = makeDeps({ resolveApproval: resolver.fn });
    seedToken(deps.tokens, "tok-1", makeEntry({ choice: "approve" }));
    const app = createApprovalTokenRoute(deps);

    const res = await request(app, "tok-1");

    expect(res.status).toBe(200);
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]!.shortId).toBe("abcDEF123456");
    expect(resolver.calls[0]!.choice).toBe("approve");
  });

  it("does NOT resolve a second approval when the same token is GET twice (single-use)", async () => {
    const resolver = makeResolver({ resolved: true });
    const deps = makeDeps({ resolveApproval: resolver.fn });
    seedToken(deps.tokens, "tok-1", makeEntry());
    const app = createApprovalTokenRoute(deps);

    const first = await request(app, "tok-1");
    const second = await request(app, "tok-1");

    expect(first.status).toBe(200);
    // The second GET finds a dead token → not resolved again.
    expect(second.status).toBe(410);
    expect(resolver.calls).toHaveLength(1);
    expect(deps.tokens.has("tok-1")).toBe(false);
  });

  it("consumes the token on a HEAD/preview prefetch so a following GET does NOT resolve (revoke regardless of method)", async () => {
    const resolver = makeResolver({ resolved: true });
    const deps = makeDeps({ resolveApproval: resolver.fn });
    seedToken(deps.tokens, "tok-1", makeEntry());
    const app = createApprovalTokenRoute(deps);

    // A mail client preview prefetch: HEAD consumes the token.
    await request(app, "tok-1", "HEAD");
    expect(deps.tokens.has("tok-1")).toBe(false);

    // The real user click (GET) now finds a dead token.
    const afterHead = await request(app, "tok-1", "GET");
    expect(afterHead.status).toBe(410);
    // The token was consumed exactly once across HEAD + GET.
    expect(resolver.calls).toHaveLength(1);
  });

  it("leaves the token dead even when the resolution path errors AFTER the revoke (no reusable state)", async () => {
    const resolver = makeResolver({ throwOnCall: true });
    const deps = makeDeps({ resolveApproval: resolver.fn });
    seedToken(deps.tokens, "tok-1", makeEntry());
    const app = createApprovalTokenRoute(deps);

    // The forced-failure resolution must not re-arm the token.
    const res = await request(app, "tok-1");
    // A post-revoke resolution failure is a CONSUMED-but-failed terminal
    // state, NOT a transient server error. 500 is the conventional "retry me"
    // signal and contradicts the "cannot be retried" body copy (a mail-client
    // prefetch that trips this would invite the user to retry a dead token).
    // Return a non-retryable 4xx so the status line agrees with the page.
    expect(res.status).toBe(409);
    expect(deps.tokens.has("tok-1")).toBe(false);

    // A retry finds no reusable state and never reaches a second resolveApproval.
    const retry = await request(app, "tok-1");
    expect(retry.status).toBe(410);
    expect(resolver.calls).toHaveLength(1);
  });

  it("returns an invalid page for an unknown token without calling resolveApproval", async () => {
    const resolver = makeResolver();
    const deps = makeDeps({ resolveApproval: resolver.fn });
    const app = createApprovalTokenRoute(deps);

    const res = await request(app, "no-such-token");
    expect(res.status).toBe(410);
    expect(resolver.calls).toHaveLength(0);
  });

  it("does not log the token string on any line", async () => {
    const logger = makeMockLogger();
    const resolver = makeResolver({ resolved: true });
    const deps = makeDeps({ resolveApproval: resolver.fn, logger });
    seedToken(deps.tokens, "super-secret-token-value", makeEntry());
    const app = createApprovalTokenRoute(deps);

    await request(app, "super-secret-token-value");

    const allCalls = [
      ...logger.trace.mock.calls,
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    const serialised = JSON.stringify(allCalls);
    expect(serialised).not.toContain("super-secret-token-value");
  });
});

describe("insertPendingApprovalToken — 5-min auto-expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-deletes the token entry after APPROVAL_TOKEN_TIMEOUT_MS so a later GET is invalid", async () => {
    const resolver = makeResolver({ resolved: true });
    const deps = makeDeps({ resolveApproval: resolver.fn });
    insertPendingApprovalToken(deps.tokens, "tok-exp", makeEntry(), deps.logger);
    expect(deps.tokens.has("tok-exp")).toBe(true);

    vi.advanceTimersByTime(APPROVAL_TOKEN_TIMEOUT_MS + 1);
    expect(deps.tokens.has("tok-exp")).toBe(false);

    const app = createApprovalTokenRoute(deps);
    const res = await request(app, "tok-exp");
    expect(res.status).toBe(410);
    expect(resolver.calls).toHaveLength(0);
  });

  it("pins APPROVAL_TOKEN_TIMEOUT_MS at 5 minutes", () => {
    expect(APPROVAL_TOKEN_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
