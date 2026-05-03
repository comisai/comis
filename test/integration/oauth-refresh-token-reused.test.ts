// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test for SC-10-3 + SC-10-4: OAuth refresh-failure error
 * classification end-to-end (Phase 10 plan 06 Task 2).
 *
 * Validates the full chain:
 *   mock OAuth server returns wire-shape error
 *   → OAuthTokenManager.getApiKey() bypasses pi-ai (Plan 10-03)
 *   → fetch body parsed → rewriteOAuthError classifies (Plan 10-02)
 *   → auth:refresh_failed event + WARN log + OAuthError all carry structured
 *     errorKind/hint/profileId
 *
 * Test inventory (5 tests):
 *   1. SC-10-4 + SC-10-3 case 4 — refresh_token_reused full chain.
 *   2. SC-10-3 case 1 — unsupported_country_region_territory.
 *   3. SC-10-3 case 2 — state mismatch (direct rewriteOAuthError call;
 *      this case happens at the LOCAL callback validation in pi-ai's login
 *      handler, NOT at OpenAI's HTTP boundary, so it is exercised as a
 *      unit-style test inside the integration file — covers the SC-10-3
 *      wire-detection invariant by asserting the catalogue's classification).
 *   4. SC-10-3 case 3 — invalid_grant generic (NOT reused).
 *   5. CRITICAL ordering invariant — refresh_token_reused beats
 *      invalid_grant when BOTH substrings are present (RESEARCH §Q3).
 *
 * Per AGENTS.md §2.5: imports from dist/ — requires `pnpm build` first.
 * Runs sequentially (maxConcurrency: 1) per test/vitest.config.ts.
 *
 * Run with: `pnpm build && pnpm test:integration -- oauth-refresh-token-reused`.
 *
 * @module
 */

import * as os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  TypedEventBus,
  createSecretManager,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import {
  createOAuthCredentialStoreFile,
  createOAuthTokenManager,
  rewriteOAuthError,
  type OAuthTokenManager,
} from "@comis/agent";
import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";
import { makeMockLogger, type MockLogger } from "../support/mock-logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "openai-codex";
const TEST_PROFILE_ID = "openai-codex:user_a@example.com";
const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Fixture lifecycle (mirrors oauth-persistence.test.ts:65-101)
// ---------------------------------------------------------------------------

let mockServer: MockOAuthServer;
let mockBaseUrl: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  mockServer = createMockOAuthServer();
  const { baseUrl } = await mockServer.start();
  mockBaseUrl = baseUrl;
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  if (mockServer) await mockServer.stop();
  if (originalFetch) globalThis.fetch = originalFetch;
});

beforeEach(() => {
  // Redirect pi-ai's fetch to https://auth.openai.com/oauth/token → mock.
  // Other fetches pass through unchanged.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://auth.openai.com/oauth/token")) {
        return originalFetch(`${mockBaseUrl}/oauth/token`, init);
      }
      return originalFetch(input as RequestInfo, init);
    },
  );
  mockServer.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a realistic-shape JWT with payload overrides. Default email is
 * user_a@example.com so the manager's identity-derivation produces the
 * canonical TEST_PROFILE_ID.
 */
function makeFixtureJwt(payloadOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const defaultPayload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/profile": { email: "user_a@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
    ...payloadOverrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(defaultPayload)).toString(
    "base64url",
  );
  return `${header}.${payloadB64}.fake-signature`;
}

/** Build an EXPIRED OAuthProfile fixture so getApiKey triggers a refresh. */
function makeExpiredProfile(refreshTokenSentinel: string): OAuthProfile {
  return {
    provider: PROVIDER_ID,
    profileId: TEST_PROFILE_ID,
    access: makeFixtureJwt(),
    refresh: refreshTokenSentinel,
    expires: Date.now() - 60_000, // already expired
    accountId: "acct_test_001",
    email: "user_a@example.com",
    version: SCHEMA_VERSION,
  };
}

interface BuiltManager {
  manager: OAuthTokenManager;
  bus: TypedEventBus;
  logger: MockLogger;
  events: Array<{
    provider: string;
    profileId: string;
    errorKind: string;
    hint: string;
    timestamp: number;
  }>;
  tmpDir: string;
}

/**
 * Build a real OAuthTokenManager wired against a fresh tmp-dir-backed file
 * store, with a pre-seeded EXPIRED profile + an event-bus listener pre-
 * attached to capture auth:refresh_failed payloads. Caller MUST clean up
 * via `rmSync(tmpDir, { recursive: true, force: true })`.
 */
async function buildManagerWithSeededExpiredProfile(
  refreshSeed = "rt_initial_seed",
): Promise<BuiltManager> {
  const tmpDir = mkdtempSync(`${os.tmpdir()}/comis-10-06-rt-reused-`);
  const store: OAuthCredentialStorePort = createOAuthCredentialStoreFile({
    dataDir: tmpDir,
  });
  const seedResult = await store.set(
    TEST_PROFILE_ID,
    makeExpiredProfile(refreshSeed),
  );
  if (!seedResult.ok) {
    throw new Error(`seed failed: ${seedResult.error.message}`);
  }
  const bus = new TypedEventBus();
  const events: BuiltManager["events"] = [];
  bus.on("auth:refresh_failed", (e) => events.push(e));
  const logger = makeMockLogger();
  const manager = createOAuthTokenManager({
    secretManager: createSecretManager({}),
    eventBus: bus,
    credentialStore: store,
    logger,
    dataDir: tmpDir,
    keyPrefix: "OAUTH_",
  });
  return { manager, bus, logger, events, tmpDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SC-10-3 + SC-10-4 — refresh-failure error classification", () => {
  it("Test 1: classifies refresh_token_reused → emits auth:refresh_failed with errorKind, returns OAuthError with hint (SC-10-4 full chain)", async () => {
    mockServer.setNextResponse({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "refresh_token_reused",
      },
    });
    const { manager, logger, events, tmpDir } =
      await buildManagerWithSeededExpiredProfile();

    try {
      const result = await manager.getApiKey(PROVIDER_ID);

      // (a) Event-bus payload carries the structured errorKind + hint.
      // Falsifiable shape match — pins the literal { errorKind: "refresh_token_reused" }
      // contract per Plan 10-06 SC-10-4 acceptance.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: PROVIDER_ID,
        profileId: TEST_PROFILE_ID,
        errorKind: "refresh_token_reused",
      });
      expect(events[0]!.hint).toContain("re-login required");

      // (b) WARN log captured with module=oauth-token-manager + the same
      //     errorKind / hint.
      const warnCalls = logger._calls("warn");
      const refreshWarn = warnCalls.find(
        (c) => c.payload?.module === "oauth-token-manager",
      );
      expect(refreshWarn).toBeDefined();
      expect(refreshWarn!.payload.errorKind).toBe("refresh_token_reused");
      expect(refreshWarn!.payload.hint).toContain("re-login required");
      expect(refreshWarn!.payload.profileId).toBe(TEST_PROFILE_ID);

      // (c) Returned OAuthError shape — code + errorKind + profileId + hint
      //     + the SC-10-4 re-login literal in the message.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REFRESH_FAILED");
        expect(result.error.errorKind).toBe("refresh_token_reused");
        expect(result.error.profileId).toBe(TEST_PROFILE_ID);
        expect(result.error.hint).toContain("re-login required");
        expect(result.error.message).toContain(
          "comis auth login --provider openai-codex",
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Test 2: classifies unsupported_country_region_territory (SC-10-3 case 1)", async () => {
    mockServer.setNextResponse({
      status: 400,
      body: { error: "unsupported_country_region_territory" },
    });
    const { manager, logger, events, tmpDir } =
      await buildManagerWithSeededExpiredProfile("rt_region_seed");

    try {
      const result = await manager.getApiKey(PROVIDER_ID);

      // Event payload — SC-10-3 case 1 carries unsupported_region.
      expect(events).toHaveLength(1);
      expect(events[0]!.errorKind).toBe("unsupported_region");
      expect(events[0]!.hint).toContain("HTTPS_PROXY");

      // WARN log fields agree with the event.
      const refreshWarn = logger
        ._calls("warn")
        .find((c) => c.payload?.module === "oauth-token-manager");
      expect(refreshWarn).toBeDefined();
      expect(refreshWarn!.payload.errorKind).toBe("unsupported_region");
      expect(refreshWarn!.payload.hint).toContain("HTTPS_PROXY");

      // Returned OAuthError carries the matching classification + hint.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REFRESH_FAILED");
        expect(result.error.errorKind).toBe("unsupported_region");
        expect(result.error.hint).toContain("HTTPS_PROXY");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Test 3: rewriteOAuthError classifies state mismatch directly (SC-10-3 case 2 — local validation)", async () => {
    // SC-10-3 case 2 ("state mismatch") happens at the LOCAL callback
    // validation in pi-ai's login handler — NOT at OpenAI's HTTP boundary —
    // so the wire path can't reach it. Cover the catalogue invariant by
    // calling the classifier directly on the canonical error message; this
    // is the same input rewriteOAuthError sees from pi-ai's login runner.
    const result = rewriteOAuthError(new Error("state mismatch"));
    expect(result.code).toBe("callback_validation_failed");
    expect(result.errorKind).toBe("callback_validation_failed");
    expect(result.userMessage).toMatch(/Browser callback validation failed/i);
    expect(result.hint).toMatch(/retry/i);

    // Sanity — alternate substring 'missing authorization code' also routes
    // to callback_validation_failed (catalogue line 97 OR pattern).
    const altResult = rewriteOAuthError(new Error("missing authorization code"));
    expect(altResult.code).toBe("callback_validation_failed");
  });

  it("Test 4: classifies generic invalid_grant (SC-10-3 case 3)", async () => {
    mockServer.setNextResponse({
      status: 400,
      body: { error: "invalid_grant", error_description: "some other reason" },
    });
    const { manager, logger, events, tmpDir } =
      await buildManagerWithSeededExpiredProfile("rt_generic_invalid_grant");

    try {
      const result = await manager.getApiKey(PROVIDER_ID);

      // Event payload — SC-10-3 case 3 carries the generic invalid_grant
      // classification (NOT refresh_token_reused — the description
      // 'some other reason' does not match the more-specific substring set).
      expect(events).toHaveLength(1);
      expect(events[0]!.errorKind).toBe("invalid_grant");
      expect(events[0]!.hint).toContain("re-login required");

      // WARN log agrees.
      const refreshWarn = logger
        ._calls("warn")
        .find((c) => c.payload?.module === "oauth-token-manager");
      expect(refreshWarn).toBeDefined();
      expect(refreshWarn!.payload.errorKind).toBe("invalid_grant");

      // Returned OAuthError carries the same classification.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REFRESH_FAILED");
        expect(result.error.errorKind).toBe("invalid_grant");
        expect(result.error.message).toContain(
          "comis auth login --provider openai-codex",
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Test 5: refresh_token_reused beats invalid_grant in priority ordering (RESEARCH §Q3 invariant)", async () => {
    // Both substrings are present in the wire payload: `error: invalid_grant`
    // AND `error_description: refresh_token_reused`. The CRITICAL ORDERING
    // contract (oauth-errors.ts:55-71) tests the more-specific
    // `refresh_token_reused` matcher BEFORE the generic `invalid_grant` —
    // this test pins the resulting classification falsifiably.
    mockServer.setNextResponse({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "refresh_token_reused",
      },
    });
    const { manager, events, tmpDir } =
      await buildManagerWithSeededExpiredProfile("rt_ordering_seed");

    try {
      const result = await manager.getApiKey(PROVIDER_ID);
      // Falsifiable: if the catalogue ordering ever regresses (generic
      // invalid_grant matched first), errorKind would be 'invalid_grant'
      // and this assertion would fail.
      expect(events).toHaveLength(1);
      expect(events[0]!.errorKind).toBe("refresh_token_reused");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.errorKind).toBe("refresh_token_reused");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
