// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";
import type { Page } from "@playwright/test";

/**
 * Mock channel data for REST API /api/channels.
 * Provides 3 channels: 2 enabled (discord, telegram), 1 disabled (slack).
 */
const CHANNEL_LIST_CHANNELS = [
  // Canonical health states (the legacy "connected" alias was removed — the
  // backend emits healthy/idle/stale/disconnected/etc.; see health-status.ts).
  { type: "discord", name: "#general", enabled: true, status: "healthy" },
  { type: "telegram", name: "bot-chat", enabled: true, status: "healthy" },
  { type: "slack", name: "#ops", enabled: false, status: "disconnected" },
];

/**
 * Mock observability data from obs.channels.all RPC.
 * Provides message counts and activity timestamps for enrichment.
 */
const MOCK_OBS_CHANNELS = {
  channels: [
    {
      channelId: "discord-1",
      channelType: "discord",
      lastActiveAt: Date.now() - 60_000,
      messagesSent: 100,
      messagesReceived: 50,
    },
    {
      channelId: "telegram-1",
      channelType: "telegram",
      lastActiveAt: Date.now() - 120_000,
      messagesSent: 50,
      messagesReceived: 25,
    },
  ],
};

/**
 * Mock stale channel data from obs.channels.stale RPC.
 * Slack is marked as stale (inactive > 5 min).
 */
const MOCK_STALE_CHANNELS = {
  channels: [
    {
      channelId: "slack-1",
      channelType: "slack",
      lastActiveAt: 0,
      messagesSent: 0,
      messagesReceived: 0,
    },
  ],
};

/** Mock channel detail config from channels.get RPC. */
const MOCK_DISCORD_CONFIG = {
  enabled: true,
  status: "connected",
  botToken: "env:DISCORD_TOKEN",
  guildId: "123456789",
  streaming: {
    chunkMode: "word",
    pacingMs: 100,
    typingMode: "continuous",
  },
  allowFrom: [],
};

/** RPC handlers for channel tests. */
const CHANNEL_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "obs.channels.all": MOCK_OBS_CHANNELS,
  "obs.channels.stale": MOCK_STALE_CHANNELS,
  "channels.restart": { success: true },
  "channels.enable": { success: true },
  "channels.disable": { success: true },
  "channels.get": MOCK_DISCORD_CONFIG,
  "obs.delivery.recent": { entries: [] },
  "obs.channels.activity": { hours: [] },
  "config.read": {
    sections: {
      channels: {
        discord: { token: "env:DISCORD_TOKEN", guildId: "123456" },
        telegram: { token: "env:TELEGRAM_TOKEN" },
        slack: { token: "env:SLACK_TOKEN", appToken: "env:SLACK_APP_TOKEN" },
      },
    },
  },
  "config.patch": { success: true },
};

/**
 * Override the default /api/channels mock to use our channel list data.
 * Must be called before page.goto() to intercept the route.
 */
async function mockChannelApiRoutes(page: Page): Promise<void> {
  // First apply the standard API route mocks
  await mockApiRoutes(page);

  // Then override the channels endpoint with our test data
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ channels: CHANNEL_LIST_CHANNELS }),
    }),
  );
}

test.describe("Channel list view", () => {
  test.beforeEach(async ({ page }) => {
    await mockChannelApiRoutes(page);
    await mockRpcRoutes(page, CHANNEL_RPC_HANDLERS);
    await page.goto("/");
    await login(page);

    // Navigate to channels via sidebar
    await page.getByRole("button", { name: "Channels" }).click();

    // Wait for channel list to render
    await page.locator("ic-channel-list").waitFor({ timeout: 10_000 });
  });

  test("channel list shows platform cards for each enabled channel", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    // Verify enabled channels show as cards with capitalize(type) as name
    await expect(channelList.getByText("Discord")).toBeVisible();
    await expect(channelList.getByText("Telegram")).toBeVisible();
  });

  test("channel cards show connection status", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    // ic-channel-card renders a status pill with the health-label derived
    // from the channel's canonical status (e.g. "healthy" -> "Healthy"). Scope
    // the assertion to the ic-channel-card element so the status text inside
    // the shadow root is queried.
    const discordCard = channelList.locator("ic-channel-card").filter({ hasText: "Discord" });
    await expect(discordCard.locator(".status-text")).toHaveText("Healthy");

    const telegramCard = channelList.locator("ic-channel-card").filter({ hasText: "Telegram" });
    await expect(telegramCard.locator(".status-text")).toHaveText("Healthy");
  });

  test("channel cards show message count metrics", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    // Cards always render the Messages metric (no expand/collapse). The
    // count is messagesSent + messagesReceived from obs.channels.all.
    const discordCard = channelList.locator("ic-channel-card").filter({ hasText: "Discord" });
    await expect(discordCard.getByText("Messages")).toBeVisible();
    // Discord: 100 + 50 = 150
    await expect(discordCard.locator(".metric-value").first()).toHaveText("150");

    const telegramCard = channelList.locator("ic-channel-card").filter({ hasText: "Telegram" });
    // Telegram: 50 + 25 = 75
    await expect(telegramCard.locator(".metric-value").first()).toHaveText("75");
  });

  test("disabled channel renders with Enable action button", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    // The channel-list no longer groups disabled channels into a separate
    // section -- all channels share a single card-grid. Disabled channels
    // render with status text "Disconnected" and expose an Enable button
    // in place of Configure/Restart.
    const slackCard = channelList.locator("ic-channel-card").filter({ hasText: "Slack" });
    await expect(slackCard).toBeVisible();
    await expect(slackCard.locator(".status-text")).toHaveText("Disconnected");
    await expect(slackCard.getByRole("button", { name: /Enable Slack/i })).toBeVisible();

    // The Disabled counter chip is also surfaced in the stats row.
    await expect(channelList.locator(".stat-badge--disconnected")).toContainText("Disabled");
  });

  test("channel cards expose lifecycle action buttons", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    // Enabled cards always show Configure + Restart buttons (no expand step).
    const discordCard = channelList.locator("ic-channel-card").filter({ hasText: "Discord" });
    await expect(discordCard.getByRole("button", { name: /Configure Discord/i })).toBeVisible();
    await expect(discordCard.getByRole("button", { name: /Restart Discord/i })).toBeVisible();
  });

  test("clicking Configure navigates to channel detail", async ({ page }) => {
    const channelList = page.locator("ic-channel-list");

    const discordCard = channelList.locator("ic-channel-card").filter({ hasText: "Discord" });
    await discordCard.getByRole("button", { name: /Configure Discord/i }).click();

    // Verify navigation occurred (channel detail component renders)
    await expect(page.locator("ic-channel-detail")).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Channel detail view", () => {
  test.beforeEach(async ({ page }) => {
    await mockChannelApiRoutes(page);
    await mockRpcRoutes(page, CHANNEL_RPC_HANDLERS);
    await page.goto("/");
    await login(page);

    // Navigate directly to discord channel detail
    await page.evaluate(() => {
      window.location.hash = "#/channels/discord";
    });

    // Wait for channel detail to render
    await page.locator("ic-channel-detail").waitFor({ timeout: 10_000 });
  });

  test("channel detail shows platform name and connection status", async ({ page }) => {
    const detail = page.locator("ic-channel-detail");

    // Platform name should be shown in the page title heading (scoped to .page-title to avoid breadcrumb)
    await expect(detail.locator(".page-title").getByText("Discord")).toBeVisible();

    // Connection dot should be present
    await expect(detail.locator("ic-connection-dot")).toBeVisible();
  });

  test("channel detail shows platform-specific configuration fields", async ({ page }) => {
    const detail = page.locator("ic-channel-detail");

    // Discord-specific fields from PLATFORM_FIELDS
    await expect(detail.getByText("Bot Token")).toBeVisible();
    await expect(detail.getByText("Guild ID")).toBeVisible();

    // Bot token should be masked (secret type shows dots)
    const secretField = detail.locator(".field-value.secret");
    await expect(secretField).toBeVisible();

    // Guild ID should show the value from mock config
    await expect(detail.getByText("123456789")).toBeVisible();
  });

  test("channel detail shows streaming configuration section", async ({ page }) => {
    const detail = page.locator("ic-channel-detail");

    // Switch to Streaming tab using role to disambiguate from section title
    await detail.getByRole("tab", { name: "Streaming" }).click();

    // Streaming section should show config from mock
    await expect(detail.getByText("Chunk Mode")).toBeVisible();
    await expect(detail.getByText("word")).toBeVisible();

    await expect(detail.getByText("Pacing")).toBeVisible();
    await expect(detail.getByText("100ms")).toBeVisible();
  });

  test("channel detail shows lifecycle action buttons", async ({ page }) => {
    const detail = page.locator("ic-channel-detail");

    // Restart and Disable buttons should be present in header
    await expect(detail.getByRole("button", { name: "Restart" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Disable" })).toBeVisible();
  });

  test("breadcrumb navigates back to channel list", async ({ page }) => {
    const detail = page.locator("ic-channel-detail");

    // Breadcrumb should show "Channels" link
    const breadcrumb = detail.locator("ic-breadcrumb");
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb.getByText("Channels")).toBeVisible();

    // Click the Channels breadcrumb link
    await breadcrumb.getByText("Channels").click();

    // Verify navigation back to channel list
    await expect(page.locator("ic-channel-list")).toBeVisible({ timeout: 5_000 });
  });
});
