import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcDeliveryView } from "./delivery-view.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register custom element
import "./delivery-view.js";
import { createMockRpcClient as _createSharedMock } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_STATS = {
  totalDelivered: 150,
  successRate: 92,
  avgLatencyMs: 245,
  failed: 12,
};

const MOCK_TRACES = [
  {
    traceId: "trace-001",
    timestamp: Date.now() - 60_000,
    channelType: "telegram",
    messagePreview: "Hello from telegram channel",
    status: "success",
    latencyMs: 120,
    stepCount: 3,
    steps: [
      { name: "receive", durationMs: 10, status: "ok", timestamp: Date.now() - 60_000 },
      { name: "route", durationMs: 30, status: "ok", timestamp: Date.now() - 59_990 },
      { name: "execute", durationMs: 80, status: "ok", timestamp: Date.now() - 59_960 },
    ],
  },
  {
    traceId: "trace-002",
    timestamp: Date.now() - 120_000,
    channelType: "discord",
    messagePreview: "Discord test message",
    status: "failed",
    latencyMs: 350,
    stepCount: 2,
    steps: [
      { name: "receive", durationMs: 15, status: "ok", timestamp: Date.now() - 120_000 },
      { name: "execute", durationMs: 335, status: "error", timestamp: Date.now() - 119_985, error: "Timeout" },
    ],
  },
  {
    traceId: "trace-003",
    timestamp: Date.now() - 180_000,
    channelType: "telegram",
    messagePreview: "Another telegram message",
    status: "success",
    latencyMs: 95,
    stepCount: 3,
    steps: [],
  },
];

/* ------------------------------------------------------------------ */
/*  Mock RPC client factory                                            */
/* ------------------------------------------------------------------ */

/** Delivery-view-specific mock that routes RPC methods to test data. */
function createMockRpcClient(): RpcClient {
  return _createSharedMock(async (method: string) => {
    if (method === "obs.delivery.stats") return MOCK_STATS;
    if (method === "obs.delivery.recent") return MOCK_TRACES;
    return {};
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe("IcDeliveryView", () => {
  let el: IcDeliveryView;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    if (el?.isConnected) el.remove();
    vi.useRealTimers();
  });

  it("renders loading state initially when no rpcClient", () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-delivery-view");
    expect(el.rpcClient).toBeNull();
  });

  it("renders stat cards with success rate and latency stats", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const statCards = shadow.querySelectorAll("ic-stat-card");
    expect(statCards.length).toBe(5);

    const labels = Array.from(statCards).map(
      (card) => (card as unknown as Record<string, string>).label,
    );
    expect(labels).toContain("Success Rate");
    expect(labels).toContain("P50 Latency");
    expect(labels).toContain("P95 Latency");
    expect(labels).toContain("P99 Latency");
    expect(labels).toContain("Total Deliveries");
  });

  it("renders trace table with delivery rows", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const rows = shadow.querySelectorAll("ic-delivery-row");
    expect(rows.length).toBe(3);
  });

  it("search input filters traces by message preview", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const searchInput = shadow.querySelector(".filter-input") as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    // Simulate typing "discord"
    searchInput.value = "discord";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    const rows = shadow.querySelectorAll("ic-delivery-row");
    expect(rows.length).toBe(1);
  });

  it("status filter limits to matching status", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const selects = shadow.querySelectorAll(".filter-select");
    const statusSelect = selects[0] as HTMLSelectElement;
    expect(statusSelect).not.toBeNull();

    // Select "failed"
    statusSelect.value = "failed";
    statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    const rows = shadow.querySelectorAll("ic-delivery-row");
    expect(rows.length).toBe(1);
  });

  it("detail drawer opens on trace selection", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const row = shadow.querySelector("ic-delivery-row") as HTMLElement;
    expect(row).not.toBeNull();

    // Simulate trace-click event
    row.dispatchEvent(
      new CustomEvent("trace-click", {
        detail: "trace-001",
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;

    const panel = shadow.querySelector("ic-detail-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    expect((panel as unknown as Record<string, unknown>).open).toBe(true);
  });

  it("time range picker is present", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const picker = shadow.querySelector("ic-time-range-picker");
    expect(picker).not.toBeNull();
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-delivery-view");
    expect(ctor).toBeDefined();
  });

  it("renders error state with retry button on load failure", async () => {
    const mockRpc = createMockRpcClient();
    (mockRpc.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("RPC error"));

    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = mockRpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const errorMsg = shadow.querySelector(".error-message");
    expect(errorMsg).not.toBeNull();
    expect(errorMsg?.textContent?.trim()).toBe("Failed to load delivery data");

    const retryBtn = shadow.querySelector(".retry-btn");
    expect(retryBtn).not.toBeNull();
  });

  it("shows filter count text", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const shadow = el.shadowRoot!;
    const count = shadow.querySelector(".filter-count");
    expect(count).not.toBeNull();
    expect(count?.textContent).toContain("3 of 3");
  });
});
