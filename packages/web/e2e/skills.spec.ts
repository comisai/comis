import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Skills view e2e tests covering 4 tabs:
 * Built-in Tools, Prompt Skills, MCP Servers, and Tool Policy.
 */

/** Mock config.read response matching the ConfigReadResult interface in skills.ts */
const SKILLS_CONFIG = {
  skills: {
    discoveryPaths: ["/home/agent/.comis/skills"],
    builtinTools: {
      read: true,
      write: true,
      edit: true,
      grep: true,
      find: true,
      ls: true,
      exec: true,
      process: false,
      webSearch: false,
      webFetch: false,
      browser: false,
    },
    toolPolicy: {
      profile: "coding",
      allow: ["read", "write", "edit", "grep", "find", "ls", "exec", "process"],
      deny: [],
    },
    promptSkills: {
      maxBodyLength: 10000,
      enableDynamicContext: true,
      maxAutoInject: 3,
      allowedSkills: ["web-search", "code-review"],
      deniedSkills: [],
    },
  },
  integrations: {
    mcp: {
      servers: [
        {
          name: "local-tools",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          enabled: true,
        },
        {
          name: "remote-api",
          transport: "sse",
          url: "http://localhost:3100/sse",
          enabled: false,
        },
      ],
    },
  },
};

/** RPC handlers for the skills view. */
const SKILLS_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.read": SKILLS_CONFIG,
  "config.patch": { success: true },
};

test.describe("Skills view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SKILLS_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Skills");
  });

  test("shows built-in tools grid with categories", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Verify the Built-in Tools tab is shown (default tab)
    await expect(view.getByText("Built-in Tools")).toBeVisible();

    // Verify File Operations category with its tools (exact match to avoid description text collisions)
    await expect(view.getByText("File Operations")).toBeVisible();
    await expect(view.locator(".tool-name").getByText("read", { exact: true })).toBeVisible();
    await expect(view.locator(".tool-name").getByText("write", { exact: true })).toBeVisible();
    await expect(view.locator(".tool-name").getByText("edit", { exact: true })).toBeVisible();
    await expect(view.locator(".tool-name").getByText("find", { exact: true })).toBeVisible();
    await expect(view.locator(".tool-name").getByText("ls", { exact: true })).toBeVisible();

    // Verify Execution category (scope to category-header to avoid exec tool description collision)
    await expect(view.locator(".category-header").getByText("Execution")).toBeVisible();
    await expect(view.locator(".tool-name").getByText("exec", { exact: true })).toBeVisible();

    // Verify Search category
    await expect(view.locator(".category-header").getByText("Search")).toBeVisible();
    await expect(view.locator(".tool-name").getByText("grep", { exact: true })).toBeVisible();
  });

  test("shows enabled/disabled state for each tool", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Enabled tools should have their checkboxes checked
    const enabledTools = ["read", "write", "edit", "grep", "find", "ls", "exec"];
    for (const tool of enabledTools) {
      const checkbox = view.locator(`input[type="checkbox"][aria-label="Enable ${tool}"]`);
      await expect(checkbox).toBeChecked();
    }

    // Disabled tools should have unchecked checkboxes
    const disabledTools = ["webSearch", "webFetch", "browser"];
    for (const tool of disabledTools) {
      const checkbox = view.locator(`input[type="checkbox"][aria-label="Enable ${tool}"]`);
      await expect(checkbox).not.toBeChecked();
    }
  });

  test("prompt skills tab shows configuration", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click "Prompt Skills" tab
    await view.getByText("Prompt Skills").click();

    // Verify allowed skills are listed
    await expect(view.getByText("web-search")).toBeVisible();
    await expect(view.getByText("code-review")).toBeVisible();

    // Verify dynamic context toggle is shown and checked
    await expect(view.getByText("Enable Dynamic Context")).toBeVisible();
    const dynamicContextCheckbox = view.locator("#dynamic-context");
    await expect(dynamicContextCheckbox).toBeChecked();

    // Verify Allowed Skills section title
    await expect(view.getByText("Allowed Skills")).toBeVisible();
  });

  test("MCP servers tab shows server entries", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click "MCP Servers" tab
    await view.getByText("MCP Servers").click();

    // Verify local-tools server is visible with stdio transport
    await expect(view.getByText("local-tools")).toBeVisible();
    await expect(view.locator("ic-tag").filter({ hasText: "stdio" })).toBeVisible();

    // Verify remote-api server is visible with sse transport
    await expect(view.getByText("remote-api")).toBeVisible();
    await expect(view.locator("ic-tag").filter({ hasText: "sse" })).toBeVisible();

    // Verify local-tools is enabled (checkbox checked)
    const localToolsCheckbox = view.locator(`input[aria-label="Enable local-tools"]`);
    await expect(localToolsCheckbox).toBeChecked();

    // Verify remote-api is disabled (checkbox unchecked)
    const remoteApiCheckbox = view.locator(`input[aria-label="Enable remote-api"]`);
    await expect(remoteApiCheckbox).not.toBeChecked();
  });

  test("tool policy tab shows profile and allow/deny lists", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click "Tool Policy" tab
    await view.getByText("Tool Policy").click();

    // Verify "coding" profile is shown
    await expect(view.getByText("Profile")).toBeVisible();
    const profileSelect = view.locator(".policy-select");
    await expect(profileSelect).toHaveValue("coding");

    // Verify allow list shows allowed tools -- each tool has a remove button with aria-label
    await expect(view.getByText("Allow List")).toBeVisible();
    for (const tool of ["read", "write", "edit", "grep", "find", "ls", "exec", "process"]) {
      await expect(view.getByLabel(`Remove ${tool}`)).toBeVisible();
    }

    // Verify deny list is empty
    await expect(view.getByText("Deny List")).toBeVisible();
    // Deny list shows "No items" since it's empty
    await expect(view.getByText("No items")).toBeVisible();
  });
});
