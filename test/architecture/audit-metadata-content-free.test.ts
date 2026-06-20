// SPDX-License-Identifier: Apache-2.0
/**
 * AUDIT-04 — the content-free invariant for the ONE audit escape hatch.
 *
 * The `audit:event` `metadata: Record<string, unknown>` free-map is the single
 * place where a careless (or hostile) emit site could smuggle a secret VALUE
 * into the durable security-audit (the obs_audit_events row + the
 * security-audit.jsonl line). This test pins that the sink scrubs that free-map
 * through `sanitizeForPersistence` so a planted value (at multiple nesting
 * levels) appears in NEITHER the persisted row NOR the JSONL bytes.
 *
 * It is an ARCHITECTURE-tier test (a cross-cutting content-free invariant)
 * placed in test/architecture/ so the full-workspace gate catches it —
 * per-package runs hide cross-cutting gates (Pitfall 6 / the
 * feedback_full_workspace_gates_per_phase note).
 *
 * LOAD-BEARING: if the scrub is removed from `auditEventToRow`, Test 1 FAILS
 * (the planted value reaches the row/JSONL) — proving the assertion is not a
 * tautology. Test 2 asserts the scrubbed row is still USEFUL (structural
 * keys/counts survive) so the audit is not reduced to an empty husk.
 *
 * The system-under-test boundary is the REAL daemon row-builder
 * (`auditEventToRow`, imported from the compiled daemon dist) + the REAL JSONL
 * writer (`appendAuditJsonl`, the `@comis/memory` export) + a REAL in-memory
 * obs_audit_events store — not a re-implementation.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore, appendAuditJsonl } from "@comis/memory";
import type { AuditEventRow } from "@comis/memory";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// The architecture vitest config aliases only @comis/{core,observability,skills}
// → dist. The daemon row-builder is not on an aliased barrel, so load it
// directly from the compiled daemon dist (the file-URL form is
// cross-platform-safe). This drives the ACTUAL builder, not a copy.
const auditSinkUrl = pathToFileURL(
  resolve(REPO_ROOT, "packages/daemon/dist/observability/obs-audit-sink.js"),
).href;

type AuditEventToRow = (
  payload: {
    timestamp: number;
    agentId: string;
    tenantId: string;
    actionType: string;
    kind?: string;
    classification?: string;
    outcome: "success" | "failure" | "denied";
    metadata?: Record<string, unknown>;
  },
  resolvedTenant: string,
  resolvedAgent: string | null,
  resolvedTraceId: string | undefined,
) => AuditEventRow;

describe("AUDIT-04 — a planted audit:event metadata value never persists (content-free)", () => {
  let auditEventToRow: AuditEventToRow;
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;

  beforeEach(async () => {
    const mod = (await import(auditSinkUrl)) as { auditEventToRow: AuditEventToRow };
    auditEventToRow = mod.auditEventToRow;
    dir = fs.mkdtempSync(join(os.tmpdir(), "audit-cf-"));
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Test 1: planted secrets at ≥2 nesting levels appear in NEITHER the row NOR the JSONL", () => {
    const planted = {
      password: "PLANTED",
      token: "sk-PLANTED",
      nested: { secret: "PLANTED2", deeper: { apiKey: "PLANTED3" } },
    };
    const row = auditEventToRow(
      {
        timestamp: 1000,
        agentId: "a1",
        tenantId: "t1",
        actionType: "file.delete",
        kind: "audit",
        classification: "destructive",
        outcome: "success",
        metadata: planted,
      },
      "t1",
      "a1",
      undefined,
    );

    // a. The persisted SQLite row — no column carries any planted value.
    store.insertAuditEvent(row);
    const rows = store.queryAuditEvents({ kind: "audit" });
    expect(rows).toHaveLength(1);
    const rowJson = JSON.stringify(rows[0]);
    for (const leak of ["PLANTED", "sk-PLANTED", "PLANTED2", "PLANTED3"]) {
      expect(rowJson, `planted value '${leak}' must not reach the obs_audit_events row`).not.toContain(leak);
    }

    // b. The security-audit.jsonl line — the same row, written to disk.
    const filePath = join(dir, "security-audit.jsonl");
    appendAuditJsonl({ filePath, record: row, rotateAtBytes: 10_000_000, keepRotated: 5 });
    const jsonlBytes = fs.readFileSync(filePath, "utf8");
    for (const leak of ["PLANTED", "sk-PLANTED", "PLANTED2", "PLANTED3"]) {
      expect(jsonlBytes, `planted value '${leak}' must not reach security-audit.jsonl`).not.toContain(leak);
    }
  });

  it("Test 2: the scrubbed row is still USEFUL — structural keys survive (not an empty husk)", () => {
    const row = auditEventToRow(
      {
        timestamp: 1000,
        agentId: "a1",
        tenantId: "t1",
        actionType: "file.delete",
        kind: "audit",
        outcome: "success",
        metadata: { password: "PLANTED", attemptCount: 3, resourceId: "res-42" },
      },
      "t1",
      "a1",
      undefined,
    );
    // The closed audit columns survive verbatim (they are not the free-map).
    expect(row.kind).toBe("audit");
    expect(row.outcome).toBe("success");
    expect(row.action).toBe("file.delete");
    // The scrub keeps the benign structural fields (scalar counts/ids) and
    // removes the credential-keyed field entirely — the audit row stays
    // queryable/useful (not an empty husk), while the secret VALUE is gone.
    expect(row.refs, "the scrubbed refs must be present (not null/empty)").toBeTruthy();
    const refs = JSON.parse(row.refs!) as Record<string, unknown>;
    expect(refs.attemptCount).toBe(3); // a benign scalar count survives
    expect(refs.resourceId).toBe("res-42"); // a benign id survives
    // The credential VALUE never survives (the chokepoint drops the field).
    expect(JSON.stringify(refs)).not.toContain("PLANTED");
    // The row is not reduced to nothing — at least the benign fields remain.
    expect(Object.keys(refs).length).toBeGreaterThanOrEqual(2);
  });
});

// NOTE (Plan 04 coordination): this phase introduces the audit via SQLite +
// JSONL, NOT a trajectory record — so there is no `audit.*` trajectory type to
// enumerate in trajectory-event-types-known.test.ts. The `cache.break`
// trajectory type is Plan 04's responsibility. Verified N/A for audit here.
