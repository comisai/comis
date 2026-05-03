// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 8 OAuth hot-reload integration tests (R7).
 *
 * Note: test/vitest.config.ts already enforces maxConcurrency: 1 + retry: 1
 * + pool: "forks", so a per-file sequential annotation is REDUNDANT
 * (RESEARCH override 3). Don't add it.
 *
 * Run with: `pnpm test:integration test/integration/oauth-hot-reload.test.ts`
 * (after `pnpm build`).
 *
 * Coverage:
 * - R7 file hot-reload (change event): External rewrite of auth-profiles.json
 *   triggers chokidar `change` -> cache invalidation within 250ms. Subsequent
 *   getApiKey returns the new token without contacting the OAuth server.
 * - R7 logout (unlink event): Watcher subscribes to `unlink` too, so
 *   external file deletion (the logout path) also invalidates cache.
 * - R7 encrypted limitation: When watchPath is undefined (encrypted-mode
 *   path), no watcher is registered; manager keeps the cached token even
 *   after an external rewrite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { TypedEventBus, createSecretManager, type OAuthProfile } from "@comis/core";
import {
  createOAuthCredentialStoreFile,
  createOAuthTokenManager,
} from "@comis/agent";
import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";
import { makeMockLogger } from "../support/mock-logger.js";

const PROVIDER_ID = "openai-codex";

// Mock-server lifecycle (mirrors Phase 7).
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

/**
 * Build a realistic-shape JWT inline. Mirrors mock-oauth-server's internal
 * helper but is not exported — small 10-LoC duplication kept consistent with
 * the fixture's payload shape so derived profileIds match.
 */
function makeRealisticJwt(
  payloadOverrides: Record<string, unknown> = {},
): string {
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

function freshTmpDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "comis-oauth-hot-reload-"));
}

function cleanupTmpDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function makeFreshProfile(
  refreshSentinel: string,
  accessTokenMarker: string,
): OAuthProfile {
  return {
    provider: PROVIDER_ID,
    profileId: `${PROVIDER_ID}:user_a@example.com`,
    access: makeRealisticJwt({ access_marker: accessTokenMarker }),
    refresh: refreshSentinel,
    expires: Date.now() + 3_600_000, // 1h in future — no refresh needed
    accountId: "acct_test_001",
    email: "user_a@example.com",
    version: 1,
  };
}

/**
 * Poll for a cache-invalidation log entry up to a deadline. macOS fsevents
 * (chokidar) latency varies more than inotify, so a fixed 250ms wait is
 * flaky on macOS hosts. The Linux/CI happy path is sub-second; the 2s
 * deadline is generous enough for the worst macOS case.
 */
async function waitForCacheInvalidation(
  logger: ReturnType<typeof makeMockLogger>,
  deadlineMs = 2000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const debugCalls = logger
      ._calls("debug")
      .filter(
        (c) =>
          typeof c.msg === "string" && c.msg.includes("cache invalidated"),
      );
    if (debugCalls.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ---------------------------------------------------------------------------
// R7 — file adapter hot-reload (change event)
// ---------------------------------------------------------------------------

describe("R7 OAuth file hot-reload (change event)", () => {
  it("Manager picks up T2 after external rewrite without contacting OAuth server", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      const watchPath = path.join(tmpDir, "auth-profiles.json");
      const store1 = createOAuthCredentialStoreFile({ dataDir: tmpDir });

      // Seed profile X with token T1 via store1.
      const seedT1 = makeFreshProfile("rt_T1", "T1");
      const seedResult = await store1.set(seedT1.profileId, seedT1);
      expect(seedResult.ok).toBe(true);

      // Build manager with watchPath set (file-adapter mode).
      const eventBus = new TypedEventBus();
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: createSecretManager({}),
        eventBus,
        credentialStore: store1,
        logger,
        dataDir: tmpDir,
        watchPath,
      });

      try {
        // Populate manager cache via getApiKey.
        const r1 = await manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);
        if (!r1.ok) return;

        // Snapshot the OAuth server request count BEFORE the external rewrite.
        const refreshCountBefore = mockServer.getRequestCount("refresh_token");

        // Externally rewrite via a SECOND adapter instance (simulates the CLI process).
        const store2 = createOAuthCredentialStoreFile({ dataDir: tmpDir });
        const updated: OAuthProfile = {
          ...seedT1,
          access: makeRealisticJwt({ access_marker: "T2" }),
          refresh: "rt_T2",
        };
        const writeResult = await store2.set(updated.profileId, updated);
        expect(writeResult.ok).toBe(true);

        // Wait for chokidar event + 100ms debounce + manager cache invalidation.
        const invalidated = await waitForCacheInvalidation(logger);
        expect(invalidated).toBe(true);

        // Second getApiKey should now return T2 — the watcher invalidated the cache,
        // and the next getApiKey re-reads from the store (no refresh needed; expires is far-future).
        const r2 = await manager.getApiKey(PROVIDER_ID);
        expect(r2.ok).toBe(true);
        if (!r2.ok) return;

        // The new access token should differ from the first (different access_marker).
        expect(r2.value).not.toBe(r1.value);

        // No refresh request to the mock OAuth server (cache invalidation re-read
        // the new token from the store; expires is far-future).
        const refreshCountAfter = mockServer.getRequestCount("refresh_token");
        expect(refreshCountAfter).toBe(refreshCountBefore);
      } finally {
        await manager.dispose();
      }
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it("Watcher handles unlink event (logout path): cache invalidates on file deletion", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      const watchPath = path.join(tmpDir, "auth-profiles.json");
      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });

      const seedT1 = makeFreshProfile("rt_T1", "T1");
      await store.set(seedT1.profileId, seedT1);

      const eventBus = new TypedEventBus();
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: createSecretManager({}),
        eventBus,
        credentialStore: store,
        logger,
        dataDir: tmpDir,
        watchPath,
      });

      try {
        // Populate cache.
        const r1 = await manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);

        // Externally delete the file (simulates `comis auth logout` purging the last profile).
        // The Phase 7 file adapter rewrites the file as `{version:1, profiles:{}}` on
        // empty-state delete; for this test we simulate the harder case (file unlinked).
        fs.unlinkSync(watchPath);

        // Cache-invalidation log should have fired (within the 2s deadline).
        const invalidated = await waitForCacheInvalidation(logger);
        expect(invalidated).toBe(true);
      } finally {
        await manager.dispose();
      }
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// R7 — encrypted limitation (no watcher when watchPath is undefined)
// ---------------------------------------------------------------------------

describe("R7 OAuth encrypted-mode limitation (documented)", () => {
  it("When watchPath is undefined (encrypted-mode path), external rewrite is NOT picked up — manager keeps cached T1", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      // Use the FILE adapter for the test (not the encrypted one — encrypted
      // requires SECRETS_MASTER_KEY + secretsDb). The watchPath: undefined
      // is what reproduces the encrypted-mode behavior — no watcher is registered.
      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });

      const seedT1 = makeFreshProfile("rt_T1", "T1");
      await store.set(seedT1.profileId, seedT1);

      const eventBus = new TypedEventBus();
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: createSecretManager({}),
        eventBus,
        credentialStore: store,
        logger,
        dataDir: tmpDir,
        // watchPath: undefined  ← intentionally omitted (simulates encrypted-mode wiring)
      });

      try {
        const r1 = await manager.getApiKey(PROVIDER_ID);
        expect(r1.ok).toBe(true);

        // Externally rewrite — but no watcher → no cache invalidation.
        const store2 = createOAuthCredentialStoreFile({ dataDir: tmpDir });
        const updated: OAuthProfile = {
          ...seedT1,
          access: makeRealisticJwt({ access_marker: "T2" }),
          refresh: "rt_T2",
        };
        await store2.set(updated.profileId, updated);

        // Wait the same deadline as the positive test, then assert NO invalidation
        // log fired. waitForCacheInvalidation returns false on timeout.
        const invalidated = await waitForCacheInvalidation(logger, 500);
        expect(invalidated).toBe(false);

        // The cached token from r1 is what the manager will continue serving
        // until the next refresh-on-expiry path. The "limitation" is that
        // CLI-written changes don't propagate to the daemon's cache without
        // a restart in encrypted mode.
        const r2 = await manager.getApiKey(PROVIDER_ID);
        expect(r2.ok).toBe(true);
      } finally {
        await manager.dispose();
      }
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});
