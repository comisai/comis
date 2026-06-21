// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { IcCacheHealthView } from "./cache-health.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register the custom element under test.
import "./cache-health.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Fixtures — content-free obs.cacheBreaks.byReason rows              */
/* ------------------------------------------------------------------ */

/** A planted body marker — must NEVER reach the rendered DOM (content-free). */
const PLANTED_MARKER = "SECRET_PROMPT_BODY_DO_NOT_RENDER";

/** {reason,count,estCostUsd} — the exact obs.cacheBreaks.byReason row projection. */
function fixtureRows(): Array<Record<string, unknown>> {
  return [
    // A planted body field rides alongside — the view must surface only reason/count/$.
    { reason: "tools_changed", count: 7, estCostUsd: 0.042, body: PLANTED_MARKER },
    { reason: "system_prompt_changed", count: 3, estCostUsd: 0.018 },
    { reason: "ttl_expired", count: 12, estCostUsd: 0.006 },
  ];
}

/** A representative obs.cacheStats.window response (hit/write ratio source). */
function fixtureCacheStats(): Record<string, unknown> {
  return { hits: 80, writes: 20, misses: 5 };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface CacheMockResult {
  rpc: RpcClient;
  call: ReturnType<typeof vi.fn>;
}

/** A mock rpcClient routing the two cache RPCs to supplied responses. */
function createCacheMock(
  breaks: (params?: Record<string, unknown>) => unknown,
  stats: (params?: Record<string, unknown>) => unknown = () => fixtureCacheStats(),
): CacheMockResult {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "obs.cacheBreaks.byReason") return breaks(params);
    if (method === "obs.cacheStats.window") return stats(params);
    return {};
  });
  const rpc = createMockRpcClient(call as unknown as (...args: unknown[]) => unknown);
  return { rpc, call };
}

async function createElement(rpc: RpcClient | null): Promise<IcCacheHealthView> {
  const el = document.createElement("ic-cache-health-view") as IcCacheHealthView;
  el.rpcClient = rpc;
  document.body.appendChild(el);
  await vi.advanceTimersByTimeAsync(50);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

function priv(el: IcCacheHealthView) {
  return el as unknown as {
    _loadState: string;
    _rows: Array<{ reason: string; count: number; estCostUsd: number }>;
    _loadData(): Promise<void>;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcCacheHealthView", () => {
  it("calls obs.cacheBreaks.byReason and renders a stat-card grid + a break-rate-by-reason table", async () => {
    const { rpc, call } = createCacheMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    expect(call).toHaveBeenCalledWith("obs.cacheBreaks.byReason", expect.any(Object));
    expect(priv(el)._loadState).toBe("loaded");
    expect(priv(el)._rows.length).toBe(3);

    // Stat-card grid (total breaks, $ lost, hit/write ratio).
    const cards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect((cards?.length ?? 0)).toBeGreaterThan(0);

    // The break-rate-by-reason table.
    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
    expect((table as unknown as { rows: unknown[] }).rows.length).toBe(3);
  });

  it("renders the $-lost total summed across the reasons", async () => {
    const { rpc } = createCacheMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    // 0.042 + 0.018 + 0.006 = 0.066 -> a stat-card carries the formatted total.
    const cards = Array.from(el.shadowRoot?.querySelectorAll("ic-stat-card") ?? []);
    const lostCard = cards.find(
      (c) => (c.getAttribute("label") ?? (c as unknown as { label: string }).label ?? "")
        .toLowerCase()
        .includes("lost"),
    );
    expect(lostCard).toBeTruthy();
    const value = lostCard!.getAttribute("value") ?? (lostCard as unknown as { value: string }).value;
    expect(value).toContain("0.066");
  });

  it("honest-degradation: an empty { rows: [] } renders 'cache health not configured', NOT a blank success", async () => {
    const { rpc } = createCacheMock(() => ({ rows: [] }));
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("loaded");
    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    expect((empty as unknown as { message: string }).message.toLowerCase()).toContain("cache health not configured");
    expect(el.shadowRoot?.querySelector("ic-data-table")).toBeFalsy();
  });

  it("admin-denial: an 'Admin access required' rejection surfaces the error path (not a silent render)", async () => {
    const { rpc } = createCacheMock(() => {
      throw new Error("Admin access required");
    });
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("error");
    expect(el.shadowRoot?.querySelector(".error-container")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".retry-btn")).toBeTruthy();
  });

  it("content-free: a planted body marker in a fixture row is absent from the rendered DOM", async () => {
    const { rpc } = createCacheMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    const text = el.shadowRoot?.textContent ?? "";
    expect(text).not.toContain(PLANTED_MARKER);
    const table = el.shadowRoot?.querySelector("ic-data-table");
    const tableText = table?.shadowRoot?.textContent ?? "";
    expect(tableText).not.toContain(PLANTED_MARKER);
  });

  it("loading state: a null rpcClient settles without throwing (no error state)", async () => {
    const el = await createElement(null);
    expect(priv(el)._loadState).not.toBe("error");
  });
});
