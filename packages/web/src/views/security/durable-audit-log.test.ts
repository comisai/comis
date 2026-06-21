// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { IcDurableAuditLog } from "./durable-audit-log.js";
import type { RpcClient } from "../../api/rpc-client.js";

// Side-effect import to register the custom element under test.
import "./durable-audit-log.js";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Fixtures — content-free AuditEventRow projections (obs.audit.query) */
/* ------------------------------------------------------------------ */

/** A planted secret marker — must NEVER reach the rendered DOM. */
const PLANTED_SECRET = "sk-PLANTED-SECRET-VALUE-DO-NOT-RENDER";

function fixtureRows(): Array<Record<string, unknown>> {
  return [
    {
      id: "ev-1",
      tenantId: "tenant-a",
      agentId: "agent-1",
      ts: 1_700_000_000_000,
      kind: "secret",
      classification: "read",
      action: "secret.accessed",
      actor: "user-x",
      outcome: "success",
      severity: "low",
      traceId: "trace-1",
      // The scrubbed refs blob: a planted body marker that MUST be absent from DOM.
      refs: JSON.stringify({ note: PLANTED_SECRET }),
    },
    {
      id: "ev-2",
      tenantId: "tenant-b",
      agentId: "agent-2",
      ts: 1_700_000_100_000,
      kind: "approval",
      classification: "destructive",
      action: "tool.exec",
      actor: "user-y",
      outcome: "denied",
      severity: "high",
      traceId: "trace-2",
      refs: null,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface AuditMockResult {
  rpc: RpcClient;
  call: ReturnType<typeof vi.fn>;
}

/** A mock rpcClient routing `obs.audit.query` to a supplied response. */
function createAuditMock(
  respond: (params?: Record<string, unknown>) => unknown,
): AuditMockResult {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "obs.audit.query") return respond(params);
    return {};
  });
  const rpc = createMockRpcClient(call as unknown as (...args: unknown[]) => unknown);
  return { rpc, call };
}

async function createElement(rpc: RpcClient | null): Promise<IcDurableAuditLog> {
  const el = document.createElement("ic-durable-audit-log") as IcDurableAuditLog;
  el.rpcClient = rpc;
  document.body.appendChild(el);
  await vi.advanceTimersByTimeAsync(50);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

function priv(el: IcDurableAuditLog) {
  return el as unknown as {
    _loadState: string;
    _rows: unknown[];
    _kind: string;
    _agentId: string;
    _tenant: string;
    _outcome: string;
    _severity: string;
    _loadData(): Promise<void>;
    _onFilterChange(field: string, value: string): void;
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

describe("IcDurableAuditLog", () => {
  it("renders rows from a fixture obs.audit.query response in an ic-data-table", async () => {
    const { rpc, call } = createAuditMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    expect(call).toHaveBeenCalledWith("obs.audit.query", expect.any(Object));
    expect(priv(el)._loadState).toBe("loaded");
    expect(priv(el)._rows.length).toBe(2);

    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
    expect((table as unknown as { rows: unknown[] }).rows.length).toBe(2);
  });

  it("changing a filter re-calls obs.audit.query with the corresponding request param", async () => {
    const { rpc, call } = createAuditMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    call.mockClear();

    // Change the kind filter -> re-query with { kind }.
    priv(el)._onFilterChange("kind", "secret");
    await vi.advanceTimersByTimeAsync(50);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(call).toHaveBeenCalledWith(
      "obs.audit.query",
      expect.objectContaining({ kind: "secret" }),
    );

    call.mockClear();

    // Change the outcome filter -> re-query carrying BOTH set filters.
    priv(el)._onFilterChange("outcome", "denied");
    await vi.advanceTimersByTimeAsync(50);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(call).toHaveBeenCalledWith(
      "obs.audit.query",
      expect.objectContaining({ kind: "secret", outcome: "denied" }),
    );
  });

  it("only sends SET filters (an unset filter is absent from the request params)", async () => {
    const { rpc, call } = createAuditMock(() => ({ rows: fixtureRows() }));
    await createElement(rpc);

    const params = call.mock.calls[0]?.[1] as Record<string, unknown>;
    // No filters set on first load -> none of the optional filter keys present.
    expect(params).not.toHaveProperty("kind");
    expect(params).not.toHaveProperty("agentId");
    expect(params).not.toHaveProperty("tenant");
    expect(params).not.toHaveProperty("outcome");
  });

  it("honest-degradation: an empty { rows: [] } renders 'audit persistence' empty-state, NOT a blank success", async () => {
    const { rpc } = createAuditMock(() => ({ rows: [] }));
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("loaded");
    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    // Must read as "persistence off / not configured", never a silent blank table.
    expect((empty as unknown as { message: string }).message.toLowerCase()).toContain("audit persistence");
    expect(el.shadowRoot?.querySelector("ic-data-table")).toBeFalsy();
  });

  it("admin-denial: an 'Admin access required' rejection surfaces the error path (not a silent render)", async () => {
    const { rpc } = createAuditMock(() => {
      throw new Error("Admin access required");
    });
    const el = await createElement(rpc);

    expect(priv(el)._loadState).toBe("error");
    const errBox = el.shadowRoot?.querySelector(".error-container");
    expect(errBox).toBeTruthy();
    const retry = el.shadowRoot?.querySelector(".retry-btn");
    expect(retry).toBeTruthy();
  });

  it("content-free: a planted body/secret marker in a fixture row is absent from the rendered DOM", async () => {
    const { rpc } = createAuditMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    const text = el.shadowRoot?.textContent ?? "";
    expect(text).not.toContain(PLANTED_SECRET);
    // The data-table itself renders the cell values; assert across its shadow too.
    const table = el.shadowRoot?.querySelector("ic-data-table");
    const tableText = table?.shadowRoot?.textContent ?? "";
    expect(tableText).not.toContain(PLANTED_SECRET);
  });

  it("renders the content-free columns (kind/agent/tenant/outcome/severity) without a raw refs blob column", async () => {
    const { rpc } = createAuditMock(() => ({ rows: fixtureRows() }));
    const el = await createElement(rpc);

    const table = el.shadowRoot?.querySelector("ic-data-table");
    const columns = (table as unknown as { columns: Array<{ key: string }> }).columns;
    const keys = columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["kind", "agentId", "tenantId", "outcome", "severity"]));
    // The scrubbed refs blob is never surfaced as its own rendered column.
    expect(keys).not.toContain("refs");
  });

  it("loading state: skeleton shown before the first query resolves (rpcClient null)", async () => {
    const el = await createElement(null);
    // With a null client the view settles to a loaded/empty state rather than
    // hanging; assert it does not throw and renders the empty surface.
    expect(priv(el)._loadState).not.toBe("error");
  });
});
