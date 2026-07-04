// SPDX-License-Identifier: Apache-2.0
/**
 * Bot Framework Connector transport — the two outbound security boundaries.
 *
 * `isSafeServiceUrl` is the token-exfil gate: a freshly minted Connector bearer
 * must reach ONLY the exact per-cloud Connector host, so a tampered, look-alike,
 * or cross-cloud serviceUrl is rejected before any token mint or fetch. The send
 * retry executor is the send-safety gate: it re-sends only on an EXPLICIT
 * retryable non-2xx (429 → Retry-After, 5xx → capped backoff) and never on a
 * status-less transport fault, which may already have landed — a resend would
 * duplicate the activity.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import type { ConnectorTokenProvider } from "../msteams-auth.js";
import {
  isSafeServiceUrl,
  postConnectorActivity,
  postConnectorActivityWithRetry,
  type PostConnectorActivityParams,
} from "../msteams-connector.js";

// --- Fakes -----------------------------------------------------------------

/** A silent logger — the boundary matrix is asserted elsewhere; here we count POSTs. */
function makeLogger(): ComisLogger {
  const noop = vi.fn();
  return {
    level: "debug",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
}

/** A token provider that mints synchronously — the send fetch is the only wire call. */
function makeTokens(token = "connector-access-token"): ConnectorTokenProvider {
  return { getToken: async (): Promise<Result<string, Error>> => ok(token) };
}

/** One queued Connector send outcome: an explicit HTTP status, or a thrown transport fault. */
type SendStep =
  | { throws: true }
  | { status: number; retryAfter?: string; id?: string };

/**
 * A fetch stub that returns the queued send outcomes in order (repeating the
 * last), so the spy call count equals the number of send POSTs. The token is
 * minted through the injected {@link ConnectorTokenProvider}, never this fetch,
 * so every call here is a send — the count is unambiguous.
 */
function makeConnectorFetch(sequence: SendStep[]) {
  let i = 0;
  const spy = vi.fn(async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if ("throws" in step) throw new Error("connector unreachable");
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? (step.retryAfter ?? null) : null,
      },
      json: async () => ({ id: step.id ?? "sent-1" }),
    };
  });
  return { fetchImpl: spy as unknown as typeof fetch, spy };
}

function makeParams(
  overrides: Partial<PostConnectorActivityParams> = {},
): PostConnectorActivityParams {
  return {
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:dm-convo",
    activityBody: { type: "message", text: "hi" },
    tokens: makeTokens(),
    fetchImpl: makeConnectorFetch([{ status: 200 }]).fetchImpl,
    logger: makeLogger(),
    now: () => 1_000_000,
    ...overrides,
  };
}

/**
 * Drain the microtask queue via a single macrotask, so a fake-timer delay the
 * executor scheduled is registered before `advance()` is called against it.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- SEC-01: cloud-boundary serviceUrl validation --------------------------

describe("isSafeServiceUrl — cloud-boundary host validation (SEC-01)", () => {
  it("accepts the exact Public Connector host over https", () => {
    expect(isSafeServiceUrl("https://smba.trafficmanager.net/amer/", "public")).toBe(
      true,
    );
  });

  it("rejects a sibling trafficmanager host the old suffix allowlist wrongly admitted", () => {
    // Anyone can register a Traffic Manager profile, so evil.trafficmanager.net
    // must NOT be trusted — the exact-host set is what closes that breadth.
    expect(isSafeServiceUrl("https://evil.trafficmanager.net/", "public")).toBe(false);
  });

  it("rejects a look-alike host that only prefixes the trusted host label", () => {
    expect(
      isSafeServiceUrl("https://smba.trafficmanager.net.attacker.com/", "public"),
    ).toBe(false);
  });

  it("rejects the trusted host over plain http", () => {
    expect(isSafeServiceUrl("http://smba.trafficmanager.net/", "public")).toBe(false);
  });

  it("rejects a serviceUrl carrying a .. traversal segment", () => {
    expect(isSafeServiceUrl("https://smba.trafficmanager.net/../x", "public")).toBe(
      false,
    );
  });

  it("keeps the cloud boundary real: the China host is rejected under public and accepted under china", () => {
    expect(isSafeServiceUrl("https://botframework.azure.cn/", "public")).toBe(false);
    expect(isSafeServiceUrl("https://botframework.azure.cn/", "china")).toBe(true);
  });

  it("defaults to the public host set when no cloud is given", () => {
    expect(isSafeServiceUrl("https://smba.trafficmanager.net/amer/")).toBe(true);
    expect(isSafeServiceUrl("https://botframework.azure.cn/")).toBe(false);
  });
});

// --- SEC-01/T-8: reject-before-mint on the send path -----------------------

describe("postConnectorActivity — reject-before-mint gate (SEC-01/T-8)", () => {
  it("rejects a cross-origin serviceUrl before minting the token or fetching", async () => {
    const { fetchImpl, spy } = makeConnectorFetch([{ status: 200 }]);
    const tokens = makeTokens();
    const getToken = vi.spyOn(tokens, "getToken");
    const result = await postConnectorActivity(
      makeParams({ serviceUrl: "https://evil.trafficmanager.net/", fetchImpl, tokens }),
    );
    expect(result.ok).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a path-traversal conversation id before fetching", async () => {
    const { fetchImpl, spy } = makeConnectorFetch([{ status: 200 }]);
    const result = await postConnectorActivity(
      makeParams({ conversationId: "../evil", fetchImpl }),
    );
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- ERR-01: bounded, explicit-status-only send retry ----------------------

describe("postConnectorActivityWithRetry — bounded explicit-status retry (ERR-01)", () => {
  it("retries a 429 once after exactly the Retry-After delay, then succeeds with two POSTs", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch([
      { status: 429, retryAfter: "1" },
      { status: 200, id: "ok-after-429" },
    ]);
    const pending = postConnectorActivityWithRetry(makeParams({ fetchImpl }), { timer });
    await flush();
    // The delay must equal the Retry-After (1s): one tick short must NOT fire it.
    timer.advance(999);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    timer.advance(1);
    await flush();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ok-after-429");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries a transient 5xx with capped backoff, then succeeds with three POSTs", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch([
      { status: 503 },
      { status: 500 },
      { status: 200, id: "ok-after-5xx" },
    ]);
    const pending = postConnectorActivityWithRetry(makeParams({ fetchImpl }), { timer });
    // Advancing well past the backoff cap fires each scheduled retry.
    for (let round = 0; round < 3; round++) {
      await flush();
      timer.advance(60_000);
    }
    await flush();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ok-after-5xx");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401 auth failure — exactly one POST", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch([{ status: 401 }]);
    const result = await postConnectorActivityWithRetry(makeParams({ fetchImpl }), {
      timer,
    });
    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never retries a status-less transport fault — the send may have landed (exactly one POST)", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch([{ throws: true }]);
    const result = await postConnectorActivityWithRetry(makeParams({ fetchImpl }), {
      timer,
    });
    expect(result.ok).toBe(false);
    // Pitfall 4: a thrown fetch carries no HTTP status — resending risks a duplicate.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("bounds a persistent 429 storm at the retry cap and never sends unboundedly", async () => {
    const timer = createFakeTimers();
    const { fetchImpl, spy } = makeConnectorFetch([{ status: 429, retryAfter: "1" }]);
    const pending = postConnectorActivityWithRetry(makeParams({ fetchImpl }), { timer });
    // Drive far more rounds than the cap; the POST count must saturate at the bound.
    for (let round = 0; round < 12; round++) {
      await flush();
      timer.advance(1000);
    }
    await flush();
    const result = await pending;
    expect(result.ok).toBe(false);
    // One initial attempt plus the bounded number of retries.
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
