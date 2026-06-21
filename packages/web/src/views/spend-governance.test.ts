// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { IcSpendGovernanceView } from "./spend-governance.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect import to register the custom element under test.
import "./spend-governance.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Fixtures — content-free obs.spend.snapshot shapes (179-04)         */
/* ------------------------------------------------------------------ */

/** A planted body marker — must NEVER reach the rendered DOM (content-free). */
const PLANTED_MARKER = "SECRET_TENANT_NAME_DO_NOT_RENDER";

/** A LIVE snapshot with ceilings set on every scope + a pricing-coverage count. */
function fixtureSnapshotGoverned(): Record<string, unknown> {
  return {
    enabled: true,
    global: 3,
    globalCapUsd: 10,
    globalHeadroomUsd: 7,
    perAgent: [
      // A planted body field rides alongside — the view surfaces only scope/$ numbers.
      { scope: "t1 a1", spentUsd: 3, capUsd: 10, headroomUsd: 7, body: PLANTED_MARKER },
      { scope: "t1 a2", spentUsd: 8, capUsd: 10, headroomUsd: 2 },
    ],
    perTenant: [{ scope: "t1", spentUsd: 11, capUsd: 20, headroomUsd: 9 }],
    pricingCoverage: { priced: 120, free: 30, unknown: 5 },
  };
}

/** A snapshot with governance OFF — every ceiling null (the honest-degradation case). */
function fixtureSnapshotUngoverned(): Record<string, unknown> {
  return {
    enabled: true,
    global: 3,
    globalCapUsd: null,
    globalHeadroomUsd: null,
    perAgent: [{ scope: "t1 a1", spentUsd: 3, capUsd: null, headroomUsd: null }],
    perTenant: [],
    pricingCoverage: { priced: 10, free: 2, unknown: 0 },
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface SpendMockResult {
  rpc: RpcClient;
  call: ReturnType<typeof vi.fn>;
}

function createSpendMock(
  snapshot: (params?: Record<string, unknown>) => unknown,
): SpendMockResult {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "obs.spend.snapshot") return snapshot(params);
    return {};
  });
  const rpc = createMockRpcClient(call as unknown as (...args: unknown[]) => unknown);
  return { rpc, call };
}

async function createElement(rpc: RpcClient | null): Promise<IcSpendGovernanceView> {
  const el = document.createElement("ic-spend-governance-view") as IcSpendGovernanceView;
  el.rpcClient = rpc;
  document.body.appendChild(el);
  await vi.advanceTimersByTimeAsync(50);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

function priv(el: IcSpendGovernanceView) {
  return el as unknown as {
    _loadState: string;
    _snapshot: Record<string, unknown> | null;
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

describe("IcSpendGovernanceView", () => {
  it("calls obs.spend.snapshot and renders headroom gauges + a pricing-coverage stat", async () => {
    const { rpc, call } = createSpendMock(() => ({ snapshot: fixtureSnapshotGoverned() }));
    const el = await createElement(rpc);

    expect(call).toHaveBeenCalledWith("obs.spend.snapshot", expect.any(Object));
    expect(priv(el)._loadState).toBe("loaded");

    // Headroom gauges (per agent/tenant/global) render as stat-cards.
    const cards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect((cards?.length ?? 0)).toBeGreaterThan(0);

    // The global headroom is surfaced (ceiling 10 − spent 3 = 7).
    const text = el.shadowRoot?.textContent ?? "";
    expect(text).toContain("Global");

    // Pricing-coverage (priced/free/unknown) is shown.
    expect(text.toLowerCase()).toContain("pricing");
  });

  it("renders the LIVE per-scope figures from the snapshot (agrees with the kill-switch)", async () => {
    const { rpc } = createSpendMock(() => ({ snapshot: fixtureSnapshotGoverned() }));
    const el = await createElement(rpc);

    // The per-(tenant,agent) rows ride a data-table — the LIVE accumulator values.
    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
    const rows = (table as unknown as { rows: unknown[] }).rows;
    // 2 perAgent + 1 perTenant = 3 governed scope rows.
    expect(rows.length).toBe(3);
  });

  it("honest-degradation: an { enabled: false } snapshot renders 'spend governance not configured', NOT a $0 success", async () => {
    const { rpc } = createSpendMock(() => ({ snapshot: { enabled: false } }));
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("loaded");
    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    expect((empty as unknown as { message: string }).message.toLowerCase()).toContain("spend governance not configured");
    // NOT a misleading $0 gauge.
    expect(el.shadowRoot?.querySelector("ic-stat-card")).toBeFalsy();
  });

  it("honest-degradation: null ceilings (governance off) also render 'spend governance not configured', NOT a $0 success", async () => {
    const { rpc } = createSpendMock(() => ({ snapshot: fixtureSnapshotUngoverned() }));
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("loaded");
    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    expect((empty as unknown as { message: string }).message.toLowerCase()).toContain("spend governance not configured");
    expect(el.shadowRoot?.querySelector("ic-stat-card")).toBeFalsy();
  });

  it("admin-denial: an 'Admin access required' rejection surfaces the error path (not a silent render)", async () => {
    const { rpc } = createSpendMock(() => {
      throw new Error("Admin access required");
    });
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("error");
    expect(el.shadowRoot?.querySelector(".error-container")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".retry-btn")).toBeTruthy();
  });

  it("content-free: a planted body marker in a scope row is absent from the rendered DOM", async () => {
    const { rpc } = createSpendMock(() => ({ snapshot: fixtureSnapshotGoverned() }));
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
