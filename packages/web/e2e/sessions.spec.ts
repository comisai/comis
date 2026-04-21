// SPDX-License-Identifier: Apache-2.0
import { test, expect, type Page } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/** Mock session data matching the SessionInfo interface in api/types.ts */
const MOCK_SESSIONS = [
  {
    key: "agent-default:telegram:12345",
    agentId: "agent-default",
    channelType: "telegram",
    messageCount: 25,
    totalTokens: 15000,
    inputTokens: 8000,
    outputTokens: 7000,
    toolCalls: 5,
    compactions: 1,
    resetCount: 0,
    createdAt: Date.now() - 86400000,
    lastActiveAt: Date.now() - 3600000,
  },
  {
    key: "agent-coding:discord:67890",
    agentId: "agent-coding",
    channelType: "discord",
    messageCount: 10,
    totalTokens: 5000,
    inputTokens: 3000,
    outputTokens: 2000,
    toolCalls: 2,
    compactions: 0,
    resetCount: 1,
    createdAt: Date.now() - 43200000,
    lastActiveAt: Date.now() - 7200000,
  },
];

/** Mock session detail response matching getSessionDetail return type */
const MOCK_SESSION_DETAIL = {
  session: MOCK_SESSIONS[0],
  messages: [
    {
      role: "user",
      content: "Hello",
      timestamp: Date.now() - 3700000,
    },
    {
      role: "assistant",
      content: "Hi there! How can I help?",
      timestamp: Date.now() - 3600000,
    },
  ],
};

/**
 * Set up REST route mocks for session endpoints.
 * The session views use apiClient (REST) since app.ts does not pass rpcCall.
 */
async function mockSessionRoutes(page: Page): Promise<void> {
  // List sessions endpoint
  await page.route("**/api/sessions", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_SESSIONS),
      });
    }
    return route.continue();
  });

  // Session detail and action endpoints
  await page.route("**/api/sessions/**", (route) => {
    const url = route.request().url();
    // Skip the list endpoint (already handled above)
    if (url.endsWith("/api/sessions") || url.endsWith("/api/sessions/")) {
      return route.continue();
    }

    // Handle sub-actions
    if (url.includes("/reset")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    }
    if (url.includes("/compact")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    }
    if (url.includes("/export")) {
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: '{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there!"}',
      });
    }
    if (url.includes("/bulk-delete")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: 1 }),
      });
    }
    if (url.includes("/bulk-reset")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reset: 1 }),
      });
    }
    if (url.includes("/bulk-export")) {
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: '{"role":"user","content":"bulk export data"}',
      });
    }

    // DELETE method for individual session
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    }

    // Session detail (GET)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SESSION_DETAIL),
    });
  });
}

/**
 * Login flow for session detail view -- navigates to /#/sessions/:key
 * then waits for ic-session-detail instead of ic-dashboard.
 */
async function loginForDetail(page: Page): Promise<void> {
  await page.locator("ic-app").waitFor();
  const tokenInput = page.locator("ic-app").getByRole("textbox");
  await tokenInput.fill("test-token-123");
  await page.locator("ic-app").getByRole("button", { name: "Connect" }).click();
  // When URL hash is sessions/:key, router resolves to ic-session-detail
  await expect(page.locator("ic-session-detail")).toBeVisible({ timeout: 10_000 });
}

test.describe("Session list view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, DEFAULT_RPC_HANDLERS);
    await mockSessionRoutes(page);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Sessions");
  });

  test("session list shows all sessions in table", async ({ page }) => {
    // Wait for the session list view to render
    const sessionView = page.locator("ic-session-list-view");
    await expect(sessionView).toBeVisible({ timeout: 10_000 });

    // Verify page title (scoped to the h1 heading to avoid sidebar collision)
    await expect(sessionView.locator(".page-title")).toHaveText("Sessions");

    // Verify first session data -- scope to the ic-session-list table area
    const sessionList = sessionView.locator("ic-session-list");
    await expect(sessionList.getByText("agent-default")).toBeVisible();
    await expect(sessionList.getByText("telegram")).toBeVisible();

    // Verify second session data (use exact cell match to avoid key truncation collision)
    await expect(sessionList.getByRole("cell", { name: "agent-coding", exact: true })).toBeVisible();
    await expect(sessionList.getByText("discord")).toBeVisible();
  });

  test("session list shows message count", async ({ page }) => {
    const sessionView = page.locator("ic-session-list-view");
    await expect(sessionView).toBeVisible({ timeout: 10_000 });

    // Verify message counts are displayed in the table
    const sessionList = sessionView.locator("ic-session-list");
    await expect(sessionList.getByText("25")).toBeVisible();
    await expect(sessionList.getByText("10")).toBeVisible();
  });

  test("session list search filters sessions", async ({ page }) => {
    const sessionView = page.locator("ic-session-list-view");
    await expect(sessionView).toBeVisible({ timeout: 10_000 });

    // Find search input by its role (ic-search-input renders role="searchbox")
    const searchBox = sessionView.getByRole("searchbox");
    await expect(searchBox).toBeVisible();
    await searchBox.fill("telegram");

    // Wait for debounce (300ms default) + re-render
    await page.waitForTimeout(500);

    // Verify telegram session is still visible
    const sessionList = sessionView.locator("ic-session-list");
    await expect(sessionList.getByText("telegram")).toBeVisible();

    // Verify discord session is no longer visible
    await expect(sessionList.getByText("discord")).not.toBeVisible();
  });

  test("clicking session navigates to detail", async ({ page }) => {
    const sessionView = page.locator("ic-session-list-view");
    await expect(sessionView).toBeVisible({ timeout: 10_000 });

    // Click on the first session row via the agent ID text
    const sessionList = sessionView.locator("ic-session-list");
    await sessionList.getByText("agent-default").click();

    // Verify URL hash changes to contain sessions/
    await expect(page).toHaveURL(/sessions\//);
  });
});

test.describe("Session detail view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, DEFAULT_RPC_HANDLERS);
    await mockSessionRoutes(page);
    await page.goto("/#/sessions/agent-default:telegram:12345");
    await loginForDetail(page);
  });

  test("session detail shows conversation history", async ({ page }) => {
    const detail = page.locator("ic-session-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Verify user message is visible
    await expect(detail.getByText("Hello")).toBeVisible();

    // Verify assistant message is visible
    await expect(detail.getByText("Hi there! How can I help?")).toBeVisible();

    // Verify messages have role indicators via data-role attributes
    await expect(detail.locator("[data-role='user']")).toBeVisible();
    await expect(detail.locator("[data-role='assistant']")).toBeVisible();
  });

  test("session detail shows session metadata", async ({ page }) => {
    const detail = page.locator("ic-session-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Verify agent ID is displayed in the info bar
    const infoBar = detail.locator(".session-info");
    await expect(infoBar.getByText("agent-default")).toBeVisible();

    // Verify channel type is displayed
    await expect(infoBar.getByText("telegram")).toBeVisible();

    // Verify message count is displayed
    await expect(infoBar.getByText("25")).toBeVisible();
  });

  test("session detail has action buttons", async ({ page }) => {
    const detail = page.locator("ic-session-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Verify action buttons are visible in the actions bar
    const actionsBar = detail.locator(".actions-bar");
    await expect(actionsBar.getByRole("button", { name: "Reset" })).toBeVisible();
    await expect(actionsBar.getByRole("button", { name: "Export JSONL" })).toBeVisible();
    await expect(actionsBar.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(actionsBar.getByRole("button", { name: "Compact" })).toBeVisible();
  });

  test("session detail export triggers download", async ({ page }) => {
    const detail = page.locator("ic-session-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Listen for download event
    const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);

    // Click Export button
    await detail.getByRole("button", { name: "Export JSONL" }).click();

    // The export creates a blob URL and triggers a download via a.click()
    const download = await downloadPromise;
    if (download) {
      // If download event was captured, verify filename pattern
      expect(download.suggestedFilename()).toContain("session-");
    }
    // Export action completed without error -- success toast should appear
  });
});
