// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Models view e2e tests covering provider cards, models table,
 * aliases, defaults, and test connection button.
 */

/** Mock config.read response matching the models view's expected shape. */
const MODELS_CONFIG = {
  providers: {
    entries: {
      anthropic: {
        type: "anthropic",
        name: "anthropic",
        baseUrl: "",
        apiKeyName: "ANTHROPIC_API_KEY",
        enabled: true,
        timeoutMs: 120000,
        maxRetries: 2,
      },
      openai: {
        type: "openai",
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyName: "OPENAI_API_KEY",
        enabled: true,
        timeoutMs: 120000,
        maxRetries: 2,
      },
    },
  },
  models: {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    aliases: [
      { alias: "fast", provider: "anthropic", modelId: "claude-haiku-35" },
      { alias: "smart", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    ],
  },
};

/** Mock models.list response matching ModelsListResponse interface. */
const MODELS_LIST = {
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      displayName: "Claude Sonnet 4",
      contextWindow: 200000,
      maxTokens: 8192,
      input: true,
      reasoning: false,
      validated: true,
    },
    {
      provider: "anthropic",
      modelId: "claude-haiku-35",
      displayName: "Claude Haiku 3.5",
      contextWindow: 200000,
      maxTokens: 8192,
      input: true,
      reasoning: false,
      validated: true,
    },
    {
      provider: "openai",
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      contextWindow: 128000,
      maxTokens: 4096,
      input: true,
      reasoning: false,
      validated: false,
    },
  ],
  providers: ["anthropic", "openai"],
  total: 3,
};

/** RPC handlers for the models view. */
const MODELS_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.read": MODELS_CONFIG,
  "config.patch": { success: true },
  "models.list": MODELS_LIST,
  "models.test": { status: "ok", modelsAvailable: 3, validatedModels: 2 },
};

test.describe("Models view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, MODELS_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Models");
  });

  test("shows provider cards", async ({ page }) => {
    const view = page.locator("ic-models-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Verify provider cards are rendered
    const providerCards = page.locator("ic-provider-card");
    await expect(providerCards).toHaveCount(2);

    // Verify anthropic provider card is visible with its type
    await expect(providerCards.filter({ hasText: "anthropic" }).first()).toBeVisible();

    // Verify openai provider card is visible with its type
    await expect(providerCards.filter({ hasText: "openai" }).first()).toBeVisible();
  });

  test("shows available models table", async ({ page }) => {
    const view = page.locator("ic-models-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Navigate to Available Models tab
    await view.getByText("Available Models").click();

    // Verify all three models are listed
    await expect(view.getByText("claude-sonnet-4-20250514")).toBeVisible();
    await expect(view.getByText("claude-haiku-35")).toBeVisible();
    await expect(view.getByText("gpt-4o")).toBeVisible();

    // Verify context window values are displayed (toLocaleString format)
    // Two models share 200,000 context window so use .first() to avoid strict mode violation
    await expect(view.getByText("200,000").first()).toBeVisible();
    await expect(view.getByText("128,000")).toBeVisible();
  });

  test("shows model aliases", async ({ page }) => {
    const view = page.locator("ic-models-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Navigate to Aliases tab
    await view.getByText("Aliases").click();

    // Verify alias "fast" pointing to claude-haiku-35 is visible
    await expect(view.getByText("fast", { exact: true })).toBeVisible();
    await expect(view.getByText("claude-haiku-35")).toBeVisible();

    // Verify alias "smart" pointing to claude-sonnet-4-20250514 is visible
    await expect(view.getByText("smart", { exact: true })).toBeVisible();
    await expect(view.getByText("claude-sonnet-4-20250514")).toBeVisible();
  });

  test("shows default provider and model", async ({ page }) => {
    const view = page.locator("ic-models-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Navigate to Defaults tab
    await view.getByText("Defaults").click();

    // Verify default provider "anthropic" is indicated
    await expect(view.getByText("Default Provider")).toBeVisible();

    // Verify default model "claude-sonnet-4-20250514" is indicated
    await expect(view.getByText("Default Model")).toBeVisible();

    // The defaults summary section shows the current defaults via ic-tag
    await expect(view.locator("ic-tag").filter({ hasText: "anthropic" })).toBeVisible();
    await expect(view.locator("ic-tag").filter({ hasText: "claude-sonnet-4-20250514" })).toBeVisible();
  });

  test("provider card has test connection button", async ({ page }) => {
    const view = page.locator("ic-models-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Each provider card should have a "Test" button with appropriate aria-label
    await expect(page.getByLabel("Test connection for anthropic")).toBeVisible();
    await expect(page.getByLabel("Test connection for openai")).toBeVisible();
  });
});
