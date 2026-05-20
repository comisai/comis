// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the config-OBSERVE writer (OBS-REVIEW-03 fix).
 *
 * The observe-side writer mirrors the write-side `appendConfigAuditRecord`
 * shape: produce a record matching `ConfigObserveAuditRecordSchema`,
 * persist it via the same `appendRegularFile`-backed JSONL chassis
 * the write-side uses. The four observability invariants per
 * design §9.2:
 *
 *   1. `event: "config.observe"`, `source: "config-io"`, no `phase` /
 *      no flat-stat / no `result` fields (those belong to the write
 *      side). Caller provenance fields (`pid`, `ppid`, `argv`, `cwd`,
 *      `execArgv`, `watchMode`) match write-side semantics.
 *
 *   2. `callerSource` carries the call-site identifier (e.g.
 *      "daemon-bootstrap").
 *
 *   3. `suspicious` array reflects the same heuristics (`unknown-binary`,
 *      `non-comis-argv`, `permission-restricted-caller`) the write side
 *      uses.
 *
 *   4. The on-disk JSONL line round-trips through the
 *      `ConfigObserveAuditRecordSchema` parser unchanged.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendConfigObserveAuditRecord,
  createConfigObserveAuditRecord,
} from "./append-observe.js";
import {
  ConfigObserveAuditRecordSchema,
  type ConfigObserveAuditRecord,
} from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-observe-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createConfigObserveAuditRecord — record shape", () => {
  it("produces a record that parses against ConfigObserveAuditRecordSchema for an existing file", () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "logging:\n  level: info\n", { mode: 0o600 });

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    // Round-trip through the schema parser — failure here means the
    // shape doesn't match design §9.2.
    const parsed = ConfigObserveAuditRecordSchema.parse(record);
    expect(parsed.event).toBe("config.observe");
    expect(parsed.source).toBe("config-io");
    expect(parsed.callerSource).toBe("daemon-bootstrap");
    expect(parsed.configPath).toBe(cfgPath);
    // Caller-provenance fields populated from process introspection.
    expect(typeof parsed.pid).toBe("number");
    expect(parsed.pid).toBeGreaterThan(0);
    expect(Array.isArray(parsed.argv)).toBe(true);
    expect(Array.isArray(parsed.execArgv)).toBe(true);
    expect(Array.isArray(parsed.suspicious)).toBe(true);
  });

  it("produces a valid record for a non-existent config file (caller-provenance fields still populated)", () => {
    const cfgPath = path.join(tmpDir, "does-not-exist.yaml");
    expect(fs.existsSync(cfgPath)).toBe(false);

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    const parsed = ConfigObserveAuditRecordSchema.parse(record);
    // The observe record itself does not embed exists/hash in the
    // current schema — those would be a future extension. The record
    // is still well-formed (caller provenance + identity fields).
    expect(parsed.configPath).toBe(cfgPath);
    expect(parsed.callerSource).toBe("daemon-bootstrap");
  });
});

describe("createConfigObserveAuditRecord — entryScript threading (260521-0bn)", () => {
  it("forwards entryScript into the suspicious heuristic so daemon.js path clears non-comis-argv under pm2", () => {
    // Cannot inject argv directly into createConfigObserveAuditRecord — it
    // reads process.argv internally. Instead assert the surface contract:
    // passing entryScript MUST NOT throw and the resulting record's
    // `suspicious` shape stays well-formed. The actual non-comis-argv
    // clearing is asserted in suspicious.test.ts (existing 260520-wcf
    // coverage) where the heuristic is exercised directly.
    const record = createConfigObserveAuditRecord({
      filePath: "/example/.comis/config.yaml",
      callerSource: "daemon-bootstrap",
      entryScript: "/example/dist/daemon.js",
    });
    expect(record.event).toBe("config.observe");
    expect(Array.isArray(record.suspicious)).toBe(true);
  });

  it("omits entryScript when undefined — preserves existing (pre-260521-0bn) behavior", () => {
    const record = createConfigObserveAuditRecord({
      filePath: "/example/.comis/config.yaml",
      callerSource: "daemon-bootstrap",
    });
    expect(record.event).toBe("config.observe");
    expect(Array.isArray(record.suspicious)).toBe(true);
  });
});

describe("createConfigObserveAuditRecord — §9.2 observation + valid + recovery", () => {
  it("projects the observation cluster onto the file-state / LKG / backup blocks", () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });

    const snapshot = {
      hash: "0".repeat(64),
      bytes: 4,
      mtimeMs: 1_779_148_800_000,
      ctimeMs: 1_779_148_800_000,
      dev: "64768",
      ino: "999999",
      mode: 0o600,
      nlink: 1,
      uid: 1000,
      gid: 1000,
    };
    const lkgSnap = {
      ...snapshot,
      hash: "1".repeat(64),
      bytes: 8,
    };
    const bakSnap = {
      ...snapshot,
      hash: "2".repeat(64),
      bytes: 12,
    };

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
      observation: {
        exists: true,
        snapshot,
        lkg: lkgSnap,
        backup: bakSnap,
      },
      valid: false,
    });

    const parsed = ConfigObserveAuditRecordSchema.parse(record);
    expect(parsed.exists).toBe(true);
    expect(parsed.valid).toBe(false);
    expect(parsed.hash).toBe("0".repeat(64));
    expect(parsed.bytes).toBe(4);
    expect(parsed.dev).toBe("64768");
    expect(parsed.ino).toBe("999999");
    expect(parsed.mode).toBe(0o600);
    // LKG triple — narrowed to {hash, bytes, mtimeMs}.
    expect(parsed.lastKnownGoodHash).toBe("1".repeat(64));
    expect(parsed.lastKnownGoodBytes).toBe(8);
    // Backup triple — narrowed to {hash, bytes, mtimeMs}.
    expect(parsed.backupHash).toBe("2".repeat(64));
    expect(parsed.backupBytes).toBe(12);
  });

  it("defaults to the no-recovery shape when recovery param is omitted", () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    const parsed = ConfigObserveAuditRecordSchema.parse(record);
    expect(parsed.clobberedPath).toBeNull();
    expect(parsed.restoredFromBackup).toBe(false);
    expect(parsed.restoredBackupPath).toBeNull();
    expect(parsed.restoreErrorCode).toBeNull();
    expect(parsed.restoreErrorMessage).toBeNull();
  });

  it("defaults `valid` to true when omitted (non-bootstrap read-only callers)", () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });
    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "cli-config-show",
    });
    expect(record.valid).toBe(true);
  });

  it("propagates an explicit recovery cluster onto the record", () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });
    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
      recovery: {
        clobberedPath: "/path/to/clobbered.yaml",
        restoredFromBackup: true,
        restoredBackupPath: "/path/to/restored.bak.yaml",
        restoreErrorCode: "ENOENT",
        restoreErrorMessage: "no such file",
      },
    });
    const parsed = ConfigObserveAuditRecordSchema.parse(record);
    expect(parsed.clobberedPath).toBe("/path/to/clobbered.yaml");
    expect(parsed.restoredFromBackup).toBe(true);
    expect(parsed.restoredBackupPath).toBe("/path/to/restored.bak.yaml");
    expect(parsed.restoreErrorCode).toBe("ENOENT");
    expect(parsed.restoreErrorMessage).toBe("no such file");
  });
});

describe("appendConfigObserveAuditRecord — disk persistence", () => {
  it("appends a single JSONL line that round-trips through ConfigObserveAuditRecordSchema", async () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "logging:\n  level: info\n", { mode: 0o600 });
    const auditPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    const result = await appendConfigObserveAuditRecord({
      filePath: auditPath,
      record,
    });
    expect(result.ok).toBe(true);

    const raw = fs.readFileSync(auditPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = ConfigObserveAuditRecordSchema.parse(JSON.parse(raw.trim()));
    expect(parsed.event).toBe("config.observe");
    expect(parsed.callerSource).toBe("daemon-bootstrap");
    expect(parsed.configPath).toBe(cfgPath);
  });

  it("creates the parent dir at mode 0o700 via the shared ensureParentDir helper", async () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "logging:\n  level: info\n", { mode: 0o600 });
    const auditPath = path.join(tmpDir, "nested", "logs", "config-audit.jsonl");

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    await appendConfigObserveAuditRecord({
      filePath: auditPath,
      record,
    });

    const parentDir = path.dirname(auditPath);
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700);
  });

  it("writes argv redacted via redactConfigAuditArgv (no secret-flag leakage)", async () => {
    // We can't inject argv directly into createConfigObserveAuditRecord
    // because it reads process.argv at the trust boundary. Instead, we
    // hand-build a record with a secret-flag-shaped argv and verify the
    // appender redacts it.
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });
    const auditPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    const record: ConfigObserveAuditRecord = {
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: new Date().toISOString(),
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: cfgPath,
      callerSource: "test-direct",
      pid: 12345,
      ppid: 1,
      argv: ["comis", "--api-key=sk-secret-abc1234567890"],
      cwd: tmpDir,
      execArgv: [],
      watchMode: false,
      exists: false,
      valid: true,
      hash: null,
      bytes: null,
      mtimeMs: null,
      ctimeMs: null,
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
      lastKnownGoodHash: null,
      lastKnownGoodBytes: null,
      lastKnownGoodMtimeMs: null,
      backupHash: null,
      backupBytes: null,
      backupMtimeMs: null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
      suspicious: [],
    };

    await appendConfigObserveAuditRecord({
      filePath: auditPath,
      record,
    });

    const raw = fs.readFileSync(auditPath, "utf-8");
    expect(raw).not.toContain("sk-secret-abc1234567890");
    expect(raw).toContain("--api-key=***");
  });

  it("rotates when the existing file size + new record exceeds rotateAtBytes", async () => {
    const cfgPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfgPath, "k: v\n", { mode: 0o600 });
    const auditPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    // Seed the audit file at near-cap so the next append triggers rotation.
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(auditPath, "x".repeat(900) + "\n", { mode: 0o600 });

    const record = createConfigObserveAuditRecord({
      filePath: cfgPath,
      callerSource: "daemon-bootstrap",
    });

    await appendConfigObserveAuditRecord({
      filePath: auditPath,
      record,
      rotateAtBytes: 1024,
      keepRotated: 3,
    });

    // After rotation: main file holds the new record only; .1 holds the
    // pre-rotation seed content. We don't assert the new file's size
    // against the cap — observe records can legitimately exceed the
    // per-rotation cap (argv + cwd carry full paths). The rotation
    // invariant we're proving is: the pre-rotation content moved to
    // .1, and the main file is freshly built around the new record.
    expect(fs.existsSync(auditPath + ".1")).toBe(true);
    const rotatedSeed = fs.readFileSync(auditPath + ".1", "utf-8");
    expect(rotatedSeed).toContain("xxxxx"); // the pre-rotation seed
    const newContent = fs.readFileSync(auditPath, "utf-8");
    expect(newContent).toContain("comis-config-audit");
    expect(newContent).toContain("config.observe");
    // New file is exactly one record line (no carry-over from seed).
    expect(newContent.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });
});
