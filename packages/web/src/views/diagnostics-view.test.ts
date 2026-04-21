// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcDiagnosticsView } from "./diagnostics-view.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./diagnostics-view.js";
import { createMockRpcClient as _createSharedMock } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_EVENTS = {
  events: [
    {
      id: "evt-1",
      timestamp: Date.now() - 60_000,
      category: "usage",
      eventType: "observability:token_usage",
      agentId: "default",
      data: { model: "claude-sonnet-4-20250514", tokens: { total: 1200 }, cost: { total: 0.005 } },
    },
    {
      id: "evt-2",
      timestamp: Date.now() - 120_000,
      category: "webhook",
      eventType: "retry:exhausted",
      data: { channelId: "test-channel" },
    },
    {
      id: "evt-3",
      timestamp: Date.now() - 180_000,
      category: "message",
      eventType: "retry:attempted",
      data: { channelId: "test-channel" },
    },
    {
      id: "evt-4",
      timestamp: Date.now() - 240_000,
      category: "usage",
      eventType: "observability:token_usage",
      agentId: "researcher",
      data: { model: "claude-sonnet-4-20250514", tokens: { total: 5000 }, cost: { total: 0.02 } },
    },
    {
      id: "evt-5",
      timestamp: Date.now() - 300_000,
      category: "session",
      eventType: "session:expired",
      data: {},
    },
  ],
  counts: {
    usage: 2,
    webhook: 1,
    message: 1,
    session: 1,
  },
};

/* ------------------------------------------------------------------ */
/*  Mock RPC client factory                                            */
/* ------------------------------------------------------------------ */

/** Diagnostics-view-specific mock that routes RPC methods to test data. */
function createMockRpcClient(): RpcClient {
  return _createSharedMock(async (method: string) => {
    if (method === "obs.diagnostics") return MOCK_EVENTS;
    return {};
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("IcDiagnosticsView", () => {
  let el: IcDiagnosticsView;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    if (el?.isConnected) el.remove();
    vi.useRealTimers();
  });

  it("renders loading state initially when no rpcClient", () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-diagnostics-view");
    expect(el.rpcClient).toBeNull();
  });

  it("renders event table with diagnostic events", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const rows = shadow.querySelectorAll(".event-row");
    expect(rows.length).toBe(5);
  });

  it("category filter chips render with correct options", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const filterChips = shadow.querySelectorAll("ic-filter-chips");
    expect(filterChips.length).toBe(2);

    // First filter chips = category
    const categoryChips = filterChips[0] as unknown as { options: Array<{ value: string }> };
    const categoryValues = categoryChips.options.map((o) => o.value);
    expect(categoryValues).toContain("usage");
    expect(categoryValues).toContain("webhook");
    expect(categoryValues).toContain("message");
    expect(categoryValues).toContain("session");
  });

  it("severity filter chips render with correct options", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const filterChips = shadow.querySelectorAll("ic-filter-chips");
    expect(filterChips.length).toBe(2);

    // Second filter chips = severity
    const severityChips = filterChips[1] as unknown as { options: Array<{ value: string }> };
    const severityValues = severityChips.options.map((o) => o.value);
    expect(severityValues).toContain("info");
    expect(severityValues).toContain("warn");
    expect(severityValues).toContain("error");
  });

  it("filtering by category reduces shown events", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;

    // Initially 5 rows
    let rows = shadow.querySelectorAll(".event-row");
    expect(rows.length).toBe(5);

    // Simulate category filter change to only "usage"
    const categoryChips = shadow.querySelectorAll("ic-filter-chips")[0]!;
    categoryChips.dispatchEvent(
      new CustomEvent("filter-change", {
        detail: { selected: new Set(["usage"]) },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;

    rows = shadow.querySelectorAll(".event-row");
    expect(rows.length).toBe(2);
  });

  it("export button is present", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const exportBtn = shadow.querySelector(".export-btn");
    expect(exportBtn).not.toBeNull();
    expect(exportBtn?.textContent?.trim()).toContain("Export JSONL");
  });

  it("export button disabled when no events", async () => {
    const emptyRpc = createMockRpcClient();
    (emptyRpc.call as ReturnType<typeof vi.fn>).mockResolvedValue({ events: [], counts: {} });

    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = emptyRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const exportBtn = shadow.querySelector(".export-btn") as HTMLButtonElement;
    expect(exportBtn).not.toBeNull();
    expect(exportBtn.disabled).toBe(true);
  });

  it("time range picker is present", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const picker = shadow.querySelector("ic-time-range-picker");
    expect(picker).not.toBeNull();
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-diagnostics-view");
    expect(ctor).toBeDefined();
  });

  it("renders error state with retry button on load failure", async () => {
    const mockRpc = createMockRpcClient();
    (mockRpc.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("RPC error"));

    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const errorMsg = shadow.querySelector(".error-message");
    expect(errorMsg).not.toBeNull();
    expect(errorMsg?.textContent?.trim()).toBe("Failed to load diagnostics data");

    const retryBtn = shadow.querySelector(".retry-btn");
    expect(retryBtn).not.toBeNull();
  });

  it("summary bar shows event count", async () => {
    el = document.createElement("ic-diagnostics-view") as IcDiagnosticsView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const summaryBar = shadow.querySelector(".summary-bar");
    expect(summaryBar).not.toBeNull();
    expect(summaryBar?.textContent).toContain("5 of 5");
  });
});
