// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  lastKnownGoodPath,
  saveLastKnownGood,
  restoreLastKnownGood,
  buildRollbackSuggestion,
  handleRestoreFlag,
} from "./last-known-good.js";

describe("last-known-good config", () => {
  let tmpDir: string;
  let configPath: string;
  let auditLogPath: string;
  let prevAuditEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lkg-test-"));
    configPath = join(tmpDir, "config.yaml");
    // Redirect the daemon-wide config-audit log into the tmpdir so the
    // hook does not pollute ~/.comis/logs/ during tests.
    auditLogPath = join(tmpDir, "config-audit.jsonl");
    // eslint-disable-next-line no-restricted-syntax -- test fixture env override
    prevAuditEnv = process.env["COMIS_CONFIG_AUDIT_LOG"];
    // eslint-disable-next-line no-restricted-syntax -- test fixture env override
    process.env["COMIS_CONFIG_AUDIT_LOG"] = auditLogPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
    if (prevAuditEnv === undefined) delete process.env["COMIS_CONFIG_AUDIT_LOG"];
    // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
    else process.env["COMIS_CONFIG_AUDIT_LOG"] = prevAuditEnv;
  });

  describe("lastKnownGoodPath", () => {
    it("derives .last-good.yaml from config path", () => {
      expect(lastKnownGoodPath("/home/user/.comis/config.yaml")).toBe(
        "/home/user/.comis/config.last-good.yaml",
      );
    });

    it("handles config.local.yaml", () => {
      expect(lastKnownGoodPath("/home/user/.comis/config.local.yaml")).toBe(
        "/home/user/.comis/config.local.last-good.yaml",
      );
    });
  });

  describe("saveLastKnownGood", () => {
    it("copies config to last-known-good path", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe("key: value\n");
    });

    it("returns saved: false when config does not exist", () => {
      const result = saveLastKnownGood(join(tmpDir, "nonexistent.yaml"));
      expect(result.saved).toBe(false);
    });

    it("sets 0o600 permissions on snapshot file", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);

      const stat = statSync(result.path);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("overwrites existing last-known-good", () => {
      writeFileSync(configPath, "version: 1\n");
      saveLastKnownGood(configPath);

      writeFileSync(configPath, "version: 2\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe("version: 2\n");
    });
  });

  describe("restoreLastKnownGood", () => {
    it("restores config from last-known-good", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);

      // Simulate bad config change
      writeFileSync(configPath, "bad: true\n");
      expect(readFileSync(configPath, "utf-8")).toBe("bad: true\n");

      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(true);
      expect(readFileSync(configPath, "utf-8")).toBe("good: true\n");
    });

    it("sets 0o600 permissions on restored config file", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);

      // Overwrite config with bad content (and default permissive permissions)
      writeFileSync(configPath, "bad: true\n");

      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(true);

      const stat = statSync(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("returns restored: false when no snapshot exists", () => {
      writeFileSync(configPath, "key: value\n");
      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(false);
    });
  });

  describe("buildRollbackSuggestion", () => {
    it("returns null when no last-known-good exists", () => {
      writeFileSync(configPath, "key: value\n");
      expect(buildRollbackSuggestion(configPath)).toBeNull();
    });

    it("returns hint and diff when last-known-good exists and differs", () => {
      writeFileSync(configPath, "key: good\n");
      saveLastKnownGood(configPath);
      writeFileSync(configPath, "key: bad\n");

      const result = buildRollbackSuggestion(configPath);
      expect(result).not.toBeNull();
      expect(result!.hint).toContain("--restore-last-good");
      expect(result!.diff).toContain("- key: good");
      expect(result!.diff).toContain("+ key: bad");
    });

    it("notes when configs are identical", () => {
      writeFileSync(configPath, "key: value\n");
      saveLastKnownGood(configPath);

      const result = buildRollbackSuggestion(configPath);
      expect(result).not.toBeNull();
      expect(result!.diff).toContain("no differences");
    });
  });

  describe("handleRestoreFlag", () => {
    it("restores and exits 0 when snapshot exists", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);
      writeFileSync(configPath, "bad: true\n");

      let exitCode = -1;
      handleRestoreFlag([configPath], (code) => { exitCode = code; });
      expect(exitCode).toBe(0);
      expect(readFileSync(configPath, "utf-8")).toBe("good: true\n");
    });

    it("exits 1 when no snapshot exists", () => {
      writeFileSync(configPath, "key: value\n");
      let exitCode = -1;
      handleRestoreFlag([configPath], (code) => { exitCode = code; });
      expect(exitCode).toBe(1);
    });

    it("exits 1 when no config paths provided", () => {
      let exitCode = -1;
      handleRestoreFlag([], (code) => { exitCode = code; });
      expect(exitCode).toBe(1);
    });
  });

  describe("config-audit hook (Plan 45-05 task 7)", () => {
    it("writes a config-audit JSONL line for a successful save", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);

      // The audit log lives at the env-override path.
      expect(existsSync(auditLogPath)).toBe(true);
      const log = readFileSync(auditLogPath, "utf-8").trim().split("\n");
      expect(log.length).toBe(1);
      const record = JSON.parse(log[0]!) as {
        source: string;
        result: string;
        configPath: string;
        phase: string;
      };
      expect(record.source).toBe("last-known-good-save");
      expect(record.result).toBe("rename");
      expect(record.configPath).toBe(result.path);
      expect(record.phase).toBe("write");
    });

    it("writes a config-audit JSONL line for a successful restore", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);
      // Drop the save record so the restore line is the only one
      // visible in the assertion below.
      writeFileSync(auditLogPath, "");

      writeFileSync(configPath, "bad: true\n");
      const result = restoreLastKnownGood(configPath);
      expect(result.restored).toBe(true);

      const log = readFileSync(auditLogPath, "utf-8").trim().split("\n");
      expect(log.length).toBe(1);
      const record = JSON.parse(log[0]!) as { source: string; result: string };
      expect(record.source).toBe("last-known-good-restore");
      expect(record.result).toBe("rename");
    });
  });

  // Plan 45.1-04 task 4 (TRAJ-FIX-06): saveLastKnownGood/restoreLastKnownGood
  // honor an auditEnabled parameter — when false the audit JSONL append is
  // skipped but the LKG copy still runs.
  describe("config-audit hook honors auditEnabled (TRAJ-FIX-06)", () => {
    it("saveLastKnownGood with auditEnabled: false skips the audit JSONL append", () => {
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath, false);
      // LKG copy still happens — the audit log is a forensics aid, not
      // a gate on the snapshot itself.
      expect(result.saved).toBe(true);
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe("key: value\n");

      // Audit log must NOT have been written. If pre-existing, must
      // still be empty.
      if (existsSync(auditLogPath)) {
        expect(readFileSync(auditLogPath, "utf-8")).toBe("");
      } else {
        expect(existsSync(auditLogPath)).toBe(false);
      }
    });

    it("restoreLastKnownGood with auditEnabled: false skips the audit JSONL append but still copies the snapshot", () => {
      writeFileSync(configPath, "good: true\n");
      saveLastKnownGood(configPath);
      // Clear the audit log so we can detect new appends.
      writeFileSync(auditLogPath, "");

      writeFileSync(configPath, "bad: true\n");
      const result = restoreLastKnownGood(configPath, false);
      expect(result.restored).toBe(true);
      // Restore happened: configPath now matches the saved snapshot.
      expect(readFileSync(configPath, "utf-8")).toBe("good: true\n");
      // No new audit lines appended.
      expect(readFileSync(auditLogPath, "utf-8")).toBe("");
    });

    it("saveLastKnownGood with auditEnabled omitted writes the audit line (default = true preserves pre-fix behavior)", () => {
      // Symmetric positive case that gates the negative tests above.
      // The default-parameter contract must keep existing callers
      // (daemon.ts pre-rewire) producing the audit record.
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);

      expect(existsSync(auditLogPath)).toBe(true);
      const log = readFileSync(auditLogPath, "utf-8").trim().split("\n");
      expect(log.length).toBe(1);
    });
  });
});
