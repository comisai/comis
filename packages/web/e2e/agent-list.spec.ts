// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Mock agents with different statuses for agent list tests.
 * Uses 3 agents to verify multiple rows and status variants.
 */
const AGENT_LIST_AGENTS = [
  {
    id: "agent-default",
    name: "DefaultAgent",
    status: "active",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  },
  {
    id: "agent-coding",
    name: "CodingAgent",
    status: "idle",
    provider: "openai",
    model: "gpt-4o",
  },
  {
    id: "agent-suspended",
    name: "SuspendedAgent",
    status: "suspended",
    provider: "anthropic",
    model: "claude-haiku-35",
  },
];

/** RPC handlers extended with agent list data and actions */
const AGENT_LIST_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "agents.list": AGENT_LIST_AGENTS,
  "agents.suspend": { success: true },
  "agents.resume": { success: true },
  "agents.delete": { success: true },
  // Agent detail data needed for row-click navigation test
  "agents.get": {
    id: "agent-default",
    name: "DefaultAgent",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    status: "active",
    maxSteps: 25,
  },
  "obs.billing.byAgent": {
    messagesToday: 50,
    tokensToday: 25000,
    activeSessions: 3,
    costToday: 0.65,
  },
};

test.describe("Agent list view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    // Override /api/agents AFTER mockApiRoutes to ensure our 3-agent data takes
    // precedence (Playwright matches most recently registered route first)
    await page.route("**/api/agents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: AGENT_LIST_AGENTS }),
      }),
    );
    await mockRpcRoutes(page, AGENT_LIST_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Agents");
  });

  test("agent list shows all agents in grid table", async ({ page }) => {
    const agentList = page.locator("ic-agent-list");
    await expect(agentList).toBeVisible({ timeout: 10_000 });

    // Verify page title "Agents"
    await expect(agentList.locator(".page-title")).toHaveText("Agents");

    // Verify all 3 agent names are visible
    await expect(agentList.getByText("DefaultAgent")).toBeVisible();
    await expect(agentList.getByText("CodingAgent")).toBeVisible();
    await expect(agentList.getByText("SuspendedAgent")).toBeVisible();

    // Verify model names are visible
    await expect(agentList.getByText("claude-sonnet-4-20250514")).toBeVisible();
    await expect(agentList.getByText("gpt-4o")).toBeVisible();
    await expect(agentList.getByText("claude-haiku-35")).toBeVisible();
  });

  test("agent list shows status tags with correct variants", async ({ page }) => {
    const agentList = page.locator("ic-agent-list");
    await expect(agentList).toBeVisible({ timeout: 10_000 });

    // STATUS_LABEL map: active -> "Active", idle -> "Idle", suspended -> "Suspended"
    await expect(agentList.getByText("Active", { exact: true })).toBeVisible();
    await expect(agentList.getByText("Idle", { exact: true })).toBeVisible();
    await expect(agentList.getByText("Suspended", { exact: true })).toBeVisible();
  });

  test("agent list has Create Agent button", async ({ page }) => {
    const agentList = page.locator("ic-agent-list");
    await expect(agentList).toBeVisible({ timeout: 10_000 });

    // The create-btn contains "Create Agent" text with a plus icon
    const createBtn = agentList.locator(".create-btn").first();
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toHaveText(/Create Agent/);
  });

  test("agent list row click navigates to agent detail", async ({ page }) => {
    const agentList = page.locator("ic-agent-list");
    await expect(agentList).toBeVisible({ timeout: 10_000 });

    // Click on the row containing "DefaultAgent"
    await agentList.getByText("DefaultAgent").click();

    // The row click dispatches navigate event with "agents/agent-default"
    // which causes the router to update the hash
    await page.waitForURL(/#\/agents\/agent-default/);

    // Verify agent detail view becomes visible
    await expect(page.locator("ic-agent-detail")).toBeVisible({ timeout: 10_000 });
  });

  test("agent list renders all grid rows after data loads", async ({ page }) => {
    const agentList = page.locator("ic-agent-list");
    await expect(agentList).toBeVisible({ timeout: 10_000 });

    // Verify the grid-table rendered with 3 data rows (one per agent)
    const rows = agentList.locator(".grid-row");
    await expect(rows).toHaveCount(3);

    // Verify the grid header exists with column headers
    const headerCells = agentList.locator(".grid-header .cell");
    await expect(headerCells).toHaveCount(5); // ID, Name, Model, Status, Actions
  });
});
