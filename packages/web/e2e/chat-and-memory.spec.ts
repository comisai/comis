import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";

test.describe("Chat interaction", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    // Mock POST /api/chat REST endpoint used by chat console
    await page.route("**/api/chat", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            response: "Hello from agent!",
            tokensUsed: 42,
          }),
        });
      }
      return route.continue();
    });
    await mockRpcRoutes(page, {
      ...DEFAULT_RPC_HANDLERS,
      "session.list": [],
    });
  });

  test("send message and receive agent response", async ({ page }) => {
    await page.goto("/");
    await login(page);

    // Navigate to Chat
    await page.getByRole("button", { name: "Chat" }).click();
    await expect(page.locator("ic-chat-console")).toBeVisible({ timeout: 5_000 });

    // Verify textarea is visible
    const textarea = page.locator("ic-chat-console").getByRole("textbox");
    await expect(textarea).toBeVisible();

    // Type a message
    await textarea.fill("Hello there");

    // Click send
    await page.locator("ic-chat-console").getByRole("button", { name: "Send message" }).click();

    // Verify user message appears (optimistic)
    await expect(page.getByText("Hello there")).toBeVisible({ timeout: 5_000 });

    // Verify agent response appears (from POST /api/chat REST result)
    await expect(page.getByText("Hello from agent!")).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Memory inspector", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page);
  });

  test("search and view memory detail", async ({ page }) => {
    await page.goto("/");
    await login(page);

    // Navigate to Memory
    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.locator("ic-memory-inspector")).toBeVisible({ timeout: 5_000 });

    // Type search query into the ic-search-input's inner input
    const searchInput = page.locator("ic-memory-inspector").getByRole("searchbox", { name: "Search" });
    await expect(searchInput).toBeVisible();
    await searchInput.fill("test query");
    await searchInput.press("Enter");

    // Verify search results appear
    await expect(page.getByText("Test memory")).toBeVisible({ timeout: 5_000 });

    // Click on the result to open detail panel
    await page.getByText("Test memory").click();

    // Verify detail panel opens with "Memory Entry" header
    await expect(page.getByText("Memory Entry")).toBeVisible({ timeout: 5_000 });
  });
});
