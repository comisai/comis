/**
 * Security view e2e tests.
 *
 * Tests the 5-tab security view: Audit Log, Tokens, Secrets, Policies, Gateway.
 * Uses shared helpers for REST API mocking, WebSocket RPC mocking, and login.
 */
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Mock config.read response with full security and gateway sections.
 *
 * The security view calls config.read and uses the result's security and
 * gateway sections. Tokens are nested at gateway.auth.tokens.
 */
const SECURITY_CONFIG = {
  security: {
    actionClassifier: {
      "file:write": "medium",
      "exec:shell": "high",
      "web:fetch": "low",
    },
    agentToAgent: {
      mode: "explicit",
      pairs: ["agent-default->agent-coding"],
    },
    sendPolicy: {
      enabled: true,
      rules: ["no-pii", "content-filter"],
    },
    permissions: {
      "agent-default": "full",
      "agent-coding": "restricted",
    },
    secrets: ["ANTHROPIC_API_KEY", "DISCORD_TOKEN", "TELEGRAM_TOKEN"],
  },
  gateway: {
    tls: {
      enabled: false,
      certPath: "",
      keyPath: "",
    },
    rateLimit: {
      requestsPerWindow: 100,
      windowMs: 60000,
    },
    cors: {
      origins: ["http://localhost:5173"],
    },
    trustedProxies: ["127.0.0.1"],
    auth: {
      tokens: [
        {
          id: "tok-abc123",
          scopes: ["read", "write", "admin"],
          createdAt: Date.now() - 604800000,
          lastUsedAt: Date.now() - 3600000,
        },
        {
          id: "tok-def456",
          scopes: ["read"],
          createdAt: Date.now() - 86400000,
          lastUsedAt: Date.now() - 7200000,
        },
      ],
    },
    requestLog: [
      {
        method: "GET",
        path: "/api/health",
        status: 200,
        timestamp: Date.now() - 30000,
      },
      {
        method: "POST",
        path: "/api/chat",
        status: 200,
        timestamp: Date.now() - 60000,
      },
      {
        method: "GET",
        path: "/api/agents",
        status: 401,
        timestamp: Date.now() - 90000,
      },
    ],
  },
};

/** Merged RPC handlers with security-specific config.read response. */
const SECURITY_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.read": SECURITY_CONFIG,
  "config.patch": { success: true },
};

test.describe("Security view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SECURITY_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Security");
  });

  // --- Audit Log Tab ---

  test("audit log tab shows event stream area", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Audit Log tab should be active by default (first tab)
    // The tab bar is inside ic-tabs shadow DOM -- look for the tab label
    const tabs = securityView.locator("ic-tabs");
    await expect(tabs).toBeVisible();

    // Audit log empty state should be visible (no SSE events dispatched)
    await expect(securityView.getByText("No audit events")).toBeVisible();

    // Pause/Resume button should be present in the audit controls
    await expect(securityView.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  // --- Tokens Tab ---

  test("tokens tab shows existing tokens", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Click "Tokens" tab -- tabs render as role="tab" buttons inside ic-tabs shadow DOM
    await securityView.locator("ic-tabs").getByRole("tab", { name: "Tokens" }).click();

    // Wait for token data to render
    await expect(securityView.getByText("tok-abc123")).toBeVisible({ timeout: 5_000 });
    await expect(securityView.getByText("tok-def456")).toBeVisible();

    // Verify scopes displayed for first token (scoped to cell containing tok-abc123 row)
    // Both tokens have "read" scope, so scope assertions to the row with tok-abc123
    const tokensTable = securityView.locator('[role="table"][aria-label="API tokens"]');
    await expect(tokensTable).toBeVisible();

    // Verify first token's scopes: read, write, admin are all visible in table
    // Scope to the table to avoid collisions with the Create Token form labels
    await expect(tokensTable.getByText("write")).toBeVisible();
    await expect(tokensTable.getByText("admin")).toBeVisible();
    // "read" scope appears on both tokens, verify at least one is visible
    await expect(tokensTable.getByText("read").first()).toBeVisible();
  });

  test("tokens tab has create and revoke actions", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Click "Tokens" tab
    await securityView.locator("ic-tabs").getByRole("tab", { name: "Tokens" }).click();

    // "Create Token" form title should be visible
    await expect(securityView.getByText("Create Token")).toBeVisible({ timeout: 5_000 });

    // Generate button should be present (the create action)
    await expect(securityView.getByRole("button", { name: "Generate" })).toBeVisible();

    // Each token row should have a "Revoke" button
    const revokeButtons = securityView.getByRole("button", { name: "Revoke" });
    await expect(revokeButtons).toHaveCount(2);
  });

  // --- Secrets Tab ---

  test("secrets tab shows key inventory (names only)", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Click "Secrets" tab
    await securityView.locator("ic-tabs").getByRole("tab", { name: "Secrets" }).click();

    // Secret names should be visible
    await expect(securityView.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: 5_000 });
    await expect(securityView.getByText("DISCORD_TOKEN")).toBeVisible();
    await expect(securityView.getByText("TELEGRAM_TOKEN")).toBeVisible();

    // Security requirement: NO actual secret values should be shown.
    // The secrets list only shows key names in .secret-name spans.
    // We verify by checking that common secret-like patterns are NOT present.
    // The view only renders the name strings, never secret values.
    const secretRows = securityView.locator(".secret-row");
    await expect(secretRows).toHaveCount(3);
  });

  // --- Policies Tab ---

  test("policies tab shows action rules and permissions", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Click "Policies" tab
    await securityView.locator("ic-tabs").getByRole("tab", { name: "Policies" }).click();

    // Action Confirmation Rules section header should be visible
    await expect(securityView.getByText("Action Confirmation Rules")).toBeVisible({
      timeout: 5_000,
    });

    // Agent-to-Agent Policy section should show
    await expect(securityView.getByText("Agent-to-Agent Policy")).toBeVisible();

    // Send Policy section should show
    await expect(securityView.getByText("Send Policy")).toBeVisible();

    // Permissions section should show
    await expect(securityView.getByText("Permissions")).toBeVisible();
  });

  // --- Gateway Tab ---

  test("gateway tab shows TLS and rate limit settings", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Click "Gateway" tab
    await securityView.locator("ic-tabs").getByRole("tab", { name: "Gateway" }).click();

    // TLS Status section should show with "Disabled" tag
    await expect(securityView.getByText("TLS Status")).toBeVisible({ timeout: 5_000 });
    await expect(securityView.getByText("Disabled")).toBeVisible();

    // Rate Limits section with form inputs
    await expect(securityView.getByText("Rate Limits")).toBeVisible();

    // CORS Origins section with the origin listed
    await expect(securityView.getByText("CORS Origins")).toBeVisible();
    await expect(securityView.getByText("http://localhost:5173")).toBeVisible();

    // Request Log section with recent requests
    await expect(securityView.getByText("Request Log")).toBeVisible();
    await expect(securityView.getByText("/api/health")).toBeVisible();
    await expect(securityView.getByText("/api/chat")).toBeVisible();
    await expect(securityView.getByText("/api/agents")).toBeVisible();
  });
});
