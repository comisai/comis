// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Config editor RPC mock data.
 *
 * config.read returns { config, sections } matching the
 * component's _loadData() Promise.all call shape.
 * config.schema returns { schema, sections } for form/schema rendering.
 */
const CONFIG_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.read": {
    config: {
      general: {
        tenantId: "default",
        dataDir: "/home/agent/.comis",
        logLevel: "info",
      },
      gateway: {
        host: "0.0.0.0",
        port: 4766,
      },
      providers: {
        anthropic: {
          type: "anthropic",
          apiKey: "env:ANTHROPIC_API_KEY",
        },
      },
      agents: {
        "agent-default": {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          maxSteps: 25,
        },
      },
    },
    sections: ["general", "gateway", "providers", "agents"],
  },
  "config.schema": {
    schema: {
      general: {
        type: "object",
        properties: {
          tenantId: {
            type: "string",
            description: "Tenant identifier",
          },
          dataDir: {
            type: "string",
            description: "Data directory path",
          },
          logLevel: {
            type: "string",
            enum: ["debug", "info", "warn", "error"],
            description: "Log level",
          },
        },
      },
      gateway: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
        },
      },
      providers: {
        type: "object",
        properties: {
          anthropic: {
            type: "object",
            properties: {
              type: { type: "string" },
              apiKey: { type: "string" },
            },
          },
        },
      },
      agents: {
        type: "object",
        properties: {
          "agent-default": {
            type: "object",
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              maxSteps: { type: "number" },
            },
          },
        },
      },
    },
    sections: ["general", "gateway", "providers", "agents"],
  },
  "config.apply": { success: true },
  "config.export": "tenantId: default\ndataDir: /home/agent/.comis\nlogLevel: info\n",
  "config.import": { success: true },
};

test.describe("Config editor view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, CONFIG_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Config");
  });

  test("config editor shows section navigation sidebar", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Verify section navigation items are rendered in the sidebar
    const sectionNav = editor.locator('[role="navigation"]');
    await expect(sectionNav).toBeVisible();

    // Check all 4 sections appear (capitalized from section names)
    await expect(sectionNav.getByText("General")).toBeVisible();
    await expect(sectionNav.getByText("Gateway")).toBeVisible();
    await expect(sectionNav.getByText("Providers")).toBeVisible();
    await expect(sectionNav.getByText("Agents")).toBeVisible();

    // First section should be selected by default (data-selected attribute)
    const generalItem = editor.locator(".section-item").first();
    await expect(generalItem).toHaveAttribute("data-selected", "");

    // Click Gateway section and verify it becomes selected
    await sectionNav.getByText("Gateway").click();
    const gatewayItem = editor.locator(".section-item").nth(1);
    await expect(gatewayItem).toHaveAttribute("data-selected", "");
  });

  test("form mode shows auto-generated form fields", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Form mode should be active by default
    const formModeBtn = editor.locator(".mode-btn").first();
    await expect(formModeBtn).toHaveAttribute("data-active", "");

    // General section is selected by default -- verify form fields
    // tenantId field should show "default" value
    const formContent = editor.locator(".form-content");
    await expect(formContent).toBeVisible();

    // Verify tenantId label (toTitleCase turns "tenantId" into "Tenant Id")
    await expect(editor.getByText("Tenant Id", { exact: true })).toBeVisible();
    // Verify tenantId input has value "default"
    await expect(editor.getByRole("textbox").first()).toHaveValue("default");
    // Log Level renders as ic-select with label "Log Level"
    // Use exact match to avoid collision with description text "Log level" (lowercase l)
    await expect(editor.getByText("Log Level", { exact: true })).toBeVisible();
  });

  test("YAML mode shows editable YAML content", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Click YAML mode button
    await editor.getByText("YAML", { exact: true }).click();

    // Verify YAML textarea appears with aria-label
    const yamlTextarea = editor.locator('textarea[aria-label="YAML editor"]');
    await expect(yamlTextarea).toBeVisible();

    // Verify YAML content includes serialized config values
    const yamlContent = await yamlTextarea.inputValue();
    expect(yamlContent).toContain("tenantId");
    expect(yamlContent).toContain("default");

    // Valid configuration message should appear (no errors)
    await expect(editor.getByText("Valid configuration")).toBeVisible();
  });

  test("Schema mode shows JSON Schema tree", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Click Schema mode button
    await editor.getByText("Schema", { exact: true }).click();

    // Verify schema tree renders with property names
    const schemaTree = editor.locator(".schema-tree");
    await expect(schemaTree).toBeVisible();

    // tenantId property should be visible with "string" type tag
    await expect(editor.locator(".schema-key").getByText("tenantId")).toBeVisible();
    await expect(editor.locator("ic-tag").getByText("string").first()).toBeVisible();

    // Description should be visible for tenantId
    await expect(editor.getByText("Tenant identifier")).toBeVisible();
  });

  test("Apply button triggers config save", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Apply button should be present but disabled when no changes
    const applyBtn = editor.locator(".apply-btn");
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toContainText("Apply Changes");
    await expect(applyBtn).toBeDisabled();

    // Make a change to enable the Apply button: switch to YAML mode and edit
    await editor.getByText("YAML", { exact: true }).click();
    const yamlTextarea = editor.locator('textarea[aria-label="YAML editor"]');
    await yamlTextarea.fill("tenantId: modified\ndataDir: /home/agent/.comis\nlogLevel: info");

    // Apply button should now be enabled (dirty state)
    await expect(applyBtn).toBeEnabled();

    // Click Apply -- the component calls config.apply RPC then reloads config
    await applyBtn.click();

    // After successful apply, dirty state resets and button becomes disabled again
    await expect(applyBtn).toBeDisabled({ timeout: 5_000 });
  });

  test("import/export buttons are available", async ({ page }) => {
    const editor = page.locator("ic-config-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Verify Import and Export buttons are present in the toolbar
    const importBtn = editor.locator(".secondary-btn").getByText("Import");
    const exportBtn = editor.locator(".secondary-btn").getByText("Export");

    await expect(importBtn).toBeVisible();
    await expect(exportBtn).toBeVisible();
  });
});
