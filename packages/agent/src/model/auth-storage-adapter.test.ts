// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createSecretManager } from "@comis/core";
import {
  createAuthStorageAdapter,
  DEFAULT_PROVIDER_KEYS,
} from "./auth-storage-adapter.js";

// AuthStorage.getApiKey() falls back to process.env via pi-ai's getEnvApiKey().
// pi-ai maps providers to env vars differently than our DEFAULT_PROVIDER_KEYS
// (e.g., "google" -> GEMINI_API_KEY, "anthropic" -> ANTHROPIC_OAUTH_TOKEN).
// We must clear ALL possible env vars that pi-ai checks for these providers.
const ENV_KEYS_TO_CLEAR = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
] as const;

// ---------------------------------------------------------------------------
// createAuthStorageAdapter
// ---------------------------------------------------------------------------

describe("createAuthStorageAdapter", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_CLEAR) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("populates API keys for all providers present in SecretManager", async () => {
    const secretManager = createSecretManager({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
      GOOGLE_API_KEY: "google-test",
      GROQ_API_KEY: "groq-test",
      MISTRAL_API_KEY: "mistral-test",
    });

    const storage = createAuthStorageAdapter({ secretManager });

    expect(await storage.getApiKey("anthropic")).toBe("sk-ant-test");
    expect(await storage.getApiKey("openai")).toBe("sk-openai-test");
    expect(await storage.getApiKey("google")).toBe("google-test");
    expect(await storage.getApiKey("groq")).toBe("groq-test");
    expect(await storage.getApiKey("mistral")).toBe("mistral-test");
  });

  it("skips providers not present in SecretManager without error", async () => {
    const secretManager = createSecretManager({
      ANTHROPIC_API_KEY: "sk-ant-test",
      // All other keys absent
    });

    const storage = createAuthStorageAdapter({ secretManager });

    expect(await storage.getApiKey("anthropic")).toBe("sk-ant-test");
    expect(await storage.getApiKey("openai")).toBeUndefined();
    expect(await storage.getApiKey("google")).toBeUndefined();
    expect(await storage.getApiKey("groq")).toBeUndefined();
    expect(await storage.getApiKey("mistral")).toBeUndefined();
  });

  it("supports additionalProviderKeys for custom providers", async () => {
    const secretManager = createSecretManager({
      DEEPSEEK_API_KEY: "deepseek-test-key",
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      additionalProviderKeys: { deepseek: "DEEPSEEK_API_KEY" },
    });

    expect(await storage.getApiKey("deepseek")).toBe("deepseek-test-key");
  });

  it("additionalProviderKeys overrides default provider key names", async () => {
    const secretManager = createSecretManager({
      CUSTOM_ANTHROPIC_KEY: "custom-key",
      // ANTHROPIC_API_KEY not set -- default key would miss
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      additionalProviderKeys: { anthropic: "CUSTOM_ANTHROPIC_KEY" },
    });

    expect(await storage.getApiKey("anthropic")).toBe("custom-key");
  });

  it("returns an AuthStorage instance", () => {
    const secretManager = createSecretManager({});
    const storage = createAuthStorageAdapter({ secretManager });

    expect(storage).toBeInstanceOf(AuthStorage);
  });

  it("exposes 5 default provider key mappings", () => {
    expect(Object.keys(DEFAULT_PROVIDER_KEYS)).toEqual([
      "anthropic",
      "openai",
      "google",
      "groq",
      "mistral",
    ]);

    expect(DEFAULT_PROVIDER_KEYS.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(DEFAULT_PROVIDER_KEYS.openai).toBe("OPENAI_API_KEY");
    expect(DEFAULT_PROVIDER_KEYS.google).toBe("GOOGLE_API_KEY");
    expect(DEFAULT_PROVIDER_KEYS.groq).toBe("GROQ_API_KEY");
    expect(DEFAULT_PROVIDER_KEYS.mistral).toBe("MISTRAL_API_KEY");
  });
});
