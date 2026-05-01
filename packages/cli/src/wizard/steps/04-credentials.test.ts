// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for credentials entry step (step 04).
 *
 * Verifies API key collection and live validation for standard providers,
 * ollama skip, custom endpoint flow, and retry/continue/skip recovery.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState, ProviderConfig } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Mock pi-ai's getModels so we control the catalog baseUrl in tests
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    getModels: vi.fn(() => [{ baseUrl: "https://api.anthropic.com" }]),
  };
});

import { credentialsStep } from "./04-credentials.js";
import { getModels } from "@mariozechner/pi-ai";

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

  it("collects custom endpoint details for custom provider", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("https://my-llm.internal/v1") // base URL
      .mockResolvedValueOnce("my-custom-model"); // model ID
    vi.mocked(prompter.select).mockResolvedValueOnce("openai"); // compat mode
    vi.mocked(prompter.password).mockResolvedValueOnce("my-key-123"); // optional key

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "custom" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.id).toBe("custom");
    expect(result.provider?.customEndpoint).toBe("https://my-llm.internal/v1");
    expect(result.provider?.compatMode).toBe("openai");
    expect(result.provider?.apiKey).toBe("my-key-123");
    expect(result.provider?.validated).toBe(true);
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

    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBe("oauth");
    expect(result.provider?.apiKey).toBe(
      "sk-ant-oat01-someOAuthTokenValueThatIsLongEnoughToPass",
    );
  });

  it("shows auth method selector for openai and skips live validation for OAuth", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("oauth");
    vi.mocked(prompter.password).mockResolvedValueOnce(
      "oat-some-openai-oauth-token-value-here-12345",
    );

    const state: WizardState = {
      ...INITIAL_STATE,
      provider: { id: "openai" } as ProviderConfig,
    };

    const result = await credentialsStep.execute(state, prompter);

    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "openai authentication method",
      }),
    );
    // OAuth skips live validation
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBe("oauth");
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
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBe("oauth");
  });

  it("custom endpoint with empty key sets apiKey to undefined", async () => {
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

    const result = await credentialsStep.execute(state, prompter);

    expect(result.provider?.apiKey).toBeUndefined();
  });

  // ---------- D1-D4: catalog-driven validation regression tests ----------

  it("D1: validation URL is built from pi-ai catalog baseUrl, not a hardcoded map", async () => {
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

  it("D2: provider with no catalog baseUrl skips live validation (returns valid)", async () => {
    // No baseUrl in catalog -> getValidationEndpoint returns undefined
    // -> the line-130 fallback short-circuits and returns valid=true.
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
    expect(result.provider?.validated).toBe(true);
  });

  it("D3: anthropic OAuth tokens still skip live validation entirely (regression pin)", async () => {
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
    expect(result.provider?.validated).toBe(true);
    expect(result.provider?.authMethod).toBe("oauth");
  });

  it("D4: PROVIDER_VALIDATION map is gone; getValidationEndpoint + PROVIDER_VALIDATION_PATHS are present", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "04-credentials.ts"), "utf-8");
    // Dropped: const PROVIDER_VALIDATION: Record<string, ...>
    expect(src).not.toMatch(/const PROVIDER_VALIDATION\s*:\s*Record/);
    // New artifacts present
    expect(src).toMatch(/PROVIDER_VALIDATION_PATHS/);
    expect(src).toMatch(/getValidationEndpoint/);
    expect(src).toMatch(/getModels.*KnownProvider.*baseUrl/);
  });
});
