// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for provider-oauth-catalog.ts.
 *
 * Eligibility tests run against the real pi-ai builtin provider catalog
 * (pure, no network). Refresh/derive tests inject a fake OAuthAuth through
 * the oauthOverride seam — NO vi.mock.
 */

import { describe, it, expect, vi } from "vitest";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
  getProviderOAuth,
  listOAuthProviderIds,
  resolveOAuthApiKey,
} from "./provider-oauth-catalog.js";

function makeFakeOAuth(overrides: Partial<OAuthAuth> = {}): OAuthAuth {
  return {
    name: "Fake",
    login: vi.fn(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 })),
    refresh: vi.fn(async (cred: OAuthCredential) => ({
      ...cred,
      access: "refreshed-access",
      refresh: "refreshed-refresh",
      expires: Date.now() + 3_600_000,
    })),
    toAuth: vi.fn(async (cred: OAuthCredential) => ({ apiKey: cred.access })),
    ...overrides,
  };
}

describe("getProviderOAuth / listOAuthProviderIds", () => {
  it("returns an OAuth flow for each OAuth-capable builtin provider", () => {
    expect(getProviderOAuth("anthropic")).toBeDefined();
    expect(getProviderOAuth("openai-codex")).toBeDefined();
    expect(getProviderOAuth("github-copilot")).toBeDefined();
  });

  it("returns undefined for api-key-only and unknown providers", () => {
    expect(getProviderOAuth("openai")).toBeUndefined();
    expect(getProviderOAuth("no-such-provider")).toBeUndefined();
  });

  it("lists OAuth provider ids including the long-standing trio", () => {
    const ids = listOAuthProviderIds();
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai-codex", "github-copilot"]));
    expect(ids).not.toContain("openai");
  });
});

describe("resolveOAuthApiKey", () => {
  const validCreds = { access: "live-access", refresh: "live-refresh", expires: Date.now() + 3_600_000 };

  it("throws for an unknown OAuth provider", async () => {
    await expect(resolveOAuthApiKey("no-such-provider", {})).rejects.toThrow(
      /Unknown OAuth provider/,
    );
  });

  it("returns null when no credentials are stored for the provider", async () => {
    const oauth = makeFakeOAuth();
    await expect(
      resolveOAuthApiKey("anthropic", {}, { oauthOverride: oauth }),
    ).resolves.toBeNull();
  });

  it("derives the api key without refreshing when the token is still valid", async () => {
    const oauth = makeFakeOAuth();
    const result = await resolveOAuthApiKey(
      "anthropic",
      { anthropic: validCreds },
      { oauthOverride: oauth },
    );
    expect(result).toEqual({ newCredentials: validCreds, apiKey: "live-access" });
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and returns the new credentials", async () => {
    const oauth = makeFakeOAuth();
    const expired = { access: "old", refresh: "old-refresh", expires: Date.now() - 1 };
    const result = await resolveOAuthApiKey(
      "anthropic",
      { anthropic: expired },
      { oauthOverride: oauth },
    );
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("refreshed-access");
    expect(result?.newCredentials.refresh).toBe("refreshed-refresh");
  });

  it("wraps refresh failures in the provider-scoped error", async () => {
    const oauth = makeFakeOAuth({
      refresh: vi.fn(async () => {
        throw new Error("invalid_grant");
      }),
    });
    const expired = { access: "old", refresh: "old-refresh", expires: Date.now() - 1 };
    await expect(
      resolveOAuthApiKey("anthropic", { anthropic: expired }, { oauthOverride: oauth }),
    ).rejects.toThrow("Failed to refresh OAuth token for anthropic");
  });

  it("fails when the derived auth carries no api key", async () => {
    const oauth = makeFakeOAuth({ toAuth: vi.fn(async () => ({})) });
    await expect(
      resolveOAuthApiKey("anthropic", { anthropic: validCreds }, { oauthOverride: oauth }),
    ).rejects.toThrow(/no api key/i);
  });
});
