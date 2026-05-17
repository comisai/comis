// SPDX-License-Identifier: Apache-2.0
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

    // Built-in tool enable/disable has moved out of the global Skills view.
    // The Skills view now renders informational tool cards (name + description);
    // per-tool toggling lives in the agent editor's tool policy section.
    // Verify the relevant tool cards still render with the canonical tool names.
    const expectedTools = ["read", "write", "edit", "grep", "find", "ls", "exec"];
    for (const tool of expectedTools) {
      await expect(
        view.locator(".tool-name").getByText(tool, { exact: true }),
      ).toBeVisible();
    }

    // The view explicitly directs users to the agent editor for per-tool config.
    await expect(
      view.getByText("Enable or disable tools per agent in the agent editor."),
    ).toBeVisible();
  });

  test("prompt skills tab shows configuration", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click the "Prompt Skills" tab via role=tab to avoid ambiguity with the
    // matching description span on the Built-in Tools tab.
    await view.getByRole("tab", { name: "Prompt Skills" }).click();

    // With no discovered skills returned by the mock, the tab renders an
    // empty state directing users to upload or import a skill folder.
    await expect(
      view.getByText("No prompt skills discovered"),
    ).toBeVisible();

    // The tab footer links per-agent configuration to the agent editor.
    await expect(
      view.getByText(
        /Configure prompt skill settings.*per agent in the agent editor\./,
      ),
    ).toBeVisible();
  });

  test("MCP servers are managed in the dedicated MCP view", async ({ page }) => {
    // MCP servers were extracted out of the Skills view into the dedicated
    // ic-mcp-management view (reachable from the sidebar). The Skills view
    // no longer has an "MCP Servers" tab.
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Verify the Skills view has exactly the current set of tabs --
    // no "MCP Servers" tab is present.
    const tabs = view.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(view.getByRole("tab", { name: "Built-in Tools" })).toBeVisible();
    await expect(view.getByRole("tab", { name: "Prompt Skills" })).toBeVisible();

    // Navigate to the dedicated MCP view via the sidebar.
    await navigateTo(page, "MCP Servers");
    await expect(page.locator("ic-mcp-management")).toBeVisible({ timeout: 10_000 });
  });

  test("tool policy guidance is shown in the Built-in Tools tab", async ({ page }) => {
    const view = page.locator("ic-skills-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Tool Policy is no longer a dedicated tab -- its content is folded into
    // the Built-in Tools tab as a labelled section beneath the tool cards.
    // Scope the "Tool Policy" assertion to the section-header to avoid the
    // strict-mode collision with the inline help copy.
    await expect(
      view.locator(".section-header").getByText("Tool Policy"),
    ).toBeVisible();

    // The section explains profile semantics and points per-agent config to
    // the agent editor.
    await expect(
      view.getByText(/Profiles \(minimal, coding, messaging, supervisor, full\)/),
    ).toBeVisible();
    await expect(
      view.getByText("Configure tool policy per agent in the agent editor."),
    ).toBeVisible();
  });
});
