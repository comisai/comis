/**
 * Shared login and navigation helpers for Playwright e2e tests.
 *
 * Provides reusable authentication flow and sidebar navigation
 * that all spec files can import.
 */
import { type Page, expect } from "@playwright/test";

/**
 * Perform the login flow: fill token, click Connect, wait for dashboard.
 *
 * @param page - Playwright Page instance (must already have navigated to "/")
 */
export async function login(page: Page): Promise<void> {
  // Wait for the app element to be present
  await page.locator("ic-app").waitFor();

  // Fill the password input with a test token
  const tokenInput = page.locator("ic-app").getByRole("textbox");
  await tokenInput.fill("test-token-123");

  // Click the Connect button
  await page.locator("ic-app").getByRole("button", { name: "Connect" }).click();

  // Wait for the dashboard to load (ic-dashboard element appears)
  await expect(page.locator("ic-dashboard")).toBeVisible({ timeout: 10_000 });
}

/**
 * Navigate to a view by clicking its sidebar button.
 *
 * @param page - Playwright Page instance (must be authenticated)
 * @param label - The sidebar button label (e.g., "Chat", "Memory", "Agents")
 */
export async function navigateTo(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label }).click();
}
