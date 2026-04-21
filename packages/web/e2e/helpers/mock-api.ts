// SPDX-License-Identifier: Apache-2.0
/**
 * Shared REST API route mocking for Playwright e2e tests.
 *
 * Provides reusable mock data and route handlers that all
 * spec files can import to avoid duplicating mock setup.
 */
import { type Page } from "@playwright/test";

/** Mock agent data returned by GET /api/agents */
export const MOCK_AGENTS = [
  {
    id: "agent-default",
    name: "TestAgent",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    status: "active",
  },
];

/** Mock channel data returned by GET /api/channels */
export const MOCK_CHANNELS = [
  {
    type: "discord",
    name: "#general",
    enabled: true,
    status: "connected",
  },
  {
    type: "telegram",
    name: "bot-chat",
    enabled: true,
    status: "connected",
  },
];

/** Mock activity entries returned by GET /api/activity */
export const MOCK_ACTIVITY: unknown[] = [];

/** Mock chat history returned by GET /api/chat/history */
export const MOCK_CHAT_HISTORY: unknown[] = [];

/** Mock memory stats returned by GET /api/memory/stats */
export const MOCK_MEMORY_STATS = {
  totalEntries: 42,
  totalSessions: 5,
  embeddedEntries: 10,
};

/** Mock memory search results returned by GET /api/memory/search */
export const MOCK_MEMORY_SEARCH_RESULTS = [
  {
    id: "m1",
    content: "Test memory",
    memoryType: "semantic",
    trustLevel: "learned",
    score: 0.95,
    createdAt: Date.now(),
  },
];

/**
 * Mock all common API routes used after login.
 *
 * Sets up Playwright route handlers for health, agents, channels,
 * activity, chat history, memory stats, and memory search endpoints.
 */
export async function mockApiRoutes(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }),
    }),
  );

  await page.route("**/api/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: MOCK_AGENTS }),
    }),
  );

  await page.route("**/api/channels", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ channels: MOCK_CHANNELS }),
    }),
  );

  await page.route("**/api/activity**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: MOCK_ACTIVITY }),
    }),
  );

  await page.route("**/api/chat/history**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: MOCK_CHAT_HISTORY }),
    }),
  );

  await page.route("**/api/memory/stats**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_MEMORY_STATS),
    }),
  );

  await page.route("**/api/memory/search**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_MEMORY_SEARCH_RESULTS }),
    }),
  );
}
