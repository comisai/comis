// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ok } from "@comis/shared";
import { ComisCredentialStore } from "./auth-storage-adapter.js";
import { resolveProviderApiKey } from "./resolve-provider-api-key.js";
import type { OAuthTokenManager } from "./oauth-token-manager.js";

describe("resolveProviderApiKey real SDK credential contract", () => {
  it("registers an OAuth credential that the SDK accepts for an OAuth-only provider", async () => {
    const authStorage = new ComisCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials: authStorage,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const oauthManager = {
      getApiKey: vi.fn(async () => ok("test-access-token")),
      getCredential: vi.fn(async () => ok({
        apiKey: "test-access-token",
        credential: {
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: 4_000_000_000_000,
        },
      })),
    } as unknown as OAuthTokenManager;

    await expect(resolveProviderApiKey("openai-codex", {
      authStorage,
      oauthManager,
    })).resolves.toBe("test-access-token");

    await expect(authStorage.read("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
    });
    await expect(modelRuntime.checkAuth("openai-codex")).resolves.toMatchObject({
      type: "oauth",
    });
    await expect(modelRuntime.getAuth("openai-codex")).resolves.toMatchObject({
      auth: { apiKey: "test-access-token" },
      source: "OAuth",
    });
  });
});
