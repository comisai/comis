// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcBillingView } from "./billing-view.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./billing-view.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_BILLING_TOTAL = {
  totalCost: 42.5,
  totalTokens: 125_000,
  callCount: 350,
};

const MOCK_BILLING_CUMULATIVE = {
  totalCost: 80.0,
  totalTokens: 240_000,
  callCount: 680,
};

const MOCK_PROVIDERS = {
  providers: [
    {
      provider: "Anthropic",
      totalTokens: 100_000,
      totalCost: 35.0,
      callCount: 280,
      models: [
        { model: "claude-sonnet-4-20250514", cost: 25.0, tokens: 80_000, calls: 200 },
        { model: "claude-haiku-35", cost: 10.0, tokens: 20_000, calls: 80 },
      ],
    },
    {
      provider: "OpenAI",
      totalTokens: 25_000,
      totalCost: 7.5,
      callCount: 70,
      models: [
        { model: "gpt-4o", cost: 7.5, tokens: 25_000, calls: 70 },
      ],
    },
  ],
};

const MOCK_AGENTS = { agents: ["default", "researcher"] };

/** A planted body/secret marker — must never reach the DOM or the export. */
const BODY_MARKER = "SECRET_MESSAGE_BODY_DO_NOT_LEAK";

const MOCK_AGENT_BILLING = {
  tokensToday: 80_000,
  costToday: 28.5,
  percentOfTotal: 67.1,
  // COST-01 per-tool (tool_tag, best-effort even-split) — sums to the turn.
  tools: [
    { tool: "bash", cost: 18.0, tokens: 50_000, calls: 30 },
    { tool: "read", cost: 10.5, tokens: 30_000, calls: 20 },
  ],
  // COST-02 per-subagent corrected-$ subtree rollup.
  subagents: [
    { nodeId: "planner", cost: 12.0, subtreeCost: 28.5 },
    { nodeId: "worker", cost: 16.5, subtreeCost: 16.5 },
  ],
  // A body field the view must ignore (content-free).
  message: BODY_MARKER,
};

const MOCK_SESSION_BILLING = {
  sessions: [
    { sessionKey: "sess-1", totalTokens: 50_000, totalCost: 18.0, callCount: 120 },
    { sessionKey: "sess-2", totalTokens: 30_000, totalCost: 10.5, callCount: 80 },
  ],
};

/* ------------------------------------------------------------------ */
/*  Mock RPC client factory                                            */
/* ------------------------------------------------------------------ */

function createBillingMockRpcClient(): ReturnType<typeof createMockRpcClient> {
  return createMockRpcClient(async (method: string, params?: Record<string, unknown>) => {
    if (method === "obs.billing.total") {
      const sinceMs = (params as Record<string, unknown>)?.sinceMs;
      if (typeof sinceMs === "number" && sinceMs > 604_800_000) {
        return MOCK_BILLING_CUMULATIVE;
      }
      return MOCK_BILLING_TOTAL;
    }
    if (method === "obs.billing.byProvider") return MOCK_PROVIDERS;
    if (method === "agents.list") return MOCK_AGENTS;
    if (method === "obs.billing.byAgent") return MOCK_AGENT_BILLING;
    if (method === "obs.billing.bySession") return MOCK_SESSION_BILLING;
    return {};
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("IcBillingView", () => {
  let el: IcBillingView;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    if (el?.isConnected) el.remove();
    vi.useRealTimers();
  });

  it("renders loading state initially when no rpcClient", () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-billing-view");
    expect(el.rpcClient).toBeNull();
  });

  it("renders stat cards with billing total data", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const statCards = shadow.querySelectorAll("ic-stat-card");
    expect(statCards.length).toBe(3);

    // Verify labels
    const labels = Array.from(statCards).map((card) => card.getAttribute("label") ?? (card as unknown as Record<string, string>).label);
    expect(labels).toContain("Total Cost");
    expect(labels).toContain("Total Tokens");
    expect(labels).toContain("API Calls");
  });

  it("renders cost breakdown component", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const breakdown = shadow.querySelector("ic-cost-breakdown");
    expect(breakdown).not.toBeNull();
  });

  it("renders time range picker", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const picker = shadow.querySelector("ic-time-range-picker");
    expect(picker).not.toBeNull();
  });

  it("drill level state changes on segment click dispatch", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const breakdown = shadow.querySelector("ic-cost-breakdown");
    expect(breakdown).not.toBeNull();

    // Simulate segment-click event
    breakdown!.dispatchEvent(
      new CustomEvent("segment-click", {
        detail: { label: "Anthropic", value: 35.0 },
        bubbles: true,
        composed: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    // Should now show provider-level content (model breakdown)
    const sectionTitles = shadow.querySelectorAll(".section-title");
    const titleTexts = Array.from(sectionTitles).map((t) => t.textContent?.trim());
    expect(titleTexts).toContain("Model Breakdown");
  });

  it("breadcrumb renders correct path for nested drill level", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;

    // Drill into provider
    const breakdown = shadow.querySelector("ic-cost-breakdown");
    breakdown!.dispatchEvent(
      new CustomEvent("segment-click", {
        detail: { label: "Anthropic", value: 35.0 },
        bubbles: true,
        composed: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    // Breadcrumb should show "Billing / Anthropic"
    const breadcrumb = shadow.querySelector(".breadcrumb");
    expect(breadcrumb).not.toBeNull();
    const text = breadcrumb!.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(text).toContain("Billing");
    expect(text).toContain("Anthropic");
  });

  it("back button navigates to parent level", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;

    // Drill into provider
    const breakdown = shadow.querySelector("ic-cost-breakdown");
    breakdown!.dispatchEvent(
      new CustomEvent("segment-click", {
        detail: { label: "Anthropic", value: 35.0 },
        bubbles: true,
        composed: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    // Click breadcrumb "Billing" link to go back to total
    const breadcrumbLink = shadow.querySelector(".breadcrumb-link") as HTMLButtonElement;
    expect(breadcrumbLink).not.toBeNull();
    breadcrumbLink.click();

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    // Should be back at total level -- stat cards visible
    const statCards = shadow.querySelectorAll("ic-stat-card");
    expect(statCards.length).toBe(3);
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-billing-view");
    expect(ctor).toBeDefined();
  });

  it("comparison deltas show percentage change", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const statCards = shadow.querySelectorAll("ic-stat-card");

    // At least one stat card should have a trend set
    const trends = Array.from(statCards).map(
      (card) => (card as unknown as Record<string, string>).trend,
    );
    const hasTrend = trends.some((t) => t === "up" || t === "down");
    expect(hasTrend).toBe(true);
  });

  it("renders error state with retry button on load failure", async () => {
    const mockRpc = createMockRpcClient();
    (mockRpc.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("RPC error"));

    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const errorMsg = shadow.querySelector(".error-message");
    expect(errorMsg).not.toBeNull();
    expect(errorMsg?.textContent?.trim()).toBe("Failed to load billing data");

    const retryBtn = shadow.querySelector(".retry-btn");
    expect(retryBtn).not.toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /*  COST-01/02 granularity + export + DSL (Task 3)                   */
  /* ---------------------------------------------------------------- */

  /** Access private fields for direct drill/filter manipulation. */
  function priv(e: IcBillingView) {
    return e as unknown as {
      _drillLevel: string;
      _filterQuery: string;
      _loadData: () => Promise<void>;
      _exportBilling: (format: "csv" | "json") => void;
    };
  }

  async function drillToAgentLevel(e: IcBillingView): Promise<void> {
    priv(e)._drillLevel = "agent";
    await priv(e)._loadData();
    await e.updateComplete;
  }

  it("renders per-tool cost labeled (best-effort) at the agent level", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    await drillToAgentLevel(el);

    const shadow = el.shadowRoot!;
    const text = shadow.textContent ?? "";
    // per-tool section present + the best-effort label (N3)
    expect(text).toMatch(/per-tool/i);
    expect(text.toLowerCase()).toContain("best-effort");
    // the distinct tools render
    expect(text).toContain("bash");
    expect(text).toContain("read");
  });

  it("renders per-subagent corrected-$ cost at the agent level", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    await drillToAgentLevel(el);

    const shadow = el.shadowRoot!;
    const text = shadow.textContent ?? "";
    expect(text).toMatch(/per-subagent|subagent/i);
    expect(text).toContain("planner");
    expect(text).toContain("worker");
  });

  it("export builds a CSV blob with only the allowlisted columns", async () => {
    const createSpy = vi.fn(() => "blob:mock-url");
    const revokeSpy = vi.fn();
    let capturedBlobText = "";
    const OriginalBlob = globalThis.Blob;
    vi.stubGlobal("Blob", class MockBlob {
      constructor(parts: BlobPart[]) {
        capturedBlobText = parts.map((p) => String(p)).join("");
      }
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: createSpy, revokeObjectURL: revokeSpy });

    try {
      el = document.createElement("ic-billing-view") as IcBillingView;
      el.rpcClient = createBillingMockRpcClient();
      document.body.appendChild(el);
      await vi.advanceTimersByTimeAsync(50);
      await el.updateComplete;
      await drillToAgentLevel(el);

      priv(el)._exportBilling("csv");

      expect(createSpy).toHaveBeenCalledTimes(1);
      // header is the explicit allowlist
      expect(capturedBlobText).toContain("agentId,totalTokens,percentOfTotal,cost");
      // the planted body marker is ABSENT from the export
      expect(capturedBlobText).not.toContain(BODY_MARKER);
    } finally {
      vi.stubGlobal("Blob", OriginalBlob);
      vi.unstubAllGlobals();
    }
  });

  it("export builds a JSON blob honoring the active DSL filter", async () => {
    const createSpy = vi.fn(() => "blob:mock-url");
    let capturedBlobText = "";
    const OriginalBlob = globalThis.Blob;
    vi.stubGlobal("Blob", class MockBlob {
      constructor(parts: BlobPart[]) {
        capturedBlobText = parts.map((p) => String(p)).join("");
      }
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: createSpy, revokeObjectURL: vi.fn() });

    try {
      el = document.createElement("ic-billing-view") as IcBillingView;
      el.rpcClient = createBillingMockRpcClient();
      document.body.appendChild(el);
      await vi.advanceTimersByTimeAsync(50);
      await el.updateComplete;
      await drillToAgentLevel(el);

      // filter to a single agent then export JSON
      priv(el)._filterQuery = "agent:default";
      await el.updateComplete;
      priv(el)._exportBilling("json");

      const parsed = JSON.parse(capturedBlobText) as Array<Record<string, string>>;
      expect(parsed.every((row) => row.agentId === "default")).toBe(true);
      expect(parsed.length).toBe(1);
    } finally {
      vi.stubGlobal("Blob", OriginalBlob);
      vi.unstubAllGlobals();
    }
  });

  it("DSL filter narrows the rendered agent rows; unknown key surfaces a hint, no throw", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;
    await drillToAgentLevel(el);

    const shadow = el.shadowRoot!;
    // both agents render before filtering
    let rows = shadow.querySelectorAll(".agent-table .grid-row");
    expect(rows.length).toBe(2);

    // a valid filter narrows to one row
    priv(el)._filterQuery = "agent:researcher";
    await el.updateComplete;
    rows = shadow.querySelectorAll(".agent-table .grid-row");
    expect(rows.length).toBe(1);

    // an unknown-key filter does NOT throw and surfaces a hint
    priv(el)._filterQuery = "bogus:x";
    await el.updateComplete;
    const text = shadow.textContent ?? "";
    expect(text.toLowerCase()).toContain("unknown");
    // unknown-only filter => empty filter => all rows still shown
    rows = shadow.querySelectorAll(".agent-table .grid-row");
    expect(rows.length).toBe(2);
  });

  it("content-free: the planted body marker is absent from the rendered DOM", async () => {
    el = document.createElement("ic-billing-view") as IcBillingView;
    el.rpcClient = createBillingMockRpcClient();
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;
    await drillToAgentLevel(el);

    const shadow = el.shadowRoot!;
    expect(shadow.textContent ?? "").not.toContain(BODY_MARKER);
  });
});
