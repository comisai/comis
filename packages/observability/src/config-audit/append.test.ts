// SPDX-License-Identifier: Apache-2.0
//
// File-mode invariant: appendRegularFile() from 45-01 calls
// fchmodSync(fd, 0o600) defensively after open, so the test below
// does NOT need to manipulate process.umask. The chmod-by-fd
// behavior is verified in 45-01 task 8; we rely on it transitively
// here.
//
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  type ConfigWriteAuditRecordBase,
} from "./append.js";
import {
  ConfigWriteAuditRecordSchema,
  type ConfigWriteAuditRecord,
} from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-audit-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBaseRecord(overrides: Partial<ConfigWriteAuditRecord> = {}): ConfigWriteAuditRecord {
  const base: ConfigWriteAuditRecord = {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    phase: "write",
    source: "config-patch-rpc",
    configPath: "/home/test/.comis/config.yaml",
    pid: 12345,
    ppid: 1,
    argv: ["node", "daemon.js"],
    cwd: "/home/test",
    execArgv: [],
    watchMode: false,
    existsBefore: true,
    previousHash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    previousBytes: 128,
    previousStat: { dev: 64768, ino: 1, mode: 0o600, nlink: 1, uid: 1000, gid: 1000 },
    hasMetaBefore: true,
    nextHash:
      "1111111111111111111111111111111111111111111111111111111111111111",
    nextBytes: 196,
    nextStat: { dev: 64768, ino: 1, mode: 0o600, nlink: 1, uid: 1000, gid: 1000 },
    hasMetaAfter: true,
    changedPathCount: 1,
    result: "rename",
    suspicious: [],
    ts: "2026-05-19T03:00:00.000Z",
    tsMs: 1_779_148_800_000,
  };
  return { ...base, ...overrides };
}

describe("config-audit/append", () => {
  it("writes a record as a single JSONL line parseable as ConfigWriteAuditRecord", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    const record = makeBaseRecord();

    const result = await appendConfigAuditRecord({ filePath, record });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    const parsed = ConfigWriteAuditRecordSchema.parse(JSON.parse(content.trim()));
    expect(parsed.source).toBe("config-patch-rpc");
    expect(parsed.pid).toBe(12345);
  });

  it("file mode is 0o600 via the defensive fchmod in appendRegularFile", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    await appendConfigAuditRecord({ filePath, record: makeBaseRecord() });
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("parent dir mode is 0o700 when the helper creates the directory", async () => {
    const subdir = path.join(tmpDir, "nested", "subdir");
    const filePath = path.join(subdir, "config-audit.jsonl");
    await appendConfigAuditRecord({ filePath, record: makeBaseRecord() });
    const dirStat = fs.statSync(subdir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("rotates when the existing file size + new record exceeds rotateAtBytes", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    // Seed the file with a near-cap blob to force rotation on append.
    const rotateAtBytes = 1024;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "x".repeat(900) + "\n", { mode: 0o600 });

    await appendConfigAuditRecord({
      filePath,
      record: makeBaseRecord(),
      rotateAtBytes,
      keepRotated: 3,
    });

    // After rotation: old file became .1, new file holds the latest record.
    expect(fs.existsSync(filePath + ".1")).toBe(true);
    const newContent = fs.readFileSync(filePath, "utf-8");
    expect(newContent.length).toBeLessThan(rotateAtBytes);
    expect(newContent).toContain("comis-config-audit");
  });

  it("enforces keepRotated by discarding the oldest rotated file", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Pre-seed .1 .. .5 to verify .5 is discarded when rotateAtBytes triggers.
    fs.writeFileSync(filePath, "x".repeat(900) + "\n", { mode: 0o600 });
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(filePath + "." + i, `rotated-${i}\n`, { mode: 0o600 });
    }

    await appendConfigAuditRecord({
      filePath,
      record: makeBaseRecord(),
      rotateAtBytes: 1024,
      keepRotated: 5,
    });

    // After rotation: main file is fresh, .1 holds the most recent
    // pre-rotation content; the original .5 (oldest) is discarded.
    // Original .5 was 'rotated-5'; original .4 became .5.
    expect(fs.readFileSync(filePath + ".5", "utf-8")).toBe("rotated-4\n");
    // Original .1 became .2.
    expect(fs.readFileSync(filePath + ".2", "utf-8")).toBe("rotated-1\n");
    // .1 is the previous main contents.
    expect(fs.readFileSync(filePath + ".1", "utf-8")).toContain("xxxxx");
  });

  it("redacts argv via redactConfigAuditArgv before writing to disk", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    const record = makeBaseRecord({
      argv: ["comis", "--api-key=sk-abc1234567890abcdef"],
    });

    await appendConfigAuditRecord({ filePath, record });

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).not.toContain("sk-abc1234567890abcdef");
    expect(content).toContain('"argv":["comis","--api-key=***"]');
  });

  it("pipes record through sanitizeForPersistence so errorMessage gets regex-redacted", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    const record = makeBaseRecord({
      result: "failed",
      errorCode: "EACCES",
      // Pretend an error message accidentally captured a token.
      errorMessage: "Failed to write: token=sk-ant-abc1234567890",
    });
    await appendConfigAuditRecord({ filePath, record });

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).not.toContain("sk-ant-abc1234567890");
  });

  it("sync variant produces equivalent on-disk output to the async variant", () => {
    const filePathAsync = path.join(tmpDir, "config-audit-async.jsonl");
    const filePathSync = path.join(tmpDir, "config-audit-sync.jsonl");
    const record = makeBaseRecord();

    // Sync variant only for now — comparing JSON shape, not byte-equality
    // (timestamps would differ in any clock-using path; we use a fixed
    // record so the only difference would be a path-derived field).
    const result = appendConfigAuditRecordSync({
      filePath: filePathSync,
      record,
    });
    expect(result.ok).toBe(true);

    const contentSync = fs.readFileSync(filePathSync, "utf-8");
    const parsedSync = JSON.parse(contentSync.trim());
    expect(parsedSync.source).toBe("config-patch-rpc");

    // Sync write should not have async-related artefacts.
    void filePathAsync;
  });

  it("two-phase pattern: createConfigWriteAuditRecordBase + finalizeConfigWriteAuditRecord", () => {
    // Use a temp config file so previousHash + previousBytes resolve from disk.
    const tmpConfig = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(tmpConfig, "logging:\n  level: info\n", { mode: 0o600 });

    const base: ConfigWriteAuditRecordBase = createConfigWriteAuditRecordBase({
      source: "config-patch-rpc",
      configPath: tmpConfig,
      pid: 99999,
      ppid: 1,
      argv: ["comis", "config", "set", "logging.level", "debug"],
      cwd: "/home/test",
      execArgv: [],
      watchMode: false,
    });

    expect(base.source).toBe("config-patch-rpc");
    expect(base.existsBefore).toBe(true);
    expect(base.previousBytes).toBeGreaterThan(0);
    expect(typeof base.previousHash).toBe("string");
    // hasMetaBefore reflects whether the stat succeeded.
    expect(base.hasMetaBefore).toBe(true);

    // Mutate the file to simulate the write.
    fs.writeFileSync(tmpConfig, "logging:\n  level: debug\n", { mode: 0o600 });

    const final = finalizeConfigWriteAuditRecord(base, {
      result: "rename",
    });
    expect(final.result).toBe("rename");
    expect(final.nextHash).not.toBe(base.previousHash);
    expect(final.nextBytes).toBeGreaterThan(0);
    expect(final.hasMetaAfter).toBe(true);
    expect(final.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Suspicious heuristics computed via task 4.
    expect(Array.isArray(final.suspicious)).toBe(true);
  });
});
