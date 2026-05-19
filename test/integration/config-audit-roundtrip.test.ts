// SPDX-License-Identifier: Apache-2.0
// Plan 45-05: config-audit roundtrip integration.
//
// Tests the persisted-write pipeline end-to-end without spinning up a
// full daemon process. Two gating cases:
//
//   1. Roundtrip success: build a ConfigWriteAuditRecord via the
//      two-phase pattern (createConfigWriteAuditRecordBase +
//      finalizeConfigWriteAuditRecord), append it via
//      appendConfigAuditRecordSync, then list it back via the
//      reader path used by config.audit.list (parse the JSONL
//      directly here). Asserts result: "rename" flows through.
//      Directly gates ROADMAP Phase 45 success criterion #3
//      (TRAJ-08..10).
//
//   2. Rejected-write recording: simulate a config-write rejection
//      (validation failure / immutable path), finalize with
//      result: "rejected", append, and assert the record carries
//      result: "rejected".
//
// Per AGENTS.md section 2.5: imports from dist/ -- requires pnpm
// build first. Vitest aliases @comis/* to packages/*/dist/index.js.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  appendConfigAuditRecordSync,
  type ConfigWriteAuditRecord,
} from "@comis/observability";

let tmpDir: string;
let configPath: string;
let auditLogPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-audit-int-"));
  configPath = path.join(tmpDir, "config.yaml");
  auditLogPath = path.join(tmpDir, "config-audit.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readAuditRecords(file: string): ConfigWriteAuditRecord[] {
  const raw = fs.readFileSync(file, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ConfigWriteAuditRecord);
}

describe("config-audit roundtrip integration", () => {
  it("records a successful config.write -- rename outcome with non-empty hash diff (TRAJ-08..10)", () => {
    // Seed the config with an initial value (the "before" state).
    fs.writeFileSync(configPath, "logging:\n  level: info\n", { mode: 0o600 });

    // Two-phase pattern: BEFORE the write, capture provenance + previous-state.
    const base = createConfigWriteAuditRecordBase({
      source: "config-patch-rpc",
      configPath,
      pid: 99_999,
      ppid: 1,
      argv: [
        "node",
        "comis",
        "config",
        "set",
        "logging.level",
        "debug",
      ],
      cwd: "/home/test",
      execArgv: [],
      watchMode: false,
    });

    // Simulate the actual write (the daemon's config-handlers would
    // do this; we do it directly here).
    fs.writeFileSync(configPath, "logging:\n  level: debug\n", { mode: 0o600 });

    // AFTER the write: finalize and append.
    const record = finalizeConfigWriteAuditRecord(base, { result: "rename" });
    const appendResult = appendConfigAuditRecordSync({
      filePath: auditLogPath,
      record,
    });
    expect(appendResult.ok).toBe(true);

    // Read back via the same parse path config.audit.list uses.
    const records = readAuditRecords(auditLogPath);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.result).toBe("rename");
    expect(r.source).toBe("config-patch-rpc");
    expect(r.configPath).toBe(configPath);
    expect(r.existsBefore).toBe(true);
    // Hash diff: previousHash !== nextHash because the file content changed.
    expect(typeof r.previousHash).toBe("string");
    expect(typeof r.nextHash).toBe("string");
    expect(r.previousHash).not.toBe(r.nextHash);
    // Caller provenance preserved.
    expect(r.pid).toBe(99_999);
    expect(r.argv.length).toBeGreaterThan(0);
  });

  it("records a rejected config.write -- rejected outcome with no file mutation", () => {
    fs.writeFileSync(configPath, "logging:\n  level: info\n", { mode: 0o600 });

    const base = createConfigWriteAuditRecordBase({
      source: "config-patch-rpc",
      configPath,
      pid: 12_345,
      ppid: 1,
      argv: ["node", "comis", "config", "set", "bogus.key", "value"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: false,
    });

    // No write happens -- the validation rejection prevented the file
    // from being mutated. The audit record still reflects the
    // attempt.
    const record = finalizeConfigWriteAuditRecord(base, { result: "rejected" });
    const appendResult = appendConfigAuditRecordSync({
      filePath: auditLogPath,
      record,
    });
    expect(appendResult.ok).toBe(true);

    const records = readAuditRecords(auditLogPath);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.result).toBe("rejected");
    // Because the file was not mutated, previousHash === nextHash.
    expect(r.previousHash).toBe(r.nextHash);
    expect(r.previousBytes).toBe(r.nextBytes);
  });
});
