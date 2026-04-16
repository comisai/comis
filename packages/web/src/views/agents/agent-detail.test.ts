import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcAgentDetail } from "./agent-detail.js";
import { formatTokens } from "./agent-detail.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { AgentDetail, AgentBilling, HeartbeatAgentStateDto } from "../../api/types/index.js";

// Side-effect import to register custom element
import "./agent-detail.js";
import { createMockRpcClient as _createSharedMock } from "../../test-support/mock-rpc-client.js";

/**
 * Raw daemon format returned by agents.get RPC.
 * The component's _mapToAgentDetail() maps this to AgentDetail.
 */
const mockRawAgent = {
  agentId: "default",
  config: {
    name: "Comis",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    maxSteps: 25,
    temperature: 0.7,
    thinkingLevel: "medium",
    budgets: { perExecution: 100000, perHour: 500000, perDay: 2000000 },
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60000 },
    contextGuard: { enabled: true, warnPercent: 80, blockPercent: 95 },
    sdkRetry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    modelFailover: { fallbackModels: [{}, {}] },
    session: {
      resetPolicy: { mode: "daily", dailyResetHour: 4, dailyResetTimezone: "America/New_York", idleTimeoutMs: 300000 },
    },
    concurrency: { maxConcurrentRuns: 3, maxQueuedPerSession: 5 },
    routingBindings: [
      { pattern: "telegram/*", agentId: "default" },
      { pattern: "discord/main-guild", agentId: "default" },
    ],
  },
};

const mockBilling: AgentBilling = {
  messagesToday: 423,
  tokensToday: 612000,
  activeSessions: 12,
  costToday: 4.82,
  budgetUsed: {
    perHour: { used: 123456 },
    perDay: { used: 612000 },
  },
};

const mockSkills = {
  skills: [
    { name: "bash", description: "Execute shell commands", location: "built-in", source: "bundled" },
    { name: "file_ops", description: "File operations", location: "built-in", source: "bundled" },
    { name: "my-skill", description: "A custom prompt skill", location: "/skills/my-skill", source: "local" },
  ],
};

const mockHeartbeat: { agents: HeartbeatAgentStateDto[] } = {
  agents: [
    {
      agentId: "default",
      enabled: true,
      intervalMs: 900000,
      lastRunMs: Date.now() - 60000,
      nextDueMs: Date.now() + 840000,
      consecutiveErrors: 0,
      backoffUntilMs: 0,
      tickStartedAtMs: 0,
      lastAlertMs: 0,
      lastErrorKind: null,
    },
  ],
};

/** Agent-detail-specific mock that routes RPC methods to test data. */
function createMockRpcClient(
  callImpl?: (...args: unknown[]) => unknown,
  overrides?: Partial<RpcClient>,
): RpcClient {
  return _createSharedMock(
    callImpl ??
      (async (method: string) => {
        if (method === "agents.get") return mockRawAgent;
        if (method === "obs.billing.byAgent") return mockBilling;
        if (method === "skills.list") return mockSkills;
        if (method === "heartbeat.states") return mockHeartbeat;
        return {};
      }),
    overrides,
  );
}

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Type-safe access to private fields. */
function priv(el: IcAgentDetail) {
  return el as unknown as {
    _agent: AgentDetail | null;
    _billing: AgentBilling | null;
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _actionPending: boolean;
    _loadData(): Promise<void>;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcAgentDetail", () => {
  it("renders loading state initially", async () => {
    const el = await createElement<IcAgentDetail>("ic-agent-detail");

    const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("renders two-column layout with left and right sections", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const layout = el.shadowRoot?.querySelector(".detail-layout");
    expect(layout).toBeTruthy();

    const leftCol = el.shadowRoot?.querySelector(".left-column");
    const rightCol = el.shadowRoot?.querySelector(".right-column");
    expect(leftCol).toBeTruthy();
    expect(rightCol).toBeTruthy();
  });

  it("renders breadcrumb with agent name and status badge", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const breadcrumb = el.shadowRoot?.querySelector("ic-breadcrumb");
    expect(breadcrumb).toBeTruthy();

    const items = (breadcrumb as any).items;
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe("Agents");
    expect(items[0].route).toBe("agents");
    expect(items[1].label).toBe("Comis");

    // Status badge
    const titleSection = el.shadowRoot?.querySelector(".agent-title");
    expect(titleSection).toBeTruthy();
    const tag = titleSection!.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe("active");
  });

  it("identity card shows agent config fields", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const cards = el.shadowRoot?.querySelectorAll(".card");
    const identityCard = cards?.[0];
    expect(identityCard).toBeTruthy();

    const title = identityCard!.querySelector(".card-title");
    expect(title?.textContent).toBe("Identity");

    const textContent = identityCard!.textContent!;
    expect(textContent).toContain("default"); // agent ID
    expect(textContent).toContain("Comis"); // name
    expect(textContent).toContain("anthropic"); // provider
    expect(textContent).toContain("claude-sonnet-4-5"); // model
    expect(textContent).toContain("0.7"); // temperature
    expect(textContent).toContain("25"); // maxSteps
    expect(textContent).toContain("medium"); // thinkingLevel
  });

  it("stats card shows billing data with formatted currency", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect(statCards).toBeTruthy();
    expect(statCards!.length).toBe(4);

    const labels = Array.from(statCards!).map((c) => (c as any).label);
    expect(labels).toContain("Messages Today");
    expect(labels).toContain("Tokens Today");
    expect(labels).toContain("Active Sessions");
    expect(labels).toContain("Cost Today");

    const values = Array.from(statCards!).map((c) => (c as any).value);
    expect(values).toContain("423");
    expect(values).toContain("612K");
    expect(values).toContain("12");
    // Cost formatted with Intl.NumberFormat currency
    expect(values).toContain("$4.82");
  });

  it("budget gauges render when budget data available", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const gauges = el.shadowRoot?.querySelectorAll("ic-metric-gauge");
    expect(gauges).toBeTruthy();
    // 3 budget gauges: perExecution, perHour, perDay
    expect(gauges!.length).toBe(3);

    const labels = Array.from(gauges!).map((g) => (g as any).label);
    expect(labels).toContain("Per Exec");
    expect(labels).toContain("Per Hour");
    expect(labels).toContain("Per Day");

    // Per Hour gauge: used=123456, total=500000 -> 25%
    const perHourGauge = Array.from(gauges!).find((g) => (g as any).label === "Per Hour");
    expect((perHourGauge as any).value).toBe(25);

    // Per Day gauge: used=612000, total=2000000 -> 31%
    const perDayGauge = Array.from(gauges!).find((g) => (g as any).label === "Per Day");
    expect((perDayGauge as any).value).toBe(31);
  });

  it("circuit breaker displays state and failure count", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const cbCard = Array.from(el.shadowRoot?.querySelectorAll(".card") ?? []).find(
      (c) => c.querySelector(".card-title")?.textContent === "Circuit Breaker",
    );
    expect(cbCard).toBeTruthy();

    const cbText = cbCard!.textContent!;
    expect(cbText).toContain("closed");
    expect(cbText).toContain("0"); // failures
    expect(cbText).toContain("5"); // threshold

    const tag = cbCard!.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag!.getAttribute("variant")).toBe("success");
  });

  it("skills list renders discovered skills as tag chips", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const skillsCard = Array.from(el.shadowRoot?.querySelectorAll(".card") ?? []).find(
      (c) => c.querySelector(".card-title")?.textContent?.startsWith("Skills"),
    );
    expect(skillsCard).toBeTruthy();

    const skillChips = skillsCard!.querySelectorAll("ic-tag");
    expect(skillChips.length).toBe(3);

    const chipTexts = Array.from(skillChips).map((c) => c.textContent);
    expect(chipTexts.some((t) => t?.includes("bash"))).toBe(true);
    expect(chipTexts.some((t) => t?.includes("file_ops"))).toBe(true);
    expect(chipTexts.some((t) => t?.includes("my-skill"))).toBe(true);
  });

  it("heartbeat card shows schedule info", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const hbCard = Array.from(el.shadowRoot?.querySelectorAll(".card") ?? []).find(
      (c) => c.querySelector(".card-title")?.textContent === "Heartbeat",
    );
    expect(hbCard).toBeTruthy();

    const text = hbCard!.textContent!;
    expect(text).toContain("healthy");
    expect(text).toContain("Every 15m"); // 900000ms = 15 minutes
  });

  it("action buttons (edit, suspend, delete) are rendered", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const buttons = el.shadowRoot?.querySelectorAll(".header-actions .btn");
    expect(buttons).toBeTruthy();
    expect(buttons!.length).toBe(4);

    const buttonTexts = Array.from(buttons!).map((b) => b.textContent?.trim());
    expect(buttonTexts).toContain("Workspace");
    expect(buttonTexts).toContain("Edit");
    expect(buttonTexts).toContain("Suspend");
    expect(buttonTexts).toContain("Delete");
  });

  it("Edit button dispatches navigate event to edit route", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const editBtn = el.shadowRoot?.querySelector(".btn--primary");
    expect(editBtn).toBeTruthy();
    expect(editBtn!.textContent?.trim()).toBe("Edit");

    (editBtn as HTMLElement)?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("agents/default/edit");
  });

  it("Workspace button dispatches navigate event to workspace route", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const allSecondary = el.shadowRoot?.querySelectorAll(".btn--secondary");
    const workspaceBtn = Array.from(allSecondary ?? []).find(
      (b) => b.textContent?.trim() === "Workspace",
    );
    expect(workspaceBtn).toBeTruthy();

    (workspaceBtn as HTMLElement)?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("agents/default/workspace");
  });

  it("suspend button calls agents.suspend RPC", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    // Active agent should show "Suspend" button (find by text, not index)
    const allSecondary = el.shadowRoot?.querySelectorAll(".btn--secondary");
    const suspendBtn = Array.from(allSecondary ?? []).find(
      (b) => b.textContent?.trim() === "Suspend",
    );
    expect(suspendBtn).toBeTruthy();

    (suspendBtn as HTMLElement)?.click();

    // Wait for async call
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRpc.call).toHaveBeenCalledWith("agents.suspend", { agentId: "default" });
  });

  it("responsive collapse class exists for single column", async () => {
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    // The detail-layout element exists and has the grid layout
    const layout = el.shadowRoot?.querySelector(".detail-layout");
    expect(layout).toBeTruthy();

    // Verify the CSS contains responsive media query -- check stylesheets
    const styles = (el.constructor as typeof LitElement).styles;
    const cssText = Array.isArray(styles)
      ? styles.map((s) => (s as any).cssText || "").join("")
      : (styles as any)?.cssText || "";
    expect(cssText).toContain("max-width: 767px");
    expect(cssText).toContain("grid-template-columns: 1fr");
  });

  it("gracefully handles optional RPC call failures", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "agents.get") return Promise.resolve(mockRawAgent);
        // All other calls fail
        return Promise.reject(new Error("RPC failed"));
      }),
    });

    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    // Should still render the layout (agent data loaded successfully)
    expect(priv(el)._loadState).toBe("loaded");
    expect(priv(el)._agent).toBeTruthy();
    expect(priv(el)._billing).toBeNull();

    const layout = el.shadowRoot?.querySelector(".detail-layout");
    expect(layout).toBeTruthy();
  });

  it("shows error state when agents.get fails", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockRejectedValue(new Error("Agent not found")),
    });
    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "missing-agent",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent).toContain("Agent not found");

    const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
    expect(retryBtn).toBeTruthy();
  });

  it("formats token count correctly", () => {
    expect(formatTokens(612000)).toBe("612K");
    expect(formatTokens(1200000)).toBe("1.2M");
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(1500)).toBe("1.5K");
  });

  it("shows 'No budget set' empty state when no budgets configured", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "agents.get") {
          return Promise.resolve({
            agentId: "no-budget",
            config: {
              name: "NoBudgetAgent",
              provider: "anthropic",
              model: "claude-sonnet-4-5",
            },
          });
        }
        return Promise.resolve({});
      }),
    });

    const el = await createElement<IcAgentDetail>("ic-agent-detail", {
      rpcClient: mockRpc,
      agentId: "no-budget",
    });

    await priv(el)._loadData();
    await el.updateComplete;

    const budgetEmpty = el.shadowRoot?.querySelector(".budget-empty");
    expect(budgetEmpty).toBeTruthy();
    expect(budgetEmpty!.textContent).toContain("No budget set");
  });
});
