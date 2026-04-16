import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcObserveView } from "./observe-view.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./observe-view.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_DELIVERY_STATS = { successRate: 99.2, avgLatencyMs: 234, totalDelivered: 1247, failed: 3 };
const MOCK_BILLING_TOTAL = { totalTokens: 845000, totalCost: 6.23 };
const MOCK_USAGE_24H = Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 10000 + i * 1000 }));
const MOCK_BY_PROVIDER = [
  { provider: "Anthropic", totalTokens: 456000, totalCost: 4.82, callCount: 150, models: [] },
  { provider: "OpenAI", totalTokens: 89000, totalCost: 1.41, callCount: 45, models: [] },
];
const MOCK_BY_AGENT = [
  { agentId: "default", totalTokens: 612000, percentOfTotal: 72.4, cost: 4.51 },
  { agentId: "support", totalTokens: 145000, percentOfTotal: 17.2, cost: 1.07 },
];
const MOCK_DIAGNOSTICS = [
  { id: "d1", timestamp: Date.now() - 120_000, category: "usage", eventType: "retry:attempted", data: {} },
  { id: "d2", timestamp: Date.now() - 300_000, category: "message", eventType: "message:received", data: {} },
  { id: "d3", timestamp: Date.now() - 60_000, category: "message", eventType: "retry:exhausted", data: {} },
];

const MOCK_DELIVERY_TRACES = [
  {
    traceId: "trace-001",
    timestamp: Date.now() - 60_000,
    channelType: "telegram",
    messagePreview: "Hello, how can I help?",
    status: "success" as const,
    latencyMs: 187,
    stepCount: 3,
    steps: [
      { name: "receive", timestamp: Date.now() - 60_000, durationMs: 5, status: "ok" as const },
      { name: "execute", timestamp: Date.now() - 59_995, durationMs: 170, status: "ok" as const },
      { name: "respond", timestamp: Date.now() - 59_825, durationMs: 12, status: "ok" as const },
    ],
  },
  {
    traceId: "trace-002",
    timestamp: Date.now() - 120_000,
    channelType: "discord",
    messagePreview: "Error processing request",
    status: "failed" as const,
    latencyMs: null,
    stepCount: 1,
    steps: [
      { name: "receive", timestamp: Date.now() - 120_000, durationMs: 5, status: "ok" as const },
      { name: "execute", timestamp: Date.now() - 119_995, durationMs: 0, status: "error" as const, error: "Budget exceeded" },
    ],
  },
  {
    traceId: "trace-003",
    timestamp: Date.now() - 300_000,
    channelType: "telegram",
    messagePreview: "Another message here",
    status: "success" as const,
    latencyMs: 342,
    stepCount: 5,
  },
];

const MOCK_CHANNEL_ACTIVITY = [
  {
    channelType: "telegram",
    channelId: "tg-main",
    messagesSent: 523,
    messagesReceived: 489,
    lastActiveAt: Date.now() - 30_000,
    isStale: false,
  },
  {
    channelType: "discord",
    channelId: "dc-server-1",
    messagesSent: 12,
    messagesReceived: 8,
    lastActiveAt: Date.now() - 7200_000,
    isStale: true,
  },
  {
    channelType: "slack",
    channelId: "slack-workspace",
    messagesSent: 201,
    messagesReceived: 187,
    lastActiveAt: Date.now() - 60_000,
    isStale: false,
  },
];

const MOCK_AGENT_LIST = { agents: ["default", "support"] };
const MOCK_AGENT_DEFAULT = {
  agentId: "default",
  config: { model: "claude-sonnet-4-20250514" },
  suspended: false,
  isDefault: true,
};
const MOCK_AGENT_SUPPORT = {
  agentId: "support",
  config: { model: "gpt-4o" },
  suspended: true,
  isDefault: false,
};
const MOCK_CHANNEL_LIST = {
  channels: [
    { channelType: "telegram", channelId: "tg-main", status: "running" },
    { channelType: "discord", channelId: "dc-server-1", status: "stopped" },
  ],
  total: 2,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function createObserveMockRpcClient(): RpcClient & { _callFn: ReturnType<typeof vi.fn> } {
  const callFn = vi.fn().mockImplementation((method: string) => {
    switch (method) {
      case "obs.delivery.stats":
        return Promise.resolve(MOCK_DELIVERY_STATS);
      case "obs.billing.total":
        return Promise.resolve(MOCK_BILLING_TOTAL);
      case "obs.billing.usage24h":
        return Promise.resolve(MOCK_USAGE_24H);
      case "obs.billing.byProvider":
        return Promise.resolve(MOCK_BY_PROVIDER);
      case "obs.billing.byAgent":
        return Promise.resolve(MOCK_BY_AGENT);
      case "obs.diagnostics":
        return Promise.resolve(MOCK_DIAGNOSTICS);
      case "obs.delivery.recent":
        return Promise.resolve(MOCK_DELIVERY_TRACES);
      case "obs.channels.all":
        return Promise.resolve(MOCK_CHANNEL_ACTIVITY);
      case "agents.list":
        return Promise.resolve(MOCK_AGENT_LIST);
      case "agents.get":
        return Promise.resolve(MOCK_AGENT_DEFAULT);
      case "channels.list":
        return Promise.resolve(MOCK_CHANNEL_LIST);
      case "obs.reset":
        return Promise.resolve({ reset: true });
      default:
        return Promise.resolve({});
    }
  });
  const rpc = createMockRpcClient(callFn);
  return Object.assign(rpc, { _callFn: callFn });
}

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcObserveView> {
  const el = document.createElement("ic-observe-view") as IcObserveView;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Flush pending microtasks (for RPC promises). */
async function flush(el: IcObserveView): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (el as any).updateComplete;
}

/** Access private fields. */
function priv(el: IcObserveView) {
  return el as unknown as {
    _loadState: string;
    _activeTab: string;
    _error: string;
    _requestsToday: number;
    _tokensToday: number;
    _costToday: number;
    _errorsToday: number;
    _tokenUsage24h: Array<{ hour: number; tokens: number }>;
    _billingByProvider: Array<{ provider: string; cost: number }>;
    _billingByAgent: Array<{ agentId: string; percentOfTotal: number }>;
    _diagnosticsEvents: Array<{ id: string; category: string; eventType: string; data: Record<string, unknown> }>;
    _deliveryTraces: typeof MOCK_DELIVERY_TRACES;
    _channelActivity: typeof MOCK_CHANNEL_ACTIVITY;
    _deliveryChannelFilter: string;
    _deliveryStatusFilter: string;
    _deliveryTimeRange: string;
    _expandedTraceId: string | null;
    _refreshInterval: ReturnType<typeof setInterval> | null;
    _agentHealth: Array<{ agentId: string; config: Record<string, unknown>; suspended: boolean; isDefault: boolean }>;
    _channelHealth: Array<{ channelType: string; channelId?: string; status: string }>;
    _resetConfirming: boolean;
    _resetInput: string;
    rpcClient: RpcClient | null;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcObserveView", () => {
  it("1 - renders tabs with placeholders when rpcClient is null", async () => {
    const el = await createElement({ rpcClient: null });
    await flush(el);
    // When rpcClient is null, view loads with default empty data and shows tabs
    const tabs = el.shadowRoot?.querySelector("ic-tabs");
    expect(tabs).toBeTruthy();
    // Stat cards should show "---" placeholder values
    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    if (statCards && statCards.length > 0) {
      const values = Array.from(statCards).map((card) => (card as any).value);
      for (const v of values) {
        expect(v).toBe("---");
      }
    }
  });

  it("2 - renders error state when all RPC calls fail", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation(() => Promise.reject(new Error("Connection lost")));
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    expect(priv(el)._loadState).toBe("error");
    const errMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errMsg?.textContent).toContain("Connection lost");
  });

  it("3 - renders 5 tabs after successful load", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const tabs = el.shadowRoot?.querySelector("ic-tabs");
    expect(tabs).toBeTruthy();
    const tabDefs = (tabs as any).tabs;
    expect(tabDefs).toHaveLength(5);
    expect(tabDefs.map((t: { id: string }) => t.id)).toEqual([
      "overview", "billing", "delivery", "channels", "diagnostics",
    ]);
  });

  it("4 - overview tab shows 6 stat cards", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect(statCards?.length).toBe(6);
  });

  it("5 - overview stat cards show correct values", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    const labels = Array.from(statCards ?? []).map((card) => (card as any).label);
    const values = Array.from(statCards ?? []).map((card) => (card as any).value);
    // 6 cards: Requests/min, Error Rate, Avg Latency, Active Agents, Tokens (24h), Cost Today
    expect(labels).toContain("Requests/min");
    expect(labels).toContain("Error Rate");
    expect(labels).toContain("Avg Latency");
    expect(labels).toContain("Active Agents");
    expect(labels).toContain("Tokens (24h)");
    expect(labels).toContain("Cost Today");
    expect(values).toContain("1,247"); // requests/min (total requests)
    expect(values).toContain("845K");  // tokens
    expect(values).toContain("$6.23"); // cost
    expect(values).toContain("234ms"); // avg latency
  });

  it("6 - overview tab shows token usage bar chart", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const barChart = el.shadowRoot?.querySelector(".bar-chart");
    expect(barChart).toBeTruthy();
    const bars = barChart?.querySelectorAll(".bar");
    expect(bars?.length).toBe(24);
  });

  it("7 - billing tab shows provider breakdown table", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    const providerTable = el.shadowRoot?.querySelector(".provider-table");
    expect(providerTable).toBeTruthy();
    const text = providerTable?.textContent ?? "";
    expect(text).toContain("Anthropic");
    expect(text).toContain("OpenAI");
  });

  it("8 - billing tab shows provider totals", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    const totalRow = el.shadowRoot?.querySelector(".total-row");
    expect(totalRow).toBeTruthy();
    const text = totalRow?.textContent ?? "";
    expect(text).toContain("Total");
    // 456000 + 89000 = 545,000
    expect(text).toContain("545,000");
  });

  it("9 - billing tab shows agent breakdown when data injected", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    // obs.billing.byAgent requires per-agent agentId param, so _loadData skips it.
    // Inject agent billing data directly to verify rendering.
    (el as any)._billingByAgent = MOCK_BY_AGENT;
    await (el as any).updateComplete;

    const agentTable = el.shadowRoot?.querySelector(".agent-table");
    expect(agentTable).toBeTruthy();
    const text = agentTable?.textContent ?? "";
    expect(text).toContain("default");
    expect(text).toContain("support");
  });

  it("10 - billing tab shows percentage column when data injected", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    // Inject agent billing data directly
    (el as any)._billingByAgent = MOCK_BY_AGENT;
    await (el as any).updateComplete;

    const agentTable = el.shadowRoot?.querySelector(".agent-table");
    const text = agentTable?.textContent ?? "";
    expect(text).toContain("72.4%");
    expect(text).toContain("17.2%");
  });

  it("11 - diagnostics tab shows event table", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "diagnostics" });
    await flush(el);

    const diagTable = el.shadowRoot?.querySelector(".diagnostics-table");
    expect(diagTable).toBeTruthy();
    const text = diagTable?.textContent ?? "";
    expect(text).toContain("Retry attempted");
    expect(text).toContain("Message received");
  });

  it("12 - diagnostics tab shows severity tags", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "diagnostics" });
    await flush(el);

    const tags = el.shadowRoot?.querySelectorAll(".diagnostics-table ic-tag");
    // Each event has a category tag + level tag = 6 total (3 events * 2)
    expect(tags?.length).toBeGreaterThanOrEqual(6);
    // Check that the derived level tags include warn, info, error
    const tagTexts = Array.from(tags ?? []).map((t) => t.textContent?.trim());
    expect(tagTexts).toContain("warn");   // retry:attempted
    expect(tagTexts).toContain("info");   // message:received
    expect(tagTexts).toContain("error");  // retry:exhausted
  });

  it("13 - delivery tab renders delivery trace rows", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const rows = el.shadowRoot?.querySelectorAll("ic-delivery-row");
    expect(rows?.length).toBe(3);
  });

  it("14 - channels tab renders channel rows", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    expect(channelTable).toBeTruthy();
    // 3 channels = 3 data rows
    const rows = channelTable?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
  });

  it("15 - tab switching updates active content", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Initially on overview - stat cards present (6 stat cards)
    expect(el.shadowRoot?.querySelectorAll("ic-stat-card")?.length).toBe(6);

    // Switch to billing
    priv(el)._activeTab = "billing";
    await (el as any).updateComplete;
    const providerTable = el.shadowRoot?.querySelector(".provider-table");
    expect(providerTable).toBeTruthy();

    // Switch to diagnostics
    priv(el)._activeTab = "diagnostics";
    await (el as any).updateComplete;
    const diagTable = el.shadowRoot?.querySelector(".diagnostics-table");
    expect(diagTable).toBeTruthy();
  });

  it("16 - initialTab property sets starting tab", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    expect(priv(el)._activeTab).toBe("billing");
    const providerTable = el.shadowRoot?.querySelector(".provider-table");
    expect(providerTable).toBeTruthy();
  });

  it("17 - retry button reloads data", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation(() => Promise.reject(new Error("Connection lost")));
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    expect(priv(el)._loadState).toBe("error");
    const callCountBefore = rpc._callFn.mock.calls.length;

    // Now make RPC succeed
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.billing.byAgent") return Promise.resolve(MOCK_BY_AGENT);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve([]);
      if (method === "obs.channels.all") return Promise.resolve([]);
      if (method === "agents.list") return Promise.resolve({ agents: [] });
      if (method === "channels.list") return Promise.resolve({ channels: [], total: 0 });
      return Promise.resolve({});
    });

    // Click retry button
    const retryBtn = el.shadowRoot?.querySelector(".retry-btn") as HTMLElement;
    expect(retryBtn).toBeTruthy();
    retryBtn.click();
    await flush(el);

    expect(rpc._callFn.mock.calls.length).toBeGreaterThan(callCountBefore);
    expect(priv(el)._loadState).toBe("loaded");
  });

  it("18 - graceful degradation when rpcClient is null shows tabs with defaults", async () => {
    const el = await createElement({ rpcClient: null });
    await flush(el);

    // Should show the tabbed view with empty/default data
    const tabs = el.shadowRoot?.querySelector("ic-tabs");
    expect(tabs).toBeTruthy();
    expect(priv(el)._loadState).toBe("loaded");
    // All data should be at defaults
    expect(priv(el)._requestsToday).toBe(0);
    expect(priv(el)._tokensToday).toBe(0);
    expect(priv(el)._costToday).toBe(0);
  });

  it("19 - overview shows --- values when rpcClient disconnected", async () => {
    const rpc = createObserveMockRpcClient();
    Object.defineProperty(rpc, "status", { value: "disconnected" });
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    if (statCards && statCards.length > 0) {
      const values = Array.from(statCards).map((card) => (card as any).value);
      // When disconnected, should show "---"
      for (const v of values) {
        expect(v).toBe("---");
      }
    }
  });

  it("20 - billing tab shows empty state when no billing data", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "obs.billing.byProvider") return Promise.resolve([]);
      if (method === "obs.billing.byAgent") return Promise.resolve([]);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.diagnostics") return Promise.resolve([]);
      if (method === "obs.delivery.recent") return Promise.resolve([]);
      if (method === "obs.channels.all") return Promise.resolve([]);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc, initialTab: "billing" });
    await flush(el);

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect((emptyState as any).message).toBe("No billing data available");
  });

  it("21 - diagnostics tab shows empty state when no events", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "obs.diagnostics") return Promise.resolve([]);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve([]);
      if (method === "obs.billing.byAgent") return Promise.resolve([]);
      if (method === "obs.delivery.recent") return Promise.resolve([]);
      if (method === "obs.channels.all") return Promise.resolve([]);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc, initialTab: "diagnostics" });
    await flush(el);

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect((emptyState as any).message).toBe("No diagnostic events");
  });

  it("22 - diagnostics events sorted most recent first", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "diagnostics" });
    await flush(el);

    // The retry:exhausted event (timestamp - 60_000) should be first since it's most recent
    const diagTable = el.shadowRoot?.querySelector(".diagnostics-table");
    const rows = diagTable?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
    // First row should be the most recent (retry:exhausted at -60s)
    const firstRowText = rows?.[0]?.textContent ?? "";
    expect(firstRowText).toContain("Retries exhausted");
  });

  it("23 - disconnectedCallback clears refresh interval", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    expect(priv(el)._refreshInterval).not.toBeNull();

    el.remove();

    expect(priv(el)._refreshInterval).toBeNull();
  });

  it("24 - tab-change event from ic-tabs updates active tab", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const tabs = el.shadowRoot?.querySelector("ic-tabs") as HTMLElement;
    expect(tabs).toBeTruthy();

    // Dispatch tab-change event
    tabs.dispatchEvent(new CustomEvent("tab-change", { detail: "billing" }));
    await (el as any).updateComplete;

    expect(priv(el)._activeTab).toBe("billing");
  });

  /* ---- Delivery Tracing tab tests ---- */

  it("25 - delivery tab shows stats summary", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const stats = el.shadowRoot?.querySelector(".stats-summary");
    expect(stats).toBeTruthy();
    const text = stats?.textContent ?? "";
    expect(text).toContain("99.2%");
    expect(text).toContain("234ms");
    expect(text).toContain("1,247");
  });

  it("26 - delivery tab shows channel filter dropdown", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const selects = el.shadowRoot?.querySelectorAll(".filter-select");
    expect(selects?.length).toBeGreaterThanOrEqual(3);
    const channelSelect = selects?.[0] as HTMLSelectElement;
    const options = channelSelect?.querySelectorAll("option");
    // "All Channels" + unique channel types (telegram, discord)
    expect(options?.length).toBeGreaterThanOrEqual(3);
    const optTexts = Array.from(options ?? []).map((o) => o.textContent?.trim());
    expect(optTexts).toContain("All Channels");
    expect(optTexts).toContain("telegram");
    expect(optTexts).toContain("discord");
  });

  it("27 - delivery tab shows status filter dropdown", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const selects = el.shadowRoot?.querySelectorAll(".filter-select");
    const statusSelect = selects?.[1] as HTMLSelectElement;
    const options = statusSelect?.querySelectorAll("option");
    expect(options?.length).toBe(4);
    const optTexts = Array.from(options ?? []).map((o) => o.textContent?.trim());
    expect(optTexts).toContain("All Statuses");
    expect(optTexts).toContain("Success");
    expect(optTexts).toContain("Failed");
    expect(optTexts).toContain("Timeout");
  });

  it("28 - delivery tab filters by channel", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Initially 3 traces
    expect(el.shadowRoot?.querySelectorAll("ic-delivery-row")?.length).toBe(3);

    // Set channel filter to telegram
    priv(el)._deliveryChannelFilter = "telegram";
    await (el as any).updateComplete;

    // Only telegram traces (trace-001 and trace-003)
    const rows = el.shadowRoot?.querySelectorAll("ic-delivery-row");
    expect(rows?.length).toBe(2);
  });

  it("29 - delivery tab filters by status", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Set status filter to failed
    priv(el)._deliveryStatusFilter = "failed";
    await (el as any).updateComplete;

    const rows = el.shadowRoot?.querySelectorAll("ic-delivery-row");
    expect(rows?.length).toBe(1);
  });

  it("30 - delivery tab shows empty state when no traces match filter", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Filter to non-matching combo
    priv(el)._deliveryChannelFilter = "slack";
    await (el as any).updateComplete;

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect((emptyState as any).message).toContain("No delivery traces match");
  });

  it("31 - delivery tab expands trace detail on row click", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // No trace detail initially
    expect(el.shadowRoot?.querySelector(".trace-detail")).toBeFalsy();

    // Click first row by dispatching trace-click event
    const row = el.shadowRoot?.querySelector("ic-delivery-row") as HTMLElement;
    expect(row).toBeTruthy();
    row.dispatchEvent(
      new CustomEvent("trace-click", { detail: "trace-001", bubbles: true, composed: true }),
    );
    await (el as any).updateComplete;

    expect(priv(el)._expandedTraceId).toBe("trace-001");
    const detail = el.shadowRoot?.querySelector(".trace-detail");
    expect(detail).toBeTruthy();
  });

  it("32 - delivery tab shows step timeline in expanded detail", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Expand trace-001 (has 3 steps)
    priv(el)._expandedTraceId = "trace-001";
    await (el as any).updateComplete;

    const detail = el.shadowRoot?.querySelector(".trace-detail");
    expect(detail).toBeTruthy();
    const steps = detail?.querySelectorAll(".step-item");
    expect(steps?.length).toBe(3);
    const stepNames = Array.from(steps ?? []).map((s) => s.textContent?.trim());
    expect(stepNames?.some((n) => n?.includes("receive"))).toBe(true);
    expect(stepNames?.some((n) => n?.includes("execute"))).toBe(true);
    expect(stepNames?.some((n) => n?.includes("respond"))).toBe(true);
  });

  it("33 - delivery tab collapses detail on second click", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Expand
    priv(el)._expandedTraceId = "trace-001";
    await (el as any).updateComplete;
    expect(el.shadowRoot?.querySelector(".trace-detail")).toBeTruthy();

    // Dispatch same trace-click to toggle off
    const row = el.shadowRoot?.querySelector("ic-delivery-row") as HTMLElement;
    row.dispatchEvent(
      new CustomEvent("trace-click", { detail: "trace-001", bubbles: true, composed: true }),
    );
    await (el as any).updateComplete;

    expect(priv(el)._expandedTraceId).toBeNull();
    expect(el.shadowRoot?.querySelector(".trace-detail")).toBeFalsy();
  });

  it("34 - delivery tab shows error step in red", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Expand trace-002 (has error step)
    priv(el)._expandedTraceId = "trace-002";
    await (el as any).updateComplete;

    const detail = el.shadowRoot?.querySelector(".trace-detail");
    expect(detail).toBeTruthy();
    // Should have error dot
    const errorDot = detail?.querySelector(".step-dot.error");
    expect(errorDot).toBeTruthy();
    // Should show error message
    const errorMsg = detail?.querySelector(".step-error");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent).toContain("Budget exceeded");
  });

  it("35 - delivery tab sorts traces by timestamp descending", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const rows = el.shadowRoot?.querySelectorAll("ic-delivery-row");
    expect(rows?.length).toBe(3);
    // First row should be trace-001 (most recent at -60s)
    expect((rows?.[0] as any).trace.traceId).toBe("trace-001");
    // Second row: trace-002 (-120s)
    expect((rows?.[1] as any).trace.traceId).toBe("trace-002");
    // Third row: trace-003 (-300s)
    expect((rows?.[2] as any).trace.traceId).toBe("trace-003");
  });

  it("36 - delivery tab shows no-steps message for trace without steps", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Expand trace-003 (no steps field)
    priv(el)._expandedTraceId = "trace-003";
    await (el as any).updateComplete;

    const detail = el.shadowRoot?.querySelector(".trace-detail");
    expect(detail).toBeTruthy();
    expect(detail?.textContent).toContain("No step details available");
  });

  it("37 - delivery tab stats show green color for high success rate", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Success rate is 99.2% (>99%) so should have rate-green
    const rateEl = el.shadowRoot?.querySelector(".stats-summary .rate-green");
    expect(rateEl).toBeTruthy();
    expect(rateEl?.textContent).toContain("99.2%");
  });

  /* ---- Channel Activity tab tests ---- */

  it("38 - channels tab shows stale alert banner", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const alert = el.shadowRoot?.querySelector(".stale-alert");
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("1 stale channel(s)");
  });

  it("39 - channels tab sorts stale channels to top", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    const rows = channelTable?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
    // First row should be stale (discord)
    expect(rows?.[0]?.classList.contains("stale")).toBe(true);
    expect(rows?.[0]?.textContent).toContain("discord");
  });

  it("40 - channels tab shows stale badge", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    const rows = channelTable?.querySelectorAll(".grid-row");
    // First row (stale) should have Stale tag
    const staleTags = rows?.[0]?.querySelectorAll("ic-tag");
    const staleTexts = Array.from(staleTags ?? []).map((t) => t.textContent?.trim());
    expect(staleTexts).toContain("Stale");
  });

  it("41 - channels tab shows active badge", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    const rows = channelTable?.querySelectorAll(".grid-row");
    // Second row (telegram, not stale) should have Active tag
    const activeTags = rows?.[1]?.querySelectorAll("ic-tag");
    const activeTexts = Array.from(activeTags ?? []).map((t) => t.textContent?.trim());
    expect(activeTexts).toContain("Active");
  });

  it("42 - channels tab shows message counts", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    const text = channelTable?.textContent ?? "";
    // telegram: 523 sent, 489 received
    expect(text).toContain("523");
    expect(text).toContain("489");
  });

  it("43 - channels tab shows relative time for last active", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const channelTable = el.shadowRoot?.querySelector(".channel-table");
    const relativeTimeEls = channelTable?.querySelectorAll("ic-relative-time");
    expect(relativeTimeEls?.length).toBe(3);
  });

  it("44 - channels tab shows empty state when no data", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "obs.channels.all") return Promise.resolve([]);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.billing.byAgent") return Promise.resolve(MOCK_BY_AGENT);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve(MOCK_DELIVERY_TRACES);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect((emptyState as any).description).toContain("Channel activity will appear");
  });

  it("45 - channels tab has no stale alert when no stale channels", async () => {
    const rpc = createObserveMockRpcClient();
    const noStaleData = MOCK_CHANNEL_ACTIVITY.map((c) => ({ ...c, isStale: false }));
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "obs.channels.all") return Promise.resolve(noStaleData);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.billing.byAgent") return Promise.resolve(MOCK_BY_AGENT);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve(MOCK_DELIVERY_TRACES);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const alert = el.shadowRoot?.querySelector(".stale-alert");
    expect(alert).toBeFalsy();
  });

  it("46 - delivery tab filter change updates via select element", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    // Find channel filter select and change it
    const selects = el.shadowRoot?.querySelectorAll(".filter-select") as NodeListOf<HTMLSelectElement>;
    const channelSelect = selects[0];
    channelSelect.value = "telegram";
    channelSelect.dispatchEvent(new Event("change"));
    await (el as any).updateComplete;

    expect(priv(el)._deliveryChannelFilter).toBe("telegram");
    const rows = el.shadowRoot?.querySelectorAll("ic-delivery-row");
    expect(rows?.length).toBe(2);
  });

  it("47 - delivery table has proper ARIA attributes", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "delivery" });
    await flush(el);

    const table = el.shadowRoot?.querySelector(".delivery-table");
    expect(table?.getAttribute("role")).toBe("table");
    expect(table?.getAttribute("aria-label")).toBe("Delivery traces");
  });

  it("48 - channel table has proper ARIA attributes", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "channels" });
    await flush(el);

    const table = el.shadowRoot?.querySelector(".channel-table");
    expect(table?.getAttribute("role")).toBe("table");
    expect(table?.getAttribute("aria-label")).toBe("Channel activity");
  });

  /* ---- Enhanced Overview tests ---- */

  it("49 - overview shows reset button", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const resetBtn = el.shadowRoot?.querySelector(".reset-btn") as HTMLElement;
    expect(resetBtn).toBeTruthy();
    expect(resetBtn?.textContent?.trim()).toContain("Reset Observability Data");
  });

  it("50 - reset button click shows confirmation input", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Click reset button
    const resetBtn = el.shadowRoot?.querySelector(".reset-btn") as HTMLElement;
    resetBtn.click();
    await (el as any).updateComplete;

    expect(priv(el)._resetConfirming).toBe(true);
    // Should show input and warning
    const input = el.shadowRoot?.querySelector(".reset-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    const warning = el.shadowRoot?.querySelector(".reset-warning");
    expect(warning).toBeTruthy();
    expect(warning?.textContent).toContain("Type RESET to confirm");
  });

  it("51 - reset confirm button disabled until RESET typed", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Enter confirmation mode
    priv(el)._resetConfirming = true;
    priv(el)._resetInput = "";
    await (el as any).updateComplete;

    const confirmBtn = el.shadowRoot?.querySelector(".reset-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);

    // Type RESET
    priv(el)._resetInput = "RESET";
    await (el as any).updateComplete;

    const confirmBtn2 = el.shadowRoot?.querySelector(".reset-confirm-btn") as HTMLButtonElement;
    expect(confirmBtn2.disabled).toBe(false);
  });

  it("52 - reset cancel resets confirmation state", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Enter confirmation mode
    priv(el)._resetConfirming = true;
    priv(el)._resetInput = "RES";
    await (el as any).updateComplete;

    // Click cancel
    const cancelBtn = el.shadowRoot?.querySelector(".reset-cancel-btn") as HTMLElement;
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    await (el as any).updateComplete;

    expect(priv(el)._resetConfirming).toBe(false);
    expect(priv(el)._resetInput).toBe("");
  });

  it("53 - reset confirm calls obs.reset RPC and re-fetches data", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Enter confirmation mode with RESET typed
    priv(el)._resetConfirming = true;
    priv(el)._resetInput = "RESET";
    await (el as any).updateComplete;

    const callCountBefore = rpc._callFn.mock.calls.length;

    // Click confirm
    const confirmBtn = el.shadowRoot?.querySelector(".reset-confirm-btn") as HTMLElement;
    confirmBtn.click();
    await flush(el);

    // Should have called obs.reset + re-loaded data
    const resetCalls = rpc._callFn.mock.calls.filter((c: string[]) => c[0] === "obs.reset");
    expect(resetCalls.length).toBe(1);
    expect(rpc._callFn.mock.calls.length).toBeGreaterThan(callCountBefore);
    // Should have reset confirmation state
    expect(priv(el)._resetConfirming).toBe(false);
    expect(priv(el)._resetInput).toBe("");
  });

  it("54 - overview shows agent health grid", async () => {
    const rpc = createObserveMockRpcClient();
    // Return both agents on agents.get
    rpc._callFn.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "agents.get") {
        const id = params?.agentId;
        if (id === "default") return Promise.resolve(MOCK_AGENT_DEFAULT);
        if (id === "support") return Promise.resolve(MOCK_AGENT_SUPPORT);
        return Promise.reject(new Error("Not found"));
      }
      if (method === "agents.list") return Promise.resolve(MOCK_AGENT_LIST);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve(MOCK_DELIVERY_TRACES);
      if (method === "obs.channels.all") return Promise.resolve(MOCK_CHANNEL_ACTIVITY);
      if (method === "channels.list") return Promise.resolve(MOCK_CHANNEL_LIST);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const agentGrid = el.shadowRoot?.querySelector('[aria-label="Agent health"]');
    expect(agentGrid).toBeTruthy();
    const text = agentGrid?.textContent ?? "";
    expect(text).toContain("default");
    expect(text).toContain("support");
  });

  it("55 - agent health grid shows model and status", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "agents.get") {
        const id = params?.agentId;
        if (id === "default") return Promise.resolve(MOCK_AGENT_DEFAULT);
        if (id === "support") return Promise.resolve(MOCK_AGENT_SUPPORT);
        return Promise.reject(new Error("Not found"));
      }
      if (method === "agents.list") return Promise.resolve(MOCK_AGENT_LIST);
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve(MOCK_DELIVERY_TRACES);
      if (method === "obs.channels.all") return Promise.resolve(MOCK_CHANNEL_ACTIVITY);
      if (method === "channels.list") return Promise.resolve(MOCK_CHANNEL_LIST);
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const agentGrid = el.shadowRoot?.querySelector('[aria-label="Agent health"]');
    const text = agentGrid?.textContent ?? "";
    // Default agent should show model and active status
    expect(text).toContain("claude-sonnet-4-20250514");
    expect(text).toContain("active");
    // Support agent should show suspended
    expect(text).toContain("gpt-4o");
    expect(text).toContain("suspended");
  });

  it("56 - overview shows channel health grid", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const channelGrid = el.shadowRoot?.querySelector('[aria-label="Channel health"]');
    expect(channelGrid).toBeTruthy();
    const text = channelGrid?.textContent ?? "";
    expect(text).toContain("telegram");
    expect(text).toContain("discord");
  });

  it("57 - channel health grid shows status badges", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const channelGrid = el.shadowRoot?.querySelector('[aria-label="Channel health"]');
    const text = channelGrid?.textContent ?? "";
    // Running channels show "Healthy" (via getHealthVisual("running"))
    expect(text).toContain("Healthy");
    // Stopped channels show "Disconnected" (via getHealthVisual("stopped"))
    expect(text).toContain("Disconnected");
  });

  it("58 - agent health grid shows empty message when no agents", async () => {
    const rpc = createObserveMockRpcClient();
    rpc._callFn.mockImplementation((method: string) => {
      if (method === "agents.list") return Promise.resolve({ agents: [] });
      if (method === "obs.delivery.stats") return Promise.resolve(MOCK_DELIVERY_STATS);
      if (method === "obs.billing.total") return Promise.resolve(MOCK_BILLING_TOTAL);
      if (method === "obs.billing.usage24h") return Promise.resolve(MOCK_USAGE_24H);
      if (method === "obs.billing.byProvider") return Promise.resolve(MOCK_BY_PROVIDER);
      if (method === "obs.diagnostics") return Promise.resolve(MOCK_DIAGNOSTICS);
      if (method === "obs.delivery.recent") return Promise.resolve(MOCK_DELIVERY_TRACES);
      if (method === "obs.channels.all") return Promise.resolve(MOCK_CHANNEL_ACTIVITY);
      if (method === "channels.list") return Promise.resolve({ channels: [], total: 0 });
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const emptyMsg = el.shadowRoot?.querySelector(".health-empty");
    expect(emptyMsg).toBeTruthy();
    expect(emptyMsg?.textContent).toContain("No agents configured");
  });

  it("59 - overview stats-grid uses responsive CSS grid", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const statsGrid = el.shadowRoot?.querySelector(".stats-grid");
    expect(statsGrid).toBeTruthy();
    // Should contain 6 stat cards
    const cards = statsGrid?.querySelectorAll("ic-stat-card");
    expect(cards?.length).toBe(6);
  });

  it("60 - overview health grids section renders side by side", async () => {
    const rpc = createObserveMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const healthGrids = el.shadowRoot?.querySelector(".health-grids");
    expect(healthGrids).toBeTruthy();
    // Should have 2 child sections (agent + channel)
    const sections = healthGrids?.querySelectorAll(".section-title");
    const titles = Array.from(sections ?? []).map((s) => s.textContent?.trim());
    expect(titles).toContain("Agent Health");
    expect(titles).toContain("Channel Health");
  });
});
