// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bindConfigAuditHandlers } from "./config-audit.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import type { ObservabilityApiDeps } from "../types.js";

function makeDeps(): ObservabilityApiDeps {
  return {
    container: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub for handler invocation
    } as any,
    logger: createMockLogger(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
  } as any;
}

let tmpDir: string;
let auditLogPath: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-audit-rpc-test-"));
  auditLogPath = path.join(tmpDir, "config-audit.jsonl");
  // eslint-disable-next-line no-restricted-syntax -- test fixture env override
  prevEnv = process.env["COMIS_CONFIG_AUDIT_LOG"];
  // eslint-disable-next-line no-restricted-syntax -- test fixture env override
  process.env["COMIS_CONFIG_AUDIT_LOG"] = auditLogPath;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
  if (prevEnv === undefined) delete process.env["COMIS_CONFIG_AUDIT_LOG"];
  // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
  else process.env["COMIS_CONFIG_AUDIT_LOG"] = prevEnv;
});

function writeRecord(
  pid: number,
  tsMs: number,
  options: { suspicious?: string[]; argv?: string[] } = {},
): void {
  const record = {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    phase: "write",
    source: "config-patch-rpc",
    configPath: "/home/test/.comis/config.yaml",
    pid,
    ppid: 1,
    argv: options.argv ?? ["comis", "config", "set", "logging.level", "debug"],
    cwd: "/home/test",
    execArgv: [],
    watchMode: false,
    existsBefore: true,
    previousHash: "a".repeat(64),
    previousBytes: 64,
    previousStat: null,
    hasMetaBefore: false,
    nextHash: "b".repeat(64),
    nextBytes: 128,
    nextStat: null,
    hasMetaAfter: false,
    changedPathCount: 1,
    result: "rename",
    suspicious: options.suspicious ?? [],
    ts: new Date(tsMs).toISOString(),
    tsMs,
  };
  fs.appendFileSync(auditLogPath, JSON.stringify(record) + "\n", {
    mode: 0o600,
  });
}

describe("config.audit.list handler", () => {
  it("list filters records by since=1h to only include records within the window", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    const now = Date.now();
    writeRecord(1, now - 2 * 60 * 60 * 1000); // 2h old — outside 1h window
    writeRecord(2, now - 10 * 60 * 1000); // 10 min old — inside
    writeRecord(3, now); // now — inside

    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.list"]!({
      since: "1h",
      _trustLevel: "admin",
    })) as { records: Array<{ pid: number }> };
    expect(result.records).toHaveLength(2);
    const pids = result.records.map((r) => r.pid).sort();
    expect(pids).toEqual([2, 3]);
  });

  it("list filters by suspiciousOnly=true", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    const now = Date.now();
    writeRecord(1, now, { suspicious: [] });
    writeRecord(2, now, { suspicious: ["unknown-binary"] });

    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.list"]!({
      suspiciousOnly: true,
      _trustLevel: "admin",
    })) as { records: Array<{ pid: number }> };
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.pid).toBe(2);
  });

  it("list filters by pid", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    const now = Date.now();
    writeRecord(100, now);
    writeRecord(200, now);
    writeRecord(300, now);

    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.list"]!({
      pid: 200,
      _trustLevel: "admin",
    })) as { records: Array<{ pid: number }> };
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.pid).toBe(200);
  });

  it("list rejects non-admin trust level", async () => {
    const handlers = bindConfigAuditHandlers(makeDeps());
    await expect(
      handlers["config.audit.list"]!({ _trustLevel: "viewer" }),
    ).rejects.toThrow(/admin/i);
  });

  it("list returns empty records array when the audit log does not exist", async () => {
    // No file written.
    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.list"]!({
      _trustLevel: "admin",
    })) as { records: unknown[] };
    expect(result.records).toEqual([]);
  });
});

describe("config.audit.scrub handler", () => {
  it("scrub dry-run does not modify the file", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    writeRecord(1, Date.now(), {
      argv: ["comis", "--api-key=sk-raw-secret-payload"],
    });
    const before = fs.readFileSync(auditLogPath, "utf-8");

    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.scrub"]!({
      dryRun: true,
      _trustLevel: "admin",
    })) as { rewrittenRecords: number; aborted: boolean };
    expect(result.aborted).toBe(false);

    const after = fs.readFileSync(auditLogPath, "utf-8");
    expect(after).toBe(before);
    // Dry-run still surfaces the raw value because it didn't rewrite.
    expect(after).toContain("sk-raw-secret-payload");
  });

  it("scrub apply (dryRun=false) modifies the file and reports rewrittenRecords", async () => {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
    writeRecord(1, Date.now(), {
      argv: ["comis", "--api-key=sk-raw-secret-payload"],
    });

    const handlers = bindConfigAuditHandlers(makeDeps());
    const result = (await handlers["config.audit.scrub"]!({
      _trustLevel: "admin",
    })) as { rewrittenRecords: number; aborted: boolean };
    expect(result.aborted).toBe(false);
    expect(result.rewrittenRecords).toBe(1);

    const after = fs.readFileSync(auditLogPath, "utf-8");
    expect(after).not.toContain("sk-raw-secret-payload");
    expect(after).toContain("--api-key=***");
  });

  it("scrub rejects non-admin trust level", async () => {
    const handlers = bindConfigAuditHandlers(makeDeps());
    await expect(
      handlers["config.audit.scrub"]!({ _trustLevel: "viewer" }),
    ).rejects.toThrow(/admin/i);
  });
});
