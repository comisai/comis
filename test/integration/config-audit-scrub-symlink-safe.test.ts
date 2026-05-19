// SPDX-License-Identifier: Apache-2.0
/**
 * Symlink-safe scrub tmp-write integration test.
 *
 * Verifies that an attacker who pre-stages a symlink at the predictable
 * scrub tmp path (`<auditLog>.scrub.tmp`) CANNOT redirect the scrub
 * write to an arbitrary file the daemon has write access to.
 *
 * Per AGENTS.md §2.5: imports from dist/ — requires `pnpm build` first.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendConfigAuditRecordSync,
  scrubConfigAuditLog,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
} from "@comis/observability";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-symlink-safe-"));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scrubConfigAuditLog — BL-02 symlink resistance (integration)", () => {
  it("pre-staged symlink at .scrub.tmp does NOT redirect the scrub write to the symlink target", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");
    const tmpPath = filePath + ".scrub.tmp";
    const sentinel = path.join(tmpDir, "sentinel-file");

    // 1. Write a valid audit log via the production appender.
    const base = createConfigWriteAuditRecordBase({
      source: "cli",
      configPath: path.join(tmpDir, "config.yaml"),
      pid: 1,
      ppid: 0,
      argv: ["node", "comis", "--token", "secret-value-XYZ"],
      cwd: tmpDir,
      execArgv: [],
      watchMode: false,
    });
    const record = finalizeConfigWriteAuditRecord(base, { result: "rename" });
    appendConfigAuditRecordSync({ filePath, record });
    expect(fs.existsSync(filePath)).toBe(true);

    // 2. Attacker prepares the sentinel and the symlink at the tmp path.
    fs.writeFileSync(sentinel, "ATTACKER_TARGET_PRISTINE", { mode: 0o644 });
    fs.symlinkSync(sentinel, tmpPath);
    // Verify pre-state.
    expect(fs.lstatSync(tmpPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("ATTACKER_TARGET_PRISTINE");

    // 3. Run scrub.
    const result = await scrubConfigAuditLog({ filePath });

    // 4. The scrub may succeed (preferred) or err with a symlink-rejection;
    //    EITHER outcome is acceptable as long as the sentinel is untouched.
    if (result.ok) {
      // Successful scrub: the audit log was rewritten without following the symlink.
      expect(fs.existsSync(filePath)).toBe(true);
      // The original audit-log content still parses.
      const rewritten = fs.readFileSync(filePath, "utf-8");
      expect(rewritten.length).toBeGreaterThan(0);
    }

    // CRITICAL: the sentinel content is untouched regardless of outcome.
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("ATTACKER_TARGET_PRISTINE");
  });

  it("normal scrub (no pre-staged symlink) still completes successfully", async () => {
    const filePath = path.join(tmpDir, "config-audit.jsonl");

    const base = createConfigWriteAuditRecordBase({
      source: "cli",
      configPath: path.join(tmpDir, "config.yaml"),
      pid: 1,
      ppid: 0,
      argv: ["node", "comis"],
      cwd: tmpDir,
      execArgv: [],
      watchMode: false,
    });
    const record = finalizeConfigWriteAuditRecord(base, { result: "rename" });
    appendConfigAuditRecordSync({ filePath, record });

    const result = await scrubConfigAuditLog({ filePath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rewrittenRecords).toBe(1);
      expect(result.value.aborted).toBe(false);
    }

    const final = fs.readFileSync(filePath, "utf-8");
    expect(final.length).toBeGreaterThan(0);
    const lines = final.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.traceSchema).toBe("comis-config-audit");
  });
});
