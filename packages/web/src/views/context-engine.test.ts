import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcContextEngineView } from "./context-engine.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./context-engine.js";
import { createMockRpcClient as _createSharedMock } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_PIPELINE: Record<string, unknown> = {
  agentId: "default",
  sessionKey: "sess-1",
  tokensLoaded: 10000,
  tokensEvicted: 500,
  tokensMasked: 200,
  tokensCompacted: 0,
  thinkingBlocksRemoved: 3,
  budgetUtilization: 0.72,
  evictionCategories: { file_read: 2, exec: 1 },
  cacheHitTokens: 0,
  cacheWriteTokens: 0,
  cacheMissTokens: 0,
  durationMs: 45,
  layerCount: 4,
  layers: [
    { name: "thinking-cleaner", durationMs: 5, messagesIn: 20, messagesOut: 17 },
    { name: "history-window", durationMs: 2, messagesIn: 17, messagesOut: 10 },
    { name: "dead-content-evictor", durationMs: 15, messagesIn: 10, messagesOut: 8 },
    { name: "observation-masker", durationMs: 23, messagesIn: 8, messagesOut: 8 },
  ],
  timestamp: Date.now() - 60_000,
};

const MOCK_DAG: Record<string, unknown> = {
  agentId: "default",
  sessionKey: "sess-1",
  leafSummariesCreated: 3,
  condensedSummariesCreated: 1,
  maxDepthReached: 2,
  totalSummariesCreated: 4,
  durationMs: 120,
  timestamp: Date.now() - 30_000,
};

const MOCK_AGENTS = { agents: [{ id: "default", provider: "anthropic", model: "claude", status: "active" }] };

/* ------------------------------------------------------------------ */
/*  Mock RPC client factory                                            */
/* ------------------------------------------------------------------ */

/** Context-engine-specific mock that routes RPC methods to test data. */
function createMockRpcClient(overrides?: Record<string, unknown>): RpcClient {
  return _createSharedMock(async (method: string) => {
    if (method === "obs.context.pipeline") return [MOCK_PIPELINE];
    if (method === "obs.context.dag") return [MOCK_DAG];
    if (method === "agents.list") return MOCK_AGENTS;
    return overrides?.[method] ?? [];
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("IcContextEngineView", () => {
  let el: IcContextEngineView;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    if (el?.isConnected) el.remove();
    vi.useRealTimers();
  });

  it("creates element with default state", () => {
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-context-engine-view");
    expect(el.rpcClient).toBeNull();
  });

  it("renders agent filter dropdown", async () => {
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    // Wait for data load and render
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const select = shadow.querySelector(".filter-select") as HTMLSelectElement;
    expect(select).toBeDefined();
    expect(select?.tagName.toLowerCase()).toBe("select");
  });

  it("loads pipeline data via RPC client", async () => {
    const mockRpc = createMockRpcClient();
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("obs.context.pipeline", expect.any(Object));
    expect(mockRpc.call).toHaveBeenCalledWith("obs.context.dag", expect.any(Object));
  });

  it("renders pipeline metrics when data exists", async () => {
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    // Should have section titles
    const titles = shadow.querySelectorAll(".section-title");
    const titleTexts = [...titles].map((t) => t.textContent?.trim());
    expect(titleTexts).toContain("Pipeline Metrics");
    expect(titleTexts).toContain("Layer Waterfall");
  });

  it("renders DAG panel only when DAG data exists", async () => {
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const titles = shadow.querySelectorAll(".section-title");
    const titleTexts = [...titles].map((t) => t.textContent?.trim());
    // DAG data exists in mock, so panel should render
    expect(titleTexts).toContain("DAG Compaction");
  });

  it("does not render DAG panel when no DAG data", async () => {
    const mockRpc = createMockRpcClient();
    (mockRpc.call as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "obs.context.pipeline") return [MOCK_PIPELINE];
      if (method === "obs.context.dag") return [];
      if (method === "agents.list") return MOCK_AGENTS;
      return [];
    });

    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const titles = shadow.querySelectorAll(".section-title");
    const titleTexts = [...titles].map((t) => t.textContent?.trim());
    expect(titleTexts).not.toContain("DAG Compaction");
  });

  it("shows empty state when no pipeline data", async () => {
    const mockRpc = createMockRpcClient();
    (mockRpc.call as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "obs.context.pipeline") return [];
      if (method === "obs.context.dag") return [];
      if (method === "agents.list") return MOCK_AGENTS;
      return [];
    });

    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const emptyStates = shadow.querySelectorAll("ic-empty-state");
    expect(emptyStates.length).toBeGreaterThan(0);
  });

  it("renders execution rows in waterfall section", async () => {
    el = document.createElement("ic-context-engine-view") as IcContextEngineView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const execRows = shadow.querySelectorAll(".execution-row");
    expect(execRows.length).toBeGreaterThan(0);
  });
});
