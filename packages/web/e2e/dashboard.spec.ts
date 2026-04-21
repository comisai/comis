// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes, MOCK_AGENTS, MOCK_CHANNELS } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";

test.describe("Dashboard view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, DEFAULT_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
  });

  test("dashboard shows stat cards with agent and channel counts", async ({ page }) => {
    // Scope assertions to the dashboard component to avoid sidebar/nav ambiguity
    const dashboard = page.locator("ic-dashboard");
    await expect(dashboard).toBeVisible();

    // Verify "Active Agents" stat card shows correct count from mock data
    const activeAgentCount = MOCK_AGENTS.filter((a) => a.status === "active").length;
    const totalAgentCount = MOCK_AGENTS.length;
    await expect(dashboard.getByText("Active Agents")).toBeVisible();
    await expect(dashboard.getByText(`${activeAgentCount}/${totalAgentCount}`)).toBeVisible();

    // Verify "Channels" stat card shows correct count (scoped to label text)
    const connectedChannelCount = MOCK_CHANNELS.filter((c) => c.status === "connected").length;
    const totalChannelCount = MOCK_CHANNELS.length;
    // Use exact match to avoid matching the section title "Channels" which is also present
    await expect(dashboard.locator("ic-stat-card").filter({ hasText: "Channels" })).toBeVisible();
    await expect(dashboard.getByText(`${connectedChannelCount}/${totalChannelCount}`)).toBeVisible();
  });

  test("dashboard shows system health card with uptime and memory", async ({ page }) => {
    const dashboard = page.locator("ic-dashboard");

    // The dashboard fetches gateway.status via RPC, which returns uptime: 86400
    // formatUptime(86400) produces "1d 0h 0m"
    await expect(dashboard.getByText("System Health")).toBeVisible({ timeout: 10_000 });
    await expect(dashboard.getByText("Uptime")).toBeVisible();
    await expect(dashboard.getByText("1d 0h 0m")).toBeVisible();

    // Memory usage should be displayed (scoped to info-card to avoid sidebar "Memory" nav item)
    const healthCard = dashboard.locator(".info-card").filter({ hasText: "System Health" });
    await expect(healthCard.getByText("Memory")).toBeVisible();

    // Event Loop Delay should show "2.5ms"
    await expect(dashboard.getByText("Event Loop Delay")).toBeVisible();
    await expect(dashboard.getByText("2.5ms")).toBeVisible();

    // Node.js version should be shown
    await expect(dashboard.getByText("v22.0.0")).toBeVisible();
  });

  test("dashboard shows agent cards with name and status", async ({ page }) => {
    const dashboard = page.locator("ic-dashboard");

    // The Agents section title is rendered (use exact match to avoid "Active Agents")
    await expect(
      dashboard.locator(".section-title").filter({ hasText: "Agents" }),
    ).toBeVisible();

    // Agent card should show the test agent name
    await expect(dashboard.getByText("TestAgent")).toBeVisible();

    // Agent card shows status text (the status-badge renders the raw status string)
    const agentCard = page.locator("ic-agent-card");
    await expect(agentCard.getByText("active")).toBeVisible();

    // Agent card shows provider and model details
    await expect(agentCard.getByText("anthropic")).toBeVisible();
    await expect(agentCard.getByText("claude-sonnet-4-20250514")).toBeVisible();
  });

  test("dashboard shows channel badges with platform type", async ({ page }) => {
    const dashboard = page.locator("ic-dashboard");

    // The Channels section title is rendered
    await expect(
      dashboard.locator(".section-title").filter({ hasText: "Channels" }),
    ).toBeVisible();

    // Verify discord channel badge is present with name "#general"
    await expect(page.locator("ic-channel-badge").getByText("#general")).toBeVisible();

    // Verify telegram channel badge is present with name "bot-chat"
    await expect(page.locator("ic-channel-badge").getByText("bot-chat")).toBeVisible();
  });

  test("dashboard shows activity feed", async ({ page }) => {
    // Activity feed section should be present
    const activityFeed = page.locator("ic-activity-feed");
    await expect(activityFeed).toBeVisible();
    await expect(activityFeed.getByText("Recent Activity")).toBeVisible();

    // Since mock activity is empty, show empty state message
    await expect(activityFeed.getByText("No activity yet")).toBeVisible();
  });
});

test.describe("Dashboard view (no RPC)", () => {
  test("dashboard stat cards show placeholder when RPC unavailable", async ({ page }) => {
    // Set up only REST mocks (no RPC mock)
    await mockApiRoutes(page);

    // Mock WebSocket to close immediately, simulating RPC unavailable
    await page.routeWebSocket(/\/ws/, (ws) => {
      ws.close();
    });

    await page.goto("/");
    await login(page);

    const dashboard = page.locator("ic-dashboard");
    await expect(dashboard).toBeVisible();

    // Without RPC data, "Messages Today" and "Tokens Today" should show "---" placeholder
    await expect(dashboard.getByText("Messages Today")).toBeVisible();
    await expect(dashboard.getByText("Tokens Today")).toBeVisible();

    // The stat cards for Messages Today and Tokens Today show "---" when no RPC data
    // Find stat cards containing these labels and verify their values
    const messagesStat = dashboard.locator("ic-stat-card").filter({ hasText: "Messages Today" });
    await expect(messagesStat.getByText("---")).toBeVisible({ timeout: 10_000 });

    const tokensStat = dashboard.locator("ic-stat-card").filter({ hasText: "Tokens Today" });
    await expect(tokensStat.getByText("---")).toBeVisible();

    // System Health card should show loading/placeholder state
    const healthCard = dashboard.locator(".info-card").filter({ hasText: "System Health" });
    await expect(healthCard.getByText("---")).toBeVisible();
  });
});
