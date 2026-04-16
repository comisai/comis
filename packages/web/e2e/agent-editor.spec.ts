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

  test("editor shows all 9 tabs", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // The 9 tab labels as defined in EDITOR_TABS in agent-editor.ts
    const tabLabels = [
      "General",
      "Budgets & Safety",
      "Model Failover",
      "RAG",
      "Session Policy",
      "Concurrency",
      "Skills",
      "Broadcast",
      "Advanced",
    ];

    for (const label of tabLabels) {
      await expect(editor.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("General tab shows agent identity fields", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Verify title shows edit mode with agent ID
    await expect(editor.getByText("Edit Agent: agent-default")).toBeVisible();

    // Agent ID field should be readonly in edit mode
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

  test("Budgets & Safety tab shows token budgets and circuit breaker", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Click the Budgets & Safety tab
    await editor.getByText("Budgets & Safety", { exact: true }).click();

    // Verify budget fields appear with values from mock
    const perExecutionInput = editor.locator("#field-budgets-perExecution");
    await expect(perExecutionInput).toBeVisible();
    await expect(perExecutionInput).toHaveValue("10000");

    const perHourInput = editor.locator("#field-budgets-perHour");
    await expect(perHourInput).toHaveValue("50000");

    const perDayInput = editor.locator("#field-budgets-perDay");
    await expect(perDayInput).toHaveValue("500000");

    // Circuit breaker threshold
    const cbThreshold = editor.locator("#field-cb-threshold");
    await expect(cbThreshold).toHaveValue("5");
  });

  test("switching between tabs preserves form state", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // On General tab, change agent name
    const nameInput = editor.locator("#field-name");
    await nameInput.fill("UpdatedAgent");
    await expect(nameInput).toHaveValue("UpdatedAgent");

    // Switch to Budgets & Safety tab
    await editor.getByText("Budgets & Safety", { exact: true }).click();

    // Verify we are on budgets tab (budget fields visible)
    await expect(editor.locator("#field-budgets-perDay")).toBeVisible();

    // Switch back to General tab
    await editor.getByText("General", { exact: true }).click();

    // Verify name field still shows "UpdatedAgent"
    await expect(nameInput).toHaveValue("UpdatedAgent");
  });

  test("RAG tab shows enable toggle and settings", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Click RAG tab
    await editor.getByText("RAG", { exact: true }).click();

    // RAG enabled checkbox should be checked (mock has enabled: true)
    const ragEnabled = editor.locator("#field-rag-enabled");
    await expect(ragEnabled).toBeVisible();
    await expect(ragEnabled).toBeChecked();

    // Max results field should show "5" from mock
    const maxResults = editor.locator("#field-rag-maxResults");
    await expect(maxResults).toHaveValue("5");

    // Min score field should show "0.5"
    const minScore = editor.locator("#field-rag-minScore");
    await expect(minScore).toHaveValue("0.5");

    // Trust level checkboxes: system and learned should be checked
    await expect(editor.locator("#field-rag-trust-system")).toBeChecked();
    await expect(editor.locator("#field-rag-trust-learned")).toBeChecked();
    await expect(editor.locator("#field-rag-trust-external")).not.toBeChecked();
  });

  test("Session Policy tab shows reset mode and timeout fields", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Click Session Policy tab
    await editor.getByText("Session Policy", { exact: true }).click();

    // Reset mode select should show "daily"
    const resetMode = editor.locator("#field-sess-resetMode");
    await expect(resetMode).toBeVisible();
    await expect(resetMode).toHaveValue("daily");

    // Idle timeout field should have value from mock
    const idleTimeout = editor.locator("#field-sess-idleTimeout");
    await expect(idleTimeout).toHaveValue("3600000");

    // Timezone field
    const timezone = editor.locator("#field-sess-timezone");
    await expect(timezone).toHaveValue("UTC");
  });

  test("Concurrency tab shows concurrent runs and queue mode", async ({ page }) => {
    const editor = page.locator("ic-agent-editor");

    // Click Concurrency tab
    await editor.getByText("Concurrency", { exact: true }).click();

    // Max concurrent should show "3" from mock
    const maxConcurrent = editor.locator("#field-conc-maxConcurrent");
    await expect(maxConcurrent).toBeVisible();
    await expect(maxConcurrent).toHaveValue("3");

    // Max queued should show "10"
    const maxQueued = editor.locator("#field-conc-maxQueued");
    await expect(maxQueued).toHaveValue("10");

    // Queue mode should show "followup"
    const queueMode = editor.locator("#field-conc-queueMode");
    await expect(queueMode).toHaveValue("followup");
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
