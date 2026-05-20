// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon bootstrap config.observe wiring test (OBS-REVIEW-03 fix).
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

import { emitBootstrapConfigObserveRecords } from "./stages/foundation-helpers.js";
import { ConfigObserveAuditRecordSchema } from "@comis/observability";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-daemon-observe-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("emitBootstrapConfigObserveRecords — daemon bootstrap config.observe wiring", () => {
  it("appends exactly one config.observe record per resolved configPath entry", async () => {
    // Seed two config files at known paths.
    const cfgA = path.join(tmpDir, "config-a.yaml");
    const cfgB = path.join(tmpDir, "config-b.yaml");
    fs.writeFileSync(cfgA, "logging:\n  level: info\n", { mode: 0o600 });
    fs.writeFileSync(cfgB, "logging:\n  level: debug\n", { mode: 0o600 });

    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");

    await emitBootstrapConfigObserveRecords({
      configPaths: [cfgA, cfgB],
      auditLogPath,
      confinedBaseDir: tmpDir,
    });

    const raw = fs.readFileSync(auditLogPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = ConfigObserveAuditRecordSchema.parse(JSON.parse(line));
      expect(parsed.event).toBe("config.observe");
      expect(parsed.callerSource).toBe("daemon-bootstrap");
    }
    const observedPaths = lines.map((l) => JSON.parse(l).configPath);
    expect(observedPaths).toContain(cfgA);
    expect(observedPaths).toContain(cfgB);
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
        configPaths: [cfg],
        auditLogPath,
        confinedBaseDir: tmpDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("handles an empty configPaths array gracefully (no audit-log lines, no throw)", async () => {
    const auditLogPath = path.join(tmpDir, "logs", "config-audit.jsonl");
    await emitBootstrapConfigObserveRecords({
      configPaths: [],
      auditLogPath,
      confinedBaseDir: tmpDir,
    });
    // No audit file created when there's nothing to write.
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });
});
