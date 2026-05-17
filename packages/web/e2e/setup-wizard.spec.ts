// SPDX-License-Identifier: Apache-2.0
import { test, expect, type Locator } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Setup wizard RPC mock data.
 *
 * The wizard fetches its provider catalog via models.list_providers on
 * mount; if that call fails, Step 2 renders a Retry placeholder instead
 * of the .provider-grid expected by the tests. Mock the catalog and the
 * per-provider model list, plus config.apply / models.test used during
 * the Review/Apply flow.
 */
const WIZARD_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.apply": { success: true },
  "models.test": { success: true, latencyMs: 350 },
  "models.list_providers": {
    providers: ["anthropic", "openai", "ollama"],
    count: 3,
  },
  "models.list": {
    models: [
      { modelId: "claude-sonnet-4-20250514", cost: { input: 0.000003, output: 0.000015 } },
      { modelId: "gpt-4o", cost: { input: 0.000005, output: 0.000015 } },
      { modelId: "llama3.1:8b", cost: { input: 0, output: 0 } },
    ],
  },
};

test.describe("Setup wizard view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, WIZARD_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Setup");
  });

  test("setup wizard shows 5 step indicators", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Verify all 5 step labels are visible in the step bar
    const stepBar = wizard.locator('[role="navigation"]');
    await expect(stepBar).toBeVisible();

    await expect(stepBar.getByText("Basics")).toBeVisible();
    await expect(stepBar.getByText("Provider")).toBeVisible();
    await expect(stepBar.getByText("Agent")).toBeVisible();
    await expect(stepBar.getByText("Channels")).toBeVisible();
    await expect(stepBar.getByText("Review")).toBeVisible();

    // Step 1 (Basics) should be active/current -- step circle shows "1"
    const firstCircle = wizard.locator(".step-circle").first();
    await expect(firstCircle).toHaveClass(/current/);
  });

  test("step 1 Basics shows configuration fields", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Verify form fields for the Basics step
    await expect(wizard.getByText("Tenant ID", { exact: true })).toBeVisible();
    await expect(wizard.getByText("Data Directory")).toBeVisible();
    await expect(wizard.getByText("Log Level", { exact: true })).toBeVisible();
    await expect(wizard.getByText("Gateway Host")).toBeVisible();
    await expect(wizard.getByText("Gateway Port")).toBeVisible();

    // Verify defaults are populated
    const inputs = wizard.locator("input.form-input");
    // First input is tenantId with default "default"
    await expect(inputs.first()).toHaveValue("default");
  });

  test("Next button advances to step 2 Provider", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Click Next (Basics has tenantId="default" so validation passes)
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify step 2 (Provider) becomes active
    const secondCircle = wizard.locator(".step-circle").nth(1);
    await expect(secondCircle).toHaveClass(/current/);

    // Verify provider cards are shown
    await expect(wizard.locator(".provider-card").first()).toBeVisible();
  });

  test("step 2 Provider shows provider cards for selection", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Navigate to step 2
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify provider option cards are rendered
    const providerGrid = wizard.locator(".provider-grid");
    await expect(providerGrid).toBeVisible();

    // Verify each provider card shows name and description.
    await expect(wizard.locator(".provider-card-name").getByText("Anthropic")).toBeVisible();
    // The description text comes from getProviderHint() for the anthropic key.
    await expect(wizard.locator(".provider-card-desc").first()).toBeVisible();
    await expect(wizard.locator(".provider-card-name").getByText("OpenAI")).toBeVisible();
    await expect(wizard.locator(".provider-card-name").getByText("Ollama")).toBeVisible();

    // Clicking a card selects it (adds "active" class)
    const anthropicCard = wizard.locator(".provider-card").filter({ hasText: "Anthropic" });
    await anthropicCard.click();
    await expect(anthropicCard).toHaveClass(/active/);

    // After selecting Anthropic, API Key field should appear (needsApiKey=true)
    // Use exact match to avoid collision with Ollama description "no API key needed"
    await expect(wizard.getByText("API Key", { exact: true })).toBeVisible();
  });

  /**
   * Walk a wizard instance through step 1 (Basics) and step 2 (Provider).
   * Picks anthropic because it has a known UI hint with needsApiKey=true.
   * Fills the API key and selects the first available model from the live
   * dropdown so step-2 validation passes.
   */
  async function advanceToStep3(wizard: Locator): Promise<void> {
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.locator(".provider-card").filter({ hasText: "Anthropic" }).first().click();
    // API key required for anthropic; fill any non-empty value.
    await wizard.locator('input[type="password"]').first().fill("test-api-key");
    // The native-provider model dropdown renders with class .form-select.
    await wizard
      .locator("select.form-select")
      .first()
      .selectOption("claude-sonnet-4-20250514");
    await wizard.getByRole("button", { name: "Next" }).click();
  }

  test("step 3 Agent shows agent configuration fields", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    await advanceToStep3(wizard);

    // Verify step 3 (Agent) fields.
    await expect(wizard.getByText("Agent ID")).toBeVisible();
    await expect(wizard.getByText("Agent Name")).toBeVisible();
    await expect(wizard.getByText("Max Steps")).toBeVisible();
  });

  test("step 4 Channels shows platform toggles", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    await advanceToStep3(wizard);
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify step 4 (Channels) shows platform cards.
    await expect(wizard.getByText("Telegram")).toBeVisible();
    await expect(wizard.getByText("Discord")).toBeVisible();
    await expect(wizard.getByText("Slack")).toBeVisible();
    await expect(wizard.getByText("WhatsApp")).toBeVisible();

    // Toggle Telegram on and verify the toggle reflects the enabled state.
    const telegramCard = wizard.locator(".channel-card").filter({ hasText: "Telegram" });
    await telegramCard.locator(".channel-toggle").click();
    await expect(telegramCard.locator(".channel-toggle")).toHaveClass(/enabled/);
  });

  test("step 5 Review shows YAML preview", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    await advanceToStep3(wizard);
    await wizard.getByRole("button", { name: "Next" }).click();
    // Step 4 button label is "Review" on the channels step.
    await wizard.getByRole("button", { name: "Review" }).click();

    // The Review step renders a YAML preview surface.
    const yamlPreview = wizard.locator(".yaml-preview");
    await expect(yamlPreview).toBeVisible();
    const yamlText = await yamlPreview.textContent();
    // The serialized config carries the provider + agent picked during the
    // walk; assert those rather than legacy keys that may have moved nodes.
    expect(yamlText).toContain("anthropic");
    expect(yamlText).toContain("claude-sonnet-4-20250514");

    // Action buttons available on the Review step.
    await expect(wizard.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Apply" })).toBeVisible();
  });

  test("Back button returns to previous step", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Navigate to step 2
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify we are on step 2
    const secondCircle = wizard.locator(".step-circle").nth(1);
    await expect(secondCircle).toHaveClass(/current/);

    // Click Back
    await wizard.getByRole("button", { name: "Back" }).click();

    // Verify step 1 is active again
    const firstCircle = wizard.locator(".step-circle").first();
    await expect(firstCircle).toHaveClass(/current/);

    // Verify previously entered values are preserved (tenantId still "default")
    const firstInput = wizard.locator("input.form-input").first();
    await expect(firstInput).toHaveValue("default");
  });

  test("step 1 has no Back button, step 5 has no Next button", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // On step 1, Back button should not be present
    const navBar = wizard.locator(".nav-bar");
    await expect(navBar.getByRole("button", { name: "Back" })).not.toBeVisible();
    await expect(navBar.getByRole("button", { name: "Next" })).toBeVisible();

    await advanceToStep3(wizard);
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Review" }).click();

    // On step 5, Next button should not be present
    await expect(navBar.getByRole("button", { name: "Next" })).not.toBeVisible();
    await expect(navBar.getByRole("button", { name: "Review" })).not.toBeVisible();
  });
});
