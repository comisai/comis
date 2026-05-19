// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scrubConfigAuditLog } from "./scrub.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-scrub-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeValidRecordLine(extras: Record<string, unknown> = {}): string {
  const record = {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    phase: "write",
    source: "config-patch-rpc",
    configPath: "/home/test/.comis/config.yaml",
    pid: 1,
    ppid: 0,
    argv: ["comis", "--api-key=sk-abc1234567890"],
    cwd: "/home/test",
    execArgv: [],
    watchMode: false,
    existsBefore: true,
    previousHash: "abc",
    previousBytes: 64,
    previousStat: null,
    hasMetaBefore: false,
    nextHash: "def",
    nextBytes: 128,
    nextStat: null,
    hasMetaAfter: false,
    changedPathCount: 1,
    result: "rename",
    suspicious: [],
    ts: "2026-05-19T03:00:00.000Z",
    tsMs: 1779148800000,
    ...extras,
  };
  return JSON.stringify(record) + "\n";
}

describe("config-audit/scrub", () => {
  it("is idempotent on a clean file — second scrub does nothing", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    // Two records: one with a raw secret in argv, one already masked.
    fs.writeFileSync(
      filePath,
      makeValidRecordLine({ argv: ["comis", "--api-key=sk-raw"] }) +
        makeValidRecordLine({ argv: ["comis", "--api-key=***"] }),
      { mode: 0o600 },
    );

    const first = await scrubConfigAuditLog({ filePath });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.aborted).toBe(false);
      expect(first.value.rewrittenRecords).toBe(2);
    }
    const afterFirst = fs.readFileSync(filePath, "utf-8");

    const second = await scrubConfigAuditLog({ filePath });
    expect(second.ok).toBe(true);
    const afterSecond = fs.readFileSync(filePath, "utf-8");
    expect(afterSecond).toBe(afterFirst);
  });

  it("aborts when a concurrent append grew the file between read and write", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    fs.writeFileSync(filePath, makeValidRecordLine(), { mode: 0o600 });

    // Inject a concurrent append between the scrubber's read and
    // write by passing an injectedAfterRead callback.
    const result = await scrubConfigAuditLog({
      filePath,
      injectedAfterRead: () => {
        fs.appendFileSync(filePath, makeValidRecordLine(), { mode: 0o600 });
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.aborted).toBe(true);
    }
  });

  it("preserves malformed lines verbatim and increments skippedMalformed", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    const malformed = "{not valid JSON\n";
    const valid = makeValidRecordLine();
    fs.writeFileSync(filePath, malformed + valid, { mode: 0o600 });

    const result = await scrubConfigAuditLog({ filePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skippedMalformed).toBeGreaterThanOrEqual(1);
    }

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).toContain("{not valid JSON");
    expect(after).toContain('"traceSchema":"comis-config-audit"');
  });

  it("uses an atomic rename pattern with a .scrub.tmp intermediate path", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    fs.writeFileSync(filePath, makeValidRecordLine(), { mode: 0o600 });
    const result = await scrubConfigAuditLog({ filePath });
    expect(result.ok).toBe(true);
    // After scrub, the tmp file MUST NOT exist (it was renamed into place).
    expect(fs.existsSync(filePath + ".scrub.tmp")).toBe(false);
  });

  it("redacts argv in existing records via the argv redactor", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    fs.writeFileSync(
      filePath,
      makeValidRecordLine({
        argv: ["comis", "--api-key=sk-raw-secret-payload"],
      }),
      { mode: 0o600 },
    );

    await scrubConfigAuditLog({ filePath });

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).not.toContain("sk-raw-secret-payload");
    expect(after).toContain('"--api-key=***"');
  });
});

// ---------------------------------------------------------------------------
// Symlink-safe scrub tmp-write — unit-level guard.
// ---------------------------------------------------------------------------
describe("scrubConfigAuditLog — symlink-safe tmp-write", () => {
  it("does NOT follow a pre-staged symlink at the .scrub.tmp path (unit-level)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-bl02-unit-"));
    const filePath = path.join(dir, "config-audit.jsonl");
    const tmpPath = filePath + ".scrub.tmp";
    const sentinel = path.join(dir, "sentinel-do-not-touch");

    try {
      // Write a valid audit-log file with one parseable record.
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          traceSchema: "comis-config-audit",
          schemaVersion: 1,
          argv: ["node", "comis"],
          cwd: dir,
          tsMs: Date.now(),
        }) + "\n",
        { mode: 0o600 },
      );

      // Create the sentinel (this is what an attacker would have made writable).
      fs.writeFileSync(sentinel, "ATTACKER_SHOULD_NOT_OVERWRITE_THIS");

      // Pre-stage the symlink at the predictable tmp path.
      fs.symlinkSync(sentinel, tmpPath);

      await scrubConfigAuditLog({ filePath });

      // Critical assertion: the sentinel content is UNCHANGED.
      // (If writeFileSync followed the symlink, this content would be
      // the rewritten audit-log payload instead of the attacker string.)
      const sentinelAfter = fs.readFileSync(sentinel, "utf-8");
      expect(sentinelAfter).toBe("ATTACKER_SHOULD_NOT_OVERWRITE_THIS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sentinel-record fallback in reEncodeRecord.
// ---------------------------------------------------------------------------
describe("reEncodeRecord — sentinel on serialization failure", () => {
  it("emits sentinel when an object record contains a BigInt", async () => {
    const { reEncodeRecord } = await import("./scrub.js");

    // Pass an object containing BigInt to force safeJsonStringify -> undefined.
    const result = reEncodeRecord({ traceSchema: "comis-config-audit", evil: BigInt(1) });
    expect(result).not.toBe("undefined\n");
    // Strip trailing newline for parse.
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.__serializationError).toBe("record-not-serializable");
    expect(parsed.traceSchema).toBe("comis-config-audit");
  });

  it("emits sentinel when a non-object parsed value is unrepresentable (BigInt primitive)", async () => {
    const { reEncodeRecord } = await import("./scrub.js");
    const result = reEncodeRecord(BigInt(5));
    expect(result).not.toBe("undefined\n");
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.__serializationError).toBe("record-not-serializable");
  });
});
