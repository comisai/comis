// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login, navigateTo } from "./helpers/login.js";

/** Mock cron job data matching the SchedulerCronJob interface in scheduler.ts */
const MOCK_JOBS = [
  {
    id: "daily-summary",
    name: "Daily Summary",
    agentId: "agent-default",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    payload: { kind: "message", message: "Generate daily summary" },
    sessionTarget: "dedicated",
    enabled: true,
    nextRunAtMs: Date.now() + 3600000,
    lastRunAtMs: Date.now() - 86400000,
    consecutiveErrors: 0,
    createdAtMs: Date.now() - 604800000,
  },
  {
    id: "hourly-check",
    name: "Hourly Check",
    agentId: "agent-default",
    schedule: { kind: "every", everyMs: 3600000 },
    payload: { kind: "message", message: "Run hourly check" },
    sessionTarget: "shared",
    enabled: false,
    nextRunAtMs: null,
    lastRunAtMs: Date.now() - 7200000,
    consecutiveErrors: 2,
    createdAtMs: Date.now() - 604800000,
  },
];

/** RPC handlers for scheduler methods, merged with default handlers */
const SCHEDULER_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "cron.list": MOCK_JOBS,
  "cron.add": { jobId: "new-job" },
  "cron.update": { success: true },
  "cron.remove": { success: true },
  "config.read": {
    heartbeat: {
      enabled: true,
      intervalMs: 300000,
    },
  },
};

test.describe("Scheduler - Cron Jobs", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SCHEDULER_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Scheduler");
  });

  test("shows cron jobs table with job entries", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Verify Cron Jobs tab is active by default (tab content renders jobs)
    await expect(scheduler.getByText("Daily Summary")).toBeVisible();
    await expect(scheduler.getByText("Hourly Check")).toBeVisible();

    // Verify cron expression is shown
    await expect(scheduler.getByText("0 9 * * *")).toBeVisible();
  });

  test("shows enabled and disabled status for jobs", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Daily Summary is enabled with 0 errors -> active status dot (green)
    const dailyRow = scheduler.locator(".grid-row").filter({ hasText: "Daily Summary" });
    await expect(dailyRow.locator(".status-dot--active")).toBeVisible();

    // Hourly Check is disabled (enabled=false) -> inactive status dot regardless of errors
    // Logic: enabled ? (errors > 0 ? error : active) : inactive
    const hourlyRow = scheduler.locator(".grid-row").filter({ hasText: "Hourly Check" });
    await expect(hourlyRow.locator(".status-dot--inactive")).toBeVisible();
  });

  test("shows error count for failing jobs", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Hourly Check has 2 consecutive errors -- shown even when disabled
    const hourlyRow = scheduler.locator(".grid-row").filter({ hasText: "Hourly Check" });
    await expect(hourlyRow.getByText("2 errors")).toBeVisible();
  });

  test("has Add Job button", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // The header has "+ New Job" button
    await expect(scheduler.getByRole("button", { name: "+ New Job" })).toBeVisible();
  });
});

test.describe("Scheduler - Heartbeat", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SCHEDULER_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Scheduler");
  });

  test("heartbeat tab shows status and metrics", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Click the Heartbeat tab via the role="tab" button to avoid ambiguity
    await scheduler.getByRole("tab", { name: "Heartbeat" }).click();

    // Verify heartbeat enabled checkbox is checked (config.read returns enabled: true)
    await expect(scheduler.locator("#hb-toggle")).toBeChecked();

    // Verify interval is displayed -- formatIntervalMs(300000) = "Every 5m"
    await expect(scheduler.getByText("Every 5m")).toBeVisible();

    // Initially no heartbeat events have occurred, so "Awaiting first heartbeat check" shows
    await expect(scheduler.getByText("Awaiting first heartbeat check")).toBeVisible();

    // Dispatch a heartbeat SSE event to populate heartbeat data
    await page.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent("scheduler:heartbeat_check", {
          detail: {
            checksRun: 150,
            alertsRaised: 3,
            timestamp: Date.now(),
          },
        }),
      );
    });

    // After the event, heartbeat summary should show checks and alerts
    // Scope to the heartbeat-summary panel to avoid matching other "150" occurrences
    const summary = scheduler.locator(".heartbeat-summary");
    await expect(summary.getByText("150")).toBeVisible({ timeout: 5_000 });
    await expect(summary.locator(".alerts-highlight").getByText("3")).toBeVisible();
  });
});

test.describe("Scheduler - Extracted Tasks", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, SCHEDULER_RPC_HANDLERS);
    await page.goto("/");
    await login(page);
    await navigateTo(page, "Scheduler");
  });

  test("extracted tasks tab shows pending and completed tasks", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Click the Extracted Tasks tab via role="tab"
    await scheduler.getByRole("tab", { name: "Extracted Tasks" }).click();

    // Initially empty
    await expect(scheduler.getByText("No extracted tasks")).toBeVisible();

    // Dispatch task extracted events to populate the list
    await page.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent("scheduler:task_extracted", {
          detail: {
            taskId: "task-1",
            title: "Review error logs",
            priority: "high",
            confidence: 0.85,
            sessionKey: "agent-default:telegram:12345",
            timestamp: Date.now() - 3600000,
          },
        }),
      );
      document.dispatchEvent(
        new CustomEvent("scheduler:task_extracted", {
          detail: {
            taskId: "task-2",
            title: "Update documentation",
            priority: "medium",
            confidence: 0.7,
            sessionKey: "agent-coding:discord:67890",
            timestamp: Date.now() - 7200000,
          },
        }),
      );
    });

    // Verify tasks are displayed
    await expect(scheduler.getByText("Review error logs")).toBeVisible({ timeout: 5_000 });
    await expect(scheduler.getByText("Update documentation")).toBeVisible();

    // Verify priority indicators
    await expect(scheduler.locator(".priority-tag--high")).toBeVisible();
    await expect(scheduler.locator(".priority-tag--medium")).toBeVisible();

    // Verify status indicators (both should be "pending" initially)
    const pendingCells = scheduler.locator(".grid-row").filter({ hasText: "pending" });
    await expect(pendingCells.first()).toBeVisible();
  });

  test("pending task has action buttons", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Click the Extracted Tasks tab via role="tab"
    await scheduler.getByRole("tab", { name: "Extracted Tasks" }).click();

    // Dispatch a pending task event
    await page.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent("scheduler:task_extracted", {
          detail: {
            taskId: "task-1",
            title: "Review error logs",
            priority: "high",
            confidence: 0.85,
            sessionKey: "agent-default:telegram:12345",
            timestamp: Date.now(),
          },
        }),
      );
    });

    // Wait for task to render
    await expect(scheduler.getByText("Review error logs")).toBeVisible({ timeout: 5_000 });

    // Verify action buttons for pending task
    const taskRow = scheduler.locator(".grid-row").filter({ hasText: "Review error logs" });
    await expect(taskRow.getByRole("button", { name: "Complete" })).toBeVisible();
    await expect(taskRow.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });
});
