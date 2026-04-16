import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";

/**
 * Mock agent detail data matching the AgentDetail TypeScript interface.
 * Includes budgets and routing bindings to exercise all detail sections.
 */
const MOCK_AGENT_DETAIL = {
  agentId: "agent-default",
  config: {
    name: "DefaultAgent",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxSteps: 25,
    temperature: 0.7,
    thinkingLevel: "medium",
    budgets: {
      perExecution: 10000,
      perHour: 50000,
      perDay: 500000,
    },
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 60000,
      halfOpenTimeoutMs: 30000,
    },
    contextGuard: { enabled: true, warnPercent: 80, blockPercent: 95 },
    sdkRetry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000 },
    modelFailover: { fallbackModels: ["gpt-4", "gpt-3.5-turbo"] },
    rag: { enabled: false },
    session: { resetPolicy: { mode: "daily" } },
    concurrency: { maxConcurrentRuns: 3, maxQueuedPerSession: 10 },
  },
  suspended: false,
};

/** Mock billing data matching the AgentBilling interface */
const MOCK_AGENT_BILLING = {
  messagesToday: 50,
  tokensToday: 25000,
  activeSessions: 3,
  costToday: 0.65,
  budgetUsed: {
    perHour: { used: 12500, total: 50000 },
    perDay: { used: 125000, total: 500000 },
  },
};

/** RPC handlers for agent detail view */
const AGENT_DETAIL_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "agents.get": MOCK_AGENT_DETAIL,
  "obs.billing.byAgent": MOCK_AGENT_BILLING,
};

test.describe("Agent detail view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, AGENT_DETAIL_RPC_HANDLERS);
    // Navigate to "/" first so login helper can wait for ic-dashboard
    await page.goto("/");
    await login(page);
    // Navigate to agent detail via hash change (avoids full page reload)
    await page.evaluate(() => {
      window.location.hash = "#/agents/agent-default";
    });
    await page.locator("ic-agent-detail").waitFor({ timeout: 10_000 });
  });

  test("agent detail shows agent name and status", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Breadcrumb shows agent name
    await expect(detail.getByText("DefaultAgent")).toBeVisible();

    // Status is "active" so the Suspend button should be visible
    await expect(detail.getByRole("button", { name: "Suspend" })).toBeVisible();
  });

  test("agent detail shows stat cards with metrics", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Stat cards display billing data
    await expect(detail.getByText("Messages Today")).toBeVisible();
    await expect(detail.getByText("Tokens Today")).toBeVisible();
    await expect(detail.getByText("Active Sessions")).toBeVisible();
    await expect(detail.getByText("Cost Today")).toBeVisible();

    // Verify specific values from mock billing data
    // messagesToday=50 -> "50", tokensToday=25000 -> "25K", activeSessions=3, costToday=0.65 -> "$0.65"
    const messagesCard = detail.locator("ic-stat-card").filter({ hasText: "Messages Today" });
    await expect(messagesCard).toBeVisible();

    const costCard = detail.locator("ic-stat-card").filter({ hasText: "Cost Today" });
    await expect(costCard.getByText("$0.65")).toBeVisible();

    const sessionsCard = detail.locator("ic-stat-card").filter({ hasText: "Active Sessions" });
    await expect(sessionsCard.getByText("3")).toBeVisible();

    const tokensCard = detail.locator("ic-stat-card").filter({ hasText: "Tokens Today" });
    await expect(tokensCard.getByText("25K")).toBeVisible();
  });

  test("agent detail shows budget bars", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Budgets section should be visible with budget bar components
    await expect(detail.getByText("Budgets")).toBeVisible();

    // Budget bars for Per Execution, Per Hour, Per Day
    const budgetBars = detail.locator("ic-budget-bar");
    await expect(budgetBars).toHaveCount(3);

    // Verify labels
    await expect(detail.getByText("Per Execution")).toBeVisible();
    await expect(detail.getByText("Per Hour")).toBeVisible();
    await expect(detail.getByText("Per Day")).toBeVisible();
  });

  test("agent detail shows configuration summary", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Configuration section
    await expect(detail.getByText("Configuration")).toBeVisible();

    // Scope to the config-grid to avoid matching values in other sections
    const configGrid = detail.locator(".config-grid");
    await expect(configGrid).toBeVisible();

    // Config grid items: Model, Provider, Max Steps, Temperature, Thinking
    await expect(configGrid.getByText("anthropic")).toBeVisible();
    await expect(configGrid.getByText("claude-sonnet-4-20250514")).toBeVisible();
    // Use exact match for "25" to avoid matching "25K" or "25%"
    await expect(configGrid.getByText("25", { exact: true })).toBeVisible();
    await expect(configGrid.getByText("0.7")).toBeVisible();
    await expect(configGrid.getByText("medium")).toBeVisible();
  });

  test("agent detail shows routing bindings section", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Routing Bindings section heading
    await expect(detail.getByRole("heading", { name: "Routing Bindings" })).toBeVisible();

    // No routing bindings in PerAgentConfig, so shows empty state
    await expect(detail.getByText("No routing bindings")).toBeVisible();
  });

  test("agent detail has edit button that navigates to editor", async ({ page }) => {
    const detail = page.locator("ic-agent-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });

    // Click Edit button
    await detail.getByRole("button", { name: "Edit" }).click();

    // Verify URL hash changes to contain agents/agent-default/edit
    await page.waitForURL(/#\/agents\/agent-default\/edit/);
  });
});
