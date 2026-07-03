// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { SecretManager } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { ok as _ok, err as _err } from "@comis/shared";
import type { OAuthCredentialStorePort, OAuthProfile } from "@comis/core";
import { createOAuthTokenManager, type OAuthTokenManager, type OAuthError } from "./oauth-token-manager.js";

// ---------------------------------------------------------------------------
// Mock pi-ai OAuth module
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-ai/oauth", () => ({
  getOAuthProvider: vi.fn(),
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn(),
}));

import {
  getOAuthProvider,
  getOAuthApiKey,
  getOAuthProviders,
} from "@earendil-works/pi-ai/oauth";
import type { FileLockPort } from "@comis/core";

// The production OAuthTokenManager does not import `@comis/scheduler`'s
// `createFileLock` directly — it consumes a `FileLockPort` from
// `OAuthTokenManagerDeps.fileLock`. The shared `mockWithLock` spy is exposed
// via the deps `fileLock` field constructed inside `legacyOAuthDeps()` and
// `makeFileLockStub()`.
//
// `mockWithLock` invokes the supplied callback inline, so refresh-path tests
// observe deterministic control flow: the fn runs in the same tick, and the
// result Result-wraps the value.
const mockWithLock = vi.fn(
  async (_path: string, fn: () => Promise<unknown>, _opts?: unknown) => ({
    ok: true as const,
    value: await fn(),
  }),
);

/** Mock FileLockPort — `withLock` invokes the fn inline; other methods are stubs. */
function makeFileLockStub(): FileLockPort {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    // Cast through unknown to satisfy the generic Result<T, LockError> shape
    // without dragging in a separate per-test helper file.
    withLock: mockWithLock as unknown as FileLockPort["withLock"],
    isLocked: vi.fn(),
    cleanupStaleLocks: vi.fn(),
  };
}

const mockGetOAuthProvider = vi.mocked(getOAuthProvider);
const mockGetOAuthApiKey = vi.mocked(getOAuthApiKey);
const mockGetOAuthProviders = vi.mocked(getOAuthProviders);

// ---------------------------------------------------------------------------
// Shared helpers (used by both the original 13-test block and the port-backed
// manager block)
// ---------------------------------------------------------------------------

function makeSecretManager(secrets: Record<string, string>): SecretManager {
  return {
    get: vi.fn((key: string) => secrets[key]),
    has: vi.fn((key: string) => key in secrets),
    require: vi.fn((key: string) => {
      if (key in secrets) return secrets[key]!;
      throw new Error(`Secret not found: ${key}`);
    }),
    keys: vi.fn(() => Object.keys(secrets)),
  };
}

function makeFakeProvider(id: string) {
  return {
    id,
    name: `Provider ${id}`,
    login: vi.fn(),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  };
}

/** Mock OAuthCredentialStorePort backed by vi.fn() — defaults to empty store. */
function makeMockCredentialStore(): OAuthCredentialStorePort {
  return {
    get: vi.fn(async (_id: string) => _ok(undefined)),
    set: vi.fn(async (_id: string, _profile: OAuthProfile) => _ok(undefined)),
    delete: vi.fn(async (_id: string) => _ok(false)),
    list: vi.fn(async (_filter?: { provider?: string }) => _ok([] as OAuthProfile[])),
    has: vi.fn(async (_id: string) => _ok(false)),
  };
}

/** Mock logger that captures all calls for assertion. */
function makeMockLogger() {
  const calls: Array<{ level: string; payload: object; msg: string }> = [];
  return {
    debug: vi.fn((p: object, m: string) => calls.push({ level: "debug", payload: p, msg: m })),
    info: vi.fn((p: object, m: string) => calls.push({ level: "info", payload: p, msg: m })),
    warn: vi.fn((p: object, m: string) => calls.push({ level: "warn", payload: p, msg: m })),
    error: vi.fn((p: object, m: string) => calls.push({ level: "error", payload: p, msg: m })),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
    _calls: () => calls,
  };
}

/**
 * Build the required-deps stub (credentialStore + logger + dataDir +
 * fileLock) for the env-bootstrap test block. The factory keeps these fields
 * REQUIRED, but those tests only exercise the env-bootstrap path, so
 * default-empty mocks satisfy the signature without affecting behavior.
 */
function legacyOAuthDeps(): {
  credentialStore: OAuthCredentialStorePort;
  logger: ReturnType<typeof makeMockLogger>;
  dataDir: string;
  fileLock: FileLockPort;
} {
  return {
    credentialStore: makeMockCredentialStore(),
    logger: makeMockLogger(),
    dataDir: "/tmp/comis-test-legacy",
    fileLock: makeFileLockStub(),
  };
}

const FAKE_CREDS = {
  refresh: "refresh-token-abc",
  access: "access-token-xyz",
  // pi-ai's OAuthCredentials.expires is milliseconds since epoch (JWT exp is
  // seconds, but pi-ai multiplies by 1000 before returning). Aligned to ms here.
  expires: Date.now() + 3600_000, // 1 hour from now (ms)
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CODEX_PROFILE: OAuthProfile = {
  provider: "openai-codex",
  profileId: "openai-codex:default",
  access: "access-token-xyz",
  refresh: "refresh-token-abc",
  expires: Date.now() + 3600_000,
  version: 1,
};

describe("hasStoredCredentials (store-aware availability — the cold-cache image-gen fix)", () => {
  let eventBus: TypedEventBus;
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
  });

  it("is TRUE when the persisted store has a profile even though the in-memory cache is cold (where the sync hasCredentials is FALSE)", async () => {
    // The exact production shape: encrypted-store mode, Codex logged in via
    // `comis auth login` (profile in the store), no env key, cache cold at boot.
    const secretManager = makeSecretManager({}); // no OAUTH_OPENAI_CODEX env key
    const credentialStore = makeMockCredentialStore();
    (credentialStore.list as ReturnType<typeof vi.fn>).mockImplementation(
      async (filter?: { provider?: string }) =>
        _ok(filter?.provider === "openai-codex" ? [CODEX_PROFILE] : []),
    );
    const manager = createOAuthTokenManager({
      secretManager,
      eventBus,
      ...legacyOAuthDeps(),
      credentialStore,
    });

    // The bug: the sync cache-only check misses the store-backed login.
    expect(manager.hasCredentials("openai-codex")).toBe(false);
    // The fix: the store-aware check finds it (cache cold, no env key, store hit).
    expect(await manager.hasStoredCredentials("openai-codex")).toBe(true);
  });

  it("is FALSE when neither cache, env-var, nor store has the provider", async () => {
    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus,
      ...legacyOAuthDeps(),
    });
    expect(await manager.hasStoredCredentials("openai-codex")).toBe(false);
  });

  it("is TRUE from the env-var (SecretManager) with no store hit (bootstrap parity)", async () => {
    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({ OAUTH_OPENAI_CODEX: JSON.stringify(FAKE_CREDS) }),
      eventBus,
      ...legacyOAuthDeps(),
    });
    expect(await manager.hasStoredCredentials("openai-codex")).toBe(true);
  });
});

describe("createOAuthTokenManager", () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
  });

  it("getApiKey returns err NO_CREDENTIALS when no credentials stored", async () => {
    const secretManager = makeSecretManager({});
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });

    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_CREDENTIALS");
      expect(result.error.providerId).toBe("github-copilot");
    }
  });

  it("getApiKey returns err NO_PROVIDER when pi-ai does not recognize provider", async () => {
    const secretManager = makeSecretManager({
      OAUTH_UNKNOWN_PROVIDER: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(undefined);

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });

    const result = await manager.getApiKey("unknown-provider");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_PROVIDER");
      expect(result.error.providerId).toBe("unknown-provider");
    }
  });

  it("getApiKey returns ok(apiKey) when credentials are valid and no refresh needed", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_test-api-key-123",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ghu_test-api-key-123");
    }

    // Verify getOAuthApiKey was called with the right shape
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith(
      "github-copilot",
      { "github-copilot": FAKE_CREDS },
    );
  });

  it("getApiKey stores refreshed credentials and emits auth:token_rotated", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    // pi-ai's OAuthCredentials.expires is ms-since-epoch. Aligned to ms here.
    const newCreds = {
      refresh: "new-refresh-token",
      access: "new-access-token",
      expires: Date.now() + 7200_000, // 2 hours from now (ms)
    };
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: newCreds,
      apiKey: "ghu_refreshed-key-456",
    });

    const events: unknown[] = [];
    eventBus.on("auth:token_rotated", (payload) => events.push(payload));

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ghu_refreshed-key-456");
    }

    // Should have emitted auth:token_rotated
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.provider).toBe("github-copilot");
    expect(event.expiresAtMs).toBe(newCreds.expires);
    expect(typeof event.timestamp).toBe("number");

    // Subsequent getApiKey should use the cached refreshed credentials
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: newCreds,
      apiKey: "ghu_refreshed-key-456",
    });
    const result2 = await manager.getApiKey("github-copilot");
    expect(result2.ok).toBe(true);

    // The second call should use cached (updated) credentials
    expect(mockGetOAuthApiKey).toHaveBeenLastCalledWith(
      "github-copilot",
      { "github-copilot": newCreds },
    );
  });

  it("getApiKey returns err REFRESH_FAILED when getOAuthApiKey throws", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockRejectedValue(new Error("Token refresh failed: invalid grant"));

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REFRESH_FAILED");
      expect(result.error.providerId).toBe("github-copilot");
      expect(result.error.message).toContain("Token refresh failed");
    }
  });

  it("getApiKey returns err NO_CREDENTIALS when getOAuthApiKey returns null", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue(null);

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_CREDENTIALS");
      expect(result.error.providerId).toBe("github-copilot");
    }
  });

  it("hasCredentials returns true when SecretManager has stored creds", () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    expect(manager.hasCredentials("github-copilot")).toBe(true);
  });

  it("hasCredentials returns false when no credentials stored", () => {
    const secretManager = makeSecretManager({});

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    expect(manager.hasCredentials("github-copilot")).toBe(false);
  });

  it("storeCredentials stores credentials accessible by getApiKey", async () => {
    const secretManager = makeSecretManager({});
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_stored-key-789",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });

    // Initially no credentials
    expect(manager.hasCredentials("github-copilot")).toBe(false);

    // Store credentials
    manager.storeCredentials("github-copilot", FAKE_CREDS);

    // Now has credentials
    expect(manager.hasCredentials("github-copilot")).toBe(true);

    // getApiKey should work using stored credentials
    const result = await manager.getApiKey("github-copilot");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ghu_stored-key-789");
    }

    // Verify getOAuthApiKey was called with the stored credentials
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith(
      "github-copilot",
      { "github-copilot": FAKE_CREDS },
    );
  });

  it("getSupportedProviders returns provider IDs from pi-ai", () => {
    mockGetOAuthProviders.mockReturnValue([
      makeFakeProvider("anthropic"),
      makeFakeProvider("github-copilot"),
      makeFakeProvider("google-gemini-cli"),
      makeFakeProvider("google-antigravity"),
      makeFakeProvider("openai-codex"),
    ] as unknown as ReturnType<typeof getOAuthProviders>);

    const secretManager = makeSecretManager({});
    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    const providers = manager.getSupportedProviders();

    expect(providers).toEqual([
      "anthropic",
      "github-copilot",
      "google-gemini-cli",
      "google-antigravity",
      "openai-codex",
    ]);
  });

  it("maps provider id to uppercase SecretManager key with OAUTH_ prefix", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_key",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });
    await manager.getApiKey("github-copilot");

    // Verify SecretManager was queried with the correct key
    expect(secretManager.get).toHaveBeenCalledWith("OAUTH_GITHUB_COPILOT");
  });

  // Additional: custom key prefix
  it("supports custom key prefix for SecretManager keys", async () => {
    const secretManager = makeSecretManager({
      MYAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_custom-prefix-key",
    });

    const manager = createOAuthTokenManager({
      secretManager,
      eventBus,
      ...legacyOAuthDeps(),
      keyPrefix: "MYAUTH_",
    });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(true);
    expect(secretManager.get).toHaveBeenCalledWith("MYAUTH_GITHUB_COPILOT");
  });

  // Additional: hasCredentials returns true after storeCredentials
  it("hasCredentials returns true after storeCredentials even without SecretManager entry", () => {
    const secretManager = makeSecretManager({});
    const manager = createOAuthTokenManager({ secretManager, eventBus, ...legacyOAuthDeps() });

    manager.storeCredentials("anthropic", FAKE_CREDS);
    expect(manager.hasCredentials("anthropic")).toBe(true);
  });
});

// =============================================================================
// Port-backed manager block
//
// Helpers (makeMockCredentialStore, makeMockLogger, createFileLock/withLock
// module-mock) are defined ONCE at the top of this file so both the original
// 13-test block and this port-backed block can share them. legacyOAuthDeps()
// supplies the required deps fields that the original 13 tests do not
// construct themselves.
// =============================================================================

/** Realistic Codex-shape JWT with the supplied payload. */
function encodeJwtForTest(payload: Record<string, unknown>): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${headerB64}.${payloadB64}.fake-signature`;
}

const CODEX_PROFILE_ID = "openai-codex:user_a@example.com";
const FORBIDDEN_ACCESS = "FORBIDDEN_LOG_ACCESS_TOKEN_x9y8z7";
const FORBIDDEN_REFRESH = "FORBIDDEN_LOG_REFRESH_TOKEN_p4q3r2";

/**
 * Module-level slot the bypass fetch shim reads when synthesizing a Response.
 * Hoisted ahead of `makeStoredProfile` / `buildProfile` so they can prime it
 * without TDZ. Cleared by the shim's `restore()`.
 */
// eslint-disable-next-line prefer-const -- assigned across many test setups
let codexBypassActiveProfile: OAuthProfile | undefined;

function makeStoredProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  // Default to an EXPIRED profile so tests that mock the refresh wire path
  // observe that path. Tests that need a still-valid profile (no-refresh
  // skip) override `expires` with a future value explicitly. Previously the
  // codex bypass always re-hit the wire, so a future-expires worked for
  // both shapes; with the buffered-skip in place, the fixture must default
  // to expired to keep the mocked refresh path reachable.
  const profile: OAuthProfile = {
    provider: "openai-codex",
    profileId: CODEX_PROFILE_ID,
    access: encodeJwtForTest({
      "https://api.openai.com/profile": { email: "user_a@example.com" },
      exp: Math.floor(Date.now() / 1000) - 60,
    }),
    refresh: "stored-refresh-token-abc",
    expires: Date.now() - 60_000,
    email: "user_a@example.com",
    version: 1,
    ...overrides,
  };
  // Prime the bypass-fetch shim with the seeded profile so the synthesized
  // auth.openai.com Response uses the right access token.
  codexBypassActiveProfile = profile;
  return profile;
}

/**
 * When the test mocks `mockGetOAuthApiKey` for the Codex provider, the bypass
 * (`refreshOpenAICodexTokenLocal`) replaces the pi-ai call path with a direct
 * `fetch("https://auth.openai.com/oauth/token", ...)`. To keep the broad
 * pre-existing test corpus (~30 openai-codex tests) working without touching
 * every `mockGetOAuthApiKey.mockResolvedValue` call, we install a
 * `globalThis.fetch` shim that translates the configured `mockGetOAuthApiKey`
 * result into the equivalent `auth.openai.com` Response.
 *
 * Tests that exercise the bypass directly (refresh_token_reused detection
 * block at the bottom of this file) bypass this shim by spying on
 * `globalThis.fetch` before each `it()` body runs.
 */
function installCodexBypassFetchShim(): { restore: () => void } {
  const original = globalThis.fetch;
  const shim = vi.fn(async (url: unknown, init?: unknown) => {
    const target = String(url);
    if (!target.startsWith("https://auth.openai.com/oauth/token")) {
      return new Response("not found", { status: 404 });
    }
    const reqBody = (init as { body?: unknown })?.body;
    const params =
      reqBody instanceof URLSearchParams
        ? reqBody
        : new URLSearchParams(typeof reqBody === "string" ? reqBody : "");
    const refreshToken = params.get("refresh_token") ?? "";

    // Replay the pi-ai mock — tests that used `mockGetOAuthApiKey` either
    // .mockResolvedValue or .mockImplementation. Pass the FULL seeded
    // credentials (from the active profile slot when set) so identity-style
    // mocks return the matching access token.
    let piResult: {
      newCredentials?: { access?: string; refresh?: string; expires?: number };
      apiKey?: string;
    } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const impl = (mockGetOAuthApiKey as any).getMockImplementation?.();
      if (typeof impl === "function") {
        const seedAccess =
          codexBypassActiveProfile?.access ?? "shim-access";
        const seedRefresh =
          codexBypassActiveProfile?.refresh ?? refreshToken;
        const seedExpires =
          codexBypassActiveProfile?.expires ?? Date.now() + 3600_000;
        piResult = await impl("openai-codex", {
          "openai-codex": {
            access: seedAccess,
            refresh: seedRefresh,
            expires: seedExpires,
          } as never,
        });
      }
    } catch {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "pi-ai mock threw",
        }),
        { status: 400 },
      );
    }
    if (!piResult) {
      return new Response(
        JSON.stringify({ error: "no_credentials" }),
        { status: 400 },
      );
    }
    const creds = piResult.newCredentials ?? {};
    return new Response(
      JSON.stringify({
        access_token: piResult.apiKey ?? creds.access ?? "shim-access",
        refresh_token: creds.refresh ?? "shim-refresh",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  });
  globalThis.fetch = shim as unknown as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
      codexBypassActiveProfile = undefined;
    },
  };
}

describe("OAuthTokenManager — port-backed", () => {
  let eventBus: TypedEventBus;
  let fetchShim: { restore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
    mockWithLock.mockImplementation(async (_path: string, fn: () => Promise<unknown>) =>
      _ok(await fn()),
    );
    fetchShim = installCodexBypassFetchShim();
  });

  afterEach(() => {
    fetchShim.restore();
  });

  // ---------------------------------------------------------------------------
  // Group A — Port-backed credential resolution
  // ---------------------------------------------------------------------------

  describe("A. port-backed credential resolution", () => {
    // Test A.1
    it("getApiKey calls credentialStore.get(profileId) instead of reading directly from SecretManager", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: { ...makeStoredProfile(), refresh: "stored-refresh-token-abc" } as never,
        apiKey: "key-from-port",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      expect(credentialStore.get).toHaveBeenCalled();
    });

    // Test A.2
    it("returns err({code: 'NO_CREDENTIALS'}) when store empty AND no env-var bootstrap", async () => {
      const credentialStore = makeMockCredentialStore();
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NO_CREDENTIALS");
    });

    // Test A.3
    it("returns err({code: 'STORE_FAILED'}) when credentialStore.get returns err", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_err(new Error("store offline")));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("STORE_FAILED");
    });
  });

  // ---------------------------------------------------------------------------
  // Group B — Persisted-on-refresh + bug fix
  // ---------------------------------------------------------------------------

  describe("B. persisted-on-refresh + always-truthy newCredentials bug fix", () => {
    // Test B.1
    it("when refresh token is rotated, manager calls credentialStore.set exactly once", async () => {
      const stored = makeStoredProfile({ refresh: "old-refresh-token" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: {
          ...stored,
          refresh: "new-refresh-token", // ROTATED
        } as never,
        apiKey: "rotated-api-key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      expect(credentialStore.set).toHaveBeenCalledTimes(1);
    });

    // Test B.2 — newCredentials always truthy quirk
    it("when refresh token is unchanged, manager does NOT call credentialStore.set and does NOT emit auth:token_rotated", async () => {
      const stored = makeStoredProfile({ refresh: "stored-refresh" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: {
          ...stored,
          refresh: "stored-refresh", // UNCHANGED — should NOT trigger persist + event
        } as never,
        apiKey: "no-rotation-api-key",
      });
      const events: unknown[] = [];
      eventBus.on("auth:token_rotated", (p) => events.push(p));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      expect(credentialStore.set).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    // Test B.3 — auth:token_rotated payload includes profileId
    it("after persisted-write, auth:token_rotated event includes profileId field", async () => {
      const stored = makeStoredProfile({ refresh: "old-refresh" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: { ...stored, refresh: "new-refresh", expires: stored.expires } as never,
        apiKey: "rotated",
      });
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("auth:token_rotated", (p) => events.push(p as Record<string, unknown>));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.provider).toBe("openai-codex");
      expect(event.profileId).toBe(CODEX_PROFILE_ID);
      expect(typeof event.expiresAtMs).toBe("number");
      expect(typeof event.timestamp).toBe("number");
    });

    // Test B.4
    it("when credentialStore.set returns err, manager returns err({code: 'STORE_FAILED'})", async () => {
      const stored = makeStoredProfile({ refresh: "old-refresh" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      vi.mocked(credentialStore.set).mockResolvedValue(_err(new Error("disk full")));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: { ...stored, refresh: "new-refresh" } as never,
        apiKey: "rotated",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("STORE_FAILED");
    });
  });

  // ---------------------------------------------------------------------------
  // Group C — Lock acquisition
  // ---------------------------------------------------------------------------

  describe("C. lock acquisition", () => {
    // Test C.1
    it("manager calls withExecutionLock with staleMs: 30_000 and updateMs: 5_000", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: makeStoredProfile() as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      expect(mockWithLock).toHaveBeenCalled();
      const call = mockWithLock.mock.calls[0];
      const opts = call?.[2] as { staleMs?: number; updateMs?: number } | undefined;
      expect(opts?.staleMs).toBe(30_000);
      expect(opts?.updateMs).toBe(5_000);
    });

    // Test C.2
    it("lock-path argument is per-profile-ID and sanitizes ':' → '__' and '@' → '_at_'", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: makeStoredProfile() as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const lockPathArg = mockWithLock.mock.calls[0]?.[0] as string;
      expect(lockPathArg).toContain(".locks");
      // The manager's lock-sentinel name is "auth-refresh__<sanitized>.lock" —
      // distinct from the file adapter's "auth-profile__<sanitized>.lock". Both
      // protect the same profile-ID but at different layers; using the SAME
      // sentinel would self-deadlock when credentialStore.set() is called
      // inside the manager's refresh lock body (proper-lockfile retries: 0
      // default).
      expect(lockPathArg).toContain("auth-refresh__openai-codex__user_a_at_example.com.lock");
    });

    // Test C.3
    it("when withExecutionLock returns err('locked'), manager logs WARN with hint='lock_contention' and returns err({code: 'REFRESH_FAILED'})", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockWithLock.mockImplementationOnce(async () =>
        _err({ kind: "locked", message: "test contention" } as const),
      );
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("REFRESH_FAILED");
      const warnCalls = logger._calls().filter((c) => c.level === "warn");
      const hasLockContention = warnCalls.some((c) => {
        const p = c.payload as Record<string, unknown>;
        return p.hint === "lock_contention" && p.errorKind === "auth";
      });
      expect(hasLockContention).toBe(true);
    });

    // Test C.4
    it("when withExecutionLock returns err('error'), manager logs WARN and returns err({code: 'REFRESH_FAILED'})", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockWithLock.mockImplementationOnce(async () =>
        _err({ kind: "error", message: "test failure" } as const),
      );
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("REFRESH_FAILED");
      const warnCount = logger._calls().filter((c) => c.level === "warn").length;
      expect(warnCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Group D — Env-var bootstrap
  // ---------------------------------------------------------------------------

  describe("D. env-var bootstrap", () => {
    // Test D.1
    it("empty store + valid OAUTH_OPENAI_CODEX env var → bootstraps profile, emits auth:profile_bootstrapped", async () => {
      const access = encodeJwtForTest({
        "https://api.openai.com/profile": { email: "user_a@example.com" },
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const seedCreds = {
        access,
        refresh: "env-bootstrap-refresh",
        expires: Date.now() + 3600_000,
      };
      const credentialStore = makeMockCredentialStore();
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: seedCreds as never,
        apiKey: "env-bootstrap-key",
      });
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("auth:profile_bootstrapped", (p) =>
        events.push(p as Record<string, unknown>),
      );
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify(seedCreds),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(true);
      // Profile written to store with id derived from JWT
      expect(credentialStore.set).toHaveBeenCalled();
      const setCall = vi.mocked(credentialStore.set).mock.calls[0];
      expect(setCall?.[0]).toBe("openai-codex:user_a@example.com");
      // Event emitted
      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe("openai-codex");
      expect(events[0].profileId).toBe("openai-codex:user_a@example.com");
    });

    // Test D.2
    it("when JWT decode fails on env-var seed, profile is written with id 'openai-codex:env-bootstrap'", async () => {
      const seedCreds = {
        access: "not-a-valid-jwt",
        refresh: "env-bootstrap-refresh",
        expires: Date.now() + 3600_000,
      };
      const credentialStore = makeMockCredentialStore();
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: seedCreds as never,
        apiKey: "fallback-key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify(seedCreds),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const setCall = vi.mocked(credentialStore.set).mock.calls[0];
      expect(setCall?.[0]).toBe("openai-codex:env-bootstrap");
    });

    // Test D.3 — once-per-process-per-provider
    it("auth:profile_bootstrapped fires exactly once per (provider, process)", async () => {
      const seedCreds = {
        access: encodeJwtForTest({
          "https://api.openai.com/profile": { email: "user_a@example.com" },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh: "env-bootstrap-refresh",
        expires: Date.now() + 3600_000,
      };
      const credentialStore = makeMockCredentialStore();
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: seedCreds as never,
        apiKey: "key",
      });
      const events: unknown[] = [];
      eventBus.on("auth:profile_bootstrapped", (p) => events.push(p));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify(seedCreds),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      // Second call: store now has the profile (the manager would normally read it).
      // Even if we re-trigger bootstrap somehow, the event should not re-fire.
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      await manager.getApiKey("openai-codex");
      expect(events).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Group E — Env-var conflict WARN
  // ---------------------------------------------------------------------------

  describe("E. env-var conflict WARN", () => {
    // Test E.1
    it("stored profile + env-var refresh DIFFERS → WARN logged exactly once with hint='env-override-ignored'", async () => {
      const stored = makeStoredProfile({ refresh: "stored-refresh-token" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: stored as never,
        apiKey: "stored-key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify({
            access: stored.access,
            refresh: "DIFFERENT-env-refresh-token",
            expires: stored.expires,
          }),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const driftWarns = logger
        ._calls()
        .filter((c) => c.level === "warn")
        .filter((c) => {
          const p = c.payload as Record<string, unknown>;
          return p.hint === "env-override-ignored" && p.errorKind === "auth";
        });
      expect(driftWarns).toHaveLength(1);
    });

    // Test E.2 — silent path
    it("stored profile + env-var refresh MATCHES → NO drift WARN logged (silent path)", async () => {
      const stored = makeStoredProfile({ refresh: "matching-refresh" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: stored as never,
        apiKey: "stored-key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify({
            access: stored.access,
            refresh: "matching-refresh",
            expires: stored.expires,
          }),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const driftWarns = logger._calls().filter((c) => {
        const p = c.payload as Record<string, unknown>;
        return c.level === "warn" && p.hint === "env-override-ignored";
      });
      expect(driftWarns).toHaveLength(0);
    });

    // Test E.3 — once-per-process-per-provider
    it("WARN-once-per-process-per-provider — second getApiKey on same conflict logs no second WARN", async () => {
      const stored = makeStoredProfile({ refresh: "stored-refresh" });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: stored as never,
        apiKey: "stored-key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({
          OAUTH_OPENAI_CODEX: JSON.stringify({
            access: stored.access,
            refresh: "DIFFERENT-env-refresh-token",
            expires: stored.expires,
          }),
        }),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      await manager.getApiKey("openai-codex");
      const driftWarns = logger._calls().filter((c) => {
        const p = c.payload as Record<string, unknown>;
        return c.level === "warn" && p.hint === "env-override-ignored";
      });
      expect(driftWarns).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Group F — Refresh failure event
  // ---------------------------------------------------------------------------

  describe("F. refresh failure event", () => {
    // Test F.1
    it("when pi-ai's getOAuthApiKey throws, manager emits auth:refresh_failed and returns err({code: 'REFRESH_FAILED'})", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockRejectedValue(new Error("Token refresh failed"));
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("auth:refresh_failed", (p) => events.push(p as Record<string, unknown>));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const result = await manager.getApiKey("openai-codex");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("REFRESH_FAILED");
      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe("openai-codex");
      expect(events[0].profileId).toBe(CODEX_PROFILE_ID);
      expect(typeof events[0].errorKind).toBe("string");
      expect(typeof events[0].hint).toBe("string");
      expect(typeof events[0].timestamp).toBe("number");
    });

    // Test F.2
    it("30s timeout — when pi-ai call hangs, manager errors with errorKind: 'timeout' and emits auth:refresh_failed", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      // pi-ai call hangs forever — only the timeout race resolves
      mockGetOAuthApiKey.mockImplementation(
        () => new Promise(() => {/* never resolves */}),
      );
      vi.useFakeTimers();
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("auth:refresh_failed", (p) => events.push(p as Record<string, unknown>));
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      const promise = manager.getApiKey("openai-codex");
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await promise;
      vi.useRealTimers();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("REFRESH_FAILED");
      expect(events).toHaveLength(1);
      expect(events[0].errorKind).toBe("timeout");
    });
  });

  // ---------------------------------------------------------------------------
  // Group G — Logging discipline
  // ---------------------------------------------------------------------------

  describe("G. logging discipline", () => {
    // Test G.1
    it("logs refresh-starting at DEBUG with submodule: 'oauth-token-manager'", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: makeStoredProfile() as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const debugCalls = logger._calls().filter((c) => c.level === "debug");
      const hasStartingLog = debugCalls.some((c) => {
        const p = c.payload as Record<string, unknown>;
        return p.provider === "openai-codex" && p.profileId === CODEX_PROFILE_ID;
      });
      expect(hasStartingLog).toBe(true);
    });

    // Test G.2
    it("logs refresh-complete at INFO with provider, profileId, durationMs, refreshed", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(makeStoredProfile()));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: makeStoredProfile() as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const infoCalls = logger._calls().filter((c) => c.level === "info");
      const completeLog = infoCalls.find((c) => {
        const p = c.payload as Record<string, unknown>;
        return p.provider === "openai-codex" && typeof p.durationMs === "number" && "refreshed" in p;
      });
      expect(completeLog).toBeDefined();
    });

    // Test G.3 — token-leak canaries
    it("NO log line at any level contains the literal access or refresh token string", async () => {
      const stored = makeStoredProfile({
        access: FORBIDDEN_ACCESS,
        refresh: FORBIDDEN_REFRESH,
      });
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(_ok(stored));
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: { ...stored, refresh: "rotated-but-still-checked" } as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const allCallsJson = JSON.stringify(logger._calls());
      expect(allCallsJson.indexOf("FORBIDDEN_LOG_")).toBe(-1);
    });

    // Test G.4 — semi-redacted email values in log payloads
    //
    // Explicit email/identity FIELDS in log payloads must pass through
    // redactEmailForLog before logging. The profileId field by contract
    // carries "<provider>:<identity>" — when identity is an email, profileId
    // structurally embeds the email. The profileId must be present in every
    // log line (and Test G.1 asserts the raw form). To avoid contradicting
    // G.1, this test scopes its substring check to the dedicated email +
    // identity fields, not the canonical profileId.
    it("email values in log payloads are semi-redacted via redactEmailForLog", async () => {
      const credentialStore = makeMockCredentialStore();
      vi.mocked(credentialStore.get).mockResolvedValue(
        _ok(makeStoredProfile({ email: "user_a@example.com" })),
      );
      mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));
      mockGetOAuthApiKey.mockResolvedValue({
        newCredentials: makeStoredProfile() as never,
        apiKey: "key",
      });
      const logger = makeMockLogger();
      const manager = createOAuthTokenManager({
        secretManager: makeSecretManager({}),
        eventBus,
        credentialStore,
        logger,
        dataDir: "/tmp/comis-test",
        fileLock: makeFileLockStub(),
      });
      await manager.getApiKey("openai-codex");
      const allCalls = logger._calls();
      // The dedicated email + identity FIELDS (when present) must contain
      // the redacted form, never the raw value.
      for (const call of allCalls) {
        const payload = call.payload as Record<string, unknown>;
        if (typeof payload.email === "string") {
          expect(payload.email).not.toBe("user_a@example.com");
        }
        if (typeof payload.identity === "string") {
          expect(payload.identity).not.toBe("user_a@example.com");
        }
      }
      // Acceptable forms: either redacted email appears, or no dedicated
      // email/identity field is logged at all (preferred for non-bootstrap
      // log lines).
      const allCallsJson = JSON.stringify(allCalls);
      const hasRedacted = allCallsJson.indexOf("us…a@example.com") !== -1;
      const noEmailKey = allCallsJson.indexOf('"email"') === -1 && allCallsJson.indexOf('"identity"') === -1;
      expect(hasRedacted || noEmailKey).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Group H — Hot-path cache
  // ---------------------------------------------------------------------------

  describe("H. hot-path cache", () => {
    // Persisted-write cache-coherency is deliberately NOT re-asserted here —
    // it is already exercised by two tests in this file and by the
    // integration suite, so a third assertion would duplicate coverage
    // without strengthening the invariant.
    //
    //   1. Unit:        oauth-token-manager.test.ts line ~1920 "bypass success
    //      path — cache.set, store.set called, auth:token_rotated emitted"
    //      asserts the post-refresh write-and-cache path: store.set is invoked
    //      with the rotated refresh token AND the cache is populated (the
    //      subsequent fetchSpy/getOAuthApiKey call counts confirm no
    //      redundant outbound traffic).
    //
    //   2. Unit:        oauth-token-manager.test.ts line ~2002 "bypass runs
    //      inside withExecutionLock — every refresh path acquires the
    //      per-profile lock" parallels two concurrent getApiKey() calls and
    //      asserts they share a single refresh — the second call hitting
    //      the warm cache is the implicit invariant.
    //
    //   3. Integration: test/integration/oauth-hot-reload.test.ts
    //      "Watcher invalidates cache on external file change …" populates
    //      the cache via getApiKey, externally rewrites auth-profiles.json,
    //      and asserts the second getApiKey returns the NEW token AND that
    //      no second refresh request fired (i.e. cache served the read).
    //
    // A direct "no second store-read" accounting assertion would only be
    // observable by leaking the private hot-path cache through a test seam.
    // The three tests above verify the same end-to-end invariant (post-refresh,
    // the cache hot-paths subsequent reads) without that intrusion.
  });
});

// ---------------------------------------------------------------------------
// Watcher — chokidar-based hot-reload of auth-profiles.json
// ---------------------------------------------------------------------------

describe("createOAuthTokenManager — watcher", () => {
  let mockEventBus: TypedEventBus;
  let mockStore: OAuthCredentialStorePort;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventBus = new TypedEventBus();
    mockStore = makeMockCredentialStore();
    mockLogger = makeMockLogger();
  });

  it("watcher does NOT register chokidar when watchPath is undefined (encrypted-mode path)", () => {
    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus: mockEventBus,
      credentialStore: mockStore,
      logger: mockLogger as unknown as import("@comis/core").ComisLogger,
      dataDir: "/tmp/test-data-dir-no-watch",
      fileLock: makeFileLockStub(),
      // watchPath: undefined  -- intentionally omitted
    });
    expect(manager).toBeDefined();
    expect(typeof manager.dispose).toBe("function");
    // The DEBUG log "OAuth profile watcher registered" should NOT have been emitted.
    const watcherDebugLogs = mockLogger
      ._calls()
      .filter((c) => c.msg.includes("OAuth profile watcher registered"));
    expect(watcherDebugLogs).toHaveLength(0);
  });

  it("watcher registers a chokidar watcher when watchPath is provided", async () => {
    // Use a real temp file so chokidar can actually attach.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "comis-watcher-"));
    const watchPath = path.join(tmpDir, "auth-profiles.json");
    fs.writeFileSync(
      watchPath,
      JSON.stringify({ version: 1, profiles: {} }),
      { mode: 0o600 },
    );

    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus: mockEventBus,
      credentialStore: mockStore,
      logger: mockLogger as unknown as import("@comis/core").ComisLogger,
      dataDir: tmpDir,
      fileLock: makeFileLockStub(),
      watchPath,
    });

    // DEBUG log for "watcher registered" should have fired during construction.
    const watcherDebugLogs = mockLogger
      ._calls("debug")
      .filter((c) => c.msg.includes("OAuth profile watcher registered"));
    expect(watcherDebugLogs.length).toBeGreaterThan(0);

    await manager.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("watcher dispose closes the watcher (idempotent — second call is a no-op)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "comis-watcher-"));
    const watchPath = path.join(tmpDir, "auth-profiles.json");
    fs.writeFileSync(
      watchPath,
      JSON.stringify({ version: 1, profiles: {} }),
      { mode: 0o600 },
    );

    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus: mockEventBus,
      credentialStore: mockStore,
      logger: mockLogger as unknown as import("@comis/core").ComisLogger,
      dataDir: tmpDir,
      fileLock: makeFileLockStub(),
      watchPath,
    });

    await expect(manager.dispose()).resolves.toBeUndefined();
    // Second call should not throw.
    await expect(manager.dispose()).resolves.toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("watcher debounced cache invalidation: file change triggers cache-invalidation DEBUG log within reasonable window", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "comis-watcher-"));
    const watchPath = path.join(tmpDir, "auth-profiles.json");
    fs.writeFileSync(
      watchPath,
      JSON.stringify({ version: 1, profiles: {} }),
      { mode: 0o600 },
    );

    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus: mockEventBus,
      credentialStore: mockStore,
      logger: mockLogger as unknown as import("@comis/core").ComisLogger,
      dataDir: tmpDir,
      fileLock: makeFileLockStub(),
      watchPath,
    });

    // Allow chokidar to attach the underlying watcher before we mutate the file.
    // On macOS (fsevents) the initial setup takes ~50–200ms; on Linux (inotify)
    // it's near-instant. 300ms covers both.
    await new Promise((r) => setTimeout(r, 300));

    // Trigger a write event. Use a plain modify (no rename) — chokidar's
    // atomic-rename coalescing is best-tested by integration; for the unit
    // test we just need ANY change to fire the cache-invalidation path.
    fs.writeFileSync(
      watchPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:test@x.com": {
            provider: "openai-codex",
            profileId: "openai-codex:test@x.com",
            access: "a",
            refresh: "r",
            expires: Date.now() + 3600_000,
            version: 1,
          },
        },
      }),
    );

    // Poll up to 2 seconds for the invalidation log — chokidar's atomic option
    // (100ms) plus our setTimeout debounce (100ms) plus fs-event jitter on
    // macOS can take a few hundred ms. Sub-second on Linux/CI in practice.
    const deadline = Date.now() + 2_000;
    let invalidationLogs = mockLogger
      ._calls("debug")
      .filter((c) => c.msg.includes("cache invalidated"));
    while (invalidationLogs.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      invalidationLogs = mockLogger
        ._calls("debug")
        .filter((c) => c.msg.includes("cache invalidated"));
    }
    expect(invalidationLogs.length).toBeGreaterThan(0);

    await manager.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Resolver chain (agent-config -> lastGood -> first available)
//
// Acceptance cases:
//   (a1) configured-and-present  -> ok(apiKey of configured profile)
//   (a2) configured-and-missing  -> err({code: "PROFILE_NOT_FOUND"})
//   (b)  unconfigured + lastGood -> ok(apiKey of lastGood profile); list NOT consulted
//   (c)  unconfigured + no lastGood -> ok(apiKey of first available)
//   (d)  after success, lastGood populated -> next call short-circuits to tier (b)
// Plus backward-compat (single-arg signature) and deps-getter fallback paths.
// ---------------------------------------------------------------------------

describe("OAuthTokenManager.getApiKey resolver chain", () => {
  const PROVIDER = "openai-codex";
  const CONFIGURED_PROFILE = "openai-codex:work@example.com";
  const FIRST_PROFILE = "openai-codex:first@example.com";
  const LASTGOOD_PROFILE = "openai-codex:b@example.com";
  const D_PROFILE = "openai-codex:d@example.com";

  let credentialStore: OAuthCredentialStorePort;
  let logger: ReturnType<typeof makeMockLogger>;
  let eventBus: TypedEventBus;
  let fetchShim: { restore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
    credentialStore = makeMockCredentialStore();
    logger = makeMockLogger();
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider(PROVIDER));
    // pi-ai shape: { newCredentials, apiKey }. Real-refresh detection compares
    // newCredentials.refresh !== profile.refresh; mirroring profile.refresh
    // here keeps tests on the "no rotation" path (no auth:token_rotated).
    mockGetOAuthApiKey.mockImplementation(
      async (_id: string, credsRecord: Record<string, OAuthCredentials>) => {
        const creds = credsRecord[_id];
        return {
          newCredentials: creds as OAuthCredentials,
          apiKey: (creds as OAuthCredentials).access,
        };
      },
    );
    mockWithLock.mockImplementation(
      async (_path: string, fn: () => Promise<unknown>) => _ok(await fn()),
    );
    // The bypass shim translates mockGetOAuthApiKey calls into the
    // auth.openai.com Response shape the bypass expects.
    fetchShim = installCodexBypassFetchShim();
  });

  afterEach(() => {
    fetchShim.restore();
  });

  function buildProfile(profileId: string, accessToken: string): OAuthProfile {
    // Prime the bypass-fetch shim so the synthesized auth.openai.com Response
    // carries the test's seeded access token. Each test calls `buildProfile`
    // exactly once; the last-built profile is the one the test exercises, so
    // single-slot tracking is sufficient.
    const profile: OAuthProfile = {
      provider: PROVIDER,
      profileId,
      access: accessToken,
      refresh: `refresh-for-${profileId}`,
      expires: Date.now() + 3600_000,
      version: 1,
    };
    codexBypassActiveProfile = profile;
    return profile;
  }

  function makeManager(extraDeps: Partial<OAuthTokenManagerDepsLike> = {}): OAuthTokenManager {
    return createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus,
      credentialStore,
      logger,
      dataDir: "/tmp/comis-test-resolver",
      fileLock: makeFileLockStub(),
      ...extraDeps,
    });
  }

  // (a1) Configured-and-present resolves to the configured profile.
  it("(a1) configured-and-present resolves to the configured profile", async () => {
    const profile = buildProfile(CONFIGURED_PROFILE, "ACCESS_WORK");
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(true));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    const result = await manager.getApiKey(PROVIDER, {
      oauthProfiles: { [PROVIDER]: CONFIGURED_PROFILE },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ACCESS_WORK");
    expect(credentialStore.has).toHaveBeenCalledWith(CONFIGURED_PROFILE);
    expect(credentialStore.get).toHaveBeenCalledWith(CONFIGURED_PROFILE);
    // Tier (a) returns early — list NOT consulted.
    expect(credentialStore.list).not.toHaveBeenCalled();
  });

  // The configured-profile-resolved INFO goes through withDedup, keyed on a
  // `dedupKey` field of "${providerId}::${configured}". It fires ONCE per
  // distinct key across repeated resolves, and the 3 behavior-gating Sets
  // are untouched.
  it("(a1) logs 'OAuth profile resolved via agent config' ONCE via withDedup, carrying the dedupKey field", async () => {
    const profile = buildProfile(CONFIGURED_PROFILE, "ACCESS_WORK");
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(true));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    const agentContext = { oauthProfiles: { [PROVIDER]: CONFIGURED_PROFILE } };

    // Resolve the SAME (provider, configured) twice on one manager instance.
    await manager.getApiKey(PROVIDER, agentContext);
    await manager.getApiKey(PROVIDER, agentContext);

    const resolvedInfos = logger
      ._calls()
      .filter((c) => c.level === "info" && c.msg === "OAuth profile resolved via agent config");

    // Log-once semantics: fired exactly once across the two resolves.
    expect(resolvedInfos).toHaveLength(1);
    // Carries the withDedup composite key + the documented payload fields.
    const payload = resolvedInfos[0]?.payload as Record<string, unknown>;
    expect(payload.dedupKey).toBe(`${PROVIDER}::${CONFIGURED_PROFILE}`);
    expect(payload.provider).toBe(PROVIDER);
    expect(payload.profileId).toBe(CONFIGURED_PROFILE);
    expect(payload.submodule).toBe("oauth-resolver");
  });

  // (a2) Configured-and-missing returns OAuthError{code: PROFILE_NOT_FOUND}
  // and emits the documented WARN log.
  it("(a2) configured-and-missing returns OAuthError{code: PROFILE_NOT_FOUND}", async () => {
    const configured = "openai-codex:nope@example.com";
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(false));

    const manager = makeManager();
    const result = await manager.getApiKey(PROVIDER, {
      oauthProfiles: { [PROVIDER]: configured },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROFILE_NOT_FOUND");
      expect(result.error.message).toContain(configured);
      expect(result.error.message).toContain("comis auth list");
      expect(result.error.providerId).toBe(PROVIDER);
    }
    // WARN log emitted with the documented field shape.
    const warnCalls = logger._calls().filter((c) => c.level === "warn");
    const profileMissingWarn = warnCalls.find((c) => {
      const p = c.payload as Record<string, unknown>;
      return (
        p.provider === PROVIDER &&
        p.configuredProfileId === configured &&
        p.hint === "configured-profile-missing" &&
        p.errorKind === "auth" &&
        p.submodule === "oauth-resolver"
      );
    });
    expect(profileMissingWarn).toBeDefined();
    // No fall-through — list NOT consulted, get NOT consulted.
    expect(credentialStore.list).not.toHaveBeenCalled();
    expect(credentialStore.get).not.toHaveBeenCalled();
  });

  // (b) Unconfigured + lastGood-set + still-in-store resolves to lastGood.
  it("(b) unconfigured + lastGood resolves to the lastGood profile", async () => {
    const profile = buildProfile(LASTGOOD_PROFILE, "ACCESS_B");
    // Tier (c) seed: list returns the profile so the first call populates lastGood.
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(true));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    // First call (no agentContext, no lastGood yet) -> tier (c) -> populates lastGood.
    const first = await manager.getApiKey(PROVIDER);
    expect(first.ok).toBe(true);
    expect(credentialStore.list).toHaveBeenCalledTimes(1);

    // Reset list-mock-call history.
    vi.mocked(credentialStore.list).mockClear();

    // Second call (no agentContext) -> tier (b) finds lastGood, skips list().
    const second = await manager.getApiKey(PROVIDER);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe("ACCESS_B");
    // Tier (b) short-circuited — list NOT called.
    expect(credentialStore.list).not.toHaveBeenCalled();
  });

  // (c) Unconfigured + no lastGood resolves to the first profile from list.
  it("(c) unconfigured + no lastGood resolves to the first available profile", async () => {
    const profile = buildProfile(FIRST_PROFILE, "ACCESS_C");
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    // Lock-body re-read inside refreshUnderLock calls credentialStore.get(profileId).
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    const result = await manager.getApiKey(PROVIDER);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ACCESS_C");
    expect(credentialStore.list).toHaveBeenCalledWith({ provider: PROVIDER });
  });

  // (d) After a successful resolve, lastGood reflects the just-resolved profileId.
  // Verified by spying on list() — the second call short-circuits at tier (b).
  it("(d) after success, lastGood reflects the just-resolved profileId", async () => {
    const profile = buildProfile(D_PROFILE, "ACCESS_D");
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(true));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    // Configured-resolve via tier (a) populates lastGood.
    const first = await manager.getApiKey(PROVIDER, {
      oauthProfiles: { [PROVIDER]: D_PROFILE },
    });
    expect(first.ok).toBe(true);

    // Now call with NO agentContext: tier (b) should find lastGood populated.
    vi.mocked(credentialStore.list).mockClear();
    const second = await manager.getApiKey(PROVIDER);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe("ACCESS_D");
    // lastGood short-circuits — list NOT consulted on the second call.
    expect(credentialStore.list).not.toHaveBeenCalled();
  });

  // Backward-compat: single-arg getApiKey() works without agentContext.
  it("backward-compat: single-arg getApiKey() works without agentContext", async () => {
    const profile = buildProfile("openai-codex:back@example.com", "ACCESS_BACK");
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager();
    const result = await manager.getApiKey(PROVIDER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ACCESS_BACK");
  });

  // Deps getter fallback: agentContext absent, deps.getAgentOauthProfiles supplies
  // the configured profile-ID. Tier (a) consumes it.
  it("falls back to deps.getAgentOauthProfiles when agentContext is absent", async () => {
    const profileId = "openai-codex:dep@example.com";
    const profile = buildProfile(profileId, "ACCESS_DEP");
    vi.mocked(credentialStore.has).mockResolvedValue(_ok(true));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager({
      getAgentOauthProfiles: () => ({ [PROVIDER]: profileId }),
    });

    // No agentContext passed — deps getter is the only source of the configured ID.
    const result = await manager.getApiKey(PROVIDER);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ACCESS_DEP");
    expect(credentialStore.has).toHaveBeenCalledWith(profileId);
  });

  // Deps getter returning undefined falls through to lastGood/first as if no
  // agent-level config exists.
  it("deps.getAgentOauthProfiles returning undefined falls through to tier (c)", async () => {
    const profile = buildProfile(FIRST_PROFILE, "ACCESS_FIRST_VIA_C");
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));

    const manager = makeManager({
      getAgentOauthProfiles: () => undefined,
    });
    const result = await manager.getApiKey(PROVIDER);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ACCESS_FIRST_VIA_C");
    // tier (c) — list consulted.
    expect(credentialStore.list).toHaveBeenCalledWith({ provider: PROVIDER });
  });
});

/**
 * Local alias for OAuthTokenManagerDeps used by makeManager() in the resolver-
 * chain describe block. Avoids a re-import while keeping the helper signature
 * type-safe (TypeScript infers the deps shape from createOAuthTokenManager).
 */
type OAuthTokenManagerDepsLike = Parameters<typeof createOAuthTokenManager>[0];

// =============================================================================
// refresh_token_reused detection via openai-codex bypass
//
// The token manager bypasses pi-ai's getOAuthApiKey for openai-codex so the
// refresh-failure response body is available for clean classification. These
// tests drive the bypass by mocking globalThis.fetch — the existing module-
// level mock of @earendil-works/pi-ai/oauth (lines 17-21) keeps non-Codex
// providers on the pi-ai path so we can verify pure fall-through.
// =============================================================================

describe("refresh_token_reused detection", () => {
  let eventBus: TypedEventBus;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
    mockWithLock.mockImplementation(
      async (_p: string, fn: () => Promise<unknown>) => _ok(await fn()),
    );
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a Codex profile that is past expiry (forces refresh path). */
  function expiredCodexProfile(): OAuthProfile {
    return {
      provider: "openai-codex",
      profileId: "openai-codex:user_a@example.com",
      access: encodeJwtForTest({
        "https://api.openai.com/profile": { email: "user_a@example.com" },
        exp: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
      }),
      refresh: "test-refresh-token",
      expires: Date.now() - 60_000,
      email: "user_a@example.com",
      version: 1,
    };
  }

  function buildManager(credentialStore: OAuthCredentialStorePort): {
    manager: OAuthTokenManager;
    logger: ReturnType<typeof makeMockLogger>;
  } {
    const logger = makeMockLogger();
    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus,
      credentialStore,
      logger,
      dataDir: "/tmp/comis-test",
      fileLock: makeFileLockStub(),
    });
    return { manager, logger };
  }

  it("classifies refresh_token_reused → emits auth:refresh_failed with errorKind, returns OAuthError with hint", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "refresh_token_reused",
        }),
        { status: 400 },
      ),
    );

    const events: Array<Record<string, unknown>> = [];
    eventBus.on("auth:refresh_failed", (p) =>
      events.push(p as Record<string, unknown>),
    );

    const { manager, logger } = buildManager(credentialStore);
    const result = await manager.getApiKey("openai-codex");

    // (a) auth:refresh_failed with errorKind: refresh_token_reused
    expect(events).toHaveLength(1);
    expect(events[0].errorKind).toBe("refresh_token_reused");
    expect(String(events[0].hint)).toContain("re-login required");

    // (b) WARN log with module + errorKind + hint
    const warnHits = logger
      ._calls()
      .filter((c) => c.level === "warn")
      .filter((c) => {
        const p = c.payload as Record<string, unknown>;
        return (
          p.submodule === "oauth-token-manager" &&
          p.errorKind === "auth"
        );
      });
    expect(warnHits.length).toBeGreaterThanOrEqual(1);
    const warnPayload = warnHits[0]?.payload as Record<string, unknown>;
    expect(String(warnPayload.hint)).toContain("re-login required");

    // (c) OAuthError carries new fields
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.error as OAuthError;
      expect(e.code).toBe("REFRESH_FAILED");
      expect(e.errorKind).toBe("refresh_token_reused");
      expect(e.profileId).toBe("openai-codex:user_a@example.com");
      expect(String(e.hint)).toContain("re-login required");
      expect(e.message).toContain("comis auth login --provider openai-codex");
    }

    // Bypass URL was hit; pi-ai's getOAuthApiKey was NOT called.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(calledUrl)).toBe("https://auth.openai.com/oauth/token");
    expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
  });

  it("classifies generic invalid_grant when description does not mention reuse", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "some other reason",
        }),
        { status: 400 },
      ),
    );

    const events: Array<Record<string, unknown>> = [];
    eventBus.on("auth:refresh_failed", (p) =>
      events.push(p as Record<string, unknown>),
    );

    const { manager, logger } = buildManager(credentialStore);
    const result = await manager.getApiKey("openai-codex");

    expect(events).toHaveLength(1);
    expect(events[0].errorKind).toBe("invalid_grant");

    const warnHit = logger._calls().find((c) => {
      const p = c.payload as Record<string, unknown>;
      return c.level === "warn" && p.errorKind === "auth";
    });
    expect(warnHit).toBeDefined();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.error as OAuthError;
      expect(e.errorKind).toBe("invalid_grant");
      expect(String(e.hint)).toContain("invalid_grant");
    }
  });

  it("classifies unsupported_country_region_territory + hint mentions HTTPS_PROXY", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "unsupported_country_region_territory" }),
        { status: 400 },
      ),
    );

    const events: Array<Record<string, unknown>> = [];
    eventBus.on("auth:refresh_failed", (p) =>
      events.push(p as Record<string, unknown>),
    );

    const { manager } = buildManager(credentialStore);
    const result = await manager.getApiKey("openai-codex");

    expect(events).toHaveLength(1);
    expect(events[0].errorKind).toBe("unsupported_region");
    expect(String(events[0].hint)).toContain("HTTPS_PROXY");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.error as OAuthError;
      expect(e.errorKind).toBe("unsupported_region");
      expect(String(e.hint)).toContain("HTTPS_PROXY");
    }
  });

  it("bypass success path — cache.set, store.set called, auth:token_rotated emitted", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const rotatedEvents: Array<Record<string, unknown>> = [];
    const failedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("auth:token_rotated", (p) =>
      rotatedEvents.push(p as Record<string, unknown>),
    );
    eventBus.on("auth:refresh_failed", (p) =>
      failedEvents.push(p as Record<string, unknown>),
    );

    const { manager } = buildManager(credentialStore);
    const result = await manager.getApiKey("openai-codex");

    // Returned API key matches the new access token from the bypass.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("new-access-token");

    // Persisted-on-rotation invariant: store.set called once with new refresh.
    expect(credentialStore.set).toHaveBeenCalledTimes(1);
    const setCall = vi.mocked(credentialStore.set).mock.calls[0];
    expect(setCall?.[1].refresh).toBe("new-refresh-token");
    expect(setCall?.[1].access).toBe("new-access-token");

    // auth:token_rotated emitted; auth:refresh_failed NOT.
    expect(rotatedEvents).toHaveLength(1);
    expect(failedEvents).toHaveLength(0);

    // Bypass was the only outbound call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
  });

  it("non-Codex provider routes through pi-ai's getOAuthApiKey (bypass NOT called)", async () => {
    const anthropicProfile: OAuthProfile = {
      provider: "anthropic",
      profileId: "anthropic:user_a@example.com",
      access: "anthropic-access",
      refresh: "anthropic-refresh",
      expires: Date.now() - 60_000,
      email: "user_a@example.com",
      version: 1,
    };
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(anthropicProfile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([anthropicProfile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("anthropic"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: {
        ...anthropicProfile,
        refresh: "anthropic-refresh", // unchanged
      } as never,
      apiKey: "anthropic-api-key",
    });

    const { manager } = buildManager(credentialStore);
    const result = await manager.getApiKey("anthropic");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("anthropic-api-key");

    // Pi-ai received the call; bypass fetch was NOT invoked.
    expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypass runs inside withExecutionLock — every refresh path acquires the per-profile lock", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    // Fresh Response per call — Response body can only be read once.
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "shared-access",
            refresh_token: "shared-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );

    const { manager } = buildManager(credentialStore);
    const [a, b] = await Promise.all([
      manager.getApiKey("openai-codex"),
      manager.getApiKey("openai-codex"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value).toBe(b.value);

    // Lock contract: every refresh attempt invokes fileLock.withLock with the
    // per-profile sentinel path. Two parallel callers → two lock acquisitions.
    expect(mockWithLock).toHaveBeenCalledTimes(2);
    const lockPath0 = mockWithLock.mock.calls[0]?.[0] as string;
    const lockPath1 = mockWithLock.mock.calls[1]?.[0] as string;
    expect(lockPath0).toContain("auth-refresh__openai-codex__user_a_at_example.com.lock");
    expect(lockPath1).toBe(lockPath0);

    // Bypass must be the only outbound network path.
    expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    // Each call enters refreshUnderLock independently with the test mock; the
    // production lock real-serializes them. Cap at 2 calls — never more.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("bypass timeout → errorKind: timeout, hint: auth_endpoint_unreachable", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    // Fetch never resolves — the withTimeout wrapper must trip.
    fetchSpy.mockImplementation(
      () => new Promise(() => {/* never resolves */}),
    );

    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on("auth:refresh_failed", (p) =>
      events.push(p as Record<string, unknown>),
    );

    const { manager } = buildManager(credentialStore);
    const promise = manager.getApiKey("openai-codex");
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.error as OAuthError;
      expect(e.code).toBe("REFRESH_FAILED");
      expect(e.errorKind).toBe("timeout");
      expect(e.hint).toBe("auth_endpoint_unreachable");
    }
    expect(events).toHaveLength(1);
    expect(events[0].errorKind).toBe("timeout");
    expect(events[0].hint).toBe("auth_endpoint_unreachable");
  });

  it("malformed JSON in 400 response → falls through to default classification (no thrown error)", async () => {
    const profile = expiredCodexProfile();
    const credentialStore = makeMockCredentialStore();
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profile));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profile]));
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    fetchSpy.mockResolvedValue(new Response("not json", { status: 400 }));

    const events: Array<Record<string, unknown>> = [];
    eventBus.on("auth:refresh_failed", (p) =>
      events.push(p as Record<string, unknown>),
    );

    const { manager } = buildManager(credentialStore);
    const result = await manager.getApiKey("openai-codex");

    // No exception escapes — manager returns OAuthError cleanly.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.error as OAuthError;
      expect(e.code).toBe("REFRESH_FAILED");
      // rewriteOAuthError default branch: callback_timeout (errorKind === code).
      expect(e.errorKind).toBe("callback_timeout");
    }
    expect(events).toHaveLength(1);
    expect(events[0].errorKind).toBe("callback_timeout");
  });
});

// =============================================================================
// OAuthTokenManager.invalidate()
//
// OAuthTokenManager exposes an invalidate() method that clears the in-memory
// cache so that the next getApiKey() call re-fetches from the credential
// store. This closes the encrypted-mode gap: when a CLI `auth login` writes a
// new OAuth profile (a separate process), the daemon's OAuthTokenManager must
// be able to invalidate its hot-path cache so the new profile is visible
// without a daemon restart (the encrypted-mode subscription in
// setup-agents-oauth.ts fires tokenManager.invalidate() on auth:profile_added).
// =============================================================================

describe("OAuthTokenManager.invalidate()", () => {
  let eventBus: TypedEventBus;
  let fetchShim: { restore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
    mockWithLock.mockImplementation(async (_path: string, fn: () => Promise<unknown>) =>
      _ok(await fn()),
    );
    // The openai-codex bypass routes through globalThis.fetch (not pi-ai's
    // getOAuthApiKey). Install the shim so the bypass reads the
    // mockGetOAuthApiKey result instead of making a real network call.
    fetchShim = installCodexBypassFetchShim();
  });

  afterEach(() => {
    fetchShim.restore();
  });

  it("invalidate() clears the cache so getApiKey() re-fetches from store after a profile update", async () => {
    // Arrange: construct manager with a mock store that returns profile v1 initially.
    const credentialStore = makeMockCredentialStore();
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("openai-codex"));

    const profileV1 = makeStoredProfile({ refresh: "refresh-v1", access: "access-v1" });

    // Prime the store with v1.
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profileV1));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profileV1]));
    // Mock getOAuthApiKey to return v1 access token (no real refresh needed).
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: { ...profileV1 } as never,
      apiKey: "access-v1",
    });

    const manager = createOAuthTokenManager({
      secretManager: makeSecretManager({}),
      eventBus,
      credentialStore,
      logger: makeMockLogger(),
      dataDir: "/tmp/comis-test-invalidate",
      fileLock: makeFileLockStub(),
    });

    // Act: call getApiKey() once to prime the in-memory cache.
    await manager.getApiKey("openai-codex");

    // Now "rotate": the CLI writes a new profile to the store (v2).
    const profileV2 = makeStoredProfile({ refresh: "refresh-v2", access: "access-v2" });
    vi.mocked(credentialStore.get).mockResolvedValue(_ok(profileV2));
    vi.mocked(credentialStore.list).mockResolvedValue(_ok([profileV2]));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: { ...profileV2 } as never,
      apiKey: "access-v2",
    });

    // Assert: invalidate() must exist as a function on the manager.
    expect(typeof (manager as unknown as Record<string, unknown>).invalidate).toBe("function");

    // After invalidate(), getApiKey() must return the v2 access token.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast for missing method
    await (manager as unknown as Record<string, (...args: unknown[]) => unknown>).invalidate?.();

    const result = await manager.getApiKey("openai-codex");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // access-v2 is the api key after invalidation + re-fetch.
      expect(result.value).toBe("access-v2");
    }
  });
});
