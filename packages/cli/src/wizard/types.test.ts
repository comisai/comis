// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findEnvKeys, getProviders } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ENV_KEYS } from "./types.js";

const configuredEnv = new Proxy<Record<string, string>>({}, { get: () => "test-key" });
const NON_SINGLE_KEY_PROVIDERS = new Set([
  "amazon-bedrock",
  "openai-codex",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
]);

describe("provider credential persistence map", () => {
  it("covers every catalog provider with a single entered credential", () => {
    const missing = getProviders().filter((provider) => {
      if (NON_SINGLE_KEY_PROVIDERS.has(provider)) return false;
      if ((findEnvKeys(provider, configuredEnv) ?? []).length === 0) return false;
      return PROVIDER_ENV_KEYS[provider] === undefined;
    });

    expect(missing).toEqual([]);
  });

  it("uses a catalog-recognized secret name for every single-value provider", () => {
    const mismatched = getProviders().filter((provider) => {
      if (NON_SINGLE_KEY_PROVIDERS.has(provider)) return false;
      const configuredName = PROVIDER_ENV_KEYS[provider];
      if (configuredName === undefined) return false;
      const catalogNames = findEnvKeys(provider, configuredEnv) ?? [];
      const acceptedNames = provider === "google"
        ? [...catalogNames, "GOOGLE_API_KEY"]
        : catalogNames;
      return !acceptedNames.includes(configuredName);
    });

    expect(mismatched).toEqual([]);
  });
});
