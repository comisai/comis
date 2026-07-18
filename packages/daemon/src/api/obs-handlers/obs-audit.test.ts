// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.audit.query` handler acceptance tests.
 *
 * Drives the REAL handler over a seeded `:memory:` ObservabilityStore (the real
 * `insertAuditEvent` / `queryAuditEvents` store methods), mirroring the
 * `system-health.test.ts` seam.
 *
 * Cases pinned:
 *   1. ROUND-TRIP — seeded rows come back through `obs.audit.query`.
 *   2. Admin gate — a non-admin `_trustLevel` is rejected; `stripInternalFields`
 *      keeps `_trustLevel` out of the store query / the result.
 *   3. FILTERS — the kind/agent/outcome/since/until filter surface narrows the scan.
 *   4. CONTENT-FREE — the rows carry NO `value`-shaped field (structural — the row
 *      type has no such field; a planted metadata value never surfaces).
 *   5. EMPTY STORE — no obsStore ⇒ an honest `{ rows: [] }` (the soft-fail posture).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { AuditEventRow, ObservabilityStore } from "@comis/memory";
import { bindObsAuditHandlers } from "./obs-audit.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

/** A fresh `:memory:` ObservabilityStore with the full schema initialized. */
function makeStore(): ObservabilityStore {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createObservabilityStore(db);
}

/** A content-free audit row (the `AuditEventRow` shape). */
function makeRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: overrides.id ?? `audit-${Math.random().toString(36).slice(2)}`,
    tenantId: overrides.tenantId ?? "tenant-a",
    agentId: overrides.agentId ?? "agent-1",
    ts: overrides.ts ?? 1_000,
    kind: overrides.kind ?? "secret_access",
    classification: overrides.classification ?? null,
    action: overrides.action ?? "secrets.get",
    actor: overrides.actor ?? null,
    outcome: overrides.outcome ?? "success",
    severity: overrides.severity ?? "info",
    traceId: overrides.traceId ?? null,
    refs: overrides.refs ?? null,
  };
}

/** Build the handler bound to a store (or no store for the soft-fail case). */
function makeHandler(store?: ObservabilityStore) {
  const deps = { obsStore: store } as unknown as ObsHandlerDeps;
  return bindObsAuditHandlers(deps)["obs.audit.query"];
}

describe("obs.audit.query handler", () => {
  it("round-trips seeded audit rows (admin)", async () => {
    const store = makeStore();
    store.insertAuditEvent(makeRow({ id: "a1", kind: "secret_access" }));
    store.insertAuditEvent(makeRow({ id: "a2", kind: "injection_detected", outcome: "denied" }));

    const handler = makeHandler(store);
    const result = (await handler({ _trustLevel: "admin" })) as {
      rows: AuditEventRow[];
    };

    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBe(2);
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(["a1", "a2"]);
  });

  it("rejects a non-admin _trustLevel (dual-layer admin gate)", async () => {
    const store = makeStore();
    store.insertAuditEvent(makeRow());
    const handler = makeHandler(store);

    await expect(handler({ _trustLevel: "guest" })).rejects.toThrow(
      /admin access required/i,
    );
    await expect(handler({})).rejects.toThrow(/admin access required/i);
  });

  it("applies the kind / agent / outcome / since / until filter surface", async () => {
    const store = makeStore();
    store.insertAuditEvent(makeRow({ id: "k1", kind: "secret_access", agentId: "agent-1", ts: 100 }));
    store.insertAuditEvent(makeRow({ id: "k2", kind: "injection_detected", agentId: "agent-2", ts: 200, outcome: "denied" }));
    store.insertAuditEvent(makeRow({ id: "k3", kind: "secret_access", agentId: "agent-2", ts: 300 }));
    const handler = makeHandler(store);

    const byKind = (await handler({ _trustLevel: "admin", kind: "injection_detected" })) as { rows: AuditEventRow[] };
    expect(byKind.rows.map((r) => r.id)).toEqual(["k2"]);

    const byAgent = (await handler({ _trustLevel: "admin", agentId: "agent-2" })) as { rows: AuditEventRow[] };
    expect(byAgent.rows.map((r) => r.id).sort()).toEqual(["k2", "k3"]);

    const byOutcome = (await handler({ _trustLevel: "admin", outcome: "denied" })) as { rows: AuditEventRow[] };
    expect(byOutcome.rows.map((r) => r.id)).toEqual(["k2"]);

    const byWindow = (await handler({ _trustLevel: "admin", since: 150, until: 250 })) as { rows: AuditEventRow[] };
    expect(byWindow.rows.map((r) => r.id)).toEqual(["k2"]);
  });

  it("returns content-free rows — no secret value field reaches the wire", async () => {
    const store = makeStore();
    // Even a row whose scrubbed `refs` blob carries arbitrary JSON has NO `value`
    // key promoted to the row level — the row type is counts/ids/enums + refs only.
    store.insertAuditEvent(makeRow({ id: "cf1", refs: JSON.stringify({ secretName: "OPENAI_API_KEY" }) }));
    const handler = makeHandler(store);

    const result = (await handler({ _trustLevel: "admin" })) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect("value" in row).toBe(false);
    expect("secret" in row).toBe(false);
    expect("apiKey" in row).toBe(false);
    // The expected content-free key set (the AuditEventRow columns).
    expect(Object.keys(row).sort()).toEqual(
      [
        "action",
        "actor",
        "agentId",
        "classification",
        "id",
        "kind",
        "outcome",
        "refs",
        "severity",
        "tenantId",
        "traceId",
        "ts",
      ].sort(),
    );
  });

  it("soft-fails to an empty result when no obsStore is present", async () => {
    const handler = makeHandler(undefined);
    const result = (await handler({ _trustLevel: "admin" })) as { rows: AuditEventRow[] };
    expect(result.rows).toEqual([]);
  });
});
