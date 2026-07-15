// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import type { ComisLogger } from "@comis/core";
import {
  lastKnownGoodPath,
  saveLastKnownGood,
  restoreLastKnownGood,
  buildRollbackSuggestion,
  handleRestoreFlag,
} from "./last-known-good.js";

// ---------------------------------------------------------------------------
// Test helper — minimal ComisLogger mock
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as ComisLogger;
}

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
      expect(result!.hint).toContain("node daemon-entrypoint.js --restore-last-good");
      expect(result!.hint).not.toContain("node daemon.js");
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

  describe("config-audit hook", () => {
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
        callerSource: string;
        result: string;
        configPath: string;
        event: string;
      };
      // `source` is the fixed literal "config-io"; the call
      // site identity lives on `callerSource`.
      expect(record.source).toBe("config-io");
      expect(record.callerSource).toBe("last-known-good-save");
      expect(record.result).toBe("rename");
      expect(record.configPath).toBe(result.path);
      expect(record.event).toBe("config.write");
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
      const record = JSON.parse(log[0]!) as {
        source: string;
        callerSource: string;
        result: string;
      };
      // `source` is "config-io"; callerSource holds the legacy enum.
      expect(record.source).toBe("config-io");
      expect(record.callerSource).toBe("last-known-good-restore");
      expect(record.result).toBe("rename");
    });
  });

  // saveLastKnownGood/restoreLastKnownGood honor an auditEnabled parameter
  // — when false the audit JSONL append is skipped but the LKG copy still
  // runs.
  describe("config-audit hook honors auditEnabled", () => {
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

    it("saveLastKnownGood with auditEnabled omitted writes the audit line (default = true preserves prior behavior)", () => {
      // Symmetric positive case that gates the negative tests above.
      // The default-parameter contract must keep existing callers
      // producing the audit record.
      writeFileSync(configPath, "key: value\n");
      const result = saveLastKnownGood(configPath);
      expect(result.saved).toBe(true);

      expect(existsSync(auditLogPath)).toBe(true);
      const log = readFileSync(auditLogPath, "utf-8").trim().split("\n");
      expect(log.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // LKG snapshot guard — never capture a plaintext secret.
  //
  // saveLastKnownGood scans the source config before copying:
  //   - A plaintext secret in the source file causes { saved: false } (no copy)
  //   - A ${VAR} env-ref in the source file passes through (no false-positive)
  //   - Malformed YAML returns { saved: false } (fail-safe)
  // ---------------------------------------------------------------------------
  describe("LKG secret guard", () => {
    it("returns { saved: false } when source config contains plaintext Authorization header secret", () => {
      const configWithSecret = yamlStringify({
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            ],
          },
        },
      });
      writeFileSync(configPath, configWithSecret);

      const result = saveLastKnownGood(configPath);

      expect(result.saved).toBe(false);
      // The LKG file must NOT have been created.
      expect(existsSync(result.path)).toBe(false);
    });

    it("returns { saved: true } when source config contains only ${VAR} env refs (no false-positive)", () => {
      const configWithEnvRef = yamlStringify({
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ${MY_TOKEN}",
                },
              },
            ],
          },
        },
      });
      writeFileSync(configPath, configWithEnvRef);

      const result = saveLastKnownGood(configPath);

      expect(result.saved).toBe(true);
      expect(existsSync(result.path)).toBe(true);
    });

    it("returns { saved: false } when source config has malformed YAML (fail-safe)", () => {
      writeFileSync(configPath, "{unclosed: yaml: [broken");

      const result = saveLastKnownGood(configPath);

      expect(result.saved).toBe(false);
      // No LKG file should have been created for unverifiable content.
      expect(existsSync(result.path)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // saveLastKnownGood must emit a loud WARN when it skips the snapshot, so the
  // skip is observable rather than silent.
  // ---------------------------------------------------------------------------
  describe("LKG skip emits actionable WARN (no silent failure)", () => {
    it("emits logger.warn with errorKind:'config' and hint when secret found in source config", () => {
      const logger = makeLogger();
      const configWithSecret = yamlStringify({
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            ],
          },
        },
      });
      writeFileSync(configPath, configWithSecret);

      const result = saveLastKnownGood(configPath, true, logger);

      expect(result.saved).toBe(false);
      // WARN must have been emitted
      expect(logger.warn).toHaveBeenCalledOnce();
      const [fields, msg] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string];
      // Must include errorKind: "config" per the WARN contract
      expect(fields).toMatchObject({ errorKind: "config" });
      // Must include an actionable hint — no raw secret value
      expect(typeof fields["hint"]).toBe("string");
      expect((fields["hint"] as string).length).toBeGreaterThan(0);
      // The warning message must not contain the raw secret value
      expect(msg).not.toContain("ghp_");
      expect(JSON.stringify(fields)).not.toContain("ghp_");
    });

    it("emits logger.warn with errorKind:'config' and hint when source YAML is malformed", () => {
      const logger = makeLogger();
      writeFileSync(configPath, "{unclosed: yaml: [broken");

      const result = saveLastKnownGood(configPath, true, logger);

      expect(result.saved).toBe(false);
      expect(logger.warn).toHaveBeenCalledOnce();
      const [fields] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
      expect(fields).toMatchObject({ errorKind: "config" });
    });

    it("does NOT emit logger.warn when config file is missing (normal first-run case)", () => {
      const logger = makeLogger();
      // Config file does not exist — missing file is the expected first-run state
      const result = saveLastKnownGood(join(tmpDir, "nonexistent.yaml"), true, logger);

      expect(result.saved).toBe(false);
      // Missing file is NOT a WARN condition — it's normal on first run
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("does NOT emit logger.warn when logger is not provided (backward-compat: no logger = silent)", () => {
      const configWithSecret = yamlStringify({
        secret_field: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-AAAAAAA",
      });
      writeFileSync(configPath, configWithSecret);

      // No logger provided — must not throw, just silently skip
      expect(() => saveLastKnownGood(configPath)).not.toThrow();
    });
  });
});
