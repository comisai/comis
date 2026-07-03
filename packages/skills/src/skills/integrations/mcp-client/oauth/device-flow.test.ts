// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the RFC 8628 OAuth device-authorization grant orchestrator.
 *
 * Pins the public boundary of runDeviceFlow plus the RFC 8628 §3.2 / §3.5
 * semantics: device-authorization POST, polling interval / slow_down / terminal
 * codes, transient 5xx + network resilience, hard expires_in deadline, and the
 * tokenStore.saveTokens persistence chain. Also pins the discovery cascade —
 * the operator-supplied oauth.deviceAuthorizationEndpoint wins over the
 * auto-resolved endpoint surfaced by discoveryState.
 *
 * Test fixtures use neutral hosts (example.com / operator.example) — NEVER the
 * real Higgsfield hosts, which are exercised only in E2E coverage.
 *
 * All tests assert NO logged value contains the fixture device_code string:
 * device_code is bearer-equivalent for the polling round-trip and MUST stay
 * closure-only (never logged).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { runDeviceFlow, type RunDeviceFlowDeps } from "./device-flow.js";
import type { TokenStore } from "./token-store.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const FIXTURE_DEVICE_CODE = "DC-test-device-code-xyz";
const FIXTURE_USER_CODE = "WDJB-MJHT";
const FIXTURE_VERIFICATION_URI = "https://example.com/device";
const FIXTURE_TOKEN_ENDPOINT = "https://example.com/oauth/token";
const FIXTURE_AUTHZ_SERVER_URL = "https://example.com";
const FIXTURE_AUTH_ENDPOINT = "https://example.com/oauth/device_authorization";
const FIXTURE_OPERATOR_AUTH_ENDPOINT = "https://operator.example/device";
const FIXTURE_AUTO_AUTH_ENDPOINT = "https://auto.example/device";
const FIXTURE_CLIENT_ID = "test-client-id";

function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeClientInfo(): OAuthClientInformationFull {
  // The DCR pre-cache path: tokenStore.clientInformation returns this so
  // runDeviceFlow's ensureClientRegistration skips the registerClient SDK call.
  return {
    client_id: FIXTURE_CLIENT_ID,
    redirect_uris: [],
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    token_endpoint_auth_method: "none",
  } as OAuthClientInformationFull;
}

function makeTokenStore(overrides: Partial<TokenStore> = {}): TokenStore {
  const base = {
    saveTokens: vi.fn().mockResolvedValue(undefined),
    saveClientInformation: vi.fn().mockResolvedValue(undefined),
    clientInformation: vi.fn().mockResolvedValue(makeClientInfo()),
    discoveryState: vi.fn().mockResolvedValue(undefined),
    saveDiscoveryState: vi.fn().mockResolvedValue(undefined),
    tokens: vi.fn().mockResolvedValue(undefined),
    deleteTokens: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return base as unknown as TokenStore;
}

function makeDiscoveryState(overrides?: {
  tokenEndpoint?: string;
  deviceAuthEndpoint?: string;
}): OAuthDiscoveryState {
  const tokenEndpoint = overrides?.tokenEndpoint ?? FIXTURE_TOKEN_ENDPOINT;
  const deviceAuthEndpoint = overrides?.deviceAuthEndpoint;
  return {
    authorizationServerUrl: FIXTURE_AUTHZ_SERVER_URL,
    authorizationServerMetadata: {
      issuer: FIXTURE_AUTHZ_SERVER_URL,
      authorization_endpoint: `${FIXTURE_AUTHZ_SERVER_URL}/authorize`,
      token_endpoint: tokenEndpoint,
      response_types_supported: ["code"],
      ...(deviceAuthEndpoint !== undefined
        ? { device_authorization_endpoint: deviceAuthEndpoint }
        : {}),
    },
  } as unknown as OAuthDiscoveryState;
}

/**
 * Build a fake fetchFn that returns the supplied sequence of `Response`
 * descriptors in order. Each descriptor is `{ ok, status, json }`. After the
 * sequence is exhausted, subsequent calls re-use the last descriptor (so
 * infinite-pending tests can keep polling).
 */
function makeSequenceFetch(
  sequence: ReadonlyArray<
    | { ok: true; status?: number; json: unknown }
    | { ok: false; status: number; json: unknown }
    | { throws: Error }
  >,
): { fetchFn: FetchLike; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchFn: FetchLike = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const idx = Math.min(i, sequence.length - 1);
    i++;
    const desc = sequence[idx]!;
    if ("throws" in desc) throw desc.throws;
    const ok = desc.ok;
    const status = desc.status ?? (ok ? 200 : 400);
    const json = desc.json;
    return {
      ok,
      status,
      headers: new Headers(),
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  }) as unknown as FetchLike;
  return { fetchFn, calls };
}

/**
 * Captured-intervals clock. Each call to sleep(ms) records ms and advances the
 * fake clock by ms. nowMs() returns the accumulated advance.
 */
function makeCapturedClock(): {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  intervals: number[];
  advance: (ms: number) => void;
} {
  let now = 0;
  const intervals: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    intervals.push(ms);
    now += ms;
  };
  const advance = (ms: number): void => {
    now += ms;
  };
  return { nowMs: () => now, sleep, intervals, advance };
}

/**
 * Build a baseline deps object. Tests override what they need to exercise.
 */
function makeBaseDeps(overrides: Partial<RunDeviceFlowDeps>): RunDeviceFlowDeps {
  const logger = overrides.logger ?? makeLogger();
  const clock = makeCapturedClock();
  return {
    serverName: "test-server",
    serverUrl: FIXTURE_AUTHZ_SERVER_URL,
    oauthConfig: {},
    tokenStore: makeTokenStore(),
    discoveryState: makeDiscoveryState({
      deviceAuthEndpoint: FIXTURE_AUTH_ENDPOINT,
    }),
    logger,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    ...overrides,
  };
}

/**
 * Assert no log call payload or message contains the fixture device_code.
 * device_code is bearer-equivalent and is closure-only — it must NEVER appear
 * in logs.
 */
function assertNoDeviceCodeLogged(
  logger: ReturnType<typeof makeLogger>,
): void {
  const allCalls = [
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
    ...logger.debug.mock.calls,
  ];
  for (const call of allCalls) {
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain(FIXTURE_DEVICE_CODE);
  }
}

// ---------------------------------------------------------------------------
// 1. Device-authorization request — RFC 8628 §3.2 shape parse + POST contract
// ---------------------------------------------------------------------------

describe("runDeviceFlow — RFC 8628 §3.2 device-authorization request", () => {
  it("device authorization request POSTs to endpoint and parses RFC 8628 §3.2 response", async () => {
    const logger = makeLogger();
    const { fetchFn, calls } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      // Authorization arrives quickly — single 200 with tokens stops polling.
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const result = await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        oauthConfig: { scope: "read" },
      }),
    );

    // Synchronous return carries the verification fields per RFC 8628 §3.2.
    const r = result as unknown as {
      status: string;
      userCode?: string;
      verificationUri?: string;
      expiresIn?: number;
    };
    expect(r.status).toBe("device_code_pending");
    expect(r.userCode).toBe(FIXTURE_USER_CODE);
    expect(r.verificationUri).toBe(FIXTURE_VERIFICATION_URI);
    expect(r.expiresIn).toBe(600);

    // First call is the device-authorization POST.
    const first = calls[0]!;
    expect(first.url).toBe(FIXTURE_AUTH_ENDPOINT);
    expect(first.init?.method).toBe("POST");
    const headers = (first.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(first.init?.body ?? "");
    expect(body).toContain(`client_id=${FIXTURE_CLIENT_ID}`);
    expect(body).toContain("scope=read");

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 2. Polling — slow_down +5s per RFC 8628 §3.5 (cumulative, exactly +5s)
// ---------------------------------------------------------------------------

describe("runDeviceFlow — RFC 8628 §3.5 polling semantics", () => {
  it("polling honors slow_down by adding exactly 5000ms once per occurrence per RFC 8628 §3.5", async () => {
    const logger = makeLogger();
    const clock = makeCapturedClock();
    const { fetchFn } = makeSequenceFetch([
      // 1. device-authorization → success
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      // 2. poll 1 → authorization_pending (interval stays 5000ms)
      { ok: false, status: 400, json: { error: "authorization_pending" } },
      // 3. poll 2 → slow_down (interval becomes 10000ms)
      { ok: false, status: 400, json: { error: "slow_down" } },
      // 4. poll 3 → slow_down again (interval becomes 15000ms — cumulative,
      //    NOT exponential)
      { ok: false, status: 400, json: { error: "slow_down" } },
      // 5. poll 4 → success
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        nowMs: clock.nowMs,
        sleep: clock.sleep,
        tokenStore,
      }),
    );

    // Background polling completes asynchronously; await persistence.
    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    // RFC 8628 §3.5: poll-1 waits initial 5000; poll-2 waits 5000 (pending
    // didn't change interval); poll-3 waits 10000 (first slow_down +5000);
    // poll-4 waits 15000 (second slow_down +5000).
    expect(clock.intervals.slice(0, 4)).toEqual([5000, 5000, 10000, 15000]);
    // Anti-test: pin spec interpretation — exponential [5000, 5000, 10000,
    // 20000] would mean the wrong interpretation; a doubling [5000, 10000,
    // 20000, 40000] even more so.
    expect(clock.intervals.slice(0, 4)).not.toEqual([5000, 5000, 10000, 20000]);

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Terminal codes — access_denied + expired_token return failed
// ---------------------------------------------------------------------------

describe("runDeviceFlow — RFC 8628 §3.5 terminal error codes", () => {
  it("polling treats access_denied as terminal and returns failed", async () => {
    const logger = makeLogger();
    const { fetchFn, calls } = makeSequenceFetch([
      // 1. device-authorization → success
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      // 2. poll 1 → pending
      { ok: false, status: 400, json: { error: "authorization_pending" } },
      // 3. poll 2 → access_denied (terminal — no further polls)
      { ok: false, status: 400, json: { error: "access_denied" } },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({ fetchFn, logger, tokenStore }),
    );

    // Wait for background completion (WARN log emitted).
    await vi.waitFor(
      () => {
        const found = logger.warn.mock.calls.find(([, msg]) =>
          typeof msg === "string" && msg.includes("access_denied"),
        );
        expect(found).toBeDefined();
      },
      { timeout: 1000 },
    );

    // Exactly 3 fetches: device-auth + 2 polls (no extra after terminal).
    expect(calls.length).toBe(3);

    // saveTokens NEVER fires on terminal failure.
    expect(
      (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);

    // WARN payload carries errorKind:"auth" + hint mentioning operator denial.
    const warn = logger.warn.mock.calls.find(([, msg]) =>
      typeof msg === "string" && msg.includes("access_denied"),
    );
    expect(warn).toBeDefined();
    const payload = warn![0] as Record<string, unknown>;
    expect(payload.errorKind).toBe("auth");
    expect(String(payload.hint ?? "")).toMatch(/denied/i);

    assertNoDeviceCodeLogged(logger);
  });

  it("polling treats expired_token as terminal and returns failed", async () => {
    const logger = makeLogger();
    const { fetchFn, calls } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      { ok: false, status: 400, json: { error: "expired_token" } },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({ fetchFn, logger, tokenStore }),
    );

    await vi.waitFor(
      () => {
        const found = logger.warn.mock.calls.find(([, msg]) =>
          typeof msg === "string" && msg.includes("expired_token"),
        );
        expect(found).toBeDefined();
      },
      { timeout: 1000 },
    );

    expect(calls.length).toBe(2); // device-auth + 1 poll
    expect(
      (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);

    const warn = logger.warn.mock.calls.find(([, msg]) =>
      typeof msg === "string" && msg.includes("expired_token"),
    );
    expect(warn).toBeDefined();
    const payload = warn![0] as Record<string, unknown>;
    expect(payload.errorKind).toBe("auth");
    expect(String(payload.hint ?? "")).toMatch(/expired/i);

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. Transient HTTP 5xx + network errors — continue per RFC 8628 §3.5
// ---------------------------------------------------------------------------

describe("runDeviceFlow — transient failure resilience", () => {
  it("polling continues through HTTP 5xx until deadline", async () => {
    const logger = makeLogger();
    const { fetchFn } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      // 5xx is NOT a JSON error body — Cloudflare-style HTML.
      { ok: false, status: 502, json: { error: "bad-gateway-not-json" } },
      // Recovery: 200 with tokens.
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(makeBaseDeps({ fetchFn, logger, tokenStore }));

    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    // The 502 was logged as a `dependency` continue (NOT terminal).
    const depLog =
      logger.warn.mock.calls.find(
        ([obj]) => (obj as Record<string, unknown>).errorKind === "dependency",
      ) ??
      logger.debug.mock.calls.find(
        ([obj]) => (obj as Record<string, unknown>).errorKind === "dependency",
      );
    expect(depLog).toBeDefined();

    assertNoDeviceCodeLogged(logger);
  });

  it("polling continues through fetch network errors until deadline", async () => {
    const logger = makeLogger();
    const { fetchFn } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      { throws: new Error("ECONNRESET") },
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(makeBaseDeps({ fetchFn, logger, tokenStore }));

    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    // The network throw was logged as `dependency` continue (NOT terminal).
    const depLog = logger.warn.mock.calls.find(
      ([obj]) => (obj as Record<string, unknown>).errorKind === "dependency",
    );
    expect(depLog).toBeDefined();

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 7. Deadline enforcement — hard stop at expires_in
// ---------------------------------------------------------------------------

describe("runDeviceFlow — RFC 8628 §3.2 expires_in deadline", () => {
  it("deadline enforcement returns failed once now() exceeds device_code expires_in", async () => {
    const logger = makeLogger();
    let nowValue = 0;
    const intervals: number[] = [];
    const fakeNowMs = (): number => nowValue;
    const fakeSleep = async (ms: number): Promise<void> => {
      intervals.push(ms);
      nowValue += ms;
    };

    const { fetchFn } = makeSequenceFetch([
      // device-authorization
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 30, // 30s = 30000ms deadline
          interval: 5,
        },
      },
      // Infinite pending — the loop would never terminate without the deadline.
      { ok: false, status: 400, json: { error: "authorization_pending" } },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        tokenStore,
        nowMs: fakeNowMs,
        sleep: fakeSleep,
      }),
    );

    // Wait for the deadline-exceeded WARN.
    await vi.waitFor(
      () => {
        const found = logger.warn.mock.calls.find(([, msg]) =>
          typeof msg === "string" && msg.toLowerCase().includes("deadline"),
        );
        expect(found).toBeDefined();
      },
      { timeout: 1000 },
    );

    // saveTokens never fires.
    expect(
      (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);

    const warn = logger.warn.mock.calls.find(([, msg]) =>
      typeof msg === "string" && msg.toLowerCase().includes("deadline"),
    );
    expect(warn).toBeDefined();
    const payload = warn![0] as Record<string, unknown>;
    expect(payload.errorKind).toBe("auth");
    expect(String(payload.hint ?? "")).toMatch(/expires_in|window|retry/i);

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 8. tokenStore.saveTokens persistence on successful poll
// ---------------------------------------------------------------------------

describe("runDeviceFlow — token persistence chain", () => {
  it("successful poll persists OAuthTokens via injected tokenStore.saveTokens", async () => {
    const logger = makeLogger();
    const { fetchFn } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "RT",
          scope: "openid",
        },
      },
    ]);

    const tokenStore = makeTokenStore();

    // Synchronous return carries device_code_pending.
    const result = await runDeviceFlow(
      makeBaseDeps({ fetchFn, logger, tokenStore }),
    );
    const r = result as unknown as { status: string };
    expect(r.status).toBe("device_code_pending");

    // Background poll persists OAuthTokens with all five fields.
    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBe(1);
      },
      { timeout: 1000 },
    );

    const savedCall = (
      tokenStore.saveTokens as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(savedCall[0]).toBe("test-server");
    const tokens = savedCall[1] as OAuthTokens;
    expect(tokens.access_token).toBe("AT");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBe("RT");
    expect(tokens.scope).toBe("openid");

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 9 + 10. interval defaults + clamping per RFC 8628 §3.5
// ---------------------------------------------------------------------------

describe("runDeviceFlow — interval defaults + defensive clamping", () => {
  it("interval missing from device-authorization response defaults to 5 seconds per RFC 8628 §3.5", async () => {
    const logger = makeLogger();
    const clock = makeCapturedClock();
    const { fetchFn } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          // NO interval — RFC 8628 §3.5 default = 5 seconds.
        },
      },
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        tokenStore,
        nowMs: clock.nowMs,
        sleep: clock.sleep,
      }),
    );

    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    expect(clock.intervals[0]).toBe(5000);

    assertNoDeviceCodeLogged(logger);
  });

  it("interval clamped to MIN_POLL_MS 1000 when provider returns 0 or negative interval", async () => {
    const logger = makeLogger();
    const clock = makeCapturedClock();
    const { fetchFn } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 0, // spec-violating; clamp to MIN_POLL_MS = 1000ms
        },
      },
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokenStore = makeTokenStore();
    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        tokenStore,
        nowMs: clock.nowMs,
        sleep: clock.sleep,
      }),
    );

    await vi.waitFor(
      () => {
        expect(
          (tokenStore.saveTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    expect(clock.intervals[0]).toBe(1000);

    assertNoDeviceCodeLogged(logger);
  });
});

// ---------------------------------------------------------------------------
// 11. Discovery cascade — operator override wins over auto-resolved endpoint
// ---------------------------------------------------------------------------

describe("runDeviceFlow — discovery cascade resolution", () => {
  it("discovery cascade prefers oauth.deviceAuthorizationEndpoint operator override over auto-resolved endpoint", async () => {
    const logger = makeLogger();
    const { fetchFn, calls } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      // Polling resolves immediately so we don't have to wait the full
      // background poll cycle.
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        oauthConfig: {
          deviceAuthorizationEndpoint: FIXTURE_OPERATOR_AUTH_ENDPOINT,
        },
        discoveryState: makeDiscoveryState({
          deviceAuthEndpoint: FIXTURE_AUTO_AUTH_ENDPOINT,
        }),
      }),
    );

    // First fetch is the device-authorization POST — MUST hit the operator
    // override, NOT the auto-resolved endpoint.
    expect(calls[0]!.url).toBe(FIXTURE_OPERATOR_AUTH_ENDPOINT);
    expect(calls[0]!.url).not.toBe(FIXTURE_AUTO_AUTH_ENDPOINT);

    assertNoDeviceCodeLogged(logger);
  });

  it("discovery cascade falls back to auto-resolved endpoint when operator override is absent", async () => {
    const logger = makeLogger();
    const { fetchFn, calls } = makeSequenceFetch([
      {
        ok: true,
        status: 200,
        json: {
          device_code: FIXTURE_DEVICE_CODE,
          user_code: FIXTURE_USER_CODE,
          verification_uri: FIXTURE_VERIFICATION_URI,
          expires_in: 600,
          interval: 5,
        },
      },
      {
        ok: true,
        status: 200,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    await runDeviceFlow(
      makeBaseDeps({
        fetchFn,
        logger,
        oauthConfig: {}, // no operator override
        discoveryState: makeDiscoveryState({
          deviceAuthEndpoint: FIXTURE_AUTO_AUTH_ENDPOINT,
        }),
      }),
    );

    expect(calls[0]!.url).toBe(FIXTURE_AUTO_AUTH_ENDPOINT);

    assertNoDeviceCodeLogged(logger);
  });
});
