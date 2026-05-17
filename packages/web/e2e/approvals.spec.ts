// SPDX-License-Identifier: Apache-2.0
/**
 * Approvals view e2e tests.
 *
 * Approvals were merged into the Security view (Pending Approvals / Approval
 * Rules tabs). The legacy ic-approvals-view now renders a redirect notice.
 * These tests cover both the redirect surface and the live queue inside
 * Security.
 */
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/**
 * Mock approval requests in the backend shape consumed by the Security
 * approval queue (admin.approval.pending returns { requests, total }).
 */
const MOCK_BACKEND_REQUESTS = [
  {
    requestId: "appr-001",
    toolName: "exec",
    action: "exec:shell",
    params: { command: "rm -rf /tmp/cache" },
    agentId: "agent-default",
    sessionKey: "agent-default:cli:1",
    trustLevel: "untrusted",
    createdAt: Date.now() - 120000,
    timeoutMs: 300000,
  },
  {
    requestId: "appr-002",
    toolName: "file",
    action: "file:write",
    params: { path: "/home/agent/config.yaml" },
    agentId: "agent-coding",
    sessionKey: "agent-coding:cli:1",
    trustLevel: "user",
    createdAt: Date.now() - 60000,
    timeoutMs: 300000,
  },
];

/** Merged RPC handlers with approvals-specific responses. */
const APPROVALS_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "admin.approval.pending": {
    requests: MOCK_BACKEND_REQUESTS,
    total: MOCK_BACKEND_REQUESTS.length,
  },
  "admin.approval.resolve": { success: true },
  // The Security view reads configResult.config.security to populate its
  // policy/rules tabs -- wrap the payload accordingly.
  "config.read": {
    config: {
      security: {
        approvalRules: {
          defaultMode: "manual",
          timeoutMs: 300000,
        },
      },
    },
    sections: ["security"],
  },
  "config.patch": { success: true },
};

test.describe("Approvals legacy redirect view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, APPROVALS_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Approvals");
  });

  test("legacy Approvals route shows redirect notice to Security", async ({ page }) => {
    const approvalsView = page.locator("ic-approvals-view");
    await expect(approvalsView).toBeVisible({ timeout: 10_000 });

    // The legacy view renders a single redirect card directing users to
    // the Security view's Pending Approvals tab.
    await expect(approvalsView.getByText("Approvals Moved")).toBeVisible();
    await expect(
      approvalsView.getByRole("button", { name: "Go to Security" }),
    ).toBeVisible();
  });
});

test.describe("Approvals (in Security view)", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, APPROVALS_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Security");
    await page
      .locator("ic-security-view")
      .getByRole("tab", { name: "Pending Approvals" })
      .click();
  });

  test("approvals view shows pending approval queue", async ({ page }) => {
    const security = page.locator("ic-security-view");
    await expect(security).toBeVisible({ timeout: 10_000 });

    // Approval cards render inside the embedded ic-approval-queue.
    const approvalCards = page.locator("ic-approval-card");
    await expect(approvalCards).toHaveCount(2);

    // Verify agent IDs are visible
    await expect(security.getByText("agent-default")).toBeVisible();
    await expect(security.getByText("agent-coding")).toBeVisible();

    // Verify actions are visible
    await expect(security.getByText("exec:shell")).toBeVisible();
    await expect(security.getByText("file:write")).toBeVisible();
  });

  test("approval card shows action details", async ({ page }) => {
    // Approvals are sorted by createdAt descending (newest first).
    // appr-002 (file:write, -60s) first, appr-001 (exec:shell, -120s) second.

    const firstCard = page.locator("ic-approval-card").first();
    await firstCard.getByText("Show details").click();

    // The first card's serialised params contain "config.yaml".
    await expect(firstCard.getByText(/config\.yaml/)).toBeVisible();

    const secondCard = page.locator("ic-approval-card").nth(1);
    await secondCard.getByText("Show details").click();

    // The second card's serialised params contain "rm -rf /tmp/cache".
    await expect(secondCard.getByText(/rm -rf \/tmp\/cache/)).toBeVisible();
  });

  test("approval card has approve and deny buttons", async ({ page }) => {
    // Each approval card should have Approve and Deny buttons
    const approveButtons = page.locator("ic-approval-card").getByRole("button", { name: "Approve" });
    const denyButtons = page.locator("ic-approval-card").getByRole("button", { name: "Deny" });

    await expect(approveButtons).toHaveCount(2);
    await expect(denyButtons).toHaveCount(2);
  });

  test("approving an item removes it from queue", async ({ page }) => {
    await expect(page.locator("ic-approval-card")).toHaveCount(2);

    const firstCard = page.locator("ic-approval-card").first();
    await firstCard.getByRole("button", { name: "Approve" }).click();

    // After approval resolves, only 1 card should remain
    await expect(page.locator("ic-approval-card")).toHaveCount(1, { timeout: 5_000 });
  });

  test("approval rules tab is reachable from Security", async ({ page }) => {
    const security = page.locator("ic-security-view");
    await expect(security).toBeVisible({ timeout: 10_000 });

    // Switch to the Approval Rules tab and assert it activates without error.
    await security.getByRole("tab", { name: "Approval Rules" }).click();

    // The Approval Rules tab is now active; the tab strip exposes both
    // approval-related tabs at all times.
    await expect(
      security.getByRole("tab", { name: "Approval Rules" }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
