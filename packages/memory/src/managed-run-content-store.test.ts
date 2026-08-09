// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedRunContentPort, ManagedRunContentScope } from "@comis/core";
import { ensureManagedRunTables } from "./schema-managed-runs.js";
import { createSqliteManagedRunContentStore } from "./managed-run-content-store.js";

const SCOPE: ManagedRunContentScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  managedRunId: "managed-run_a",
};
const OTHER_SCOPE: ManagedRunContentScope = {
  tenantId: "tenant_a",
  agentId: "agent_b",
  managedRunId: "managed-run_a",
};

describe("createSqliteManagedRunContentStore confined bodies", () => {
  const temporaryDirectories: string[] = [];
  let db: Database.Database;
  let directoryPath: string;
  let store: ManagedRunContentPort;

  function temporaryDirectory(): string {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-content-")));
    temporaryDirectories.push(directory);
    return directory;
  }

  beforeEach(() => {
    directoryPath = temporaryDirectory();
    db = new Database(":memory:");
    ensureManagedRunTables(db);
    const created = createSqliteManagedRunContentStore(db, { directoryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    store = created.value;
  });

  afterEach(() => {
    db.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes 0600 activation and report bodies beneath 0700 scope directories", async () => {
    const activation = await store.putActivationDescriptor(SCOPE, "activation-descriptor_a", {
      schemaVersion: 1,
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
      expiresAtMs: 1_800_000_060_000,
    });
    const report = await store.putReportBody(SCOPE, {
      schemaVersion: 1,
      serviceReportId: "service-report_a",
      kind: "progress",
      summary: "Private progress body",
    }, 1_802_592_000_000);

    expect(activation.ok).toBe(true);
    expect(report.ok).toBe(true);
    const rows = db.prepare(
      "SELECT content_ref, relative_path FROM managed_run_content_index ORDER BY content_ref",
    ).all() as Array<{ content_ref: string; relative_path: string }>;
    expect(rows.map((row) => row.content_ref)).toEqual(["activation-descriptor_a", "service-report_a"]);
    for (const row of rows) {
      const bodyPath = join(directoryPath, row.relative_path);
      expect(statSync(bodyPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(bodyPath)).mode & 0o777).toBe(0o700);
    }
    expect(await store.getActivationDescriptor(SCOPE, "activation-descriptor_a")).toMatchObject({
      ok: true,
      value: { externalRunRef: "external-run_a" },
    });
    expect(await store.getReportBody(SCOPE, "service-report_a")).toMatchObject({
      ok: true,
      value: { summary: "Private progress body" },
    });
  });

  it("stores evidence and attention bytes without placing bodies in SQLite", async () => {
    const evidenceBytes = new TextEncoder().encode("private evidence bytes");
    const attentionBytes = new TextEncoder().encode("private attention bytes");

    expect((await store.putEvidence(SCOPE, "evidence_a", {
      body: evidenceBytes,
      expiresAtMs: 1_800_000_100_000,
    })).ok).toBe(true);
    expect((await store.putAttentionBody(SCOPE, "attention_a", {
      body: attentionBytes,
    })).ok).toBe(true);
    expect(await store.getEvidence(SCOPE, "evidence_a")).toEqual({ ok: true, value: evidenceBytes });
    expect(await store.getAttentionBody(SCOPE, "attention_a")).toEqual({ ok: true, value: attentionBytes });

    const columns = new Set(
      (db.prepare("PRAGMA table_info(managed_run_content_index)").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const forbidden of ["body", "content", "summary", "details", "external_run_ref", "registration_nonce"]) {
      expect(columns.has(forbidden), forbidden).toBe(false);
    }
    const sqliteBytes = JSON.stringify(db.prepare("SELECT * FROM managed_run_content_index").all());
    expect(sqliteBytes).not.toContain("private evidence bytes");
    expect(sqliteBytes).not.toContain("private attention bytes");
  });

  it("returns original receipts for identical replay and rejects altered reuse", async () => {
    const original = {
      schemaVersion: 1 as const,
      serviceReportId: "service-report_replay",
      kind: "progress" as const,
      summary: "Original body",
    };
    const first = await store.putReportBody(SCOPE, original, 1_802_592_000_000);
    const replay = await store.putReportBody(SCOPE, original, 1_802_592_100_000);
    const altered = await store.putReportBody(SCOPE, {
      ...original,
      summary: "Altered body",
    }, 1_802_592_000_000);

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(altered.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_run_content_index").get()).toEqual({ count: 1 });
  });

  it("hides other scopes and detects body tampering before returning private data", async () => {
    expect((await store.putReportBody(SCOPE, {
      schemaVersion: 1,
      serviceReportId: "service-report_tamper",
      kind: "progress",
      summary: "Original body",
    }, 1_802_592_000_000)).ok).toBe(true);
    expect(await store.getReportBody(OTHER_SCOPE, "service-report_tamper")).toEqual({
      ok: true,
      value: undefined,
    });

    const row = db.prepare(
      "SELECT relative_path FROM managed_run_content_index WHERE content_ref = ?",
    ).get("service-report_tamper") as { relative_path: string };
    writeFileSync(join(directoryPath, row.relative_path), "tampered", { mode: 0o600 });
    expect((await store.getReportBody(SCOPE, "service-report_tamper")).ok).toBe(false);
  });

  it("purges only expired bodies and their content-free index rows", async () => {
    expect((await store.putEvidence(SCOPE, "evidence_expired", {
      body: new TextEncoder().encode("expired"),
      expiresAtMs: 1_800_000_000_100,
    })).ok).toBe(true);
    expect((await store.putEvidence(SCOPE, "evidence_retained", {
      body: new TextEncoder().encode("retained"),
      expiresAtMs: 1_800_000_100_000,
    })).ok).toBe(true);

    expect(await store.purgeExpired({
      kind: "recovery",
      expiredBeforeMs: 1_800_000_000_200,
      limit: 10,
    })).toEqual({ ok: true, value: 1 });
    expect(await store.getEvidence(SCOPE, "evidence_expired")).toEqual({ ok: true, value: undefined });
    expect(await store.getEvidence(SCOPE, "evidence_retained")).toMatchObject({ ok: true });
  });

  it("removes activation bodies only through their exact scoped reference", async () => {
    expect((await store.putActivationDescriptor(SCOPE, "activation-descriptor_delete", {
      schemaVersion: 1,
      externalRunRef: "external-run_delete",
      registrationNonce: "registration-nonce_delete",
      expiresAtMs: 1_800_000_060_000,
    })).ok).toBe(true);

    expect(await store.deleteActivationDescriptor(OTHER_SCOPE, "activation-descriptor_delete"))
      .toEqual({ ok: true, value: false });
    expect(await store.deleteActivationDescriptor(SCOPE, "activation-descriptor_delete"))
      .toEqual({ ok: true, value: true });
    expect(await store.getActivationDescriptor(SCOPE, "activation-descriptor_delete"))
      .toEqual({ ok: true, value: undefined });
  });

  it("rejects relative broad and symlinked content roots", () => {
    expect(createSqliteManagedRunContentStore(db, { directoryPath: "relative" }).ok).toBe(false);
    const broad = temporaryDirectory();
    chmodSync(broad, 0o755);
    expect(createSqliteManagedRunContentStore(db, { directoryPath: broad }).ok).toBe(false);
    chmodSync(broad, 0o700);

    const target = temporaryDirectory();
    const parent = temporaryDirectory();
    const linked = join(parent, "linked");
    symlinkSync(target, linked);
    expect(createSqliteManagedRunContentStore(db, { directoryPath: linked }).ok).toBe(false);
  });

  it("reads indexed bodies after database and adapter restart", async () => {
    const databasePath = join(directoryPath, "content-index.db");
    db.close();
    db = new Database(databasePath);
    ensureManagedRunTables(db);
    const first = createSqliteManagedRunContentStore(db, { directoryPath });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await first.value.putReportBody(SCOPE, {
      schemaVersion: 1,
      serviceReportId: "service-report_restart",
      kind: "progress",
      summary: "Survives restart",
    }, 1_802_592_000_000)).ok).toBe(true);
    db.close();

    db = new Database(databasePath);
    ensureManagedRunTables(db);
    const reopened = createSqliteManagedRunContentStore(db, { directoryPath });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(await reopened.value.getReportBody(SCOPE, "service-report_restart")).toMatchObject({
      ok: true,
      value: { summary: "Survives restart" },
    });

    const row = db.prepare(
      "SELECT relative_path FROM managed_run_content_index WHERE content_ref = ?",
    ).get("service-report_restart") as { relative_path: string };
    expect(readFileSync(join(directoryPath, row.relative_path), "utf8")).toContain("Survives restart");
  });
});
