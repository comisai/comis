import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecretManager } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { createOAuthTokenManager, type OAuthTokenManager, type OAuthError } from "./oauth-token-manager.js";

// ---------------------------------------------------------------------------
// Mock pi-ai OAuth module
// ---------------------------------------------------------------------------

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProvider: vi.fn(),
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn(),
}));

import {
  getOAuthProvider,
  getOAuthApiKey,
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";

const mockGetOAuthProvider = vi.mocked(getOAuthProvider);
const mockGetOAuthApiKey = vi.mocked(getOAuthApiKey);
const mockGetOAuthProviders = vi.mocked(getOAuthProviders);

// ---------------------------------------------------------------------------
// Helpers
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

const FAKE_CREDS = {
  refresh: "refresh-token-abc",
  access: "access-token-xyz",
  expires: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now (seconds)
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOAuthTokenManager", () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new TypedEventBus();
  });

  // Test 1: getApiKey with no stored credentials
  it("getApiKey returns err NO_CREDENTIALS when no credentials stored", async () => {
    const secretManager = makeSecretManager({});
    const manager = createOAuthTokenManager({ secretManager, eventBus });

    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_CREDENTIALS");
      expect(result.error.providerId).toBe("github-copilot");
    }
  });

  // Test 2: getApiKey with unknown provider (pi-ai returns undefined)
  it("getApiKey returns err NO_PROVIDER when pi-ai does not recognize provider", async () => {
    const secretManager = makeSecretManager({
      OAUTH_UNKNOWN_PROVIDER: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(undefined);

    const manager = createOAuthTokenManager({ secretManager, eventBus });

    const result = await manager.getApiKey("unknown-provider");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_PROVIDER");
      expect(result.error.providerId).toBe("unknown-provider");
    }
  });

  // Test 3: getApiKey with valid credentials, no refresh needed
  it("getApiKey returns ok(apiKey) when credentials are valid and no refresh needed", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_test-api-key-123",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus });
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

  // Test 4: getApiKey when refresh occurs -- stores updated creds and emits event
  it("getApiKey stores refreshed credentials and emits auth:token_rotated", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    const newCreds = {
      refresh: "new-refresh-token",
      access: "new-access-token",
      expires: Math.floor(Date.now() / 1000) + 7200, // 2 hours from now
    };
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: newCreds,
      apiKey: "ghu_refreshed-key-456",
    });

    const events: unknown[] = [];
    eventBus.on("auth:token_rotated", (payload) => events.push(payload));

    const manager = createOAuthTokenManager({ secretManager, eventBus });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ghu_refreshed-key-456");
    }

    // Should have emitted auth:token_rotated
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.provider).toBe("github-copilot");
    expect(event.profileName).toBe("OAUTH_GITHUB_COPILOT");
    expect(event.expiresAtMs).toBe(newCreds.expires * 1000);
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

  // Test 5: getApiKey when getOAuthApiKey throws
  it("getApiKey returns err REFRESH_FAILED when getOAuthApiKey throws", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockRejectedValue(new Error("Token refresh failed: invalid grant"));

    const manager = createOAuthTokenManager({ secretManager, eventBus });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REFRESH_FAILED");
      expect(result.error.providerId).toBe("github-copilot");
      expect(result.error.message).toContain("Token refresh failed");
    }
  });

  // Test 6: getApiKey when getOAuthApiKey returns null
  it("getApiKey returns err NO_CREDENTIALS when getOAuthApiKey returns null", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue(null);

    const manager = createOAuthTokenManager({ secretManager, eventBus });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_CREDENTIALS");
      expect(result.error.providerId).toBe("github-copilot");
    }
  });

  // Test 7: hasCredentials returns true when creds exist
  it("hasCredentials returns true when SecretManager has stored creds", () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus });
    expect(manager.hasCredentials("github-copilot")).toBe(true);
  });

  // Test 8: hasCredentials returns false when no creds
  it("hasCredentials returns false when no credentials stored", () => {
    const secretManager = makeSecretManager({});

    const manager = createOAuthTokenManager({ secretManager, eventBus });
    expect(manager.hasCredentials("github-copilot")).toBe(false);
  });

  // Test 9: storeCredentials serializes and caches
  it("storeCredentials stores credentials accessible by getApiKey", async () => {
    const secretManager = makeSecretManager({});
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_stored-key-789",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus });

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

  // Test 10: getSupportedProviders returns provider IDs from pi-ai
  it("getSupportedProviders returns provider IDs from pi-ai", () => {
    mockGetOAuthProviders.mockReturnValue([
      makeFakeProvider("anthropic"),
      makeFakeProvider("github-copilot"),
      makeFakeProvider("google-gemini-cli"),
      makeFakeProvider("google-antigravity"),
      makeFakeProvider("openai-codex"),
    ] as unknown as ReturnType<typeof getOAuthProviders>);

    const secretManager = makeSecretManager({});
    const manager = createOAuthTokenManager({ secretManager, eventBus });
    const providers = manager.getSupportedProviders();

    expect(providers).toEqual([
      "anthropic",
      "github-copilot",
      "google-gemini-cli",
      "google-antigravity",
      "openai-codex",
    ]);
  });

  // Test 11: Key naming convention
  it("maps provider id to uppercase SecretManager key with OAUTH_ prefix", async () => {
    const secretManager = makeSecretManager({
      OAUTH_GITHUB_COPILOT: JSON.stringify(FAKE_CREDS),
    });
    mockGetOAuthProvider.mockReturnValue(makeFakeProvider("github-copilot"));
    mockGetOAuthApiKey.mockResolvedValue({
      newCredentials: FAKE_CREDS,
      apiKey: "ghu_key",
    });

    const manager = createOAuthTokenManager({ secretManager, eventBus });
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
      keyPrefix: "MYAUTH_",
    });
    const result = await manager.getApiKey("github-copilot");

    expect(result.ok).toBe(true);
    expect(secretManager.get).toHaveBeenCalledWith("MYAUTH_GITHUB_COPILOT");
  });

  // Additional: hasCredentials returns true after storeCredentials
  it("hasCredentials returns true after storeCredentials even without SecretManager entry", () => {
    const secretManager = makeSecretManager({});
    const manager = createOAuthTokenManager({ secretManager, eventBus });

    manager.storeCredentials("anthropic", FAKE_CREDS);
    expect(manager.hasCredentials("anthropic")).toBe(true);
  });
});
