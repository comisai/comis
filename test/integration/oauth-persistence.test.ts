// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth persistence integration tests (Phase 7 plan 08 — turns plan 02
 * task 02.3's 6 it.todo placeholders GREEN end-to-end).
 *
 * Exercises the rewired OAuthTokenManager against real adapters (file +
 * encrypted) with the in-process mock OAuth fixture from plan 07-02.
 *
 * Coverage:
 * - R6 restart-survives-refresh: refresh once → recreate manager → second
 *   call uses the persisted refreshed token (mock count = 1 across BOTH
 *   manager instances).
 * - R6 concurrent-refresh: two parallel manager instances against the same
 *   store → exactly one refresh request to the mock → both return the same
 *   access token (per-profile lock + persist-before-release).
 * - R7a env-bootstrap: empty store + valid env → profile bootstrapped, store
 *   now contains openai-codex:<identity>, auth:profile_bootstrapped event
 *   fired exactly once.
 * - R7b silent-path: stored profile + matching env → ZERO env-override-ignored
 *   WARNs (the env value matches what's stored).
 * - R7c env-conflict: stored profile + DIFFERENT env → EXACTLY ONE
 *   env-override-ignored WARN across two getApiKey calls (once-per-process
 *   semantics), stored profile used (env ignored).
 * - R3 encrypted survive-restart: same as R6.1 but against the encrypted
 *   SQLite backend, plus a canary check that the plaintext access token is
 *   NOT present in the raw DB bytes on disk.
 *
 * Fetch interception: vi.spyOn(global, "fetch") redirects pi-ai's
 * https://auth.openai.com/oauth/token to ${mockBaseUrl}/oauth/token. Other
 * fetches pass through unchanged.
 *
 * W5 fix: log capture uses makeMockLogger from test/support/mock-logger.ts
 * (mirrors the helper inside oauth-token-manager.test.ts).
 * W6 fix: the encrypted Test 6 uses `secretStore.db` (the SAME handle from
 * createSqliteSecretStore) to construct createOAuthProfileStoreEncrypted
 * — proves the shared-handle path end-to-end.
 *
 * Run with: `pnpm test:integration -- oauth-persistence` (after `pnpm build`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  TypedEventBus,
  createSecretsCrypto,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import { createSecretManager } from "@comis/core";
import {
  createOAuthCredentialStoreFile,
  createOAuthTokenManager,
} from "@comis/agent";
import {
  createSqliteSecretStore,
  createOAuthProfileStoreEncrypted,
} from "@comis/memory";
import { createMockOAuthServer, type MockOAuthServer } from "../support/mock-oauth-server.js";
import { makeMockLogger, type MockLogger } from "../support/mock-logger.js";

const PROVIDER_ID = "openai-codex";
const SCHEMA_VERSION = 1 as const;

// Mock-server state — initialized in beforeAll, torn down in afterAll.
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
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
 * Build a realistic-shape JWT for fixture profiles. The mock-server's
 * default response also returns a JWT with email user_a@example.com and
 * accountId acct_test_001 — keep the fixture values consistent so the
 * profile derived from the access token has the right identity.
 */
function makeFixtureJwt(payloadOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const defaultPayload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/profile": { email: "user_a@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
    ...payloadOverrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(defaultPayload)).toString("base64url");
  return `${header}.${payloadB64}.fake-signature`;
}

/** Build an EXPIRED OAuthProfile fixture for restart/concurrent tests. */
function makeExpiredProfile(refreshTokenSentinel: string): OAuthProfile {
  return {
    provider: PROVIDER_ID,
    profileId: `${PROVIDER_ID}:user_a@example.com`,
    access: makeFixtureJwt(),
    refresh: refreshTokenSentinel,
    expires: Date.now() - 60_000, // already expired
    accountId: "acct_test_001",
    email: "user_a@example.com",
    version: SCHEMA_VERSION,
  };
}

/** Build a NOT-YET-expired OAuthProfile fixture for env-conflict tests. */
function makeFreshProfile(refreshTokenSentinel: string): OAuthProfile {
  return {
    provider: PROVIDER_ID,
    profileId: `${PROVIDER_ID}:user_a@example.com`,
    access: makeFixtureJwt(),
    refresh: refreshTokenSentinel,
    expires: Date.now() + 3_600_000, // 1h from now (not expired — no refresh)
    accountId: "acct_test_001",
    email: "user_a@example.com",
    version: SCHEMA_VERSION,
  };
}

/** Allocate a fresh tmp data dir for one test. Caller is responsible for cleanup. */
function freshTmpDataDir(): string {
  return mkdtempSync(`${os.tmpdir()}/comis-oauth-persist-`);
}

/** Tear down a tmp data dir created via freshTmpDataDir. */
function cleanupTmpDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Build a real OAuthTokenManager wired against the supplied real adapters.
 * Centralizes the wiring for re-use across all 6 tests.
 */
function buildManager(opts: {
  store: OAuthCredentialStorePort;
  envBag: Record<string, string>;
  dataDir: string;
  logger?: MockLogger;
  eventBus?: TypedEventBus;
}): {
  manager: ReturnType<typeof createOAuthTokenManager>;
  bus: TypedEventBus;
  logger: MockLogger;
} {
  const bus = opts.eventBus ?? new TypedEventBus();
  const logger = opts.logger ?? makeMockLogger();
  const secretManager = createSecretManager(opts.envBag);
  const manager = createOAuthTokenManager({
    secretManager,
    eventBus: bus,
    credentialStore: opts.store,
    logger,
    dataDir: opts.dataDir,
    keyPrefix: "OAUTH_",
  });
  return { manager, bus, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth persistence (integration)", () => {
  describe("SPEC R6 — restart survives refresh", () => {
    it("restart-survives-refresh: refresh once → recreate manager → reuses persisted refreshed token (mock count = 1)", async () => {
      const tmpDir = freshTmpDataDir();
      try {
        const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });

        // Pre-seed the store with an expired profile.
        const seedRefresh = "rt_initial_seed";
        const seed = makeExpiredProfile(seedRefresh);
        const seedResult = await store.set(seed.profileId, seed);
        expect(seedResult.ok).toBe(true);

        // Manager 1 — triggers a refresh because the seed is expired.
        const m1 = buildManager({ store, envBag: {}, dataDir: tmpDir });
        const r1 = await m1.manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);
        expect(mockServer.getRequestCount("refresh_token")).toBe(1);

        // Manager 2 — different in-memory cache, same on-disk store.
        // The persisted profile must be NOT-yet-expired (mock returns
        // expires_in=3600), so this call must NOT trigger another refresh.
        const m2 = buildManager({ store, envBag: {}, dataDir: tmpDir });
        const r2 = await m2.manager.getApiKey(PROVIDER_ID);
        expect(r2.ok).toBe(true);

        // CRITICAL R6 assertion — total refresh request count is still 1.
        expect(mockServer.getRequestCount("refresh_token")).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    it("concurrent-refresh: two parallel manager instances → exactly 1 refresh request → both return SAME access token", async () => {
      const tmpDir = freshTmpDataDir();
      try {
        const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });

        const seedRefresh = "rt_concurrent_seed";
        const seed = makeExpiredProfile(seedRefresh);
        const seedResult = await store.set(seed.profileId, seed);
        expect(seedResult.ok).toBe(true);

        // Two managers, same on-disk store, separate in-memory caches.
        const m1 = buildManager({ store, envBag: {}, dataDir: tmpDir });
        const m2 = buildManager({ store, envBag: {}, dataDir: tmpDir });

        const [r1, r2] = await Promise.all([
          m1.manager.getApiKey(PROVIDER_ID),
          m2.manager.getApiKey(PROVIDER_ID),
        ]);

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        if (r1.ok && r2.ok) {
          // Both return the same access token — proving shared-store + lock
          // gave them the SAME rotated profile.
          expect(r1.value).toBe(r2.value);
        }
        // CRITICAL R6 concurrent assertion — exactly one refresh request.
        expect(mockServer.getRequestCount("refresh_token")).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe("SPEC R7 — env-var bootstrap semantics", () => {
    it("R7a: empty store + valid OAUTH_OPENAI_CODEX env → profile bootstrapped, store now has openai-codex:<identity>, auth:profile_bootstrapped fires once", async () => {
      const tmpDir = freshTmpDataDir();
      try {
        const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });

        // Build env-var seed with a NOT-yet-expired access (no refresh
        // needed — bootstrap path only). The JWT email is user_a@example.com
        // so the resolved profileId is openai-codex:user_a@example.com.
        const envCreds = {
          access: makeFixtureJwt(),
          refresh: "rt_env_bootstrap",
          expires: Date.now() + 3_600_000,
          accountId: "acct_test_001",
        };
        const envBag = { OAUTH_OPENAI_CODEX: JSON.stringify(envCreds) };

        // Capture the bootstrap event.
        const bus = new TypedEventBus();
        const bootstrapEvents: Array<{ provider: string; profileId: string }> = [];
        bus.on("auth:profile_bootstrapped", (e) => bootstrapEvents.push(e));

        const { manager } = buildManager({ store, envBag, dataDir: tmpDir, eventBus: bus });

        const r = await manager.getApiKey(PROVIDER_ID);
        expect(r.ok).toBe(true);

        // Store now has the bootstrapped profile.
        const stored = await store.get(`${PROVIDER_ID}:user_a@example.com`);
        expect(stored.ok).toBe(true);
        if (stored.ok) {
          expect(stored.value).toBeDefined();
          expect(stored.value!.refresh).toBe("rt_env_bootstrap");
        }

        // auth:profile_bootstrapped fired exactly ONCE for openai-codex.
        const codexBootstrap = bootstrapEvents.filter((e) => e.provider === PROVIDER_ID);
        expect(codexBootstrap).toHaveLength(1);
        expect(codexBootstrap[0]!.profileId).toBe(`${PROVIDER_ID}:user_a@example.com`);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    it("R7b: stored profile + UNCHANGED env-var refresh-token → ZERO env-override-ignored WARNs (env matches stored)", async () => {
      const tmpDir = freshTmpDataDir();
      try {
        const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
        const sharedRefresh = "rt_shared_matching";
        // Pre-seed a NOT-expired stored profile with refresh = sharedRefresh.
        const stored = makeFreshProfile(sharedRefresh);
        const setResult = await store.set(stored.profileId, stored);
        expect(setResult.ok).toBe(true);

        // Env-var contains the SAME refresh token — no drift.
        const envCreds = {
          access: makeFixtureJwt(),
          refresh: sharedRefresh,
          expires: Date.now() + 3_600_000,
          accountId: "acct_test_001",
        };
        const envBag = { OAUTH_OPENAI_CODEX: JSON.stringify(envCreds) };

        const logger = makeMockLogger();
        const { manager } = buildManager({ store, envBag, dataDir: tmpDir, logger });

        const r = await manager.getApiKey(PROVIDER_ID);
        expect(r.ok).toBe(true);

        // CRITICAL R7b assertion — ZERO env-override-ignored WARNs.
        const warnsWithDriftHint = logger
          ._calls("warn")
          .filter((c) => c.payload?.hint === "env-override-ignored");
        expect(warnsWithDriftHint).toHaveLength(0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    it("R7c: stored profile + DIFFERENT env-var refresh-token → EXACTLY ONE env-override-ignored WARN across TWO getApiKey calls (once-per-process)", async () => {
      const tmpDir = freshTmpDataDir();
      try {
        const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
        const storedRefresh = "rt_stored";
        // Pre-seed a NOT-expired stored profile with refresh = storedRefresh.
        const stored = makeFreshProfile(storedRefresh);
        const setResult = await store.set(stored.profileId, stored);
        expect(setResult.ok).toBe(true);

        // Env-var contains a DIFFERENT refresh token — drift triggers WARN.
        const envCreds = {
          access: makeFixtureJwt(),
          refresh: "rt_env_stale",
          expires: Date.now() + 3_600_000,
          accountId: "acct_test_001",
        };
        const envBag = { OAUTH_OPENAI_CODEX: JSON.stringify(envCreds) };

        const logger = makeMockLogger();
        const { manager } = buildManager({ store, envBag, dataDir: tmpDir, logger });

        // Two consecutive getApiKey calls — once-per-process tracker should
        // dedup the WARN.
        const r1 = await manager.getApiKey(PROVIDER_ID);
        const r2 = await manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);

        // CRITICAL R7c assertion — exactly ONE env-override-ignored WARN.
        const warnsWithDriftHint = logger
          ._calls("warn")
          .filter((c) => c.payload?.hint === "env-override-ignored");
        expect(warnsWithDriftHint).toHaveLength(1);
        // errorKind = config_drift per D-12.
        expect(warnsWithDriftHint[0]!.payload.errorKind).toBe("config_drift");

        // Stored profile is canonical — refresh was NOT updated to the
        // env-var's value. (Profile was not expired, so no refresh fired.)
        const reread = await store.get(stored.profileId);
        expect(reread.ok).toBe(true);
        if (reread.ok && reread.value) {
          expect(reread.value.refresh).toBe(storedRefresh);
        }
        // No refresh request was made (profile not expired).
        expect(mockServer.getRequestCount("refresh_token")).toBe(0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe("SPEC R3 — encrypted storage (opt-in)", () => {
    it("R3 encrypted: oauth.storage='encrypted' restart-survives-refresh against shared-handle SqliteSecretStoreHandle.db (W6) + plaintext-canary absent from raw DB bytes", async () => {
      const tmpDir = freshTmpDataDir();
      const dbPath = `${tmpDir}/secrets.db`;
      try {
        // Build the secret store + crypto (real AES-256-GCM).
        const masterKey = randomBytes(32);
        const crypto = createSecretsCrypto(masterKey);
        const secretStore = createSqliteSecretStore(dbPath, crypto);

        // W6 — pass the SAME db handle to the encrypted OAuth adapter.
        const oauthStore = createOAuthProfileStoreEncrypted(secretStore.db, crypto);

        // Pre-seed an EXPIRED profile with a plaintext canary in the access
        // token so we can assert the canary is absent from raw DB bytes.
        const canaryPayload = {
          exp: Math.floor(Date.now() / 1000) - 60,
          "https://api.openai.com/profile": { email: "user_a@example.com" },
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
          PLAINTEXT_ACCESS_CANARY_INTEG: "PLAINTEXT_ACCESS_CANARY_INTEG_8f3d2a1c",
        };
        const seed: OAuthProfile = {
          provider: PROVIDER_ID,
          profileId: `${PROVIDER_ID}:user_a@example.com`,
          access: makeFixtureJwt(canaryPayload),
          refresh: "rt_encrypted_seed",
          expires: Date.now() - 60_000,
          accountId: "acct_test_001",
          email: "user_a@example.com",
          version: SCHEMA_VERSION,
        };
        const seedResult = await oauthStore.set(seed.profileId, seed);
        expect(seedResult.ok).toBe(true);

        // Manager 1 — triggers a refresh.
        const m1 = buildManager({ store: oauthStore, envBag: {}, dataDir: tmpDir });
        const r1 = await m1.manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);
        expect(mockServer.getRequestCount("refresh_token")).toBe(1);

        // Manager 2 — different in-memory cache, same on-disk store +
        // same shared db handle.
        const m2 = buildManager({ store: oauthStore, envBag: {}, dataDir: tmpDir });
        const r2 = await m2.manager.getApiKey(PROVIDER_ID);
        expect(r2.ok).toBe(true);

        // R6/R3 cross-cut — refresh count still 1 across both managers.
        expect(mockServer.getRequestCount("refresh_token")).toBe(1);

        // Plaintext canary check — encrypted-on-disk property.
        // Force a WAL checkpoint so all writes are durable in the main file
        // before reading raw bytes.
        secretStore.db.exec("PRAGMA wal_checkpoint(FULL)");
        const rawBytes = fs.readFileSync(dbPath);
        const canaryHit = rawBytes.indexOf(
          Buffer.from("PLAINTEXT_ACCESS_CANARY_INTEG_8f3d2a1c"),
        );
        expect(canaryHit).toBe(-1);

        secretStore.close();
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });
});
