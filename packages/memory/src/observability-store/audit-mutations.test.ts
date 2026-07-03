// SPDX-License-Identifier: Apache-2.0
/**
 * audit-mutations.ts tests.
 *
 * Two composed analogs under test:
 *   1. The SQLite half — `insertAuditEvent` / `queryAuditEvents` round-trip
 *      against an in-memory `obs_audit_events` table (initSchema creates it).
 *   2. The JSONL half — `appendAuditJsonl` writes a 0600 rotated
 *      `security-audit.jsonl` via the reused config-audit helpers (a tmp dir).
 *
 * The `secret:accessed` invariant is structural: a secret-access row
 * carries `secretName` (in `refs`/`action`) + `outcome` and NO value field
 * anywhere — there is no value to drop because the source payload is value-free.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initSchema } from "../schema.js";
import { createObservabilityStore } from "./index.js";
import {
  appendAuditJsonl,
  type AuditQueryParams,
} from "./audit-mutations.js";
import type { ObservabilityStore, AuditEventRow } from "./observability-store-types.js";

function makeRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    tenantId: "tenant-1",
    agentId: "agent-1",
    ts: 1_700_000_000_000,
    kind: "audit",
    classification: null,
    action: "file.delete",
    actor: "user-1",
    outcome: "success",
    severity: "info",
    traceId: "trace-1",
    refs: JSON.stringify({ k: 1 }),
    ...overrides,
  };
}

describe("audit-mutations — obs_audit_events insert/query (SQLite half)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("Test 1: insertAuditEvent → queryAuditEvents round-trips the row", () => {
    const row = makeRow({ id: "evt-1", kind: "auth_mutation", outcome: "denied" });
    store.insertAuditEvent(row);

    const rows = store.queryAuditEvents({});
    expect(rows).toHaveLength(1);
    const got = rows[0]!;
    expect(got.id).toBe("evt-1");
    expect(got.kind).toBe("auth_mutation");
    expect(got.outcome).toBe("denied");
    expect(got.tenantId).toBe("tenant-1");
    expect(got.agentId).toBe("agent-1");
    expect(got.classification).toBeNull();
    expect(got.action).toBe("file.delete");
    expect(got.actor).toBe("user-1");
    expect(got.severity).toBe("info");
    expect(got.traceId).toBe("trace-1");
    expect(got.refs).toBe(JSON.stringify({ k: 1 }));
  });

  it("Test 2: a secret-access row carries secretName + outcome and has NO value field anywhere", () => {
    // The secret NAME is carried in `action` (and/or `refs`); there is no value.
    const row = makeRow({
      id: "secret-1",
      kind: "secret_access",
      action: "OPENAI_API_KEY",
      actor: "agent-1",
      outcome: "success",
      classification: null,
      refs: JSON.stringify({ secretName: "OPENAI_API_KEY" }),
    });
    store.insertAuditEvent(row);

    const rows = store.queryAuditEvents({ kind: "secret_access" });
    expect(rows).toHaveLength(1);
    const got = rows[0]!;
    expect(got.action).toBe("OPENAI_API_KEY");
    expect(got.outcome).toBe("success");
    // Structural invariant: no column anywhere carries a secret VALUE — the
    // whole serialized row is name+outcome only.
    const serialized = JSON.stringify(got);
    expect(serialized).not.toMatch(/value/i);
    expect(serialized).not.toContain("sk-");
  });

  it("Test 5a: queryAuditEvents filters by kind", () => {
    store.insertAuditEvent(makeRow({ id: "a", kind: "secret_access" }));
    store.insertAuditEvent(makeRow({ id: "b", kind: "command_blocked" }));
    store.insertAuditEvent(makeRow({ id: "c", kind: "secret_access" }));

    const rows = store.queryAuditEvents({ kind: "secret_access" });
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("Test 5b: queryAuditEvents filters by agentId, tenant, outcome", () => {
    store.insertAuditEvent(makeRow({ id: "a", agentId: "agent-x", tenantId: "t1", outcome: "success" }));
    store.insertAuditEvent(makeRow({ id: "b", agentId: "agent-y", tenantId: "t1", outcome: "denied" }));
    store.insertAuditEvent(makeRow({ id: "c", agentId: "agent-x", tenantId: "t2", outcome: "denied" }));

    expect(store.queryAuditEvents({ agentId: "agent-x" }).map((r) => r.id).sort()).toEqual(["a", "c"]);
    expect(store.queryAuditEvents({ tenant: "t1" }).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(store.queryAuditEvents({ outcome: "denied" }).map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("Test 5c: queryAuditEvents filters by since/until and applies a bounded limit, ORDER BY ts DESC", () => {
    store.insertAuditEvent(makeRow({ id: "old", ts: 1_000 }));
    store.insertAuditEvent(makeRow({ id: "mid", ts: 2_000 }));
    store.insertAuditEvent(makeRow({ id: "new", ts: 3_000 }));

    // since
    expect(store.queryAuditEvents({ since: 2_000 }).map((r) => r.id)).toEqual(["new", "mid"]);
    // until
    expect(store.queryAuditEvents({ until: 2_000 }).map((r) => r.id)).toEqual(["mid", "old"]);
    // window
    expect(store.queryAuditEvents({ since: 2_000, until: 2_000 }).map((r) => r.id)).toEqual(["mid"]);
    // limit
    expect(store.queryAuditEvents({ limit: 1 }).map((r) => r.id)).toEqual(["new"]);
  });

  it("Test 5d: queryAuditEvents clamps an over-large limit to a bounded maximum", () => {
    for (let i = 0; i < 5; i++) store.insertAuditEvent(makeRow({ id: `r${i}`, ts: i }));
    // A pathological limit must not throw and must still return rows (clamped).
    const rows = store.queryAuditEvents({ limit: 10_000_000 });
    expect(rows.length).toBe(5);
  });

  it("Test 5e: classification filter narrows to a genuine read|mutate|destructive", () => {
    store.insertAuditEvent(makeRow({ id: "a", kind: "audit", classification: "destructive" }));
    store.insertAuditEvent(makeRow({ id: "b", kind: "audit", classification: "read" }));
    store.insertAuditEvent(makeRow({ id: "c", kind: "secret_access", classification: null }));

    expect(store.queryAuditEvents({ classification: "destructive" }).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("audit-mutations — security-audit.jsonl writer (JSONL half)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-jsonl-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Test 3: appends one JSON line per event and the file mode is exactly 0600", () => {
    const filePath = path.join(dir, "security-audit.jsonl");
    appendAuditJsonl({ filePath, record: { kind: "audit", outcome: "success" }, rotateAtBytes: 10_000_000, keepRotated: 5 });
    appendAuditJsonl({ filePath, record: { kind: "secret_access", outcome: "denied" }, rotateAtBytes: 10_000_000, keepRotated: 5 });

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "audit", outcome: "success" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: "secret_access", outcome: "denied" });

    // 0600 — owner read/write only.
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("Test 4: rotates when incoming bytes exceed the passed rotateAtBytes cap", () => {
    const filePath = path.join(dir, "security-audit.jsonl");
    // First write creates the file (rotation no-ops on a missing file).
    appendAuditJsonl({ filePath, record: { kind: "audit", n: 1 }, rotateAtBytes: 10, keepRotated: 5 });
    expect(fs.existsSync(filePath)).toBe(true);
    // The file is now ~22 bytes > the 10-byte cap, so the next append rotates
    // the existing file to .1 and creates a fresh main file.
    appendAuditJsonl({ filePath, record: { kind: "audit", n: 2 }, rotateAtBytes: 10, keepRotated: 5 });

    const rotated = fs.existsSync(filePath + ".1") || fs.existsSync(filePath + ".1.gz");
    expect(rotated).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// Type-level: AuditQueryParams exposes the obs_query filter surface.
const _q: AuditQueryParams = { kind: "secret_access", agentId: "a", tenant: "t", outcome: "denied", since: 1, until: 2, limit: 3, classification: "read" };
void _q;
