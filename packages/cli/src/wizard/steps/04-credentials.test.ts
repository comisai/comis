// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for credentials entry step (step 04).
 *
 * Verifies API key collection and live validation for standard providers,
 * ollama skip, custom endpoint flow, and retry/continue/skip recovery.
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState, ProviderConfig } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Mock pi-ai's getModels so we control the catalog baseUrl in tests
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    getModels: vi.fn(() => [{ baseUrl: "https://api.anthropic.com" }]),
  };
});

// Mock @comis/core's interactive OAuth flow for the dispatch tests.
// The mock returns a controllable Result so the dispatch branches can
// be exercised without a real browser open or callback server.
// selectOAuthCredentialStore is stubbed to an in-memory port so the
// test never touches ~/.comis/auth-profiles.json on the test host's
// filesystem. loadConfigFile is also mocked here so the wizard defaults
// to file storage.
// Module-level toggle for the mocked systemGetEnv("SECRETS_MASTER_KEY").
// When truthy, the wizard's encrypted-default fallback resolves "encrypted";
// when undefined, it resolves "file". COMIS_CONFIG_PATHS / COMIS_DATA_DIR
// always resolve undefined so the standard ~/.comis paths apply.
let masterKeyState: string | undefined;

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    loginOpenAICodexOAuth: vi.fn(),
    isRemoteEnvironment: vi.fn().mockReturnValue(false),
    systemGetEnv: vi.fn((key: string) =>
      key === "SECRETS_MASTER_KEY" ? masterKeyState : undefined,
    ),
    selectOAuthCredentialStore: vi.fn().mockImplementation(() => {
      const inMemory = new Map<string, unknown>();
      return {
        get: async (id: string) => ({ ok: true as const, value: inMemory.get(id) }),
        set: async (id: string, p: unknown) => {
          inMemory.set(id, p);
          return { ok: true as const, value: undefined };
        },
        delete: async (id: string) => {
          const had = inMemory.delete(id);
          return { ok: true as const, value: had };
        },
        list: async () => ({ ok: true as const, value: Array.from(inMemory.values()) }),
        has: async (id: string) => ({ ok: true as const, value: inMemory.has(id) }),
      };
    }),
    loadConfigFile: vi
      .fn()
      .mockReturnValue({ ok: false, error: new Error("no config") }),
    validateConfig: vi.fn().mockImplementation((raw: unknown) => {
      // Pass through whatever the test set up in loadConfigFile
      return { ok: true, value: raw };
    }),
  };
});

// Mock rpc-client so encrypted-mode wizard tests can assert callTyped was
// invoked with AuthSetContract without requiring a real daemon connection.
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ profileId: "openai-codex:test@example.com", stored: true })),
  // Mirrors the real impl (rpc-client.ts) so the 4001-auth-rejection fallback
  // test is faithful: true iff the error message carries the rejection prefix.
  isGatewayAuthRejection: (e: unknown) =>
    e instanceof Error && e.message.startsWith("Gateway rejected the token"),
}));

// Mock requireDaemonOrExit + DAEMON_PROBE_TIMEOUT_MS. requireDaemonOrExit is
// not used by the encrypted branch (it probes isDaemonRunning and
// routes daemon-up->RPC / daemon-down->offline); the harmless stub is retained.
vi.mock("../../util/daemon-required.js", () => ({
  requireDaemonOrExit: vi.fn(async () => undefined),
  DAEMON_PROBE_TIMEOUT_MS: 200,
}));

// Mock the daemon guard so encrypted-mode tests can toggle daemon up/down.
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(),
}));

// Mock the L11 offline store so the daemon-down encrypted path is observable
// without touching a real secrets.db.
vi.mock("../../util/offline-secrets-store.js", () => ({
  offlineOAuthProfileSet: vi.fn(async () => ({ ok: true })),
}));

import { credentialsStep } from "./04-credentials.js";
import { getModels } from "@earendil-works/pi-ai/compat";
import { loginOpenAICodexOAuth, isRemoteEnvironment, loadConfigFile, validateConfig, selectOAuthCredentialStore } from "@comis/core";
import { callTyped, withClient } from "../../client/rpc-client.js";
import { requireDaemonOrExit } from "../../util/daemon-required.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { offlineOAuthProfileSet } from "../../util/offline-secrets-store.js";

// Capture the un-mocked `getModels` so the composed-URL regression tests
// can compose URLs against the real pi-ai catalog (the module-level
// `vi.mock` returns a sentinel baseUrl).
let actualGetModels: typeof import("@earendil-works/pi-ai/compat").getModels;

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>(
    "@earendil-works/pi-ai/compat",
  );
  actualGetModels = actual.getModels;
});

// ---------- Mock Prompter Factory ----------

function createMockPrompter(
  overrides: Partial<Record<string, unknown>> = {},
): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn().mockResolvedValue(overrides.select),
    multiselect: vi.fn().mockResolvedValue(overrides.multiselect ?? []),
    text: vi.fn().mockResolvedValue(overrides.text ?? ""),
    password: vi.fn().mockResolvedValue(overrides.password ?? ""),
    confirm: vi.fn().mockResolvedValue(overrides.confirm ?? true),
    spinner: vi.fn(
      (): Spinner => ({
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    group: vi.fn(
      async (steps: Record<string, () => Promise<unknown>>) => {
        const results: Record<string, unknown> = {};
        for (const [key, fn] of Object.entries(steps)) {
          results[key] = await fn();
        }
        return results;
      },
    ),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

// ---------- Tests ----------

describe("credentialsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global.fetch for live validation
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct step id and label", () => {
    expect(credentialsStep.id).toBe("credentials");
    expect(credentialsStep.label).toBe("API Credentials");
  });

  it("skips API key entirely for ollama provider", async () => {
    const prompter = createMockPrompter();
    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "ollama" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.validated).toBe(true);
    expect(prompter.password).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalled();
  });

  it("guides Amazon Bedrock users to the ambient AWS credential chain", async () => {
    const prompter = createMockPrompter();
    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "amazon-bedrock" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider).toEqual({ id: "amazon-bedrock", validated: false });
    expect(prompter.password).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("AWS credential chain"),
      expect.stringContaining("Amazon Bedrock"),
    );
  });

  it.each([
    ["cloudflare-workers-ai", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    ["cloudflare-ai-gateway", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  ])(
    "fails clearly when %s needs multiple credential values",
    async (providerId, firstRequiredName, secondRequiredName) => {
      const prompter = createMockPrompter({ password: "test-key" });
      const state: WizardState = {
        ...INITIAL_STATE,
        provider: { id: providerId } as ProviderConfig,
      };

      await expect(credentialsStep.execute(state, prompter)).rejects.toThrow(firstRequiredName);
      await expect(credentialsStep.execute(state, prompter)).rejects.toThrow(secondRequiredName);
    },
  );

  it("collects custom endpoint details for custom provider", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("https://my-llm.internal/v1") // base URL
      .mockResolvedValueOnce("my-custom-model"); // model ID
    vi.mocked(prompter.select).mockResolvedValueOnce("openai"); // compat mode
    vi.mocked(prompter.password).mockResolvedValueOnce("my-key-123");

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "custom" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.id).toBe("custom");
    expect(result.provider?.customEndpoint).toBe("https://my-llm.internal/v1");
    expect(result.provider?.compatMode).toBe("openai");
    expect(result.provider?.apiKey).toBe("my-key-123");
    expect(result.provider?.validated).toBe(false);
    expect(result.model).toBe("my-custom-model");
  });

  it("validates API key successfully for standard provider", async () => {
    const prompter = createMockPrompter();
    // First select = auth method for anthropic
    vi.mocked(prompter.select).mockResolvedValueOnce("apikey");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-api03-validkey1234567890abcdefghijklmnop",
    );

    // fetch returns 200 OK
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.apiKey).toBe(
      "sk-ant-api03-validkey1234567890abcdefghijklmnop",
    );
    expect(result.provider?.validated).toBe(true);

    // Spinner should have been created and used
    expect(prompter.spinner).toHaveBeenCalled();
  });

  it("offers retry/continue/skip when live validation fails", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.password).mockResolvedValue(
      "sk-ant-api03-invalidkey12345678901234567890ab",
    );

    // fetch returns 401
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    // First select = auth method, second select = recovery choice ("continue")
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("apikey")
      .mockResolvedValueOnce("continue");

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.validated).toBe(false);
    expect(result.provider?.apiKey).toBe(
      "sk-ant-api03-invalidkey12345678901234567890ab",
    );
  });

  it("returns original state when user chooses skip on validation failure", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.password).mockResolvedValue(
      "sk-ant-api03-invalidkey12345678901234567890ab",
    );

    // fetch returns 401
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    // First select = auth method, second select = recovery choice ("skip")
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("apikey")
      .mockResolvedValueOnce("skip");

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // Skip returns original state unchanged
    expect(result).toEqual(state);
  });

  it("retries on validation failure then succeeds", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.password)
      .mockResolvedValueOnce("sk-ant-api03-badkey11234567890abcdefghijklmnop")
      .mockResolvedValueOnce("sk-ant-api03-goodkey1234567890abcdefghijklmnop");

    // First fetch fails, second succeeds
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    // First select = auth method, second select = recovery choice ("retry")
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("apikey")
      .mockResolvedValueOnce("retry");

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.apiKey).toBe(
      "sk-ant-api03-goodkey1234567890abcdefghijklmnop",
    );
    expect(prompter.password).toHaveBeenCalledTimes(2);
  });

  it("skips credentials when no provider is selected", async () => {
    const prompter = createMockPrompter();
    const state: WizardState = { ...INITIAL_STATE };

    const result = await credentialsStep.execute(state, prompter);

    expect(result).toEqual(state);
    expect(prompter.log.warn).toHaveBeenCalled();
  });

  it("shows auth method selector for anthropic", async () => {
    const prompter = createMockPrompter();
    // First select call = auth method, then password
    vi.mocked(prompter.select).mockResolvedValueOnce("apikey");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-api03-validkey1234567890abcdefghijklmnop",
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // Auth method select should have been called
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "anthropic authentication method",
      }),
    );
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBe("apikey");
  });

  it("accepts OAuth token for anthropic without prefix check", async () => {
    const prompter = createMockPrompter();
    // Auth method = oauth
    vi.mocked(prompter.select).mockResolvedValueOnce("oauth");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-oat01-someOAuthTokenValueThatIsLongEnoughToPass",
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.validated).toBe(false);
    expect(result.provider?.authMethod).toBe("oauth");
    expect(result.provider?.apiKey).toBe(
      "sk-ant-oat01-someOAuthTokenValueThatIsLongEnoughToPass",
    );
  });

  // openai is API-key-only -- there is no auth-method selector because
  // OAuth lives exclusively on `openai-codex`. The dispatcher skips the
  // auth-method select for openai and routes directly to the standard
  // API-key paste flow.
  it("openai uses standard API-key path (no auth-method selector)", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-validkey1234567890abcdefghijklmnopqrstuv",
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // No auth-method picker for openai (only anthropic has one).
    expect(prompter.select).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBeUndefined();
    expect(result.provider?.id).toBe("openai");
  });

  it("does not show auth method selector for non-OAuth providers", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "gsk_" + "a".repeat(50),
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "groq" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // select should NOT have been called (no auth method selector for groq)
    expect(prompter.select).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBeUndefined();
  });

  it("skips live validation for anthropic OAuth tokens", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("oauth");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-oat01-myOAuthTokenValueGoesHere12345678",
    );

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // OAuth skips live validation entirely -- no fetch call
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(false);
    expect(result.provider?.authMethod).toBe("oauth");
  });

  it("rejects a custom endpoint when its required API key is empty", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("https://internal-api.local/v1")
      .mockResolvedValueOnce("local-model");
    vi.mocked(prompter.select).mockResolvedValueOnce("anthropic");
    vi.mocked(prompter.password).mockResolvedValueOnce(""); // empty key

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "custom" } as ProviderConfig,
    };

    await expect(credentialsStep.execute(state, prompter)).rejects.toThrow(
      "API key is required for custom endpoints",
    );
  });

  // ---------- catalog-driven validation regression tests ----------

  it("validation URL is built from pi-ai catalog baseUrl, not a hardcoded map", async () => {
    // Pin the catalog baseUrl to a sentinel and assert fetch was called
    // with a URL beginning with that sentinel.
    vi.mocked(getModels).mockReturnValue([
      { baseUrl: "https://api.anthropic.com" },
    ] as never);

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("apikey");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-api03-validkey1234567890abcdefghijklmnop",
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    await credentialsStep.execute(state, prompter);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const fetchUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(fetchUrl.startsWith("https://api.anthropic.com")).toBe(true);
    expect(fetchUrl).toContain("/v1/models");
  });

  it("marks credentials unverified when the catalog has no validation base URL", async () => {
    // No baseUrl means the wizard cannot make an accurate provider request.
    vi.mocked(getModels).mockReturnValue([] as never);

    const prompter = createMockPrompter();
    // Use a non-OAuth provider (groq) -> no auth-method select call
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "gsk_" + "a".repeat(50),
    );

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "groq" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    // Live validation skipped -- no fetch call
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(false);
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("not live-validated"),
    );
  });

  it("does not guess a models path for providers without an explicit validation contract", async () => {
    vi.mocked(getModels).mockReturnValue([
      { baseUrl: "https://integrate.api.nvidia.com/v1" },
    ] as never);

    const prompter = createMockPrompter();
    vi.mocked(prompter.password).mockResolvedValueOnce("nvapi-test-key");
    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "nvidia" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(false);
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("not live-validated"),
    );
  });

  it("anthropic OAuth tokens still skip live validation entirely (regression pin)", async () => {
    // OAuth tokens cannot validate against /models -- existing fast path
    // (lines 124-126) must still trigger BEFORE the catalog lookup.
    vi.mocked(getModels).mockReturnValue([
      { baseUrl: "https://api.anthropic.com" },
    ] as never);

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("oauth");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-oat01-someOAuthTokenValueThatIsLongEnoughToPass",
    );

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(false);
    expect(result.provider?.authMethod).toBe("oauth");
  });

  it("PROVIDER_VALIDATION map is gone; getValidationEndpoint + PROVIDER_VALIDATION_PATHS are present", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "04-credentials.ts"), "utf-8");
    // Dropped: const PROVIDER_VALIDATION: Record<string, ...>
    expect(src).not.toMatch(/const PROVIDER_VALIDATION\s*:\s*Record/);
    // New artifacts present
    expect(src).toMatch(/PROVIDER_VALIDATION_PATHS/);
    expect(src).toMatch(/getValidationEndpoint/);
    expect(src).toMatch(/getModels.*KnownProvider.*baseUrl/);
  });

  // ---------- composed-URL regression tests ----------

  // Drive the credentialsStep flow with the real pi-ai catalog and capture
  // the URL passed to fetch. The mock `prompter.password` resolves directly
  // (no validate-hook invocation), so any non-empty string passes through.
  async function captureComposedUrl(providerId: string): Promise<string> {
    // Restore the real catalog for this composition so the URL reflects
    // the installed pi-ai catalog's baseUrl shape (vs the per-test sentinel).
    vi.mocked(getModels).mockImplementation(actualGetModels);

    const prompter = createMockPrompter();
    // Anthropic + openai have OAuth selectors -> first select() = "apikey".
    if (providerId === "anthropic" || providerId === "openai") {
      vi.mocked(prompter.select).mockResolvedValueOnce("apikey");
    }
    // Mock prompter.password resolves directly -- the validate hook is
    // never invoked by the mock, so any non-empty string passes through.
    vi.mocked(prompter.password).mockResolvedValueOnce("x".repeat(60));

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: providerId } as ProviderConfig,
    };

    await credentialsStep.execute(state, prompter);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const callArg = vi.mocked(globalThis.fetch).mock.calls[0][0];
    return typeof callArg === "string" ? callArg : (callArg as URL).toString();
  }

  it("composed URL for each known provider matches the canonical /models endpoint", async () => {
    const expected: Record<string, string> = {
      anthropic:  "https://api.anthropic.com/v1/models",
      openai:     "https://api.openai.com/v1/models",
      google:     "https://generativelanguage.googleapis.com/v1beta/models",
      groq:       "https://api.groq.com/openai/v1/models",
      mistral:    "https://api.mistral.ai/v1/models",
      deepseek:   "https://api.deepseek.com/v1/models",
      xai:        "https://api.x.ai/v1/models",
      cerebras:   "https://api.cerebras.ai/v1/models",
      openrouter: "https://openrouter.ai/api/v1/models",
    };

    for (const [provider, canonical] of Object.entries(expected)) {
      vi.clearAllMocks();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      );
      const composed = await captureComposedUrl(provider);
      // google appends ?key=... -> strip the query for canonical comparison.
      const composedBase = composed.split("?")[0];
      expect(composedBase, `composed URL for ${provider}`).toBe(canonical);
      vi.unstubAllGlobals();
    }
  });

  it("composed URL contains no duplicated version segments (regression guard)", async () => {
    const providers = [
      "anthropic", "openai", "google", "groq",
      "mistral", "deepseek", "xai", "cerebras", "openrouter",
    ];
    const segments = ["/v1/", "/v1beta/", "/openai/v1/", "/api/v1/"];

    for (const provider of providers) {
      vi.clearAllMocks();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      );
      const composed = await captureComposedUrl(provider);
      // Strip the `https://` prefix so segment counting is path-only
      // (e.g., the `/` in "https://" doesn't conflate with /v1/).
      const path = composed.replace(/^https?:\/\/[^/]+/, "");
      for (const segment of segments) {
        const occurrences = path.split(segment).length - 1;
        expect(
          occurrences,
          `${provider}: composed URL "${composed}" contains "${segment}" ${occurrences} times`,
        ).toBeLessThanOrEqual(1);
      }
      vi.unstubAllGlobals();
    }
  });

  it("PROVIDER_VALIDATION_PATHS contains no doubled-prefix path values (regression pin)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "04-credentials.ts"), "utf-8");

    // Extract the PROVIDER_VALIDATION_PATHS block.
    const match = src.match(
      /const PROVIDER_VALIDATION_PATHS\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/,
    );
    expect(match, "PROVIDER_VALIDATION_PATHS block must exist").not.toBeNull();
    const block = match![1];

    // Prior bug shapes that produced doubled paths -- must NOT appear as
    // path values. (Anthropic/mistral/deepseek legitimately keep "/v1/models"
    // because their catalog baseUrl is host-only. The doubled-shape patterns
    // we guard against are /openai/v1/models and /api/v1/models, which were
    // groq's and openrouter's prior values and would always be wrong now
    // since their baseUrls already include the /openai/v1 and /api/v1
    // prefixes respectively.)
    expect(block).not.toMatch(/"\/openai\/v1\/models"/);
    expect(block).not.toMatch(/"\/api\/v1\/models"/);

    // The 6 providers whose catalog baseUrl already includes the version
    // prefix MUST map to the suffix-only "/models".
    for (const provider of ["openai", "google", "groq", "xai", "cerebras", "openrouter"]) {
      const re = new RegExp(`${provider}\\s*:\\s*"\\/models"`);
      expect(block, `${provider} should map to "/models"`).toMatch(re);
    }

    // The 3 host-only-baseUrl providers MUST keep "/v1/models".
    for (const provider of ["anthropic", "mistral", "deepseek"]) {
      const re = new RegExp(`${provider}\\s*:\\s*"\\/v1\\/models"`);
      expect(block, `${provider} should map to "/v1/models"`).toMatch(re);
    }
  });

  it("keeps catalog-absent provider credentials explicitly unverified", async () => {
    // Catalog returns no models for these providers -> getValidationEndpoint
    // returns undefined, so the wizard saves the credential without claiming
    // it passed a live provider check.
    // Note: ollama is handled by Branch A (handleOllama) BEFORE
    // getValidationEndpoint is ever consulted -- separate code path,
    // covered by the existing "skips API key entirely for ollama provider"
    // test. Together is also absent from the installed catalog.
    for (const provider of ["together", "nonexistent-provider-foo"]) {
      vi.clearAllMocks();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      );
      vi.mocked(getModels).mockReturnValue([] as never);

      const prompter = createMockPrompter();
      vi.mocked(prompter.password).mockResolvedValueOnce("x".repeat(60));

      const state: WizardState = {
        ...INITIAL_STATE,
        provider: { id: provider } as ProviderConfig,
      };

      const result = await credentialsStep.execute(state, prompter);

      expect(globalThis.fetch, `${provider}: should not call fetch`).not.toHaveBeenCalled();
      expect(result.provider?.validated).toBe(false);
      expect(prompter.log.info).toHaveBeenCalledWith(
        expect.stringContaining("not live-validated"),
      );
      vi.unstubAllGlobals();
    }
  });
});

// ---------- OAuth dispatch tests ----------

describe("credentialsStep — OAuth dispatch", () => {
  beforeEach(() => {
    vi.mocked(loginOpenAICodexOAuth).mockReset();
    vi.mocked(isRemoteEnvironment).mockReturnValue(false);
    // The describe-level beforeEach in the parent suite stubs fetch +
    // clearAllMocks; vitest runs ALL parent beforeEach hooks before this
    // child block, so we only need to reset OUR mocks here. Stub fetch
    // explicitly because vi.unstubAllGlobals in the parent afterEach
    // might leave it undefined for the next describe.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provider=openai-codex routes to loginOpenAICodexOAuth via method picker (browser-auto)", async () => {
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "test_access_token",
        refresh: "test_refresh_token",
        expires: Date.now() + 3_600_000,
        accountId: "acct_test_001",
        email: "alice@example.com",
        displayName: "Alice",
        profileId: "openai-codex:alice@example.com",
      },
    });

    const prompter = createMockPrompter();
    // No hoisted auth-method select for openai-codex -- only the method picker.
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledTimes(1);
    expect(loginOpenAICodexOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ method: "browser", isRemote: false }),
    );
    expect(result.provider?.id).toBe("openai-codex");
    expect(result.provider?.oauthProfileId).toBe(
      "openai-codex:alice@example.com",
    );
    expect(result.provider?.authMethod).toBe("oauth");
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.apiKey).toBe("test_access_token");
  });

  it("does not leak wizard-oauth JSON logs onto the interactive console", async () => {
    // Regression: the wizard's OAuth logger wrote structured JSON to stderr
    // during the interactive init wizard, interleaving with the @clack prompt
    // UI. The operational logger must be quiet (warn-gated) so a successful
    // OAuth login emits nothing to the console.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    try {
      vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
        ok: true,
        value: {
          access: "tok",
          refresh: "ref",
          expires: Date.now() + 3_600_000,
          accountId: "acct",
          email: "alice@example.com",
          displayName: "Alice",
          profileId: "openai-codex:alice@example.com",
        },
      });
      const prompter = createMockPrompter();
      vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");
      await credentialsStep.execute(
        { ...INITIAL_STATE, provider: { id: "openai-codex" } as ProviderConfig },
        prompter,
      );
    } finally {
      spy.mockRestore();
    }
    const leaked = writes.filter((w) => w.includes("wizard-oauth"));
    expect(leaked).toEqual([]);
  });

  it("openai-codex device-code dispatch (isRemote=true)", async () => {
    vi.mocked(isRemoteEnvironment).mockReturnValueOnce(true);
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_dev",
        refresh: "ref_dev",
        expires: Date.now() + 3_600_000,
        accountId: "acct_dev",
        email: "user_a@example.com",
        displayName: "User A",
        profileId: "openai-codex:user_a@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("device-code");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device-code", isRemote: true }),
    );
    expect(result.provider?.id).toBe("openai-codex");
    expect(result.provider?.validated).toBe(true);
  });

  it("openai-codex browser-manual dispatch forces isRemote=true", async () => {
    // isRemoteEnvironment returns false (local desktop) but the user picks
    // "browser-manual" -- the dispatcher must still pass isRemote: true so
    // the runner uses the remote/manual-paste handlers regardless of detection.
    vi.mocked(isRemoteEnvironment).mockReturnValueOnce(false);
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_manual",
        refresh: "ref_manual",
        expires: Date.now() + 3_600_000,
        accountId: "acct_manual",
        email: "user_a@example.com",
        displayName: "User A",
        profileId: "openai-codex:user_a@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-manual");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ method: "browser", isRemote: true }),
    );
    expect(result.provider?.id).toBe("openai-codex");
    expect(result.provider?.validated).toBe(true);
  });

  it("openai-codex skip emits hint and sets unvalidated state", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("skip");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    expect(loginOpenAICodexOAuth).not.toHaveBeenCalled();
    // Hint contains the literal command for resuming OAuth post-wizard.
    const infoCalls = vi.mocked(prompter.log.info).mock.calls.map(([m]) => m);
    expect(
      infoCalls.some((m) =>
        typeof m === "string" &&
        m.includes("comis auth login --provider openai-codex"),
      ),
    ).toBe(true);
    expect(result.provider).toEqual({
      id: "openai-codex",
      validated: false,
    });
    expect(result.provider?.apiKey).toBeUndefined();
    expect(result.provider?.oauthProfileId).toBeUndefined();
    expect(result.provider?.authMethod).toBeUndefined();
  });

  it("Anthropic regression: provider=anthropic + authMethod=oauth → handleStandardProvider path (loginOpenAICodexOAuth NOT called)", async () => {
    const prompter = createMockPrompter();
    // Hoisted auth-method select returns "oauth" → because providerId is
    // "anthropic" (not "openai"), the dispatcher does NOT branch to
    // handleOpenAIOAuth. Instead it falls through to handleStandardProvider
    // with preResolvedAuthMethod="oauth", which prompts for the OAuth
    // token paste via prompter.password (the existing claude setup-token
    // paste flow).
    vi.mocked(prompter.select).mockResolvedValueOnce("oauth");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "sk-ant-oat01-fake-token-1234567890",
    );

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "anthropic" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    // The OpenAI runner must NOT be called for any other provider.
    // Anthropic OAuth keeps its claude setup-token paste flow.
    expect(loginOpenAICodexOAuth).not.toHaveBeenCalled();
    // Sanity-check the existing Anthropic OAuth path still produces a
    // validated profile in the wizard state.
    expect(result.provider?.authMethod).toBe("oauth");
    expect(result.provider?.apiKey).toBe(
      "sk-ant-oat01-fake-token-1234567890",
    );
    expect(result.provider?.oauthProfileId).toBeUndefined();
  });

  it("openai-codex OAuth failure surfaces hint and offers retry/skip recovery", async () => {
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: false,
      error: {
        code: "callback_validation_failed",
        message: "state mismatch",
        hint: "Restart the login flow.",
      },
    });

    const prompter = createMockPrompter();
    // First select = method picker ("browser-auto").
    // Second select = recovery choice "skip" after the runner fails.
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("browser-auto")
      .mockResolvedValueOnce("skip");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };
    const result = await credentialsStep.execute(startState, prompter);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledTimes(1);
    expect(prompter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("state mismatch"),
    );
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Restart the login flow."),
    );
    // State unchanged on skip -- provider id stays as set, no oauthProfileId.
    expect(result.provider?.id).toBe("openai-codex");
    expect(result.provider?.oauthProfileId).toBeUndefined();
    expect(result.provider?.validated).toBeUndefined();
  });
});

// ---------- Wizard storage-mode branch tests ----------

describe("credentialsStep — storage mode branching (encrypted/env)", () => {
  beforeEach(() => {
    vi.mocked(loginOpenAICodexOAuth).mockReset();
    vi.mocked(callTyped).mockReset();
    vi.mocked(withClient).mockReset();
    vi.mocked(requireDaemonOrExit).mockReset();
    vi.mocked(isDaemonRunning).mockReset();
    vi.mocked(offlineOAuthProfileSet).mockReset();
    vi.mocked(isRemoteEnvironment).mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    // Default: resolve callTyped for encrypted path
    vi.mocked(callTyped).mockResolvedValue({ profileId: "openai-codex:test@example.com", stored: true });
    // Default: withClient passes through to fn
    vi.mocked(withClient).mockImplementation(async (fn) => fn({}));
    // Default: requireDaemonOrExit resolves (daemon is running)
    vi.mocked(requireDaemonOrExit).mockResolvedValue(undefined);
    // Default: daemon is UP → encrypted branch routes through the daemon RPC.
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    vi.mocked(offlineOAuthProfileSet).mockResolvedValue({ ok: true, value: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(loadConfigFile).mockReturnValue({ ok: false, error: new Error("no config") });
  });

  it("encrypted mode: wizard calls callTyped with AuthSetContract (does NOT throw 'wizard cannot bootstrap')", async () => {
    // Simulate encrypted storage mode
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });

    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_encrypted",
        refresh: "ref_encrypted",
        expires: Date.now() + 3_600_000,
        accountId: "acct_enc",
        email: "enc@example.com",
        displayName: "Enc User",
        profileId: "openai-codex:enc@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    // Must NOT throw "wizard cannot bootstrap the encrypted store"
    await expect(
      credentialsStep.execute(startState, prompter),
    ).resolves.not.toThrow();

    // callTyped must be called (via withClient), carrying AuthSetContract shape
    expect(callTyped).toHaveBeenCalledTimes(1);
    const callTypedArgs = vi.mocked(callTyped).mock.calls[0]!;
    // Second arg is the contract — must have method "auth.set"
    expect((callTypedArgs[1] as { method: string }).method).toBe("auth.set");
    // Third arg is the profile payload — must have version: 1 and no plain token logging
    const payload = callTypedArgs[2] as Record<string, unknown>;
    expect(payload).toMatchObject({
      provider: "openai-codex",
      version: 1,
    });
  });

  it("encrypted mode: isDaemonRunning is consulted before persistence", async () => {
    // The encrypted branch does not hard-require a daemon; it probes
    // isDaemonRunning to decide RPC (up) vs. offline write (down).
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });

    // Track call order: isDaemonRunning must be consulted before login persists.
    const callOrder: string[] = [];
    vi.mocked(isDaemonRunning).mockImplementation(async () => {
      callOrder.push("isDaemonRunning");
      return true;
    });
    vi.mocked(loginOpenAICodexOAuth).mockImplementation(async () => {
      callOrder.push("loginOpenAICodexOAuth");
      return {
        ok: true,
        value: {
          access: "tok_order",
          refresh: "ref_order",
          expires: Date.now() + 3_600_000,
          accountId: "acct_order",
          email: "order@example.com",
          displayName: "Order User",
          profileId: "openai-codex:order@example.com",
        },
      };
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    expect(isDaemonRunning).toHaveBeenCalled();
    const daemonIdx = callOrder.indexOf("isDaemonRunning");
    const oauthIdx = callOrder.indexOf("loginOpenAICodexOAuth");
    expect(daemonIdx).toBeGreaterThanOrEqual(0);
    expect(oauthIdx).toBeGreaterThanOrEqual(0);
    expect(daemonIdx).toBeLessThan(oauthIdx);
  });

  it("encrypted + daemon DOWN: persists via offlineOAuthProfileSet, NOT RPC", async () => {
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });
    vi.mocked(isDaemonRunning).mockResolvedValue(false);

    const expiresAt = Date.now() + 3_600_000;
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_offline",
        refresh: "ref_offline",
        expires: expiresAt,
        accountId: "acct_offline",
        email: "offline@example.com",
        displayName: "Offline User",
        profileId: "openai-codex:offline@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(startState, prompter);

    // Offline encrypted write used; daemon RPC NOT used.
    expect(callTyped).not.toHaveBeenCalled();
    expect(offlineOAuthProfileSet).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(offlineOAuthProfileSet).mock.calls[0]![0] as {
      profile: Record<string, unknown>;
      dataDir: string;
      envFilePath: string;
    };
    expect(arg.profile).toMatchObject({
      provider: "openai-codex",
      profileId: "openai-codex:offline@example.com",
      access: "tok_offline",
      refresh: "ref_offline",
      expires: expiresAt,
      accountId: "acct_offline",
      email: "offline@example.com",
      displayName: "Offline User",
      version: 1,
    });
    expect(arg.dataDir.endsWith("/.comis")).toBe(true);
    expect(arg.envFilePath.endsWith("/.comis/.env")).toBe(true);

    // Success state returned (validated + profile id), no apiKey in state.
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.oauthProfileId).toBe("openai-codex:offline@example.com");
    expect(result.provider?.apiKey).toBeUndefined();
  });

  it("encrypted + daemon DOWN + offlineOAuthProfileSet err: surfaces error + skip", async () => {
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });
    vi.mocked(isDaemonRunning).mockResolvedValue(false);
    vi.mocked(offlineOAuthProfileSet).mockResolvedValue({
      ok: false,
      error: new Error("boom"),
    });

    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_err",
        refresh: "ref_err",
        expires: Date.now() + 3_600_000,
        accountId: "acct_err",
        email: "err@example.com",
        displayName: "Err User",
        profileId: "openai-codex:err@example.com",
      },
    });

    const prompter = createMockPrompter();
    // method picker = browser-auto, then recovery choice = skip
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("browser-auto")
      .mockResolvedValueOnce("skip");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    const errorCalls = vi.mocked(prompter.log.error).mock.calls.map(([m]) => String(m));
    expect(errorCalls.some((m) => m.includes("boom"))).toBe(true);
    expect(callTyped).not.toHaveBeenCalled();
  });

  it("encrypted + daemon UP: uses RPC (callTyped auth.set), offline NOT called", async () => {
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });
    vi.mocked(isDaemonRunning).mockResolvedValue(true);

    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_up",
        refresh: "ref_up",
        expires: Date.now() + 3_600_000,
        accountId: "acct_up",
        email: "up@example.com",
        displayName: "Up User",
        profileId: "openai-codex:up@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    expect(callTyped).toHaveBeenCalledTimes(1);
    const callTypedArgs = vi.mocked(callTyped).mock.calls[0]!;
    expect((callTypedArgs[1] as { method: string }).method).toBe("auth.set");
    expect(offlineOAuthProfileSet).not.toHaveBeenCalled();
  });

  it("encrypted + daemon UP but gateway rejects token (4001): falls back to offline encrypted write", async () => {
    // Fresh-install regression (live VPS, 2026-06-14): the installer starts
    // comis.service BEFORE `comis init` writes any config.yaml, so the gateway
    // has ZERO configured tokens and rejects every client with WS close 4001.
    // No CLI token can authenticate, so the auth.set RPC is unreachable. The
    // wizard must NOT dead-end — it must seal the OAuth profile into the
    // encrypted secrets.db (offline write) so credentials still land
    // encrypted-at-rest, then tell the user to restart the daemon.
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "encrypted" } },
    });
    vi.mocked(isDaemonRunning).mockResolvedValue(true); // daemon UP
    // withClient rejects with the gateway auth-rejection error (WS close 4001).
    vi.mocked(withClient).mockRejectedValue(
      new Error(
        "Gateway rejected the token (WS close 4001 Unauthorized) — the daemon IS running and listening.",
      ),
    );

    const expiresAt = Date.now() + 3_600_000;
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_4001",
        refresh: "ref_4001",
        expires: expiresAt,
        accountId: "acct_4001",
        email: "four@example.com",
        displayName: "Four Oh One",
        profileId: "openai-codex:four@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(startState, prompter);

    // Fell back to the offline encrypted write (NOT a dead-end).
    expect(offlineOAuthProfileSet).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(offlineOAuthProfileSet).mock.calls[0]![0] as {
      profile: Record<string, unknown>;
      dataDir: string;
      envFilePath: string;
    };
    expect(arg.profile).toMatchObject({
      provider: "openai-codex",
      profileId: "openai-codex:four@example.com",
      access: "tok_4001",
      version: 1,
    });
    expect(arg.dataDir.endsWith("/.comis")).toBe(true);
    expect(arg.envFilePath.endsWith("/.comis/.env")).toBe(true);

    // Profile persisted → state advances to validated (no skip, no dead-end).
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.oauthProfileId).toBe("openai-codex:four@example.com");
    expect(result.provider?.apiKey).toBeUndefined();

    // User told to restart the daemon (encrypted-store hot-reload is disabled).
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls.map(([m]) => String(m));
    expect(warnCalls.some((m) => /restart/i.test(m))).toBe(true);
  });

  it("env mode: wizard credential step surfaces actionable rejection containing 'env' and 'read-only'", async () => {
    // Simulate env storage mode
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "env" } },
    });

    const prompter = createMockPrompter();
    // Method picker would be shown; env rejection must happen before OAuth flow runs.
    // We still need to provide a select return for the method picker
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(startState, prompter);

    // loginOpenAICodexOAuth must NOT be called (env is read-only)
    expect(loginOpenAICodexOAuth).not.toHaveBeenCalled();

    // An error must be surfaced to the user containing "env" and "read-only"
    const errorCalls = vi.mocked(prompter.log.error).mock.calls.map(([m]) => String(m));
    const hasEnvReadOnlyError = errorCalls.some(
      (m) => m.toLowerCase().includes("env") && m.toLowerCase().includes("read-only"),
    );
    expect(hasEnvReadOnlyError).toBe(true);

    // State must NOT advance to validated=true (env-mode rejection returns early)
    expect(result.provider?.validated).not.toBe(true);
  });

  it("state.storageMode=encrypted forces the encrypted branch even when loadWizardStorageMode yields file", async () => {
    // Fresh-init scenario: the storage step provisioned the master key earlier
    // in this same wizard run, but the in-process env snapshot consulted by
    // loadWizardStorageMode does not reflect it (no key, no config -> "file").
    // state.storageMode="encrypted" must take precedence so the encrypted
    // persistence path runs (daemon-down -> offlineOAuthProfileSet) instead of
    // opening the file store.
    masterKeyState = undefined;
    vi.mocked(selectOAuthCredentialStore).mockClear();
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: false,
      error: new Error("no config"),
    });
    vi.mocked(isDaemonRunning).mockResolvedValue(false); // daemon down -> offline write
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_precedence",
        refresh: "ref_precedence",
        expires: Date.now() + 3_600_000,
        accountId: "acct_precedence",
        email: "prec@example.com",
        displayName: "Prec User",
        profileId: "openai-codex:prec@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      storageMode: "encrypted",
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(startState, prompter);

    // Encrypted branch taken: offline encrypted write used, file store NOT opened.
    expect(offlineOAuthProfileSet).toHaveBeenCalledTimes(1);
    expect(selectOAuthCredentialStore).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.oauthProfileId).toBe("openai-codex:prec@example.com");
  });

  it("file mode: wizard uses existing store.set() path (selectOAuthCredentialStore called, callTyped NOT called)", async () => {
    // Default: loadConfigFile returns error → falls back to file storage
    vi.mocked(loadConfigFile).mockReturnValue({ ok: false, error: new Error("no config") });

    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_file",
        refresh: "ref_file",
        expires: Date.now() + 3_600_000,
        accountId: "acct_file",
        email: "file@example.com",
        displayName: "File User",
        profileId: "openai-codex:file@example.com",
      },
    });

    const { selectOAuthCredentialStore } = await import("@comis/core");

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    // File mode must use the store adapter, not callTyped
    expect(selectOAuthCredentialStore).toHaveBeenCalled();
    expect(callTyped).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadWizardStorageMode env-ref resolution
//
// Regression guard: if loadWizardStorageMode called loadConfigFile without
// getSecret, ${VAR} refs would not be resolved before validateConfig. A config
// whose security.storage is "encrypted" but also contains a gateway token with
// a ${VAR} ref would fail Zod validation → fall back to "file" → the
// handleCodexOAuth encrypted branch (requireDaemonOrExit) would be skipped.
//
// loadWizardStorageMode must pass getSecret to loadConfigFile so refs are
// resolved and the encrypted mode is correctly detected.
// ---------------------------------------------------------------------------

describe("loadWizardStorageMode env-ref resolution", () => {
  beforeEach(() => {
    vi.mocked(loginOpenAICodexOAuth).mockReset();
    vi.mocked(callTyped).mockReset();
    vi.mocked(withClient).mockReset();
    vi.mocked(requireDaemonOrExit).mockReset();
    vi.mocked(isDaemonRunning).mockReset();
    vi.mocked(offlineOAuthProfileSet).mockReset();
    vi.mocked(isRemoteEnvironment).mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    // Default: callTyped and withClient succeed
    vi.mocked(callTyped).mockResolvedValue({ profileId: "openai-codex:test@example.com", stored: true });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({}));
    vi.mocked(requireDaemonOrExit).mockResolvedValue(undefined);
    // Daemon UP by default → encrypted branch uses the daemon RPC path.
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    vi.mocked(offlineOAuthProfileSet).mockResolvedValue({ ok: true, value: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore loadConfigFile/validateConfig to their module-default mocks
    vi.mocked(loadConfigFile).mockReturnValue({ ok: false, error: new Error("no config") });
    vi.mocked(validateConfig).mockImplementation((raw: unknown) => ({ ok: true, value: raw }));
  });

  it("loadWizardStorageMode detects encrypted mode when getSecret resolves ${ENV} refs so requireDaemonOrExit is called", async () => {
    // The guarded failure mode:
    // - loadConfigFile WITHOUT getSecret returns raw config with unresolved refs
    // - validateConfig FAILS on the unresolved ref (simulates the min:32 violation)
    // → loadWizardStorageMode falls back to "file" → requireDaemonOrExit NOT called
    //
    // Correct behavior: loadConfigFile is called WITH getSecret.
    // The mock detects getSecret and returns a resolved config.
    // validateConfig SUCCEEDS → "encrypted" → requireDaemonOrExit IS called.
    vi.mocked(loadConfigFile).mockImplementation((_path, options) => {
      if (options?.getSecret) {
        // getSecret provided → simulate resolved config (no ${} refs)
        return {
          ok: true as const,
          value: { security: { storage: "encrypted" } },
        };
      }
      // No getSecret → unresolved config with ${} ref in secret field
      return {
        ok: true as const,
        value: {
          security: { storage: "encrypted" },
          gateway: { tokens: [{ id: "api-token", secret: "${COMIS_GATEWAY_TOKEN}" }] },
        },
      };
    });

    vi.mocked(validateConfig).mockImplementation((raw: unknown) => {
      // Simulate Zod validation: fail if any field contains an unresolved ${} ref
      const serialized = JSON.stringify(raw);
      if (serialized.includes("${")) {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION_ERROR" as const,
            message: "gateway.tokens.0.secret: Too small — min 32 chars required",
          },
        };
      }
      // Resolved config passes validation
      return { ok: true as const, value: raw as Parameters<typeof validateConfig>[0] };
    });

    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      ok: true,
      value: {
        access: "tok_envref",
        refresh: "ref_envref",
        expires: Date.now() + 3_600_000,
        accountId: "acct_envref",
        email: "envref@example.com",
        displayName: "EnvRef User",
        profileId: "openai-codex:envref@example.com",
      },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("device-code");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    // loadWizardStorageMode must detect "encrypted" and the branch probes
    // isDaemonRunning before persisting (daemon UP → RPC path). Without
    // getSecret it falls back to "file" and the encrypted branch never runs.
    expect(isDaemonRunning).toHaveBeenCalled();
    // And the profile must be persisted via daemon RPC (callTyped), not file store
    expect(callTyped).toHaveBeenCalled();
    const callTypedArgs = vi.mocked(callTyped).mock.calls[0]!;
    expect((callTypedArgs[1] as { method: string }).method).toBe("auth.set");
  });
});

// ---------------------------------------------------------------------------
// loadWizardStorageMode encrypted-default fallback (init, no config)
//
// During `comis init` no config.yaml exists yet (OAuth login runs in step 04,
// config is written in step 10). loadWizardStorageMode must align with the
// daemon's encrypted default: when a SECRETS_MASTER_KEY is present, fall back
// to "encrypted" (the encrypted store is usable); otherwise "file".
//
// These tests drive the resolution behaviorally via handleCodexOAuth
// (loadWizardStorageMode is intentionally not exported standalone):
//   - config absent + master key present → encrypted branch (callTyped used,
//     selectOAuthCredentialStore NOT used).
//   - config absent + no master key      → file branch (selectOAuthCredentialStore
//     used, callTyped NOT used).
//
// The guarded regression: if both `return "file"` fallbacks returned "file"
// unconditionally, even with a master key present the file branch would be
// taken — the "encrypted when master key present" case pins this.
// ---------------------------------------------------------------------------

describe("loadWizardStorageMode encrypted-default fallback (init, no config)", () => {
  beforeEach(() => {
    vi.mocked(loginOpenAICodexOAuth).mockReset();
    vi.mocked(callTyped).mockReset();
    vi.mocked(withClient).mockReset();
    vi.mocked(requireDaemonOrExit).mockReset();
    vi.mocked(isDaemonRunning).mockReset();
    vi.mocked(offlineOAuthProfileSet).mockReset();
    vi.mocked(selectOAuthCredentialStore).mockClear();
    vi.mocked(isRemoteEnvironment).mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    vi.mocked(callTyped).mockResolvedValue({
      profileId: "openai-codex:test@example.com",
      stored: true,
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({}));
    vi.mocked(requireDaemonOrExit).mockResolvedValue(undefined);
    // Daemon UP by default → encrypted branch uses the daemon RPC path so the
    // "callTyped used" assertion holds when the fallback resolves "encrypted".
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    vi.mocked(offlineOAuthProfileSet).mockResolvedValue({ ok: true, value: undefined });

    // Config absent during init → triggers the encrypted-default fallback.
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: false,
      error: new Error("no config"),
    });

    const okLogin = {
      ok: true as const,
      value: {
        access: "tok_fallback",
        refresh: "ref_fallback",
        expires: Date.now() + 3_600_000,
        accountId: "acct_fallback",
        email: "fallback@example.com",
        displayName: "Fallback User",
        profileId: "openai-codex:fallback@example.com",
      },
    };
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue(okLogin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    masterKeyState = undefined;
    vi.mocked(loadConfigFile).mockReturnValue({ ok: false, error: new Error("no config") });
  });

  it("config absent + SECRETS_MASTER_KEY present → encrypted branch (callTyped used, file store NOT opened)", async () => {
    masterKeyState = "a".repeat(64); // master key present

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    // Encrypted branch was taken: daemon RPC path used, file store NOT opened.
    expect(callTyped).toHaveBeenCalled();
    expect(selectOAuthCredentialStore).not.toHaveBeenCalled();
  });

  it("config absent + no SECRETS_MASTER_KEY → file branch (file store opened, callTyped NOT used)", async () => {
    masterKeyState = undefined; // no master key

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    // File branch was taken: the file store adapter is opened, no daemon RPC.
    expect(selectOAuthCredentialStore).toHaveBeenCalled();
    expect(callTyped).not.toHaveBeenCalled();
  });

  it("valid config still wins (security.storage honored regardless of master key)", async () => {
    masterKeyState = "a".repeat(64);
    // Valid config explicitly selects file storage → must override the
    // encrypted-default fallback (the fallback only applies when config is absent).
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { security: { storage: "file" } },
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("browser-auto");

    const startState: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai-codex" } as ProviderConfig,
    };

    await credentialsStep.execute(startState, prompter);

    expect(selectOAuthCredentialStore).toHaveBeenCalled();
    expect(callTyped).not.toHaveBeenCalled();
  });
});
