// SPDX-License-Identifier: Apache-2.0
/**
 * AUDIT-04 — the content-free invariant for the durable security-audit sink.
 *
 * The `audit:event` `metadata: Record<string, unknown>` free-map (and the
 * tenant-less events' `refs` map) is where a careless (or hostile) emit site
 * could smuggle a secret VALUE into the durable security-audit (the
 * obs_audit_events row + the security-audit.jsonl line). This test pins that the
 * sink is content-free BY CONSTRUCTION so a planted value appears in NEITHER the
 * persisted row NOR the JSONL bytes — for BOTH a credential-KEYED field AND a
 * sensitive value under a BENIGN key (the H1/H2 leak shape the live review found:
 * a no-prefix secret config `value` and the command:blocked `commandPrefix`).
 *
 * It is an ARCHITECTURE-tier test (a cross-cutting content-free invariant)
 * placed in test/architecture/ so the full-workspace gate catches it —
 * per-package runs hide cross-cutting gates (Pitfall 6 / the
 * feedback_full_workspace_gates_per_phase note).
 *
 * LOAD-BEARING: if the scrub/digest is removed from `auditEventToRow` /
 * `buildAuditRow`, the relevant test FAILS (the planted value reaches the
 * row/JSONL) — proving the assertion is not a tautology. The "still useful"
 * test asserts the scrubbed row is not reduced to an empty husk (structural
 * keys/counts survive).
 *
 * INCIDENT (Phase 176 follow-up): a code review of the durable audit sink found
 * that the sink persisted free-form secret-bearing values under BENIGN keys —
 * the raw config `value` (H1, config-write.ts) and the `command:blocked`
 * `commandPrefix` (H2, ≤200 chars of command body) — defeating AUDIT-04. The
 * pre-fix sink only dropped credential-KEYED fields and pattern-matched
 * prefixed/keyworded secrets, so a 32-hex key / DB password / inline
 * `mysql -pSecret` landed UNREDACTED. The benign-key cases below reproduce that
 * leak (RED on pre-fix code) and lock it shut (GREEN after the fix).
 *
 * The system-under-test boundary is the REAL daemon row-builder
 * (`auditEventToRow`, imported from the compiled daemon dist), the REAL
 * `command:blocked` subscriber path (`wireAuditSink` driven by a real
 * `TypedEventBus`), the REAL JSONL writer (`appendAuditJsonl`, the
 * `@comis/memory` export) + a REAL in-memory obs_audit_events store — not a
 * re-implementation.
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
import { TypedEventBus } from "@comis/core";
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

/** Minimal capturing sink + JSONL deps for the real `wireAuditSink` path. */
interface WireAuditSinkDeps {
  eventBus: TypedEventBus;
  auditBuffer: { push(row: AuditEventRow): void };
  dataDir?: string;
  logRotation?: { maxSizeBytes: number; maxFiles: number };
}
type WireAuditSink = (deps: WireAuditSinkDeps) => void;

describe("AUDIT-04 — a planted audit:event metadata value never persists (content-free)", () => {
  let auditEventToRow: AuditEventToRow;
  let wireAuditSink: WireAuditSink;
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createObservabilityStore>;

  beforeEach(async () => {
    const mod = (await import(auditSinkUrl)) as {
      auditEventToRow: AuditEventToRow;
      wireAuditSink: WireAuditSink;
    };
    auditEventToRow = mod.auditEventToRow;
    wireAuditSink = mod.wireAuditSink;
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

  // -------------------------------------------------------------------------
  // H1/H2 (Phase 176 review) — a sensitive value under a BENIGN key. These
  // exercise the EXACT leak shape the credential-key-drop path misses: a
  // no-prefix secret value (a 32-hex key / DB password) under `value`, and the
  // command body under `commandPrefix`. RED on pre-fix code, GREEN after the
  // content-free-by-construction digest at the sink chokepoint.
  // -------------------------------------------------------------------------

  it("H1: a no-prefix secret under the benign `value` key (config.patch shape) never persists", () => {
    // A 32-hex key + a DB password + an internal hostname — none match a
    // credential-KEYED field name and none match a prefixed/keyworded redact
    // pattern, so the pattern redactor lets them through. The sink must drop
    // the free-form `value` by construction.
    const HEX32 = "deadbeefcafef00d0123456789abcdef";
    const DBPASS = "S3cr3tDbPassw0rd";
    const HOST = "internal-db.prod.corp";
    for (const planted of [HEX32, `postgres://app:${DBPASS}@${HOST}:5432/db`, HOST]) {
      const row = auditEventToRow(
        {
          timestamp: 1000,
          agentId: "a1",
          tenantId: "t1",
          actionType: "config.patch",
          kind: "audit",
          classification: "destructive",
          outcome: "success",
          // The config.patch emit shape — `value` carries the raw config value.
          metadata: { section: "database", key: "url", value: planted, durationMs: 4 },
        },
        "t1",
        "a1",
        undefined,
      );

      // a. The SQLite row.
      const freshDb = new Database(":memory:");
      initSchema(freshDb, 1536);
      const freshStore = createObservabilityStore(freshDb);
      freshStore.insertAuditEvent(row);
      const rows = freshStore.queryAuditEvents({ kind: "audit" });
      expect(rows).toHaveLength(1);
      expect(
        JSON.stringify(rows[0]),
        `planted '${planted}' must not reach the obs_audit_events row`,
      ).not.toContain(planted);
      freshDb.close();

      // b. The security-audit.jsonl line.
      const filePath = join(dir, `cfg-${rows[0]!.id}.jsonl`);
      appendAuditJsonl({ filePath, record: row, rotateAtBytes: 10_000_000, keepRotated: 5 });
      const jsonlBytes = fs.readFileSync(filePath, "utf8");
      expect(
        jsonlBytes,
        `planted '${planted}' must not reach security-audit.jsonl`,
      ).not.toContain(planted);

      // c. A content-free change-indicator survives so the audit stays useful.
      const refs = JSON.parse(row.refs!) as Record<string, unknown>;
      expect(refs.section).toBe("database"); // benign structural field survives
      expect(refs.value, "the raw value must be dropped").toBeUndefined();
      // The digest + length replace the value (content-free correlation). Note
      // the config `key` NAME is itself credential-masked by the substrate (the
      // bare `key` token is a credential keyword) — orthogonal to this leak.
      expect(refs.valueSha256, "a content-free digest survives").toBeTruthy();
      expect(refs.valueLength).toBe(planted.length);
    }
  });

  it("H2: the command:blocked `commandPrefix` (command body) never persists in the durable row/JSONL", () => {
    // Drive the REAL command:blocked subscriber via wireAuditSink — that path
    // (buildAuditRow with raw refs) is the leak site, not auditEventToRow. An
    // inline-secret command is the worst case (`mysql -p<pass>`).
    const SECRET_CMD = "mysql -uroot -pSup3rS3cretPlainPass --host internal-db.prod.corp app";
    const captured: AuditEventRow[] = [];
    const eventBus = new TypedEventBus();
    wireAuditSink({
      eventBus,
      auditBuffer: { push: (row) => captured.push(row) },
      dataDir: dir,
      logRotation: { maxSizeBytes: 10_000_000, maxFiles: 5 },
    });

    eventBus.emit("command:blocked", {
      agentId: "a1",
      commandPrefix: SECRET_CMD,
      reason: "denylist",
      blocker: "denylist",
      timestamp: 1000,
    });

    // a. The captured SQLite row — neither the command body nor its inline secret.
    expect(captured).toHaveLength(1);
    const rowJson = JSON.stringify(captured[0]);
    for (const leak of [SECRET_CMD, "Sup3rS3cretPlainPass", "internal-db.prod.corp"]) {
      expect(rowJson, `'${leak}' must not reach the command_blocked row`).not.toContain(leak);
    }
    // The closed structural fields stay useful (content-free).
    const refs = JSON.parse(captured[0]!.refs!) as Record<string, unknown>;
    expect(refs.blocker).toBe("denylist");
    expect(refs.reason).toBe("denylist");
    expect(refs.commandPrefix, "the command body must be dropped").toBeUndefined();

    // b. The security-audit.jsonl line written by the same subscriber.
    const jsonlPath = join(dir, "logs", "security-audit.jsonl");
    const jsonlBytes = fs.readFileSync(jsonlPath, "utf8");
    for (const leak of [SECRET_CMD, "Sup3rS3cretPlainPass", "internal-db.prod.corp"]) {
      expect(jsonlBytes, `'${leak}' must not reach security-audit.jsonl`).not.toContain(leak);
    }
  });
});

// NOTE (Plan 04 coordination): this phase introduces the audit via SQLite +
// JSONL, NOT a trajectory record — so there is no `audit.*` trajectory type to
// enumerate in trajectory-event-types-known.test.ts. The `cache.break`
// trajectory type is Plan 04's responsibility. Verified N/A for audit here.
