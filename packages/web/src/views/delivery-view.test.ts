// SPDX-License-Identifier: Apache-2.0
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
  total: 150,
  attempted: 146,
  success: 134,
  error: 10,
  timeout: 2,
  filtered: 3,
  aborted: 1,
  avgLatencyMs: 245,
};

const MOCK_TRACES = [
  {
    sourceChannelId: "telegram:user_a",
    sourceChannelType: "telegram",
    targetChannelType: "telegram",
    targetChannelId: "telegram:user_a",
    deliveredAt: Date.now() - 60_000,
    traceId: "trace-001",
    status: "success",
    latencyMs: 120,
    steps: [
      { name: "receive", durationMs: 10, status: "ok", timestamp: Date.now() - 60_000 },
      { name: "route", durationMs: 30, status: "ok", timestamp: Date.now() - 59_990 },
      { name: "execute", durationMs: 80, status: "ok", timestamp: Date.now() - 59_960 },
    ],
  },
  {
    sourceChannelId: "discord:user_a",
    sourceChannelType: "discord",
    targetChannelType: "discord",
    targetChannelId: "discord:user_a",
    deliveredAt: Date.now() - 120_000,
    traceId: "trace-002",
    status: "error",
    latencyMs: 350,
    error: "delivery_failed",
    failureStage: "delivery",
    errorKind: "platform",
    steps: [
      { name: "receive", durationMs: 15, status: "ok", timestamp: Date.now() - 120_000 },
      { name: "execute", durationMs: 335, status: "error", timestamp: Date.now() - 119_985, error: "Timeout" },
    ],
  },
  {
    sourceChannelId: "telegram:user_b",
    sourceChannelType: "telegram",
    targetChannelType: "telegram",
    targetChannelId: "telegram:user_b",
    deliveredAt: Date.now() - 180_000,
    traceId: "trace-003",
    status: "success",
    latencyMs: 95,
    steps: [],
  },
];

/* ------------------------------------------------------------------ */
/*  Mock RPC client factory                                            */
/* ------------------------------------------------------------------ */

/** Delivery-view-specific mock that routes RPC methods to test data. */
function createMockRpcClient(): RpcClient {
  return _createSharedMock(async (...args: unknown[]) => {
    const method = args[0];
    if (method === "obs.delivery.stats") return MOCK_STATS;
    if (method === "obs.delivery.recent") return { deliveries: MOCK_TRACES };
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
    const rpc = createMockRpcClient();
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
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

    const values = Array.from(statCards).map(
      (card) => (card as unknown as Record<string, string>).value,
    );
    expect(values).toContain("92%");
    expect(values).toContain("150");
    expect(rpc.call).toHaveBeenCalledWith("obs.delivery.stats", { sinceMs: 604_800_000 });
  });

  it("renders an unavailable success rate when no delivery was attempted", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") {
        return {
          total: 1,
          attempted: 0,
          success: 0,
          error: 0,
          timeout: 0,
          filtered: 1,
          aborted: 0,
          avgLatencyMs: 0,
        };
      }
      if (method === "obs.delivery.recent") return { deliveries: [] };
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const successCard = Array.from(el.shadowRoot!.querySelectorAll("ic-stat-card"))
      .find((card) => (card as unknown as { label: string }).label === "Success Rate");
    expect((successCard as unknown as { value: string }).value).toBe("N/A");
  });

  it("excludes filtered and aborted outcomes from attempted latency percentiles", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") return MOCK_STATS;
      if (method === "obs.delivery.recent") {
        return {
          deliveries: [
            { ...MOCK_TRACES[0]!, traceId: "success", status: "success", latencyMs: 10 },
            { ...MOCK_TRACES[0]!, traceId: "error", status: "error", latencyMs: 20 },
            { ...MOCK_TRACES[0]!, traceId: "timeout", status: "timeout", latencyMs: 30 },
            { ...MOCK_TRACES[0]!, traceId: "filtered", status: "filtered", latencyMs: 9_999 },
            { ...MOCK_TRACES[0]!, traceId: "aborted", status: "aborted", latencyMs: 8_888 },
          ],
        };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const latencyCards = new Map(
      Array.from(el.shadowRoot!.querySelectorAll("ic-stat-card")).map((card) => {
        const stat = card as unknown as { label: string; value: string };
        return [stat.label, stat.value];
      }),
    );
    expect(latencyCards.get("P50 Latency")).toBe("~20ms");
    expect(latencyCards.get("P95 Latency")).toBe("~30ms");
    expect(latencyCards.get("P99 Latency")).toBe("~30ms");
  });

  it("marks latency percentiles approximate when recent traces are truncated", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") {
        return { ...MOCK_STATS, total: 1_000, attempted: 1_000 };
      }
      if (method === "obs.delivery.recent") {
        return {
          deliveries: Array.from({ length: 20 }, (_, index) => ({
            ...MOCK_TRACES[0]!,
            traceId: `trace-${index}`,
            latencyMs: index + 1,
          })),
        };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const p95 = Array.from(el.shadowRoot!.querySelectorAll("ic-stat-card"))
      .find((card) => (card as unknown as { label: string }).label === "P95 Latency");
    expect((p95 as unknown as { value: string }).value).toMatch(/^~/);
  });

  it("computes latency percentiles with the nearest-rank definition", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") {
        return { ...MOCK_STATS, total: 20, attempted: 20 };
      }
      if (method === "obs.delivery.recent") {
        return {
          deliveries: Array.from({ length: 20 }, (_, index) => ({
            ...MOCK_TRACES[0]!,
            traceId: `trace-${index}`,
            latencyMs: index + 1,
          })),
        };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const cards = new Map(
      Array.from(el.shadowRoot!.querySelectorAll("ic-stat-card")).map((card) => {
        const stat = card as unknown as { label: string; value: string };
        return [stat.label, stat.value];
      }),
    );
    expect(cards.get("P50 Latency")).toBe("10ms");
    expect(cards.get("P95 Latency")).toBe("19ms");
    expect(cards.get("P99 Latency")).toBe("20ms");
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

  it("preserves the source platform while rendering the delivery destination", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") return MOCK_STATS;
      if (method === "obs.delivery.recent") {
        return {
          deliveries: [{
            ...MOCK_TRACES[0]!,
            targetChannelType: "slack",
            targetChannelId: "workspace_a",
          }],
        };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const row = el.shadowRoot!.querySelector("ic-delivery-row") as unknown as {
      trace: { sourceChannelType: string; targetChannelType: string };
      shadowRoot: ShadowRoot;
    };
    expect(row.trace).toMatchObject({ sourceChannelType: "telegram", targetChannelType: "slack" });
    expect(row.shadowRoot.querySelector("ic-tag")?.textContent?.trim()).toBe("slack");
  });

  it("filters delivery rows by destination platform rather than source platform", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") return MOCK_STATS;
      if (method === "obs.delivery.recent") {
        return {
          deliveries: [
            { ...MOCK_TRACES[0]!, targetChannelType: "slack", targetChannelId: "workspace_a" },
            { ...MOCK_TRACES[2]!, targetChannelType: "discord", targetChannelId: "guild_a" },
          ],
        };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const destinationSelect = el.shadowRoot!.querySelectorAll(".filter-select")[1] as HTMLSelectElement;
    destinationSelect.value = "slack";
    destinationSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot!.querySelectorAll("ic-delivery-row");
    expect(rows).toHaveLength(1);
    expect((rows[0] as unknown as { trace: { targetChannelType: string } }).trace.targetChannelType).toBe("slack");
  });

  it("search input filters traces by channel type", async () => {
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

    // Select "error"
    statusSelect.value = "error";
    statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    const rows = shadow.querySelectorAll("ic-delivery-row");
    expect(rows.length).toBe(1);
  });

  it("maps an invalid RPC delivery status to error", async () => {
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") return MOCK_STATS;
      if (method === "obs.delivery.recent") {
        return { deliveries: [{ ...MOCK_TRACES[0]!, status: "unexpected" }] };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const row = el.shadowRoot!.querySelector("ic-delivery-row") as unknown as {
      trace: { status: string };
    };
    expect(row.trace.status).toBe("error");
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

  it("detail drawer preserves the delivery failure stage and error kind", async () => {
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = createMockRpcClient();
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const errorRow = Array.from(el.shadowRoot!.querySelectorAll("ic-delivery-row"))
      .find((row) => (row as unknown as { trace: { traceId: string } }).trace.traceId === "trace-002");
    errorRow!.dispatchEvent(
      new CustomEvent("trace-click", {
        detail: "trace-002",
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;

    const detailText = el.shadowRoot!.querySelector("ic-detail-panel")?.textContent ?? "";
    expect(detailText).toContain("Failure Stage");
    expect(detailText).toContain("delivery");
    expect(detailText).toContain("Error Kind");
    expect(detailText).toContain("platform");
    expect(detailText).toContain("delivery_failed");
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

  it("reloads both traces and aggregate stats for a changed time range", async () => {
    const rpc = createMockRpcClient();
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;
    (rpc.call as ReturnType<typeof vi.fn>).mockClear();

    el.shadowRoot!.querySelector("ic-time-range-picker")!.dispatchEvent(
      new CustomEvent("time-range-change", {
        detail: { sinceMs: 86_400_000, label: "Today" },
        bubbles: true,
        composed: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith("obs.delivery.stats", { sinceMs: 86_400_000 });
    expect(rpc.call).toHaveBeenCalledWith("obs.delivery.recent", {
      sinceMs: 86_400_000,
      limit: 200,
    });
  });

  it("does not retain aggregate stats from a previous time window after a partial reload", async () => {
    let rejectStats = false;
    const rpc = _createSharedMock(async (...args: unknown[]) => {
      const method = args[0];
      if (method === "obs.delivery.stats") {
        if (rejectStats) throw new Error("stats unavailable");
        return MOCK_STATS;
      }
      if (method === "obs.delivery.recent") {
        return { deliveries: rejectStats ? [MOCK_TRACES[0]!] : MOCK_TRACES };
      }
      return {};
    });
    el = document.createElement("ic-delivery-view") as IcDeliveryView;
    el.rpcClient = rpc;
    document.body.appendChild(el);

    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;
    rejectStats = true;

    el.shadowRoot!.querySelector("ic-time-range-picker")!.dispatchEvent(
      new CustomEvent("time-range-change", {
        detail: { sinceMs: 86_400_000, label: "Today" },
        bubbles: true,
        composed: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;

    const totalCard = Array.from(el.shadowRoot!.querySelectorAll("ic-stat-card"))
      .find((card) => (card as unknown as { label: string }).label === "Total Deliveries");
    expect((totalCard as unknown as { value: string }).value).toBe("1");
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
