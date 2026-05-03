// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { PerAgentConfig } from "@comis/core";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Mock pi-ai OAuth module BEFORE importing the SUT — the SUT imports
// `getOAuthProvider` at module init.
// ---------------------------------------------------------------------------

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProvider: vi.fn(),
}));

import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { resolveProviderApiKey } from "./resolve-provider-api-key.js";
import type { OAuthTokenManager, OAuthError } from "./oauth-token-manager.js";

const mockGetOAuthProvider = vi.mocked(getOAuthProvider);

// ---------------------------------------------------------------------------
// Helpers — minimal stubs typed via Pick to avoid full SDK surface
// ---------------------------------------------------------------------------

function makeAuthStorage(): Pick<AuthStorage, "getApiKey" | "setRuntimeApiKey"> {
  return {
    getApiKey: vi.fn(),
    setRuntimeApiKey: vi.fn(),
  };
}

function makeOAuthManager(): Pick<OAuthTokenManager, "getApiKey"> {
  return {
    getApiKey: vi.fn(),
  };
}

function makeFakeOAuthProvider(id: string) {
  return {
    id,
    name: `Provider ${id}`,
    login: vi.fn(),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveProviderApiKey (Phase 9 R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: routes OAuth-eligible provider through manager and writes runtime override", async () => {
    mockGetOAuthProvider.mockReturnValue(makeFakeOAuthProvider("openai-codex"));
    const authStorage = makeAuthStorage();
    const manager = makeOAuthManager();
    (manager.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(ok("OAUTH_TOKEN"));

    const token = await resolveProviderApiKey("openai-codex", {
      authStorage: authStorage as AuthStorage,
      oauthManager: manager as OAuthTokenManager,
    });

    expect(token).toBe("OAUTH_TOKEN");
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai-codex", "OAUTH_TOKEN");
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
  });

  it("Test 2: throws on OAuthError without writing runtime override", async () => {
    mockGetOAuthProvider.mockReturnValue(makeFakeOAuthProvider("openai-codex"));
    const authStorage = makeAuthStorage();
    const manager = makeOAuthManager();
    const oauthErr: OAuthError = {
      code: "PROFILE_NOT_FOUND",
      message: 'OAuth profile "openai-codex:custom@example.com" not found in store. Run "comis auth list".',
      providerId: "openai-codex",
    };
    (manager.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(err(oauthErr));

    await expect(
      resolveProviderApiKey("openai-codex", {
        authStorage: authStorage as AuthStorage,
        oauthManager: manager as OAuthTokenManager,
      }),
    ).rejects.toThrow(/not found in store/);
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("Test 3: non-OAuth-eligible provider falls through to authStorage.getApiKey", async () => {
    mockGetOAuthProvider.mockReturnValue(undefined);
    const authStorage = makeAuthStorage();
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue("AUTHSTORAGE_KEY");
    const manager = makeOAuthManager();

    const token = await resolveProviderApiKey("anthropic", {
      authStorage: authStorage as AuthStorage,
      oauthManager: manager as OAuthTokenManager,
    });

    expect(token).toBe("AUTHSTORAGE_KEY");
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(manager.getApiKey).not.toHaveBeenCalled();
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic");
  });

  it("Test 4: OAuth-eligible but oauthManager undefined → falls through to authStorage", async () => {
    mockGetOAuthProvider.mockReturnValue(makeFakeOAuthProvider("openai-codex"));
    const authStorage = makeAuthStorage();
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue("AUTHSTORAGE_FALLBACK");

    const token = await resolveProviderApiKey("openai-codex", {
      authStorage: authStorage as AuthStorage,
      // no oauthManager
    });

    expect(token).toBe("AUTHSTORAGE_FALLBACK");
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(authStorage.getApiKey).toHaveBeenCalledWith("openai-codex");
  });

  it("Test 5: authStorage.getApiKey returns undefined → helper returns empty string", async () => {
    mockGetOAuthProvider.mockReturnValue(undefined);
    const authStorage = makeAuthStorage();
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const token = await resolveProviderApiKey("anthropic", {
      authStorage: authStorage as AuthStorage,
    });

    expect(token).toBe("");
  });

  it("Test 6: forwards agentConfig.oauthProfiles to manager as agentContext", async () => {
    mockGetOAuthProvider.mockReturnValue(makeFakeOAuthProvider("openai-codex"));
    const authStorage = makeAuthStorage();
    const manager = makeOAuthManager();
    (manager.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(ok("OAUTH_TOKEN_FOR_PROFILE"));
    const agentConfig = {
      oauthProfiles: { "openai-codex": "openai-codex:custom@example.com" },
    } as unknown as PerAgentConfig;

    const token = await resolveProviderApiKey("openai-codex", {
      authStorage: authStorage as AuthStorage,
      oauthManager: manager as OAuthTokenManager,
      agentConfig,
    });

    expect(token).toBe("OAUTH_TOKEN_FOR_PROFILE");
    expect(manager.getApiKey).toHaveBeenCalledWith("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:custom@example.com" },
    });
  });

  it("Test 7: undefined agentConfig → passes { oauthProfiles: undefined } to manager", async () => {
    mockGetOAuthProvider.mockReturnValue(makeFakeOAuthProvider("openai-codex"));
    const authStorage = makeAuthStorage();
    const manager = makeOAuthManager();
    (manager.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(ok("OAUTH_TOKEN_FALLBACK"));

    const token = await resolveProviderApiKey("openai-codex", {
      authStorage: authStorage as AuthStorage,
      oauthManager: manager as OAuthTokenManager,
      // no agentConfig
    });

    expect(token).toBe("OAUTH_TOKEN_FALLBACK");
    expect(manager.getApiKey).toHaveBeenCalledWith("openai-codex", {
      oauthProfiles: undefined,
    });
  });
});
