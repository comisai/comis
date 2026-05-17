// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api.js";
import { mockRpcRoutes, DEFAULT_RPC_HANDLERS } from "./helpers/mock-rpc.js";
import { login } from "./helpers/login.js";

/**
 * Full agent config returned by agents.get RPC in edit mode.
 * Matches the daemon's { agentId, config: PerAgentConfig } response shape.
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
    sdkRetry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
    rag: {
      enabled: true,
      maxResults: 5,
      minScore: 0.5,
      includeTrustLevels: ["system", "learned"],
    },
    session: {
      resetPolicy: {
        mode: "daily",
        dailyResetHour: 0,
        dailyResetTimezone: "UTC",
        idleTimeoutMs: 3600000,
      },
    },
    concurrency: {
      maxConcurrentRuns: 3,
      maxQueuedPerSession: 10,
    },
    skills: {
      discoveryPaths: [],
      toolPolicy: { profile: "minimal", allow: ["web-search"], deny: [] },
      builtinTools: { bash: true, file_ops: true },
    },
    broadcastGroups: [],
  },
  suspended: false,
  isDefault: true,
};

/** RPC handlers for agent editor tests. */
const EDITOR_RPC_HANDLERS: Record<string, unknown> = {
  ...DEFAULT_RPC_HANDLERS,
  "agents.get": MOCK_AGENT_DETAIL,
  "agents.update": { success: true },
  "agents.create": { agentId: "new-agent", created: true },
  "config.read": {
    sections: {
      agents: {
        "agent-default": {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      providers: {
        anthropic: { type: "anthropic" },
        openai: { type: "openai" },
      },
    },
  },
};

test.describe("Agent editor view", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, EDITOR_RPC_HANDLERS);
    await page.goto("/");
    await login(page);

    // Navigate to agent editor for the default agent
    await page.evaluate(() => {
      window.location.hash = "#/agents/agent-default/edit";
    });

    // Wait for the agent editor to load
    await page.locator("ic-agent-editor").waitFor({ timeout: 10_000 });
  });

  test("editor shows expected accordion sections", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // The editor was refactored from a 9-tab layout into a single
    // long-form page with an Essential section on top and the rest
    // grouped into <details> accordions. Verify each accordion summary
    // is rendered.
    const sectionLabels = [
      "Budget",
      "Session Policy",
      "Skills",
      "Heartbeat",
      "Advanced",
      "Context Engine",
      "Streaming (System-Wide)",
      "Delivery (System-Wide)",
      "Queue / Overflow (System-Wide)",
      "Auto-Reply (System-Wide)",
      "Send Policy (System-Wide)",
      "Log Levels (Runtime)",
    ];

    for (const label of sectionLabels) {
      await expect(
        editor.locator(".section-label").getByText(label, { exact: true }),
      ).toBeVisible();
    }
  });

  test("Essential section shows agent identity fields", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Verify title shows edit mode with agent ID
    await expect(editor.getByText("Edit Agent: agent-default")).toBeVisible();

    // Agent ID field should be readonly in edit mode (renders as a plain
    // input rather than a text-field control).
    const idInput = editor.locator("#field-id");
    await expect(idInput).toBeVisible();
    await expect(idInput).toHaveAttribute("readonly", "");

    // Name field should show "DefaultAgent" from mock
    const nameInput = editor.locator("#field-name");
    await expect(nameInput).toHaveValue("DefaultAgent");

    // Provider dropdown should show "anthropic"
    const providerSelect = editor.locator("#field-provider");
    await expect(providerSelect).toHaveValue("anthropic");

    // Model field should show the mock model
    const modelInput = editor.locator("#field-model");
    await expect(modelInput).toHaveValue("claude-sonnet-4-20250514");
  });

  test("Budget section shows token budget fields", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Expand the Budget accordion section by setting the details element
    // open. Clicking the summary span doesn't always synthesise the
    // native toggle in Playwright, so flip the open property explicitly.
    const budgetSection = editor.locator(".section-card", { hasText: "Budget" }).first();
    await budgetSection.evaluate((card) => {
      const details = card.querySelector("details");
      if (details && !details.open) details.open = true;
    });

    // Verify budget fields appear with values from mock.
    const perExecutionInput = editor.locator("#field-budgets-perExecution");
    await expect(perExecutionInput).toBeVisible();
    await expect(perExecutionInput).toHaveValue("10000");

    const perHourInput = editor.locator("#field-budgets-perHour");
    await expect(perHourInput).toHaveValue("50000");

    const perDayInput = editor.locator("#field-budgets-perDay");
    await expect(perDayInput).toHaveValue("500000");
  });

  test("changes to the Essential section persist when accordions are expanded", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Change the agent name in the Essential section
    const nameInput = editor.locator("#field-name");
    await nameInput.fill("UpdatedAgent");
    await expect(nameInput).toHaveValue("UpdatedAgent");

    // Expand the Budget accordion (does not unmount Essential).
    const budgetSection = editor.locator(".section-card", { hasText: "Budget" }).first();
    await budgetSection.evaluate((card) => {
      const details = card.querySelector("details");
      if (details && !details.open) details.open = true;
    });
    await expect(editor.locator("#field-budgets-perDay")).toBeVisible();

    // Name field still carries the change (no unmount happens when
    // expanding accordions; this guards against future regressions to a
    // tab-based layout that would unmount inactive panels).
    await expect(nameInput).toHaveValue("UpdatedAgent");
  });

  test("Skills section is reachable and renders the skills editor", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    await editor.locator(".section-label").getByText("Skills", { exact: true }).click();

    // The Skills sub-editor sub-component mounts on expand.
    await expect(editor.locator("ic-agent-skills-editor")).toBeVisible();
  });

  test("Session Policy section shows reset mode and timeout fields", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    await editor.locator(".section-label").getByText("Session Policy", { exact: true }).click();

    // Reset mode select should show "daily" (mapped from
    // session.resetPolicy.mode = "daily").
    const resetMode = editor.locator("#field-sess-resetMode");
    await expect(resetMode).toBeVisible();
    await expect(resetMode).toHaveValue("daily");

    // Timezone select reflects the mock value.
    const timezone = editor.locator("#field-sess-timezone");
    await expect(timezone).toHaveValue("UTC");
  });

  test("Advanced section opens to expose the advanced editor", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    await editor.locator(".section-label").getByText("Advanced", { exact: true }).click();

    // Advanced sub-editor is rendered.
    await expect(editor.locator("ic-agent-advanced-editor")).toBeVisible();
  });

});

test.describe("Agent editor create mode", () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await mockRpcRoutes(page, EDITOR_RPC_HANDLERS);
    await page.goto("/");
    await login(page);

    // Navigate directly to create mode
    await page.evaluate(() => {
      window.location.hash = "#/agents/new/edit";
    });

    // Wait for the agent editor in create mode
    const editor = page.locator("ic-agent-editor");
    await expect(
      editor.getByRole("heading", { name: "Create Agent" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("create mode shows empty form with Create Agent title", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Agent ID field should be editable in create mode (not readonly)
    const idInput = editor.locator("#field-id");
    await expect(idInput).toBeVisible();
    await expect(idInput).not.toHaveAttribute("readonly", "");

    // Name field should be empty
    const nameInput = editor.locator("#field-name");
    await expect(nameInput).toHaveValue("");

    // Model field should be empty
    const modelInput = editor.locator("#field-model");
    await expect(modelInput).toHaveValue("");
  });
});
