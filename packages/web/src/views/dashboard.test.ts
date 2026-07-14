// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ConnectionStatus } from "../api/types/index.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import "./dashboard.js";
import { IcDashboard, formatUptime, formatNumber, formatTokens } from "./dashboard.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue({ response: "test response" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: new Date().toISOString() }),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi.fn().mockResolvedValue({ session: {}, messages: [] }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(""),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 0 }),
    exportSessionsBulk: vi.fn().mockResolvedValue(""),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    ...overrides,
  };
}

function createMockEventDispatcher(): EventDispatcher & { _fire: (type: string, data?: unknown) => void } {
  // SseController listens for SSE events on `document` (EventDispatcher's
  // channel-2 delivery path). The mock dispatcher therefore just needs to
  // satisfy the EventDispatcher shape; _fire routes via document.dispatchEvent
  // so SseController-driven views observe the event.
  return {
    connected: true,
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(() => vi.fn()),
    _fire(type: string, data: unknown = {}) {
      document.dispatchEvent(new CustomEvent(type, { detail: data }));
    },
  };
}

/** Type-safe access to private properties on the dashboard element. */
function priv(el: IcDashboard) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _agents: Array<{ id: string; name?: string; provider: string; model: string; status: string; messagesToday?: number; tokenUsageToday?: number }>;
    _channels: Array<{
      type: string;
      name: string;
      enabled: boolean;
      status: "connected" | "disconnected" | "error";
      uptime?: number;
    }>;
    _activity: Array<{ id: number; event: string; payload: Record<string, unknown>; timestamp: number }>;
    _systemHealth: Record<string, unknown> | null;
    _deliveryStats: Record<string, unknown> | null;
    _messagesToday: number;
    _tokenUsageToday: number;
    _sessionCount: number;
    _errorCount: number;
    _totalCost: number;
    _prevMessages: number;
    _prevTokens: number;
    _prevCost: number;
    _mcpStatus: string;
    _contextSummary: { cacheHitRate: number; budgetUtilization: number; totalEvictions: number; reReads: number } | null;
    _tokenSparklineData: number[];
    _costSparklineData: number[];
    _agentBilling: Map<string, { cost: number; tokens: number }>;
    _loadData(): Promise<void>;
    _loadRpcData(): Promise<void>;
    _loadSparklineData(): Promise<void>;
    _loadAgentBilling(): Promise<void>;
    _computeDelta(current: number, previous: number): { trend: string; trendValue: string };
    _navigate(route: string): void;
    _makeKeyHandler(route: string): (e: KeyboardEvent) => void;
    _rpcRefreshInterval: ReturnType<typeof setInterval> | null;
    _sse: unknown;
    _initSse(): void;
    apiClient: ApiClient | null;
    rpcClient: RpcClient | null;
    eventDispatcher: EventDispatcher | null;
  };
}

interface DashboardTestAgent {
  id: string;
  name?: string;
  provider: string;
  model: string;
  status: string;
}

async function renderDashboardAgentCard(
  el: IcDashboard,
  agent: DashboardTestAgent,
  rpcClient: RpcClient | null = null,
): Promise<HTMLElement & { updateComplete: Promise<boolean> }> {
  priv(el)._agents = [agent];
  priv(el)._loadState = "loaded";
  priv(el).rpcClient = rpcClient;
  document.body.appendChild(el);
  await el.updateComplete;

  const agentCard = el.shadowRoot?.querySelector("ic-agent-card") as
    | (HTMLElement & { updateComplete: Promise<boolean> })
    | null;
  expect(agentCard).not.toBeNull();
  await agentCard?.updateComplete;
  expect(agentCard?.shadowRoot).not.toBeNull();
  return agentCard!;
}

describe("IcDashboard", () => {
  let el: IcDashboard;

  beforeEach(() => {
    el = document.createElement("ic-dashboard") as IcDashboard;
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Helper function tests
  // =========================================================================

  describe("helper functions", () => {
    it("formatUptime produces correct output for days, hours, minutes", () => {
      expect(formatUptime(1221720)).toBe("14d 3h 22m");
    });

    it("formatUptime handles zero seconds", () => {
      expect(formatUptime(0)).toBe("0m");
    });

    it("formatUptime handles hours only", () => {
      expect(formatUptime(9000)).toBe("2h 30m");
    });

    it("formatUptime handles negative seconds", () => {
      expect(formatUptime(-100)).toBe("0m");
    });

    it("formatNumber formats with commas", () => {
      expect(formatNumber(1234567)).toBe("1,234,567");
      expect(formatNumber(0)).toBe("0");
      expect(formatNumber(999)).toBe("999");
    });

    it("formatTokens abbreviates thousands with K", () => {
      expect(formatTokens(845000)).toBe("845K");
      expect(formatTokens(1500)).toBe("1.5K");
    });

    it("formatTokens abbreviates millions with M", () => {
      expect(formatTokens(1200000)).toBe("1.2M");
      expect(formatTokens(5000000)).toBe("5M");
    });

    it("formatTokens returns raw number for small values", () => {
      expect(formatTokens(500)).toBe("500");
      expect(formatTokens(0)).toBe("0");
    });
  });

  // =========================================================================
  // 2. Initial state tests
  // =========================================================================

  describe("initial state", () => {
    it("starts in loading state", () => {
      expect(priv(el)._loadState).toBe("loading");
    });

    it("has empty agents, channels, and activity arrays initially", () => {
      expect(priv(el)._agents).toEqual([]);
      expect(priv(el)._channels).toEqual([]);
      expect(priv(el)._activity).toEqual([]);
    });

    it("has empty error string initially", () => {
      expect(priv(el)._error).toBe("");
    });

    it("has null systemHealth, deliveryStats, contextSummary initially", () => {
      expect(priv(el)._systemHealth).toBeNull();
      expect(priv(el)._deliveryStats).toBeNull();
      expect(priv(el)._contextSummary).toBeNull();
    });

    it("has zero counters initially", () => {
      expect(priv(el)._messagesToday).toBe(0);
      expect(priv(el)._tokenUsageToday).toBe(0);
      expect(priv(el)._sessionCount).toBe(0);
      expect(priv(el)._errorCount).toBe(0);
      expect(priv(el)._totalCost).toBe(0);
    });

    it("has initial mcpStatus as '---'", () => {
      expect(priv(el)._mcpStatus).toBe("---");
    });

    it("has empty sparkline data arrays", () => {
      expect(priv(el)._tokenSparklineData).toEqual([]);
      expect(priv(el)._costSparklineData).toEqual([]);
    });

    it("has empty agentBilling map", () => {
      expect(priv(el)._agentBilling.size).toBe(0);
    });
  });

  // =========================================================================
  // 3. Data loading tests
  // =========================================================================

  describe("_loadData", () => {
    it("does nothing when apiClient is null", async () => {
      priv(el).apiClient = null;
      await priv(el)._loadData();
      expect(priv(el)._loadState).toBe("loading");
    });

    it("calls getAgents, getChannels, and getActivity in parallel", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;

      await priv(el)._loadData();

      expect(mockClient.getAgents).toHaveBeenCalledTimes(1);
      expect(mockClient.getChannels).toHaveBeenCalledTimes(1);
      expect(mockClient.getActivity).toHaveBeenCalledTimes(1);
    });

    it("sets _loadState to 'loaded' after successful fetch", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;

      await priv(el)._loadData();

      expect(priv(el)._loadState).toBe("loaded");
    });

    it("stores fetched agents, channels, and activity data", async () => {
      const agents = [
        { id: "a1", name: "Agent One", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
      ];
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const activity = [
        { id: 1, event: "message:received", payload: {}, timestamp: Date.now() },
      ];

      const mockClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
        getChannels: vi.fn().mockResolvedValue(channels),
        getActivity: vi.fn().mockResolvedValue(activity),
      });
      priv(el).apiClient = mockClient;

      await priv(el)._loadData();

      expect(priv(el)._agents).toEqual(agents);
      expect(priv(el)._channels).toEqual(channels);
      expect(priv(el)._activity).toEqual(activity);
    });

    it("handles individual endpoint failures gracefully", async () => {
      const mockClient = createMockApiClient({
        getAgents: vi.fn().mockRejectedValue(new Error("agents fail")),
        getChannels: vi.fn().mockResolvedValue([
          { type: "discord", name: "dc", enabled: true, status: "connected" as const },
        ]),
        getActivity: vi.fn().mockRejectedValue(new Error("activity fail")),
      });
      priv(el).apiClient = mockClient;

      await priv(el)._loadData();

      expect(priv(el)._agents).toEqual([]);
      expect(priv(el)._channels).toHaveLength(1);
      expect(priv(el)._activity).toEqual([]);
      expect(priv(el)._loadState).toBe("loaded");
    });

    it("resets to loading state and clears error at start of _loadData", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;

      priv(el)._loadState = "error";
      priv(el)._error = "old error";

      await priv(el)._loadData();

      expect(priv(el)._error).toBe("");
      expect(priv(el)._loadState).toBe("loaded");
    });
  });

  // =========================================================================
  // RPC data fetching
  // =========================================================================

  describe("RPC data fetching", () => {
    it("loads the initial dashboard RPC dataset once when both clients arrive together", async () => {
      const agent = {
        id: "agent-alpha",
        name: "Agent Alpha",
        provider: "anthropic",
        model: "claude",
        status: "active",
      };
      const mockApi = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue([agent]),
      });
      const mockRpc = createMockRpcClient();

      priv(el).apiClient = mockApi;
      priv(el).rpcClient = mockRpc;
      document.body.appendChild(el);
      await el.updateComplete;

      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
        expect(
          vi.mocked(mockRpc.call).mock.calls.filter(
            ([method]) => method === "obs.billing.byAgent",
          ),
        ).not.toHaveLength(0);
      });

      const rpcCalls = vi.mocked(mockRpc.call).mock.calls;
      expect(rpcCalls.filter(([method]) => method === "gateway.status")).toHaveLength(1);
      expect(rpcCalls.filter(([method]) => method === "obs.billing.total")).toHaveLength(9);
      expect(
        rpcCalls.filter(([method]) => method === "obs.billing.byAgent"),
      ).toEqual([["obs.billing.byAgent", { agentId: "agent-alpha" }]]);
      expect(rpcCalls).toHaveLength(16);
    });

    it("rpcClient.call invoked for gateway.status", async () => {
      const mockRpc = createMockRpcClient();
      priv(el).rpcClient = mockRpc;
      priv(el).apiClient = createMockApiClient();

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("gateway.status");
    });

    it("rpcClient.call invoked for obs.delivery.stats", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({
          successRate: 99.5,
          avgLatencyMs: 45,
          totalDelivered: 1000,
          failed: 5,
        }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("obs.delivery.stats");
    });

    it("rpcClient.call invoked for obs.billing.total with sinceMs", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ totalTokens: 50000, totalCost: 1.5 }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("obs.billing.total", { sinceMs: 86_400_000 });
    });

    it("rpcClient.call invoked for obs.billing.usage24h", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue([]),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("obs.billing.usage24h");
    });

    it("rpcClient.call invoked for session.list", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ total: 5 }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("session.list", {});
    });

    it("rpcClient.call invoked for mcp.list", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ servers: [], total: 0 }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("mcp.list");
    });

    it("rpcClient.call invoked for obs.context.pipeline", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue([]),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      expect(mockRpc.call).toHaveBeenCalledWith("obs.context.pipeline", { limit: 50 });
    });

    it("graceful degradation when rpcClient is null", async () => {
      priv(el).rpcClient = null;
      await priv(el)._loadRpcData();
      expect(priv(el)._systemHealth).toBeNull();
      expect(priv(el)._deliveryStats).toBeNull();
    });

    it("graceful degradation when rpcClient is not connected", async () => {
      const mockRpc = createMockRpcClient(undefined, { status: "disconnected" as ConnectionStatus });
      priv(el).rpcClient = mockRpc;
      await priv(el)._loadRpcData();
      expect(mockRpc.call).not.toHaveBeenCalled();
    });

    it("graceful degradation when RPC calls fail", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockRejectedValue(new Error("RPC error")),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();
      expect(priv(el)._systemHealth).toBeNull();
    });

    it("computes cost delta from dual billing calls", async () => {
      let callCount = 0;
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string, params?: unknown) => {
          if (method === "obs.billing.total") {
            const p = params as { sinceMs?: number } | undefined;
            callCount++;
            if (p?.sinceMs === 86_400_000) {
              return Promise.resolve({ totalTokens: 5000, totalCost: 2.5 });
            }
            if (p?.sinceMs === 172_800_000) {
              return Promise.resolve({ totalTokens: 8000, totalCost: 4.0 });
            }
            // For 7-day sparkline calls
            return Promise.resolve({ totalCost: callCount * 0.5 });
          }
          if (method === "obs.billing.usage24h") {
            return Promise.resolve([]);
          }
          return Promise.resolve({});
        }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadRpcData();

      // prevTokens = 8000 - 5000 = 3000
      expect(priv(el)._prevTokens).toBe(3000);
      // prevCost = 4.0 - 2.5 = 1.5
      expect(priv(el)._prevCost).toBe(1.5);
    });
  });

  // =========================================================================
  // 4. SSE subscription tests
  // =========================================================================

  describe("SSE event subscriptions via SseController", () => {
    afterEach(() => {
      if (el.isConnected) {
        document.body.removeChild(el);
      }
    });

    it("subscribes to events when eventDispatcher is set", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      // Element must be connected to DOM for SseController.hostConnected to fire
      document.body.appendChild(el);
      priv(el)._initSse();

      expect(priv(el)._sse).not.toBeNull();
    });

    it("does not resubscribe if already subscribed", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      document.body.appendChild(el);
      priv(el)._initSse();
      const firstSse = priv(el)._sse;
      priv(el)._initSse();

      // Same instance, not recreated
      expect(priv(el)._sse).toBe(firstSse);
    });

    it("does nothing when eventDispatcher is null", () => {
      priv(el).eventDispatcher = null;
      priv(el)._initSse();
      expect(priv(el)._sse).toBeNull();
    });

    it("SSE message:received increments _messagesToday", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      document.body.appendChild(el);
      priv(el)._initSse();

      priv(el)._messagesToday = 10;
      // SseController listens on document events (EventDispatcher channel 2).
      document.dispatchEvent(new CustomEvent("message:received"));
      expect(priv(el)._messagesToday).toBe(11);
    });

    it("SSE message:sent increments _messagesToday", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      document.body.appendChild(el);
      priv(el)._initSse();

      priv(el)._messagesToday = 5;
      document.dispatchEvent(new CustomEvent("message:sent"));
      expect(priv(el)._messagesToday).toBe(6);
    });

    it("SSE system:error increments _errorCount", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      document.body.appendChild(el);
      priv(el)._initSse();

      priv(el)._errorCount = 3;
      document.dispatchEvent(new CustomEvent("system:error"));
      expect(priv(el)._errorCount).toBe(4);
    });

    it("SSE session:created increments _sessionCount", () => {
      const mockDispatcher = createMockEventDispatcher();
      priv(el).eventDispatcher = mockDispatcher;
      document.body.appendChild(el);
      priv(el)._initSse();

      priv(el)._sessionCount = 7;
      document.dispatchEvent(new CustomEvent("session:created"));
      expect(priv(el)._sessionCount).toBe(8);
    });
  });

  // =========================================================================
  // 5. Delta computation tests
  // =========================================================================

  describe("delta computation", () => {
    it("returns +100% when previous is zero and current is positive", () => {
      const delta = priv(el)._computeDelta(100, 0);
      expect(delta.trend).toBe("up");
      expect(delta.trendValue).toBe("+100%");
    });

    it("returns flat when both current and previous are zero", () => {
      const delta = priv(el)._computeDelta(0, 0);
      expect(delta.trend).toBe("flat");
      expect(delta.trendValue).toBe("");
    });

    it("returns positive percentage when current exceeds previous", () => {
      const delta = priv(el)._computeDelta(150, 100);
      expect(delta.trend).toBe("up");
      expect(delta.trendValue).toBe("+50%");
    });

    it("returns negative percentage when current is below previous", () => {
      const delta = priv(el)._computeDelta(50, 100);
      expect(delta.trend).toBe("down");
      expect(delta.trendValue).toBe("-50%");
    });

    it("returns flat when current equals previous (non-zero)", () => {
      const delta = priv(el)._computeDelta(100, 100);
      expect(delta.trend).toBe("flat");
      expect(delta.trendValue).toBe("");
    });

    it("handles zero previous value with zero current (no division by zero)", () => {
      const delta = priv(el)._computeDelta(0, 0);
      expect(delta.trend).toBe("flat");
      // No NaN or Infinity
      expect(delta.trendValue).not.toContain("NaN");
      expect(delta.trendValue).not.toContain("Infinity");
    });
  });

  // =========================================================================
  // 6. Navigation tests
  // =========================================================================

  describe("navigation", () => {
    it("_navigate dispatches CustomEvent with bubbles: true, composed: true", () => {
      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      priv(el)._navigate("agents");

      expect(spy).toHaveBeenCalledTimes(1);
      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toBe("agents");
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
    });

    it("_makeKeyHandler dispatches navigate on Enter", () => {
      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const handler = priv(el)._makeKeyHandler("observe/billing");
      handler(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("observe/billing");
    });

    it("_makeKeyHandler dispatches navigate on Space", () => {
      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const handler = priv(el)._makeKeyHandler("sessions");
      handler(new KeyboardEvent("keydown", { key: " " }));

      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("sessions");
    });

    it("_makeKeyHandler does not dispatch on other keys", () => {
      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const handler = priv(el)._makeKeyHandler("agents");
      handler(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(spy).not.toHaveBeenCalled();
    });

    it("routes dashboard configure action to the selected agent editor", async () => {
      const navigateSpy = vi.fn();
      el.addEventListener("navigate", navigateSpy);
      const agentCard = await renderDashboardAgentCard(el, {
        id: "agent-alpha",
        name: "Agent Alpha",
        provider: "anthropic",
        model: "claude",
        status: "active",
      });

      const configureButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Configure Agent Alpha"]',
      );
      expect(configureButton).not.toBeNull();
      configureButton?.click();

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      expect((navigateSpy.mock.calls[0][0] as CustomEvent).detail).toBe(
        "agents/agent-alpha/edit",
      );
    });

    it("suspends an active agent from the dashboard card action", async () => {
      const rpcClient = createMockRpcClient();
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );

      const suspendButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Suspend Agent Alpha"]',
      );
      expect(suspendButton).not.toBeNull();
      suspendButton?.click();

      await vi.waitFor(() => {
        expect(rpcClient.call).toHaveBeenCalledWith("agents.suspend", {
          agentId: "agent-alpha",
        });
      });
    });

    it("refreshes the dashboard card after a successful suspend action", async () => {
      const rpcClient = createMockRpcClient();
      const toastSpy = vi.spyOn(IcToast, "show");
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );
      priv(el).apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue([
          {
            id: "agent-alpha",
            name: "Agent Alpha",
            provider: "anthropic",
            model: "claude",
            status: "suspended",
          },
        ]),
      });

      agentCard.shadowRoot
        ?.querySelector<HTMLButtonElement>('button[aria-label="Suspend Agent Alpha"]')
        ?.click();

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith("Agent agent-alpha suspended", "success");
        const refreshedCard = el.shadowRoot?.querySelector("ic-agent-card");
        expect(
          refreshedCard?.shadowRoot?.querySelector(
            'button[aria-label="Resume Agent Alpha"]',
          ),
        ).not.toBeNull();
      });
    });

    it("resumes a suspended agent from the dashboard card action", async () => {
      const rpcClient = createMockRpcClient();
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "suspended",
        },
        rpcClient,
      );

      const resumeButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Resume Agent Alpha"]',
      );
      expect(resumeButton).not.toBeNull();
      resumeButton?.click();

      await vi.waitFor(() => {
        expect(rpcClient.call).toHaveBeenCalledWith("agents.resume", {
          agentId: "agent-alpha",
        });
      });
    });

    it("confirms dashboard agent deletion before calling the delete RPC", async () => {
      const rpcClient = createMockRpcClient();
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );

      const deleteButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete Agent Alpha"]',
      );
      expect(deleteButton).not.toBeNull();
      deleteButton?.click();
      await el.updateComplete;

      expect(rpcClient.call).not.toHaveBeenCalledWith("agents.delete", {
        agentId: "agent-alpha",
      });
      const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
      expect(dialog).not.toBeNull();
      dialog?.dispatchEvent(new CustomEvent("confirm"));

      await vi.waitFor(() => {
        expect(rpcClient.call).toHaveBeenCalledWith("agents.delete", {
          agentId: "agent-alpha",
        });
      });
    });

    it("locks dashboard agent actions while deletion is in flight", async () => {
      let resolveDelete!: (value: unknown) => void;
      const deletePromise = new Promise<unknown>((resolve) => {
        resolveDelete = resolve;
      });
      const rpcClient = createMockRpcClient((method) =>
        method === "agents.delete" ? deletePromise : Promise.resolve({}),
      );
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );

      agentCard.shadowRoot
        ?.querySelector<HTMLButtonElement>('button[aria-label="Delete Agent Alpha"]')
        ?.click();
      await el.updateComplete;
      el.shadowRoot
        ?.querySelector("ic-confirm-dialog")
        ?.dispatchEvent(new CustomEvent("confirm"));

      await vi.waitFor(() => {
        expect(rpcClient.call).toHaveBeenCalledWith("agents.delete", {
          agentId: "agent-alpha",
        });
      });
      await el.updateComplete;
      await agentCard.updateComplete;

      const actionButtons = agentCard.shadowRoot?.querySelectorAll<HTMLButtonElement>(
        ".action-btn",
      );
      expect(Array.from(actionButtons ?? []).every((button) => button.disabled)).toBe(true);
      agentCard.shadowRoot
        ?.querySelector<HTMLButtonElement>('button[aria-label="Suspend Agent Alpha"]')
        ?.click();
      expect(rpcClient.call).not.toHaveBeenCalledWith("agents.suspend", {
        agentId: "agent-alpha",
      });

      resolveDelete({});
      await vi.waitFor(() => {
        const buttons = agentCard.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-btn");
        expect(Array.from(buttons ?? []).every((button) => !button.disabled)).toBe(true);
      });
    });

    it("cancels dashboard agent deletion without calling the delete RPC", async () => {
      const rpcClient = createMockRpcClient();
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );

      const deleteButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete Agent Alpha"]',
      );
      expect(deleteButton).not.toBeNull();
      deleteButton?.click();
      await el.updateComplete;

      const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
      expect(dialog).not.toBeNull();
      dialog?.dispatchEvent(new CustomEvent("cancel"));
      await el.updateComplete;

      expect(el.shadowRoot?.querySelector("ic-confirm-dialog")).toBeNull();
      expect(rpcClient.call).not.toHaveBeenCalledWith("agents.delete", {
        agentId: "agent-alpha",
      });
    });

    it("reports dashboard suspend failures and allows the action to be retried", async () => {
      const rpcClient = createMockRpcClient(
        (method) => {
          if (method === "agents.suspend") {
            return Promise.reject(new Error("suspend denied"));
          }
          return Promise.resolve({});
        },
        { status: "disconnected" as ConnectionStatus },
      );
      const toastSpy = vi.spyOn(IcToast, "show");
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );
      const suspendButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Suspend Agent Alpha"]',
      );
      expect(suspendButton).not.toBeNull();

      suspendButton?.click();
      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          "Failed to suspend agent: suspend denied",
          "error",
        );
      });
      suspendButton?.click();

      await vi.waitFor(() => {
        const suspendCalls = vi.mocked(rpcClient.call).mock.calls.filter(
          ([method]) => method === "agents.suspend",
        );
        expect(suspendCalls).toHaveLength(2);
      });
    });

    it("reports dashboard delete failures after confirmation", async () => {
      const rpcClient = createMockRpcClient(
        (method) => {
          if (method === "agents.delete") {
            return Promise.reject(new Error("delete denied"));
          }
          return Promise.resolve({});
        },
        { status: "disconnected" as ConnectionStatus },
      );
      const toastSpy = vi.spyOn(IcToast, "show");
      const agentCard = await renderDashboardAgentCard(
        el,
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          provider: "anthropic",
          model: "claude",
          status: "active",
        },
        rpcClient,
      );
      const deleteButton = agentCard.shadowRoot?.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete Agent Alpha"]',
      );
      expect(deleteButton).not.toBeNull();
      deleteButton?.click();
      await el.updateComplete;

      el.shadowRoot
        ?.querySelector("ic-confirm-dialog")
        ?.dispatchEvent(new CustomEvent("confirm"));

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          "Failed to delete agent: delete denied",
          "error",
        );
      });
    });
  });

  // =========================================================================
  // 7. Per-agent billing tests
  // =========================================================================

  describe("per-agent billing", () => {
    it("_loadAgentBilling calls obs.billing.byAgent for each agent", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ totalCost: 1.5, totalTokens: 5000 }),
      });
      priv(el).rpcClient = mockRpc;
      priv(el)._agents = [
        { id: "a1", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
      ] as any;

      await priv(el)._loadAgentBilling();

      expect(mockRpc.call).toHaveBeenCalledWith("obs.billing.byAgent", { agentId: "a1" });
      expect(mockRpc.call).toHaveBeenCalledWith("obs.billing.byAgent", { agentId: "a2" });
      expect(priv(el)._agentBilling.size).toBe(2);
      expect(priv(el)._agentBilling.get("a1")).toEqual({ cost: 1.5, tokens: 5000 });
    });

    it("_loadAgentBilling handles individual agent billing failures", async () => {
      let callIdx = 0;
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation(() => {
          callIdx++;
          if (callIdx === 1) return Promise.resolve({ totalCost: 2.0, totalTokens: 8000 });
          return Promise.reject(new Error("billing fail"));
        }),
      });
      priv(el).rpcClient = mockRpc;
      priv(el)._agents = [
        { id: "a1", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
      ] as any;

      await priv(el)._loadAgentBilling();

      // First agent succeeded, second failed
      expect(priv(el)._agentBilling.size).toBe(1);
      expect(priv(el)._agentBilling.has("a1")).toBe(true);
      expect(priv(el)._agentBilling.has("a2")).toBe(false);
    });

    it("_loadAgentBilling does nothing when agents array is empty", async () => {
      const mockRpc = createMockRpcClient();
      priv(el).rpcClient = mockRpc;
      priv(el)._agents = [];

      await priv(el)._loadAgentBilling();

      expect(mockRpc.call).not.toHaveBeenCalled();
      expect(priv(el)._agentBilling.size).toBe(0);
    });

    it("_loadAgentBilling caps at 20 agents", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ totalCost: 0.1, totalTokens: 100 }),
      });
      priv(el).rpcClient = mockRpc;
      // Create 25 agents
      priv(el)._agents = Array.from({ length: 25 }, (_, i) => ({
        id: `a${i}`,
        provider: "test",
        model: "test",
        status: "active",
      })) as any;

      await priv(el)._loadAgentBilling();

      // Only 20 calls made
      expect(mockRpc.call).toHaveBeenCalledTimes(20);
      expect(priv(el)._agentBilling.size).toBe(20);
    });
  });

  // =========================================================================
  // 8. Sparkline data tests
  // =========================================================================

  describe("sparkline data", () => {
    it("token sparkline maps usage24h data to number array", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "obs.billing.usage24h") {
            return Promise.resolve([
              { hour: 0, tokens: 100 },
              { hour: 1, tokens: 200 },
              { hour: 2, tokens: 150 },
            ]);
          }
          return Promise.resolve({ totalCost: 0 });
        }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadSparklineData();

      expect(priv(el)._tokenSparklineData).toEqual([100, 200, 150]);
    });

    it("cost sparkline computes daily values from cumulative totals", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string, params?: unknown) => {
          if (method === "obs.billing.usage24h") {
            return Promise.resolve([]);
          }
          if (method === "obs.billing.total") {
            const p = params as { sinceMs: number };
            const dayMs = 86_400_000;
            // Cumulative costs: 1d=$1, 2d=$3, 3d=$6, 4d=$10, 5d=$15, 6d=$21, 7d=$28
            const dayIndex = Math.round(p.sinceMs / dayMs);
            const costs: Record<number, number> = {
              1: 1, 2: 3, 3: 6, 4: 10, 5: 15, 6: 21, 7: 28,
            };
            return Promise.resolve({ totalCost: costs[dayIndex] ?? 0 });
          }
          return Promise.resolve({});
        }),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadSparklineData();

      // Daily: [1, 2, 3, 4, 5, 6, 7] reversed to [7, 6, 5, 4, 3, 2, 1]
      expect(priv(el)._costSparklineData).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });

    it("sparkline data handles empty results gracefully", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockRejectedValue(new Error("fail")),
      });
      priv(el).rpcClient = mockRpc;

      await priv(el)._loadSparklineData();

      // Should remain empty, no crash
      expect(priv(el)._tokenSparklineData).toEqual([]);
    });
  });

  // =========================================================================
  // 9. Auto-refresh interval
  // =========================================================================

  describe("auto-refresh interval", () => {
    it("creates refresh interval when rpcClient is set", async () => {
      vi.useFakeTimers();
      priv(el).apiClient = createMockApiClient();
      priv(el).rpcClient = createMockRpcClient();
      document.body.appendChild(el);
      await el.updateComplete;

      expect(priv(el)._rpcRefreshInterval).not.toBeNull();

      document.body.removeChild(el);
      vi.useRealTimers();
    });

    it("clears refresh interval on disconnectedCallback", async () => {
      vi.useFakeTimers();
      priv(el).apiClient = createMockApiClient();
      priv(el).rpcClient = createMockRpcClient();
      document.body.appendChild(el);
      await el.updateComplete;

      expect(priv(el)._rpcRefreshInterval).not.toBeNull();
      document.body.removeChild(el);

      expect(priv(el)._rpcRefreshInterval).toBeNull();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 10. Agent and channel counts
  // =========================================================================

  describe("agent and channel counts", () => {
    it("calculates active agent count by filtering status === 'active'", async () => {
      const agents = [
        { id: "a1", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
        { id: "a3", provider: "anthropic", model: "claude", status: "active" },
        { id: "a4", provider: "openai", model: "gpt-4", status: "error" },
      ];
      priv(el).apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
      });
      await priv(el)._loadData();

      const activeAgents = priv(el)._agents.filter((a) => a.status === "active").length;
      expect(activeAgents).toBe(2);
    });

    it("calculates connected channel count by filtering status === 'connected'", async () => {
      const channels = [
        { type: "telegram", name: "tg", enabled: true, status: "connected" as const },
        { type: "discord", name: "dc", enabled: true, status: "disconnected" as const },
        { type: "slack", name: "sl", enabled: true, status: "connected" as const },
        { type: "whatsapp", name: "wa", enabled: false, status: "error" as const },
      ];
      priv(el).apiClient = createMockApiClient({
        getChannels: vi.fn().mockResolvedValue(channels),
      });
      await priv(el)._loadData();

      const connectedChannels = priv(el)._channels.filter(
        (c) => c.status === "connected",
      ).length;
      expect(connectedChannels).toBe(2);
    });
  });

  // =========================================================================
  // 11. Error handling
  // =========================================================================

  describe("error handling", () => {
    it("_loadData can be called multiple times (retry pattern)", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;

      await priv(el)._loadData();
      expect(mockClient.getAgents).toHaveBeenCalledTimes(1);

      await priv(el)._loadData();
      expect(mockClient.getAgents).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 12. DOM rendering
  // =========================================================================

  describe("DOM rendering", () => {
    afterEach(() => {
      if (el.isConnected) {
        document.body.removeChild(el);
      }
    });

    it("renders skeleton view before data loads", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      const skeleton = el.shadowRoot?.querySelector("ic-skeleton-view");
      expect(skeleton).not.toBeNull();
    });

    it("renders 6 stat cards when data is loaded", async () => {
      const agents = [
        { id: "a1", name: "Agent Alpha", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
      ];
      const channels = [
        { type: "discord", name: "main", enabled: true, status: "connected" as const },
      ];

      el.apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
        getChannels: vi.fn().mockResolvedValue(channels),
      });
      document.body.appendChild(el);

      await priv(el)._loadData();
      await el.updateComplete;

      const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
      expect(statCards?.length).toBe(6);
    });

    it("stat cards show correct active agents value", async () => {
      const agents = [
        { id: "a1", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
        { id: "a3", provider: "anthropic", model: "claude", status: "active" },
      ];

      el.apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
      });
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
      const agentCard = statCards![0];
      expect((agentCard as any).value).toBe("2/3");
    });

    it("stat cards show '---' for RPC-dependent data when rpcClient is null", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
      // Cards: [0] Agents (REST), [1] Sessions (RPC), [2] Messages (RPC),
      //        [3] Tokens (RPC), [4] Cost (RPC), [5] Errors (RPC)
      const sessionsCard = statCards![1];
      const messagesCard = statCards![2];
      const tokensCard = statCards![3];
      const costCard = statCards![4];
      const errorsCard = statCards![5];
      expect((sessionsCard as any).value).toBe("---");
      expect((messagesCard as any).value).toBe("---");
      expect((tokensCard as any).value).toBe("---");
      expect((costCard as any).value).toBe("---");
      expect((errorsCard as any).value).toBe("---");
    });

    it("renders system health card", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const infoCards = el.shadowRoot?.querySelectorAll(".info-card");
      expect(infoCards?.length).toBeGreaterThanOrEqual(2);
      expect(infoCards![0]?.textContent).toContain("System Health");
    });

    it("renders context engine card", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const infoCards = el.shadowRoot?.querySelectorAll(".info-card");
      expect(infoCards![1]?.textContent).toContain("Context Engine");
    });

    it("renders sparkline cards", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const sparklineCards = el.shadowRoot?.querySelectorAll(".sparkline-card");
      expect(sparklineCards?.length).toBe(2);
    });

    it("renders sparklines when data is available", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      priv(el)._tokenSparklineData = [10, 20, 30, 40, 50];
      priv(el)._costSparklineData = [1, 2, 3, 4, 5, 6, 7];
      await el.updateComplete;

      const sparklines = el.shadowRoot?.querySelectorAll("ic-sparkline");
      expect(sparklines?.length).toBe(2);
      expect((sparklines![0] as any).data).toEqual([10, 20, 30, 40, 50]);
      expect((sparklines![1] as any).data).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("renders 'No agents configured' when agents array is empty", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const text = el.shadowRoot?.innerHTML;
      expect(text).toContain("No agents configured");
    });

    it("renders agent-card elements when agents are loaded", async () => {
      const agents = [
        { id: "a1", name: "Agent Alpha", provider: "anthropic", model: "claude", status: "active" },
        { id: "a2", provider: "openai", model: "gpt-4", status: "idle" },
      ];

      el.apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
      });
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const agentCards = el.shadowRoot?.querySelectorAll("ic-agent-card");
      expect(agentCards?.length).toBe(2);
    });

    it("renders agent cards with cost badges when billing data is loaded", async () => {
      const agents = [
        { id: "a1", name: "Agent Alpha", provider: "anthropic", model: "claude", status: "active" },
      ];

      el.apiClient = createMockApiClient({
        getAgents: vi.fn().mockResolvedValue(agents),
      });
      document.body.appendChild(el);
      await priv(el)._loadData();
      priv(el)._agentBilling = new Map([["a1", { cost: 2.5, tokens: 5000 }]]);
      await el.updateComplete;

      const badges = el.shadowRoot?.querySelectorAll(".agent-cost-badge");
      expect(badges?.length).toBe(1);
      expect(badges![0].textContent).toContain("$2.50");
    });

    it("renders channel badges when channels are loaded", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
        { type: "discord", name: "dc-main", enabled: true, status: "disconnected" as const },
      ];

      el.apiClient = createMockApiClient({
        getChannels: vi.fn().mockResolvedValue(channels),
      });
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const channelBadges = el.shadowRoot?.querySelectorAll("ic-channel-badge");
      expect(channelBadges?.length).toBe(2);
    });

    it("renders error state with retry button on error", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await el.updateComplete;

      priv(el)._loadState = "error";
      priv(el)._error = "Network failure";
      await el.updateComplete;

      const errorMsg = el.shadowRoot?.querySelector(".error-message");
      expect(errorMsg).not.toBeNull();
      expect(errorMsg!.textContent).toContain("Network failure");

      const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
      expect(retryBtn).not.toBeNull();
      expect(retryBtn!.textContent?.trim()).toBe("Retry");
    });

    it("renders activity feed", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const feed = el.shadowRoot?.querySelector("ic-activity-feed");
      expect(feed).not.toBeNull();
    });

    it("stat card links dispatch navigate on click", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const links = el.shadowRoot?.querySelectorAll(".stat-card-link");
      expect(links?.length).toBe(6);

      // Click first stat card (agents)
      (links![0] as HTMLElement).click();
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("agents");
    });

    it("info cards dispatch navigate on click", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const infoCards = el.shadowRoot?.querySelectorAll(".info-card--link");
      expect(infoCards?.length).toBe(2);

      // Click system health card
      (infoCards![0] as HTMLElement).click();
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("observe/overview");
    });

    it("section titles dispatch navigate on click", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const sectionLinks = el.shadowRoot?.querySelectorAll(".section-title--link");
      expect(sectionLinks?.length).toBe(2);

      // Click "Agents" section title
      (sectionLinks![0] as HTMLElement).click();
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("agents");
    });

    it("sparkline cards dispatch navigate on click", async () => {
      el.apiClient = createMockApiClient();
      document.body.appendChild(el);
      await priv(el)._loadData();
      await el.updateComplete;

      const spy = vi.fn();
      el.addEventListener("navigate", spy);

      const sparklineCards = el.shadowRoot?.querySelectorAll(".sparkline-card");
      expect(sparklineCards?.length).toBe(2);

      // Click token sparkline card
      (sparklineCards![0] as HTMLElement).click();
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][0] as CustomEvent).detail).toBe("observe/billing");
    });
  });
});
