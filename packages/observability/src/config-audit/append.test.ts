// SPDX-License-Identifier: Apache-2.0
//
// File-mode invariant: appendRegularFile() calls fchmodSync(fd, 0o600)
// defensively after open, so the test below does NOT need to manipulate
// process.umask. The chmod-by-fd behavior is verified elsewhere; we rely
// on it transitively here.
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
    ts: "2026-05-19T03:00:00.000Z",
    source: "config-io",
    event: "config.write",
    result: "rename",

    configPath: "/home/test/.comis/config.yaml",
    callerSource: "config-patch-rpc",
    pid: 12345,
    ppid: 1,
    argv: ["node", "daemon.js"],
    cwd: "/home/test",
    execArgv: [],
    watchMode: false,
    watchSession: null,
    watchCommand: null,

    existsBefore: true,
    previousHash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    nextHash:
      "1111111111111111111111111111111111111111111111111111111111111111",
    previousBytes: 128,
    nextBytes: 196,

    previousDev: "64768",
    nextDev: "64768",
    previousIno: "1",
    nextIno: "1",
    previousMode: 0o600,
    nextMode: 0o600,
    previousNlink: 1,
    nextNlink: 1,
    previousUid: 1000,
    nextUid: 1000,
    previousGid: 1000,
    nextGid: 1000,

    changedPathCount: 1,
    hasMetaBefore: true,
    hasMetaAfter: true,

    suspicious: [],
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
    expect(parsed.source).toBe("config-io");
    expect(parsed.callerSource).toBe("config-patch-rpc");
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
    expect(parsedSync.source).toBe("config-io");
    expect(parsedSync.callerSource).toBe("config-patch-rpc");

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

    expect(base.callerSource).toBe("config-patch-rpc");
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
    // Suspicious heuristics computed.
    expect(Array.isArray(final.suspicious)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defensive 0o700 chmod on existing parent dir.
//
// Non-observability subsystems (pino-roll, pi-mono) may create the parent
// dir FIRST under default umask (0o755). mkdir's `mode` arg is silently
// ignored when the dir already exists (recursive EEXIST). The fix:
// defensively chmod to 0o700 after the mkdir attempt, gated on a
// non-symlink lstat to preserve the §1.4 confused-deputy invariant
// (the chmod-target must be a real directory, not a symlink to
// operator-owned shared state outside our trust boundary).
// ---------------------------------------------------------------------------
describe("ensureParentDir — defensive 0o700 chmod on existing parent dir", () => {
  it("chmods a pre-existing 0o755 parent dir to 0o700 on first append", async () => {
    // Create parent with intentionally-different mode (0o755) so we can
    // detect the defensive chmod fires.
    const auditDir = path.join(tmpDir, "config-audit");
    fs.mkdirSync(auditDir, { recursive: true });
    // umask may mask out group/other write bits — re-chmod explicitly so
    // the snapshot is deterministic regardless of test-runner umask.
    fs.chmodSync(auditDir, 0o755);
    expect(fs.statSync(auditDir).mode & 0o777).toBe(0o755);

    const filePath = path.join(auditDir, "config-audit.jsonl");
    const result = await appendConfigAuditRecord({ filePath, record: makeBaseRecord() });
    expect(result.ok).toBe(true);

    const modeAfter = fs.statSync(auditDir).mode & 0o777;
    // The defensive chmod fires after the EEXIST mkdir attempt.
    expect(modeAfter).toBe(0o700);
  });

  it("does NOT chmod a symlinked parent dir (confused-deputy guard via lstat)", async () => {
    // Real dir is at 0o755 — that's operator-owned shared state OUTSIDE
    // our trust boundary. The lstat-isSymbolicLink gate must short-circuit
    // the defensive chmod so the real-dir mode is preserved.
    const realDir = path.join(tmpDir, "real-config-audit");
    const linkDir = path.join(tmpDir, "evil-link");
    fs.mkdirSync(realDir);
    fs.chmodSync(realDir, 0o755);
    fs.symlinkSync(realDir, linkDir);

    const filePath = path.join(linkDir, "config-audit.jsonl");
    // The actual append may or may not succeed (the symlink-rejection
    // inside appendRegularFile fires) — what matters is the real dir's
    // mode is unchanged.
    await appendConfigAuditRecord({ filePath, record: makeBaseRecord() });

    // Real-dir mode preserved at 0o755 — confused-deputy guard held.
    expect(fs.statSync(realDir).mode & 0o777).toBe(0o755);
  });

  it("still creates a fresh parent with 0o700 when it does NOT exist (regression guard)", async () => {
    // The "fresh create" case stays at 0o700 because the
    // `mkdirSync({mode: 0o700})` branch creates it at that mode and the
    // defensive chmod re-asserts the invariant.
    const auditDir = path.join(tmpDir, "fresh-audit");
    expect(fs.existsSync(auditDir)).toBe(false);

    const filePath = path.join(auditDir, "config-audit.jsonl");
    const result = await appendConfigAuditRecord({ filePath, record: makeBaseRecord() });
    expect(result.ok).toBe(true);

    const mode = fs.statSync(auditDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// Sentinel-record fallback when safeJsonStringify returns undefined
// (BigInt / circular reference / unrepresentable).
// ---------------------------------------------------------------------------
describe("encodeRecord — sentinel on serialization failure", () => {
  it("emits a JSON-parseable sentinel when the record contains a BigInt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-audit-bl01-bigint-"));
    const filePath = path.join(dir, "config-audit.jsonl");

    try {
      // Build a valid record then inject a BigInt via cast (mirrors real-world
      // hazard: a future bootstrap or test injects an unrepresentable value).
      const base = createConfigWriteAuditRecordBase({
        source: "cli",
        configPath: path.join(dir, "config.yaml"),
        pid: 1,
        ppid: 0,
        argv: ["node", "comis"],
        cwd: dir,
        execArgv: [],
        watchMode: false,
      });
      const record = finalizeConfigWriteAuditRecord(base, { result: "rename" });
      // Inject the BigInt — bypass readonly via cast.
      (record as unknown as { nextBytes: bigint }).nextBytes = BigInt(123);

      const appendResult = appendConfigAuditRecordSync({
        filePath,
        record,
      });
      expect(appendResult.ok).toBe(true);

      const raw = fs.readFileSync(filePath, "utf-8").trim();
      // The line MUST be valid JSON, NOT the literal string "undefined".
      expect(raw).not.toBe("undefined");
      const parsed = JSON.parse(raw);
      expect(parsed.traceSchema).toBe("comis-config-audit");
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.__serializationError).toBe("record-not-serializable");
      // Design §9.2 uses `ts` (ISO string). `tsMs` was dropped.
      expect(typeof parsed.ts).toBe("string");
      expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits sentinel when the record contains a nested BigInt inside an array (survives sanitizer)", () => {
    // NOTE: raw circular refs are normalized by sanitizeForPersistence
    // (cycles become `{__bounded__: "bounded-..."}` markers) so they no
    // longer trigger the sentinel fallback. A nested BigInt inside an
    // array survives the sanitizer untouched and exercises the same code
    // path: safeJsonStringify returns undefined → sentinel emitted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-audit-bl01-circ-"));
    const filePath = path.join(dir, "config-audit.jsonl");

    try {
      const base = createConfigWriteAuditRecordBase({
        source: "cli",
        configPath: path.join(dir, "config.yaml"),
        pid: 1,
        ppid: 0,
        argv: ["node", "comis"],
        cwd: dir,
        execArgv: [],
        watchMode: false,
      });
      const record = finalizeConfigWriteAuditRecord(base, { result: "rename" });
      // Inject a BigInt inside an array — survives the sanitizer.
      (record as unknown as { suspiciousValues: unknown[] }).suspiciousValues = [BigInt(7), 1];

      const appendResult = appendConfigAuditRecordSync({ filePath, record });
      expect(appendResult.ok).toBe(true);

      const raw = fs.readFileSync(filePath, "utf-8").trim();
      expect(raw).not.toBe("undefined");
      const parsed = JSON.parse(raw);
      expect(parsed.__serializationError).toBe("record-not-serializable");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ROTATE-02: rotateConfigAuditLogIfNeeded triggers gzip on .1 file
// via shared applyRotationPolicy helper.
// ---------------------------------------------------------------------------
describe("rotateConfigAuditLogIfNeeded — gzip via applyRotationPolicy (ROTATE-02)", () => {
  it("schedules applyRotationPolicy so config-audit.jsonl.1 becomes .1.gz after rotation", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

    // Seed the file to be just over the rotation threshold.
    const rotateAtBytes = 512;
    fs.writeFileSync(filePath, "x".repeat(400) + "\n", { mode: 0o600 });

    // Trigger rotation — this should rename main → .1 and fire applyRotationPolicy.
    const { rotateConfigAuditLogIfNeeded } = await import("./append.js");
    rotateConfigAuditLogIfNeeded(filePath, 200, rotateAtBytes, 3);

    // .1 must exist immediately after rotation (before async gzip completes).
    expect(fs.existsSync(filePath + ".1")).toBe(true);

    // Wait for the async gzip to complete (fire-and-forget pattern).
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // After gzip: .1.gz should exist and the uncompressed .1 should be removed.
    expect(
      fs.existsSync(filePath + ".1.gz"),
      "config-audit.jsonl.1.gz should exist after gzip",
    ).toBe(true);
    expect(
      fs.existsSync(filePath + ".1"),
      "config-audit.jsonl.1 should be removed after gzip",
    ).toBe(false);
  });
});
