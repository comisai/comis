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
    source: "authored",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: Date.now() + 3_600_000,
      consecutiveDependencyErrors: 0,
    },
    payload: {
      kind: "heartbeat_event",
      text: "Generate daily summary",
      wakeMode: "next-heartbeat",
    },
  },
  {
    id: "hourly-check",
    name: "Hourly Check",
    agentId: "agent-default",
    source: "authored",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: Date.now() },
    lifecycle: {
      status: "paused",
      nextRunAtMs: Date.now() + 3_600_000,
      consecutiveDependencyErrors: 2,
      reason: "dependency_errors",
    },
    payload: {
      kind: "heartbeat_event",
      text: "Run hourly check",
      wakeMode: "next-heartbeat",
    },
  },
  // A job WITH a pre-run wake-gate — exercises the editor's wake-gate field
  // populate-from-existing path in a real browser (the piece the RPC/component
  // tests cover but no full-SPA e2e did). cron.list must carry wakeGate for this
  // to surface (the daemon-side fix that makes the gate editable in the UI).
  {
    id: "gated-monitor",
    name: "Gated Monitor",
    agentId: "agent-default",
    source: "authored",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: Date.now() },
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: Date.now() + 3_600_000,
      consecutiveDependencyErrors: 0,
    },
    payload: { kind: "agent_turn", message: "check CI" },
    sessionPolicy: { strategy: "fresh" },
    continuationMode: "none",
    wakeGate: { script: 'console.log(JSON.stringify({ wake: false }));', language: "js", timeoutSeconds: 30 },
  },
];

/** RPC handlers for scheduler methods, merged with default handlers */
const SCHEDULER_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "cron.list": { jobs: MOCK_JOBS },
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

  test("shows active and dependency-error status for jobs", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // Daily Summary has a scheduled lifecycle with no dependency errors.
    const dailyRow = scheduler.locator(".grid-row").filter({ hasText: "Daily Summary" });
    await expect(dailyRow.locator(".status-dot--active")).toBeVisible();

    // Hourly Check is paused by its dependency breaker.
    const hourlyRow = scheduler.locator(".grid-row").filter({ hasText: "Hourly Check" });
    await expect(hourlyRow.locator(".status-dot--error")).toBeVisible();
  });

  test("shows error count for failing jobs", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // The strict lifecycle carries the exact dependency-error count.
    const hourlyRow = scheduler.locator(".grid-row").filter({ hasText: "Hourly Check" });
    await expect(hourlyRow.getByText("2 dependency errors")).toBeVisible();
  });

  test("has Add Job button", async ({ page }) => {
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });

    // The header has "+ New Job" button
    await expect(scheduler.getByRole("button", { name: "+ New Job" })).toBeVisible();
  });

  test("editor surfaces and populates the wake-gate script field for a gated job", async ({ page }) => {
    // The pre-run wake-gate must be VIEWABLE and EDITABLE in the dashboard, not
    // just addable — that needs cron.list to carry wakeGate (daemon-side) AND the
    // editor to bind it (component-side). Prove the full SPA path in a real
    // browser via the route-param auto-open (#/scheduler/<jobId> opens the editor
    // for that job). Complements the RPC/component tests with a live render.
    const scheduler = page.locator("ic-scheduler-view");
    await expect(scheduler).toBeVisible({ timeout: 10_000 });
    await expect(scheduler.getByText("Gated Monitor")).toBeVisible();

    // Navigate to the job's route → the view auto-opens the editor overlay for it.
    await page.goto("/app/#/scheduler/gated-monitor");

    // The wake-gate textarea surfaces and is populated from the job's wakeGate.script
    // (Playwright pierces the nested shadow roots).
    const field = page.locator("ic-cron-editor #cron-wake-gate");
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue(/wake["\s:]*false/);

    // The language selector reflects the stored language too.
    await expect(page.locator("ic-cron-editor #cron-wake-gate-lang")).toHaveValue("js");
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

    // The Heartbeat tab summary bar shows global enabled state and interval.
    // config.read returns heartbeat: { enabled: true, intervalMs: 300000 }, so:
    //   - "Global heartbeat: enabled"
    //   - "Interval: Every 5m" (formatIntervalMs(300000))
    const summary = scheduler.locator(".hb-summary-bar");
    await expect(summary).toBeVisible();
    await expect(summary.getByText("Global heartbeat: enabled")).toBeVisible();
    await expect(summary.getByText("Every 5m")).toBeVisible();

    // With no per-agent heartbeat data loaded (heartbeat.states RPC has no
    // mock here, so _heartbeatAgents stays empty), the tab falls back to an
    // empty state advising the user to configure per-agent heartbeat.
    await expect(scheduler.getByText("No heartbeat agents")).toBeVisible();
  });
});
