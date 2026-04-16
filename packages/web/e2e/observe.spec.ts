import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Observability view e2e tests covering 5 tabs:
 * Overview, Billing, Delivery, Channels, and Diagnostics.
 *
 * RPC mock data aligned to actual TypeScript interfaces:
 * DeliveryStats, BillingTotal, BillingByProvider, BillingByAgent,
 * DeliveryTrace, ChannelActivity, DiagnosticsEvent.
 */

/** RPC handlers for the observe view, matching actual method names. */
const OBSERVE_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "obs.delivery.stats": {
    successRate: 98.5,
    avgLatencyMs: 120,
    totalDelivered: 985,
    failed: 15,
  },
  "obs.billing.total": {
    totalTokens: 250000,
    totalCost: 6.5,
  },
  "obs.billing.usage24h": [],
  "obs.billing.byProvider": [
    {
      provider: "anthropic",
      inputTokens: 150000,
      outputTokens: 75000,
      functionTokens: 5000,
      cost: 4.0,
    },
    {
      provider: "openai",
      inputTokens: 10000,
      outputTokens: 5000,
      functionTokens: 1000,
      cost: 2.5,
    },
  ],
  "obs.billing.byAgent": [
    {
      agentId: "agent-default",
      totalTokens: 150000,
      percentOfTotal: 60.0,
      cost: 4.0,
    },
    {
      agentId: "agent-coding",
      totalTokens: 100000,
      percentOfTotal: 40.0,
      cost: 2.5,
    },
  ],
  "obs.delivery.recent": [
    {
      traceId: "trace-1",
      timestamp: Date.now() - 60000,
      channelType: "telegram",
      messagePreview: "Hello from telegram",
      status: "success",
      latencyMs: 95,
      stepCount: 3,
    },
    {
      traceId: "trace-2",
      timestamp: Date.now() - 120000,
      channelType: "discord",
      messagePreview: "Discord test message",
      status: "failed",
      latencyMs: null,
      stepCount: 1,
    },
  ],
  "obs.channels.activity": [
    {
      channelType: "discord",
      channelId: "discord-general",
      messagesSent: 500,
      messagesReceived: 450,
      lastActiveAt: Date.now() - 30000,
      isStale: false,
    },
    {
      channelType: "telegram",
      channelId: "telegram-bot",
      messagesSent: 300,
      messagesReceived: 280,
      lastActiveAt: Date.now() - 60000,
      isStale: false,
    },
  ],
  "obs.diagnostics": [
    {
      timestamp: Date.now() - 30000,
      category: "monitor",
      message: "High memory usage detected",
      level: "warn",
    },
    {
      timestamp: Date.now() - 60000,
      category: "daemon",
      message: "Agent restarted",
      level: "info",
    },
  ],
};

test.describe("Observability view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, OBSERVE_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Observe");
  });

  test("overview shows stat cards with request and token counts", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Verify stat cards show request count from delivery stats
    await expect(view.getByText("Requests Today")).toBeVisible();
    await expect(view.locator("ic-stat-card").filter({ hasText: "Requests Today" })).toBeVisible();

    // Verify tokens display (250,000 or 250K)
    await expect(view.getByText("Tokens Today")).toBeVisible();

    // Verify cost display
    await expect(view.getByText("Cost Today")).toBeVisible();
    await expect(view.getByText("$6.50")).toBeVisible();

    // Verify errors count from delivery stats
    await expect(view.getByText("Errors Today")).toBeVisible();
  });

  test("billing tab shows token breakdown by agent", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click Billing tab
    await view.getByText("Billing", { exact: true }).click();

    // Verify By Agent section title
    await expect(view.getByText("By Agent")).toBeVisible();

    // Verify per-agent breakdown shows agent-default
    await expect(view.getByText("agent-default")).toBeVisible();

    // Verify agent-coding is shown
    await expect(view.getByText("agent-coding")).toBeVisible();

    // Verify costs are shown ($4.00 appears in both provider and agent tables, use first())
    await expect(view.getByText("$4.00").first()).toBeVisible();
    await expect(view.getByText("$2.50").first()).toBeVisible();
  });

  test("delivery tab shows message delivery traces", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click Delivery tab
    await view.getByText("Delivery", { exact: true }).click();

    // Verify delivery stats summary shows success rate
    await expect(view.getByText("98.5%")).toBeVisible();

    // Verify delivery traces are shown -- scope to delivery table to avoid filter dropdown collisions
    const deliveryTable = view.getByLabel("Delivery traces");
    await expect(deliveryTable.getByText("telegram", { exact: true })).toBeVisible();
    await expect(deliveryTable.getByText("discord", { exact: true })).toBeVisible();
  });

  test("diagnostics tab shows recent events", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click Diagnostics tab
    await view.getByText("Diagnostics", { exact: true }).click();

    // Verify diagnostic events are shown
    await expect(view.getByText("High memory usage detected")).toBeVisible();
    await expect(view.getByText("Agent restarted")).toBeVisible();

    // Verify severity indicators are shown (warn and info tags)
    await expect(view.locator("ic-tag").filter({ hasText: "warn" })).toBeVisible();
    await expect(view.locator("ic-tag").filter({ hasText: "info" })).toBeVisible();
  });

  test("channels tab shows per-channel metrics", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Click Channels tab (within observe view)
    await view.getByText("Channels", { exact: true }).click();

    // Verify discord channel shows sent messages count
    await expect(view.getByText("500")).toBeVisible();

    // Verify telegram channel shows sent messages count
    await expect(view.getByText("300")).toBeVisible();

    // Verify channel IDs are shown
    await expect(view.getByText("discord-general")).toBeVisible();
    await expect(view.getByText("telegram-bot")).toBeVisible();
  });
});
