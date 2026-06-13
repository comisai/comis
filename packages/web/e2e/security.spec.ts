// SPDX-License-Identifier: Apache-2.0
/**
 * Security view e2e tests.
 *
 * The Security view exposes seven tabs in the current architecture:
 * Security Events (default), Audit Log, API Tokens, Secrets, Approval Rules,
 * Pending Approvals, Provider Health. Approvals are covered separately in
 * approvals.spec.ts; this spec exercises events, audit, tokens, secrets,
 * and provider health.
 */
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/** Mock token rows returned by admin.tokens.list. */
const MOCK_TOKENS = [
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
];

/** Security config consumed via config.read for the policy / secrets tabs. */
const SECURITY_CONFIG = {
  security: {
    actionConfirmation: {
      requireForDestructive: true,
      requireForSensitive: false,
      autoApprove: ["file:read"],
    },
    permission: {
      enableNodePermissions: false,
      allowedFsPaths: ["/tmp"],
      allowedNetHosts: ["api.example.com"],
    },
    secrets: {
      enabled: true,
      dbPath: "secrets.db",
    },
    approvalRules: {
      defaultMode: "manual",
      timeoutMs: 300000,
    },
  },
  gateway: {
    auth: {
      tokens: MOCK_TOKENS,
    },
  },
};

/** Merged RPC handlers with security-specific config.read response. */
const SECURITY_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "config.read": {
    config: SECURITY_CONFIG,
    sections: ["security", "gateway"],
  },
  "config.patch": { success: true },
  // ic-token-manager calls tokens.list / tokens.create / tokens.revoke /
  // tokens.rotate (not admin.tokens.*).
  "tokens.list": { tokens: MOCK_TOKENS },
  "tokens.create": { id: "tok-new", scopes: ["read"], secret: "mock-bearer-secret" },
  "tokens.revoke": { success: true },
  "tokens.rotate": { id: "tok-abc123", secret: "mock-bearer-secret" },
  "admin.approval.pending": { requests: [], total: 0 },
};

test.describe("Security view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SECURITY_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Security");
  });

  // --- Default tab: Security Events ---

  test("default Security Events tab renders the event feed", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // The default tab shows the security event feed component.
    await expect(securityView.locator("ic-security-event-feed")).toBeVisible();
  });

  // --- Audit Log Tab ---

  test("audit log tab shows event stream area", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Switch to the Audit Log tab.
    await securityView.getByRole("tab", { name: "Audit Log" }).click();

    // With no SSE events dispatched, the audit feed renders the empty state.
    await expect(securityView.getByText("No audit events")).toBeVisible();

    // The audit controls expose a Pause/Resume toggle (rendered as "Pause"
    // when the feed is live).
    await expect(securityView.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  // --- API Tokens Tab ---

  test("tokens tab shows existing tokens", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    // Tab label is "API Tokens" (not "Tokens").
    await securityView.getByRole("tab", { name: "API Tokens" }).click();

    // Tokens render inside the ic-token-manager sub-component.
    const tokenManager = securityView.locator("ic-token-manager");
    await expect(tokenManager).toBeVisible({ timeout: 5_000 });
    await expect(tokenManager.getByText("tok-abc123")).toBeVisible();
    await expect(tokenManager.getByText("tok-def456")).toBeVisible();
  });

  test("tokens tab has create and revoke actions", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    await securityView.getByRole("tab", { name: "API Tokens" }).click();
    const tokenManager = securityView.locator("ic-token-manager");
    await expect(tokenManager).toBeVisible({ timeout: 5_000 });

    // Some affordance to create a new token must exist; tolerant matcher to
    // accommodate label variations (Create / Generate / Issue / New Token).
    await expect(
      tokenManager.getByRole("button", {
        name: /create|generate|issue|new token/i,
      }).first(),
    ).toBeVisible();

    // Each existing token row exposes a revoke button.
    const revokeButtons = tokenManager.getByRole("button", { name: /revoke/i });
    await expect(revokeButtons).toHaveCount(MOCK_TOKENS.length);
  });

  // --- Secrets Tab ---

  test("secrets tab shows encrypted secrets store config", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    await securityView.getByRole("tab", { name: "Secrets" }).click();

    // The Secrets tab surfaces the read-only credential-storage config: the
    // storage mode (runtime-immutable per D17 — no toggle) and the database
    // path. It does not list secret names directly (that lives in the agent
    // editor's secrets section).
    await expect(securityView.getByText("Credential Storage")).toBeVisible();
    // exact: the "Storage Mode" label would otherwise also match the
    // "Storage mode is set in config.yaml…" helper note (strict-mode clash).
    await expect(securityView.getByText("Storage Mode", { exact: true })).toBeVisible();
    await expect(securityView.getByText("secrets.db")).toBeVisible();
  });

  // --- Provider Health Tab ---

  test("provider health tab renders an empty-state when no provider data is loaded", async ({ page }) => {
    const securityView = page.locator("ic-security-view");
    await expect(securityView).toBeVisible({ timeout: 10_000 });

    await securityView.getByRole("tab", { name: "Provider Health" }).click();

    // With no provider:health SSE events dispatched, the empty state appears.
    await expect(securityView.getByText("No provider data")).toBeVisible();
  });
});
