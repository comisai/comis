// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";

test.describe("Auth and Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page);
  });

  test("login flow: token entry loads dashboard", async ({ page }) => {
    await page.goto("/");

    // Auth screen should be visible
    const tokenInput = page.locator("ic-app").getByRole("textbox");
    await expect(tokenInput).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

    // Fill token and submit
    await tokenInput.fill("test-token-123");
    await page.getByRole("button", { name: "Connect" }).click();

    // Dashboard should load
    await expect(page.locator("ic-dashboard")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("TestAgent")).toBeVisible();
  });

  test("navigation: switch between Dashboard, Chat, and Memory", async ({ page }) => {
    await page.goto("/");
    await login(page);

    // Navigate to Chat
    await page.getByRole("button", { name: "Chat" }).click();
    // Chat console should appear
    await expect(page.locator("ic-chat-console")).toBeVisible({ timeout: 5_000 });

    // Navigate to Memory
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.locator("ic-memory-inspector")).toBeVisible({ timeout: 5_000 });

    // Navigate back to Dashboard
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(page.locator("ic-dashboard")).toBeVisible({ timeout: 5_000 });
  });

  test("logout: disconnect returns to auth screen", async ({ page }) => {
    await page.goto("/");
    await login(page);

    // Verify we are on dashboard
    await expect(page.locator("ic-dashboard")).toBeVisible();

    // Click Logout in the sidebar
    await page.getByRole("button", { name: "Logout" }).click();

    // Auth screen should return
    const tokenInput = page.locator("ic-app").getByRole("textbox");
    await expect(tokenInput).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  });
});
