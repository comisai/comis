import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Setup wizard RPC mock data.
 *
 * The wizard calls config.apply for each section when applying,
 * and models.test for provider connection testing.
 */
const WIZARD_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.apply": { success: true },
  "models.test": { success: true, latencyMs: 350 },
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

    // Verify each provider card shows name and description
    await expect(wizard.locator(".provider-card-name").getByText("Anthropic")).toBeVisible();
    await expect(wizard.getByText("Claude models, best for coding and reasoning")).toBeVisible();
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

  test("step 3 Agent shows agent configuration fields", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Navigate through step 1 (Basics) -> step 2 (Provider)
    await wizard.getByRole("button", { name: "Next" }).click();

    // Select Ollama provider (no API key needed, needs base URL)
    const ollamaCard = wizard.locator(".provider-card").filter({ hasText: "Ollama" });
    await ollamaCard.click();

    // Fill base URL for Ollama (required for validation)
    // The base URL field should already have default value "http://localhost:11434"
    // Navigate to step 3
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify step 3 (Agent) fields
    await expect(wizard.getByText("Agent ID")).toBeVisible();
    await expect(wizard.getByText("Agent Name")).toBeVisible();
    await expect(wizard.getByText("Model", { exact: true })).toBeVisible();
    await expect(wizard.getByText("Max Steps")).toBeVisible();
    await expect(wizard.getByText("Budget Per Day ($)")).toBeVisible();
    await expect(wizard.getByText("Budget Per Hour ($)")).toBeVisible();
  });

  test("step 4 Channels shows platform toggles", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Navigate to step 4: Basics -> Provider -> Agent -> Channels
    // Step 1: Next (defaults pass)
    await wizard.getByRole("button", { name: "Next" }).click();

    // Step 2: Select Ollama, then Next
    await wizard.locator(".provider-card").filter({ hasText: "Ollama" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();

    // Step 3: Next (agentId="default" passes validation)
    await wizard.getByRole("button", { name: "Next" }).click();

    // Verify step 4 (Channels) shows platform cards
    await expect(wizard.getByText("Telegram")).toBeVisible();
    await expect(wizard.getByText("Discord")).toBeVisible();
    await expect(wizard.getByText("Slack")).toBeVisible();
    await expect(wizard.getByText("WhatsApp")).toBeVisible();

    // Verify channel toggle buttons are present
    const toggleButtons = wizard.locator(".channel-toggle");
    await expect(toggleButtons.first()).toBeVisible();

    // Click toggle to enable Telegram
    const telegramCard = wizard.locator(".channel-card").filter({ hasText: "Telegram" });
    await telegramCard.locator(".channel-toggle").click();

    // After enabling, the toggle should have "enabled" class
    await expect(telegramCard.locator(".channel-toggle")).toHaveClass(/enabled/);
  });

  test("step 5 Review shows YAML preview", async ({ page }) => {
    const wizard = page.locator("ic-setup-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Navigate through all steps to reach Review
    // Step 1: Next
    await wizard.getByRole("button", { name: "Next" }).click();

    // Step 2: Select Ollama, Next
    await wizard.locator(".provider-card").filter({ hasText: "Ollama" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();

    // Step 3: Next
    await wizard.getByRole("button", { name: "Next" }).click();

    // Step 4: Click "Review" button (label changes to "Review" on step 4)
    await wizard.getByRole("button", { name: "Review" }).click();

    // Verify step 5 (Review) shows YAML preview
    const yamlPreview = wizard.locator(".yaml-preview");
    await expect(yamlPreview).toBeVisible();

    // Verify YAML contains configured values
    const yamlText = await yamlPreview.textContent();
    expect(yamlText).toContain("tenantId");
    expect(yamlText).toContain("default");

    // Verify action buttons are present
    await expect(wizard.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Download" })).toBeVisible();
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

    // Navigate to step 5 (Review)
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.locator(".provider-card").filter({ hasText: "Ollama" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Review" }).click();

    // On step 5, Next button should not be present
    await expect(navBar.getByRole("button", { name: "Next" })).not.toBeVisible();
    await expect(navBar.getByRole("button", { name: "Review" })).not.toBeVisible();
  });
});
