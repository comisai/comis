// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon bootstrap config.observe wiring test.
 *
 * Smoke-tests that on daemon startup, the bootstrap config-read path
 * emits exactly one `event: "config.observe"` audit record per
 * resolved configPath entry.
 *
 * The test does NOT spin up the full daemon — it dispatches into the
 * shared `emitBootstrapConfigObserveRecords` helper directly with a
 * controlled set of configPaths and asserts the audit-log file
 * contains one observe record per path.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { emitBootstrapConfigObserveRecords } from "./config/bootstrap-observe.js";
import { readConfigFileObservation } from "./config/read-config-file-observation.js";
import { ConfigObserveAuditRecordSchema } from "@comis/observability";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-daemon-observe-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("emitBootstrapConfigObserveRecords — daemon bootstrap config.observe wiring", () => {
  it("appends exactly one config.observe record per observation, carrying the full forensics shape", async () => {
    // Seed two config files at known paths.
    const cfgA = path.join(tmpDir, "config-a.yaml");
    const cfgB = path.join(tmpDir, "config-b.yaml");
    fs.writeFileSync(cfgA, "logging:\n  level: info\n", { mode: 0o600 });
    fs.writeFileSync(cfgB, "logging:\n  level: debug\n", { mode: 0o600 });

    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");
    const observations = [
      readConfigFileObservation(cfgA),
      readConfigFileObservation(cfgB),
    ];
    const validityByPath = new Map([
      [cfgA, true],
      [cfgB, true],
    ]);

    await emitBootstrapConfigObserveRecords({
      observations,
      validityByPath,
      auditLogPath,
      confinedBaseDir: tmpDir,
    });

    const raw = fs.readFileSync(auditLogPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = ConfigObserveAuditRecordSchema.parse(JSON.parse(line));
      expect(parsed.event).toBe("config.observe");
      expect(parsed.phase).toBe("read");
      expect(parsed.callerSource).toBe("daemon-bootstrap");
      expect(parsed.exists).toBe(true);
      expect(parsed.valid).toBe(true);
      // File-stat block populated from disk via readConfigFileObservation.
      expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.bytes).toBeGreaterThan(0);
      expect(parsed.dev).not.toBeNull();
      expect(parsed.ino).not.toBeNull();
    }
    const observedPaths = lines.map((l) => JSON.parse(l).configPath);
    expect(observedPaths).toContain(cfgA);
    expect(observedPaths).toContain(cfgB);
  });

  it("emits exists:false records for configured-but-missing paths (no existsSync filter at the call site)", async () => {
    const missing = path.join(tmpDir, "not-on-disk.yaml");
    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    const observations = [readConfigFileObservation(missing)];
    const validityByPath = new Map([[missing, true]]);

    await emitBootstrapConfigObserveRecords({
      observations,
      validityByPath,
      auditLogPath,
      confinedBaseDir: tmpDir,
    });

    const raw = fs.readFileSync(auditLogPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = ConfigObserveAuditRecordSchema.parse(JSON.parse(lines[0]!));
    expect(parsed.exists).toBe(false);
    expect(parsed.hash).toBeNull();
    expect(parsed.bytes).toBeNull();
    expect(parsed.dev).toBeNull();
  });

  it("propagates validity:false when the boot result reports a malformed config", async () => {
    const cfg = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfg, "k: v\n", { mode: 0o600 });
    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    await emitBootstrapConfigObserveRecords({
      observations: [readConfigFileObservation(cfg)],
      validityByPath: new Map([[cfg, false]]),
      auditLogPath,
      confinedBaseDir: tmpDir,
    });

    const raw = fs.readFileSync(auditLogPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const parsed = ConfigObserveAuditRecordSchema.parse(JSON.parse(lines[0]!));
    expect(parsed.valid).toBe(false);
    // exists is independent of validity — the file IS on disk.
    expect(parsed.exists).toBe(true);
  });

  it("does NOT throw when a single observe-append fails — non-fatal at boot", async () => {
    // Point the audit log at a path under a non-writable dir to force
    // the underlying append to fail. The helper must absorb the error
    // (Promise.allSettled) and not propagate.
    const cfg = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(cfg, "k: v\n", { mode: 0o600 });

    // Use a path that cannot be created (parent is a non-dir file).
    const blockingFile = path.join(tmpDir, "block-file");
    fs.writeFileSync(blockingFile, "x", { mode: 0o600 });
    const auditLogPath = path.join(blockingFile, "child", "audit.jsonl");

    // Must not throw — audit-log failures at boot are non-fatal.
    await expect(
      emitBootstrapConfigObserveRecords({
        observations: [readConfigFileObservation(cfg)],
        validityByPath: new Map([[cfg, true]]),
        auditLogPath,
        confinedBaseDir: tmpDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("handles an empty observations array gracefully (no audit-log lines, no throw)", async () => {
    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");
    await emitBootstrapConfigObserveRecords({
      observations: [],
      validityByPath: new Map(),
      auditLogPath,
      confinedBaseDir: tmpDir,
    });
    // No audit file created when there's nothing to write.
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });
});
