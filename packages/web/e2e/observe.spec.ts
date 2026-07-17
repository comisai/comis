// SPDX-License-Identifier: Apache-2.0
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
    total: 1000,
    attempted: 1000,
    success: 985,
    error: 10,
    timeout: 5,
    filtered: 0,
    aborted: 0,
    avgLatencyMs: 120,
  },
  "obs.billing.total": {
    totalTokens: 250000,
    totalCost: 6.5,
  },
  "obs.billing.usage24h": [],
  // BillingByProvider rows are rendered via totalTokens / callCount / totalCost.
  "obs.billing.byProvider": [
    {
      provider: "anthropic",
      totalTokens: 230000,
      totalCost: 4.0,
      callCount: 120,
      totalCacheSaved: 0,
      models: [],
    },
    {
      provider: "openai",
      totalTokens: 16000,
      totalCost: 2.5,
      callCount: 25,
      totalCacheSaved: 0,
      models: [],
    },
  ],
  // The observability view consumes obs.channels.all for the Channels tab.
  "obs.channels.all": {
    channels: [
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
  },
  "obs.delivery.recent": {
    deliveries: [
      {
        sourceChannelId: "chat_a",
        sourceChannelType: "telegram",
        targetChannelType: "telegram",
        targetChannelId: "chat_a",
        deliveredAt: Date.now() - 60000,
        latencyMs: 95,
        status: "success",
        error: null,
        agentId: "agent_a",
        sessionKey: null,
        traceId: "trace-1",
        toolCalls: 1,
        llmCalls: 2,
        tokensTotal: 240,
        costTotal: 0.01,
        failureStage: null,
        errorKind: null,
        steps: [],
        evidence: "diagnostic",
      },
      {
        sourceChannelId: "chat_b",
        sourceChannelType: "discord",
        targetChannelType: "discord",
        targetChannelId: "chat_b",
        deliveredAt: Date.now() - 120000,
        latencyMs: 120,
        status: "error",
        error: "Delivery failed",
        agentId: "agent_b",
        sessionKey: null,
        traceId: "trace-2",
        toolCalls: 0,
        llmCalls: 1,
        tokensTotal: 100,
        costTotal: 0.005,
        failureStage: "delivery",
        errorKind: "platform",
        steps: [],
        evidence: "diagnostic",
      },
    ],
  },
  // DiagnosticsEvent shape: { id, timestamp, category, eventType, data }.
  // deriveDiagnosticLevel falls back to "info" for unknown event types and
  // returns "warn" for retry:attempted; deriveDiagnosticMessage echoes the
  // event-type string when no specialized formatter matches.
  "obs.diagnostics": [
    {
      id: "ev-1",
      timestamp: Date.now() - 30000,
      category: "monitor",
      eventType: "retry:attempted",
      data: {},
    },
    {
      id: "ev-2",
      timestamp: Date.now() - 60000,
      category: "daemon",
      eventType: "session:created",
      data: {},
    },
  ],
};

test.describe("Observability view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, OBSERVE_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    // The sidebar groups observability routes under an "Observe" section
    // header (non-interactive). The Overview entry is the first clickable
    // item in that section and renders ic-observe-view.
    await navigateTo(page, "Overview");
  });

  test("overview shows stat cards with request and token counts", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Overview now exposes six stat cards: Requests/min, Error Rate,
    // Avg Latency, Active Agents, Tokens (24h), Cost Today.
    await expect(view.getByText("Requests/min")).toBeVisible();
    await expect(view.getByText("Tokens (24h)")).toBeVisible();
    await expect(view.getByText("Cost Today")).toBeVisible();
    // "Error Rate" also appears as a chart title ("Error Rate (24h)"), so
    // pin to the stat-card label using exact match.
    await expect(view.getByText("Error Rate", { exact: true })).toBeVisible();

    // Cost Today rendered as USD currency.
    await expect(view.getByText("$6.50")).toBeVisible();
  });

  test("billing tab shows token breakdown by provider", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Switch to the Billing tab via role to disambiguate from body text.
    await view.getByRole("tab", { name: "Billing" }).click();

    // The Billing tab renders a "By Provider" table; the legacy "By Agent"
    // table is no longer populated by the observe view's data loader.
    await expect(view.getByText("By Provider")).toBeVisible();
    await expect(view.getByText("anthropic")).toBeVisible();
    await expect(view.getByText("openai")).toBeVisible();

    // Costs render as USD currency (anthropic: $4.00, openai: $2.50).
    await expect(view.getByText("$4.00").first()).toBeVisible();
    await expect(view.getByText("$2.50").first()).toBeVisible();
  });

  test("delivery tab shows message delivery traces", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Switch to the Delivery tab via role to disambiguate from body text.
    await view.getByRole("tab", { name: "Delivery" }).click();

    // Canonical delivery records are content-free, so verify their channel and
    // lifecycle presentation without relying on a message body preview.
    const rows = view.locator("ic-delivery-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByText("telegram")).toBeVisible();
    await expect(rows.nth(1).locator('svg[aria-label="Error"]')).toBeVisible();
  });

  test("diagnostics tab shows recent events", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Switch to the Diagnostics tab via role to disambiguate from body text.
    await view.getByRole("tab", { name: "Diagnostics" }).click();

    // Diagnostic messages are derived from event type via deriveDiagnosticMessage.
    // retry:attempted -> "Retry attempted"; session:created -> "Session created".
    await expect(view.getByText("Retry attempted")).toBeVisible();
    await expect(view.getByText("Session created")).toBeVisible();

    // Severity tags: retry:attempted is "warn", session:created falls back to "info".
    await expect(view.locator("ic-tag").filter({ hasText: "warn" }).first()).toBeVisible();
    await expect(view.locator("ic-tag").filter({ hasText: "info" }).first()).toBeVisible();
  });

  test("channels tab shows per-channel metrics", async ({ page }) => {
    const view = page.locator("ic-observe-view");
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Switch to the Channels tab via role to disambiguate from body text.
    await view.getByRole("tab", { name: "Channels" }).click();

    // Verify channel IDs are shown
    await expect(view.getByText("discord-general")).toBeVisible();
    await expect(view.getByText("telegram-bot")).toBeVisible();

    // Verify per-channel message counts (sent column).
    await expect(view.getByText("500").first()).toBeVisible();
    await expect(view.getByText("300").first()).toBeVisible();
  });
});
