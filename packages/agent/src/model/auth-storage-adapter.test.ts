// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findEnvKeys, getProviders } from "@earendil-works/pi-ai/compat";
import { createSecretManager, createSecretManagerWithMutableHandle } from "@comis/core";
import {
  ComisCredentialStore,
  createAuthStorageAdapter,
  getProviderSecretNames,
  getProvidersForSecretName,
  PROVIDER_SECRET_KEYS,
  syncCredentialsForSecretChange,
  syncProviderCredential,
} from "./auth-storage-adapter.js";

// AuthStorage.getApiKey() falls back to process.env via pi-ai's getEnvApiKey().
// AuthStorage falls back to the ambient environment. Clear every catalog key
// so these tests prove that the Comis SecretManager bridge supplied the value.
const configuredEnv = new Proxy<Record<string, string>>({}, { get: () => "test-key" });
const ENV_KEYS_TO_CLEAR = [
  ...new Set([
    "GOOGLE_API_KEY",
    ...getProviders().flatMap((provider) => findEnvKeys(provider, configuredEnv) ?? []),
  ]),
];

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

  it("populates API keys for every mapped static provider", async () => {
    const secrets = Object.fromEntries(
      Object.values(PROVIDER_SECRET_KEYS).flat().map((name) => [name, `value-for-${name}`]),
    );
    Object.assign(secrets, {
      CLOUDFLARE_ACCOUNT_ID: "account_a",
      CLOUDFLARE_GATEWAY_ID: "gateway_a",
    });
    const secretManager = createSecretManager(secrets);

    const storage = createAuthStorageAdapter({ secretManager });

    for (const [provider, names] of Object.entries(PROVIDER_SECRET_KEYS)) {
      expect(await storage.getApiKey(provider), provider).toBe(`value-for-${names[0]}`);
    }
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

  it("returns a ComisCredentialStore instance", () => {
    const secretManager = createSecretManager({});
    const storage = createAuthStorageAdapter({ secretManager });

    expect(storage).toBeInstanceOf(ComisCredentialStore);
  });

  it("keeps Comis key precedence while accepting catalog aliases", () => {
    expect(getProviderSecretNames("anthropic")).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
    ]);
    expect(getProviderSecretNames("google")).toEqual([
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ]);
  });

  it("covers every static credential advertised by the current provider catalog", () => {
    const missing: string[] = [];

    for (const provider of getProviders()) {
      const catalogKeys = findEnvKeys(provider, configuredEnv) ?? [];
      const configuredKeys = getProviderSecretNames(provider);
      for (const catalogKey of catalogKeys) {
        if (!configuredKeys.includes(catalogKey)) missing.push(`${provider}:${catalogKey}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("uses catalog aliases when the preferred Comis key is absent", async () => {
    const storage = createAuthStorageAdapter({
      secretManager: createSecretManager({ GEMINI_API_KEY: "gemini-test-key" }),
    });

    expect(await storage.getApiKey("google")).toBe("gemini-test-key");
  });

  it("falls back to the next alias after a hot secret removal", async () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      GOOGLE_API_KEY: "google-primary",
      GEMINI_API_KEY: "gemini-fallback",
    });
    const storage = createAuthStorageAdapter({ secretManager });

    mutableHandle.remove("GOOGLE_API_KEY");
    syncProviderCredential(storage, secretManager, "google");

    expect(await storage.getApiKey("google")).toBe("gemini-fallback");
  });

  it("maps shared and auxiliary secret names to every affected provider", () => {
    expect(getProvidersForSecretName("MOONSHOT_API_KEY")).toEqual([
      "moonshotai",
      "moonshotai-cn",
    ]);
    expect(getProvidersForSecretName("CLOUDFLARE_ACCOUNT_ID")).toEqual([
      "cloudflare-workers-ai",
      "cloudflare-ai-gateway",
    ]);
  });

  it("attaches Cloudflare routing identifiers to stored credentials", () => {
    const storage = createAuthStorageAdapter({
      secretManager: createSecretManager({
        CLOUDFLARE_API_KEY: "cloudflare-test-key",
        CLOUDFLARE_ACCOUNT_ID: "account_a",
        CLOUDFLARE_GATEWAY_ID: "gateway_a",
      }),
    });

    expect(storage.getProviderEnv("cloudflare-workers-ai")).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account_a",
    });
    expect(storage.getProviderEnv("cloudflare-ai-gateway")).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account_a",
      CLOUDFLARE_GATEWAY_ID: "gateway_a",
    });
  });

  it("accepts a Vertex API key without ADC project and location values", async () => {
    const storage = createAuthStorageAdapter({
      secretManager: createSecretManager({
        GOOGLE_CLOUD_API_KEY: "vertex-test-key",
      }),
    });

    expect(await storage.getApiKey("google-vertex")).toBe("vertex-test-key");
    expect(storage.getProviderEnv("google-vertex")).toBeUndefined();
  });

  it("rejects Cloudflare Gateway credentials without a gateway identifier", async () => {
    const storage = createAuthStorageAdapter({
      secretManager: createSecretManager({
        CLOUDFLARE_API_KEY: "cloudflare-test-key",
        CLOUDFLARE_ACCOUNT_ID: "account_a",
      }),
    });

    expect(storage.get("cloudflare-ai-gateway")).toBeUndefined();
    expect(await storage.getApiKey("cloudflare-ai-gateway")).toBeUndefined();
  });

  it("registers customProviderEntries as runtime API keys via apiKeyName lookup", async () => {
    const secretManager = createSecretManager({
      NVIDIA_API_KEY: "nvapi-test-secret",
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "custom-nvidia": { apiKeyName: "NVIDIA_API_KEY", enabled: true },
      },
    });

    expect(await storage.getApiKey("custom-nvidia")).toBe("nvapi-test-secret");
    expect(storage.hasAuth("custom-nvidia")).toBe(true);
  });

  it("refreshes a custom provider when its configured secret changes", async () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      PRIVATE_GATEWAY_API_KEY: "first-key",
    });
    const customProviderEntries = {
      "private-gateway": {
        type: "openai",
        apiKeyName: "PRIVATE_GATEWAY_API_KEY",
        enabled: true,
      },
    };
    const storage = createAuthStorageAdapter({ secretManager, customProviderEntries });

    mutableHandle.upsert("PRIVATE_GATEWAY_API_KEY", "rotated-key");
    syncCredentialsForSecretChange(
      storage,
      secretManager,
      "PRIVATE_GATEWAY_API_KEY",
      customProviderEntries,
    );
    expect(await storage.getApiKey("private-gateway")).toBe("rotated-key");

    mutableHandle.remove("PRIVATE_GATEWAY_API_KEY");
    syncCredentialsForSecretChange(
      storage,
      secretManager,
      "PRIVATE_GATEWAY_API_KEY",
      customProviderEntries,
    );
    expect(await storage.getApiKey("private-gateway")).toBeUndefined();
  });

  it("does not reactivate an Anthropic API key when explicit OAuth selection is removed", async () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      ANTHROPIC_API_KEY: "inactive-api-key",
      ANTHROPIC_OAUTH_TOKEN: "selected-oauth-token",
    });
    const customProviderEntries = {
      anthropic: {
        type: "anthropic",
        apiKeyName: "ANTHROPIC_OAUTH_TOKEN",
        enabled: true,
      },
    };
    const storage = createAuthStorageAdapter({ secretManager, customProviderEntries });

    expect(await storage.getApiKey("anthropic")).toBe("selected-oauth-token");

    mutableHandle.remove("ANTHROPIC_OAUTH_TOKEN");
    syncCredentialsForSecretChange(
      storage,
      secretManager,
      "ANTHROPIC_OAUTH_TOKEN",
      customProviderEntries,
    );

    expect(await storage.getApiKey("anthropic")).toBeUndefined();
  });

  it("skips disabled custom provider entries", async () => {
    const secretManager = createSecretManager({
      NVIDIA_API_KEY: "nvapi-test-secret",
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "custom-nvidia": { apiKeyName: "NVIDIA_API_KEY", enabled: false },
      },
    });

    expect(await storage.getApiKey("custom-nvidia")).toBeUndefined();
  });

  it("skips custom provider entries with empty apiKeyName", async () => {
    const secretManager = createSecretManager({
      NVIDIA_API_KEY: "nvapi-test-secret",
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "custom-nvidia": { apiKeyName: "", enabled: true },
      },
    });

    expect(await storage.getApiKey("custom-nvidia")).toBeUndefined();
  });

  it("skips custom provider entries when SecretManager has no value for apiKeyName", async () => {
    const secretManager = createSecretManager({
      // NVIDIA_API_KEY intentionally absent
    });

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "custom-nvidia": { apiKeyName: "NVIDIA_API_KEY", enabled: true },
      },
    });

    expect(await storage.getApiKey("custom-nvidia")).toBeUndefined();
    expect(storage.hasAuth("custom-nvidia")).toBe(false);
  });

  // Live incident: a keyless
  // local Ollama provider (type "ollama", no apiKeyName) got NO runtime key, so
  // resolveProviderApiKey -> authStorage.getApiKey returned "" and the LCD
  // summarizer's SDK call threw "No API key for provider: <id>", tripping the
  // summarizer breaker -> every summary degraded to a truncation fallback ->
  // distillation could never fire (fallback markers are never distilled). The
  // main LLM path worked because the model-registry-adapter bakes the
  // "ollama-no-auth" sentinel; the summarizer key path bypassed it. Populate the
  // sentinel here so EVERY path resolves a key uniformly for keyless providers.
  it("registers a keyless-type provider with the ollama-no-auth sentinel when apiKeyName is empty", async () => {
    const secretManager = createSecretManager({});

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "qwen36-local": { type: "ollama", apiKeyName: "", enabled: true },
        "lmstudio-local": { type: "lm-studio", apiKeyName: "", enabled: true },
      },
    });

    expect(await storage.getApiKey("qwen36-local")).toBe("ollama-no-auth");
    expect(await storage.getApiKey("lmstudio-local")).toBe("ollama-no-auth");
  });

  it("prefers a real configured key over the keyless sentinel for a keyless-type provider", async () => {
    const secretManager = createSecretManager({ OLLAMA_API_KEY: "real-ollama-key" });

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        "qwen36-local": { type: "ollama", apiKeyName: "OLLAMA_API_KEY", enabled: true },
      },
    });

    expect(await storage.getApiKey("qwen36-local")).toBe("real-ollama-key");
  });

  it("does not use the keyless sentinel when an explicit provider key is missing", async () => {
    const storage = createAuthStorageAdapter({
      secretManager: createSecretManager({}),
      customProviderEntries: {
        "secured-ollama": {
          type: "ollama",
          apiKeyName: "OLLAMA_API_KEY",
          enabled: true,
        },
      },
    });

    expect(await storage.getApiKey("secured-ollama")).toBeUndefined();
  });

  it("does NOT apply the keyless sentinel to a non-keyless type with empty apiKeyName", async () => {
    const secretManager = createSecretManager({});

    const storage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: {
        nvidia: { type: "openai", apiKeyName: "", enabled: true },
      },
    });

    expect(await storage.getApiKey("nvidia")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ComisCredentialStore — pi-ai CredentialStore contract
// ---------------------------------------------------------------------------
// pi's ModelRuntime resolves request auth live through this interface
// (read/list/modify/delete), so a sync write into the store must be visible
// to the very next read. These tests pin that contract plus the
// runtime-override layer the rotation adapter and OAuth pre-resolve write to.

describe("ComisCredentialStore — CredentialStore contract", () => {
  it("read() returns the stored credential and undefined when absent", async () => {
    const store = new ComisCredentialStore();
    store.set("anthropic", { type: "api_key", key: "sk-1" });

    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-1" });
    await expect(store.read("openai")).resolves.toBeUndefined();
  });

  it("read() surfaces a runtime override as an api_key credential, keeping the stored env", async () => {
    const store = new ComisCredentialStore();
    store.set("cloudflare-ai-gateway", {
      type: "api_key",
      key: "stored-key",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
    });
    store.setRuntimeApiKey("cloudflare-ai-gateway", "rotated-key");

    await expect(store.read("cloudflare-ai-gateway")).resolves.toEqual({
      type: "api_key",
      key: "rotated-key",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
    });
  });

  it("a sync setRuntimeApiKey is visible to the next read() — the rotation contract", async () => {
    const store = new ComisCredentialStore();
    store.setRuntimeApiKey("anthropic", "key-A");
    await expect(store.read("anthropic")).resolves.toMatchObject({ key: "key-A" });

    store.setRuntimeApiKey("anthropic", "key-B");
    await expect(store.read("anthropic")).resolves.toMatchObject({ key: "key-B" });

    store.removeRuntimeApiKey("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });

  it("list() unions stored credentials and runtime overrides without duplicates", async () => {
    const store = new ComisCredentialStore();
    store.set("anthropic", { type: "api_key", key: "sk-1" });
    store.setRuntimeApiKey("anthropic", "override");
    store.setRuntimeApiKey("openai", "runtime-only");

    const infos = await store.list();
    const ids = infos.map((i) => i.providerId).sort();
    expect(ids).toEqual(["anthropic", "openai"]);
    expect(infos.every((i) => i.type === "api_key")).toBe(true);
  });

  it("modify() persists the returned credential and serializes per provider", async () => {
    const store = new ComisCredentialStore();
    store.set("anthropic", { type: "api_key", key: "v0" });

    const order: string[] = [];
    const slow = store.modify("anthropic", async (current) => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
      return { type: "api_key", key: `${(current as { key?: string })?.key}-slow` };
    });
    const fast = store.modify("anthropic", async (current) => {
      order.push("fast");
      return { type: "api_key", key: `${(current as { key?: string })?.key}-fast` };
    });

    await Promise.all([slow, fast]);
    // The second modify must observe the first one's write.
    expect(order).toEqual(["slow", "fast"]);
    expect(store.get("anthropic")).toEqual({ type: "api_key", key: "v0-slow-fast" });
  });

  it("modify() returning undefined leaves the entry unchanged and resolves the current value", async () => {
    const store = new ComisCredentialStore();
    store.set("anthropic", { type: "api_key", key: "keep" });

    const result = await store.modify("anthropic", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "keep" });
    expect(store.get("anthropic")).toEqual({ type: "api_key", key: "keep" });
  });

  it("delete() removes both the stored credential and any runtime override", async () => {
    const store = new ComisCredentialStore();
    store.set("anthropic", { type: "api_key", key: "sk-1" });
    store.setRuntimeApiKey("anthropic", "override");

    await store.delete("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
    expect(store.getStoredApiKey("anthropic")).toBeUndefined();
  });

  it("getApiKey({includeFallback:false}) never consults the ambient environment", async () => {
    const store = new ComisCredentialStore();
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      expect(await store.getApiKey("anthropic", { includeFallback: false })).toBeUndefined();
      expect(await store.getApiKey("anthropic")).toBe("ambient-key");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
