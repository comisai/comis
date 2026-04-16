import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSessionDetail } from "./session-detail.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { SessionInfo, SessionMessage, PipelineSnapshot } from "../api/types/index.js";

// Side-effect import to register custom element
import "./session-detail.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

const testSession: SessionInfo = {
  key: "agent:mybot:default:user123:telegram",
  agentId: "mybot",
  channelType: "telegram",
  messageCount: 47,
  totalTokens: 23400,
  inputTokens: 15234,
  outputTokens: 8166,
  toolCalls: 12,
  compactions: 1,
  resetCount: 0,
  createdAt: Date.now() - 7200000,
  lastActiveAt: Date.now() - 1800000, // 30 min ago -> "idle"
};

const testMessages: SessionMessage[] = [
  { role: "user", content: "Hello, what can you help me with?", timestamp: Date.now() - 7200000 },
  { role: "assistant", content: "I can help you with many things!", timestamp: Date.now() - 7190000 },
  { role: "tool", content: '{"result": "success"}', toolName: "web_search", toolCallId: "tc_1", timestamp: Date.now() - 7180000 },
  { role: "assistant", content: "Based on my search, here is what I found...", timestamp: Date.now() - 7170000 },
  { role: "system", content: "Context was [compacted] into summary", timestamp: Date.now() - 7160000 },
  { role: "assistant", content: "Continuing after compaction...", timestamp: Date.now() - 7150000 },
];

const testPipelineSnapshots: PipelineSnapshot[] = [
  {
    agentId: "mybot",
    sessionKey: "agent:mybot:default:user123:telegram",
    tokensLoaded: 5000,
    tokensEvicted: 1000,
    tokensMasked: 200,
    tokensCompacted: 300,
    thinkingBlocksRemoved: 2,
    budgetUtilization: 0.65,
    evictionCategories: { old: 500, large: 500 },
    cacheHitTokens: 1500,
    cacheWriteTokens: 500,
    cacheMissTokens: 200,
    durationMs: 45,
    layerCount: 3,
    layers: [
      { name: "system-prompt", durationMs: 12, messagesIn: 0, messagesOut: 3 },
      { name: "memory-inject", durationMs: 25, messagesIn: 3, messagesOut: 8 },
      { name: "thinking-cleaner", durationMs: 8, messagesIn: 8, messagesOut: 7 },
    ],
    timestamp: Date.now() - 60000,
  },
];

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSessions: 0, embeddedEntries: 0, dbSizeBytes: 0 }),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi.fn().mockResolvedValue({ session: testSession, messages: testMessages }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue('{"key":"abc12345"}'),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 0 }),
    exportSessionsBulk: vi.fn().mockResolvedValue(""),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    chat: vi.fn().mockResolvedValue({ response: "" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: "" }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as ApiClient;
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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcSessionDetail", () => {
  it("renders without error", async () => {
    const el = await createElement<IcSessionDetail>("ic-session-detail");
    expect(el.shadowRoot).toBeTruthy();
  });

  it("loads session detail on mount when apiClient and sessionKey set", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(api.getSessionDetail).toHaveBeenCalledWith("agent:mybot:default:user123:telegram");
  });

  it("renders three tab buttons (Conversation, Context State, Metrics)", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const tabs = el.shadowRoot?.querySelectorAll('[role="tab"]');
    expect(tabs?.length).toBe(3);
    const labels = Array.from(tabs ?? []).map((t) => t.textContent?.trim());
    expect(labels).toContain("Conversation");
    expect(labels).toContain("Context State");
    expect(labels).toContain("Metrics");
  });

  it("default active tab is Conversation", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const tabs = el.shadowRoot?.querySelectorAll('[role="tab"]');
    const activeTab = Array.from(tabs ?? []).find((t) =>
      t.classList.contains("tab--active"),
    );
    expect(activeTab?.textContent?.trim()).toBe("Conversation");
  });

  it("breadcrumb shows parsed session key display name", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const breadcrumb = el.shadowRoot?.querySelector("ic-breadcrumb");
    expect(breadcrumb).toBeTruthy();
    const items = (breadcrumb as any)?.items;
    expect(items?.[0]?.label).toBe("Sessions");
    // Should use parsed userId "user123" from the session key
    expect(items?.[1]?.label).toBe("user123");
  });

  it("shows session info: agent, channel, messages, tokens", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const infoSection = el.shadowRoot?.querySelector(".session-info");
    expect(infoSection).toBeTruthy();
    const text = infoSection?.textContent ?? "";
    expect(text).toContain("mybot"); // agent
    expect(text).toContain("47"); // messages
  });

  it("conversation tab renders ic-chat-message for user/assistant messages", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const chatMessages = el.shadowRoot?.querySelectorAll("ic-chat-message");
    // user + 2 assistant + 1 assistant after compaction = 4 ic-chat-message elements
    // (the system compaction message renders as a compaction marker, not ic-chat-message)
    expect(chatMessages?.length).toBe(4);
  });

  it("tool messages render as ic-tool-call components", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const toolCalls = el.shadowRoot?.querySelectorAll("ic-tool-call");
    expect(toolCalls?.length).toBe(1);
    expect((toolCalls?.[0] as any).toolName).toBe("web_search");
    expect((toolCalls?.[0] as any).expanded).toBe(false);
  });

  it("compaction markers render for system messages containing [compacted]", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const markers = el.shadowRoot?.querySelectorAll('[data-testid="compaction-marker"]');
    expect(markers?.length).toBe(1);
    expect(markers?.[0]?.textContent).toContain("Context was compacted here");
  });

  it("clicking Context State tab triggers _loadContextData", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockResolvedValue(testPipelineSnapshots),
    });
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      rpcClient: rpc,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Click Context State tab
    const tabs = el.shadowRoot?.querySelectorAll('[role="tab"]');
    const contextTab = Array.from(tabs ?? []).find(
      (t) => t.textContent?.trim() === "Context State",
    ) as HTMLElement;
    contextTab?.click();
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith("obs.context.pipeline", expect.objectContaining({ agentId: "mybot" }));
  });

  it("budget segment bar renders in Context State tab with pipeline data", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "obs.context.pipeline") return Promise.resolve(testPipelineSnapshots);
        if (method === "obs.context.dag") return Promise.resolve([]);
        return Promise.resolve([]);
      }),
    });
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      rpcClient: rpc,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Switch to Context State tab
    (el as any)._activeTab = "context";
    await (el as any)._loadContextData();
    await el.updateComplete;

    const segmentBar = el.shadowRoot?.querySelector("ic-budget-segment-bar");
    expect(segmentBar).toBeTruthy();
    const segments = (segmentBar as any)?.segments;
    expect(segments?.length).toBeGreaterThan(0);
  });

  it("layer waterfall renders when pipeline snapshot selected", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "obs.context.pipeline") return Promise.resolve(testPipelineSnapshots);
        if (method === "obs.context.dag") return Promise.resolve([]);
        return Promise.resolve([]);
      }),
    });
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      rpcClient: rpc,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Switch to Context State tab and load data
    (el as any)._activeTab = "context";
    await (el as any)._loadContextData();
    await el.updateComplete;

    const waterfall = el.shadowRoot?.querySelector("ic-layer-waterfall");
    expect(waterfall).toBeTruthy();
    const layers = (waterfall as any)?.layers;
    expect(layers?.length).toBe(3);
    expect(layers?.[0]?.name).toBe("system-prompt");
  });

  it("action bar has Reset, Compact, Export, Delete buttons", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const buttons = el.shadowRoot?.querySelectorAll(".actions-bar button");
    const labels = Array.from(buttons ?? []).map((b) => b.textContent?.trim());
    expect(labels).toContain("Reset");
    expect(labels).toContain("Compact");
    expect(labels).toContain("Export JSONL");
    expect(labels).toContain("Delete");
  });

  it("reset button calls resetSession after confirm", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._confirmAction = "reset";
    await (el as any)._handleConfirm();
    expect(api.resetSession).toHaveBeenCalledWith("agent:mybot:default:user123:telegram");
  });

  it("compact button calls compactSession after confirm", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._confirmAction = "compact";
    await (el as any)._handleConfirm();
    expect(api.compactSession).toHaveBeenCalledWith("agent:mybot:default:user123:telegram");
  });

  it("delete button calls deleteSession after confirm with danger variant", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._showActionConfirm("delete");
    await el.updateComplete;

    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect((dialog as any)?.variant).toBe("danger");

    await (el as any)._handleConfirm();
    expect(api.deleteSession).toHaveBeenCalledWith("agent:mybot:default:user123:telegram");
  });

  it("clicking Metrics tab triggers _loadMetricsData", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockResolvedValue({ totalTokens: 5000, totalCost: 0.25, callCount: 10 }),
    });
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      rpcClient: rpc,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Click Metrics tab
    const tabs = el.shadowRoot?.querySelectorAll('[role="tab"]');
    const metricsTab = Array.from(tabs ?? []).find(
      (t) => t.textContent?.trim() === "Metrics",
    ) as HTMLElement;
    metricsTab?.click();
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith("obs.billing.bySession", expect.objectContaining({ sessionKey: "agent:mybot:default:user123:telegram" }));
  });

  it("metrics tab renders stat cards with session data", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Switch to metrics tab
    (el as any)._activeTab = "metrics";
    (el as any)._metricsLoaded = true;
    await el.updateComplete;

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect(statCards?.length).toBeGreaterThanOrEqual(10);

    const labels = Array.from(statCards ?? []).map(
      (card) => (card as any).label,
    );
    expect(labels).toContain("Total Tokens");
    expect(labels).toContain("Input Tokens");
    expect(labels).toContain("Output Tokens");
    expect(labels).toContain("Tool Calls");
    expect(labels).toContain("Compactions");
    expect(labels).toContain("Resets");
  });

  it("cost formatted as currency in metrics tab", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockResolvedValue({ totalTokens: 5000, totalCost: 1.5, callCount: 10 }),
    });
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      rpcClient: rpc,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Load metrics
    (el as any)._activeTab = "metrics";
    await (el as any)._loadMetricsData();
    await el.updateComplete;

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    const costCard = Array.from(statCards ?? []).find(
      (card) => (card as any).label === "Total Cost",
    );
    expect(costCard).toBeTruthy();
    // Intl.NumberFormat currency includes $
    expect((costCard as any).value).toContain("$");
    expect((costCard as any).value).toContain("1.50");
  });

  it("status shows correct computed value in metrics tab", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionDetail>("ic-session-detail", {
      apiClient: api,
      sessionKey: "agent:mybot:default:user123:telegram",
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Switch to metrics
    (el as any)._activeTab = "metrics";
    (el as any)._metricsLoaded = true;
    await el.updateComplete;

    const badge = el.shadowRoot?.querySelector('[data-testid="session-status"]');
    expect(badge).toBeTruthy();
    // lastActiveAt is 1 hour ago, so should be "idle" (between 5min and 1hr)
    expect(badge?.textContent?.trim()).toBe("idle");
  });
});
