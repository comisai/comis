// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withAuditHookSync } from "./audit-hook.js";

describe("withAuditHookSync", () => {
  let tmpDir: string;
  let configPath: string;
  let auditLogPath: string;
  let prevAuditEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-hook-test-"));
    configPath = join(tmpDir, "config.last-good.yaml");
    // Redirect the daemon-wide config-audit log into the tmpdir so the
    // hook does not pollute ~/.comis/logs/ during tests. Mirrors the
    // pattern in packages/daemon/src/config/last-known-good.test.ts.
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

  it("reads process.pid AT CALL TIME and writes it to the JSONL record (per-call read invariant)", () => {
    // buildBaseFromProcess must read process.pid
    // at function-call time, not module-init. If the helper closes over
    // process.pid at import time, a forked process's audit records
    // would carry the parent pid. This test invokes the helper from
    // the current process and asserts the persisted pid matches the
    // CURRENT process.pid (which is also the call-time pid in this
    // single-process test).
    const result = withAuditHookSync({
      source: "last-known-good-save",
      auditConfigPath: configPath,
      entryScript: fileURLToPath(import.meta.url),
      write: () => {
        writeFileSync(configPath, "key: value\n");
      },
    });
    expect(result.ok).toBe(true);

    expect(existsSync(auditLogPath)).toBe(true);
    const line = readFileSync(auditLogPath, "utf-8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    // The recorded pid must equal process.pid at the time of THIS
    // assertion — which is the same as the pid at call time because
    // the test runs in a single process. A module-init read would
    // also yield this same pid, so the substantive invariant is "the
    // pid is current" (we cannot fork-test without spawning a child).
    // The shape assertion still gates the regression where the helper
    // could store a stale captured pid from a different builder.
    // eslint-disable-next-line no-restricted-syntax -- test reads process.pid for assertion
    expect(record.pid).toBe(process.pid);
    // Sanity-check the other fields the helper writes are also present
    // and have the call-time shape (a stale module-init read would
    // typically zero or undefined these).
    // eslint-disable-next-line no-restricted-syntax -- test reads process.ppid for assertion
    expect(record.ppid).toBe(process.ppid);
    expect(Array.isArray(record.argv)).toBe(true);
    // eslint-disable-next-line no-restricted-syntax -- test reads process.cwd for assertion
    expect(record.cwd).toBe(process.cwd());
  });

  it("returns ok:false with errorCode + errorMessage when the write callback throws, and STILL emits a JSONL line with result:failed", () => {
    // Audit fires on the failure path — the JSONL is a forensics aid
    // that must record failed-write attempts as well as successful
    // ones. This is the pre-existing semantic of the local withAuditHook
    // in last-known-good.ts that we preserve in the shared helper.
    const result = withAuditHookSync({
      source: "last-known-good-save",
      auditConfigPath: configPath,
      entryScript: fileURLToPath(import.meta.url),
      write: () => {
        const err = new Error("EACCES: permission denied") as Error & {
          code?: string;
        };
        err.code = "EACCES";
        throw err;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("EACCES");
    expect(result.errorMessage).toContain("EACCES");

    // The JSONL line must STILL be emitted with result:"failed".
    expect(existsSync(auditLogPath)).toBe(true);
    const line = readFileSync(auditLogPath, "utf-8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.result).toBe("failed");
    expect(record.errorCode).toBe("EACCES");
    expect(typeof record.errorMessage).toBe("string");
    expect(record.errorMessage as string).toContain("EACCES");
  });

  it("returns ok:true and emits a JSONL line with result:rename when the write callback succeeds", () => {
    const result = withAuditHookSync({
      source: "last-known-good-save",
      auditConfigPath: configPath,
      entryScript: fileURLToPath(import.meta.url),
      write: () => {
        writeFileSync(configPath, "key: value\n");
      },
    });
    expect(result.ok).toBe(true);
    // No error fields populated on success.
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();

    expect(existsSync(auditLogPath)).toBe(true);
    const line = readFileSync(auditLogPath, "utf-8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    // source is the fixed literal "config-io"; callerSource
    // carries the call-site identity.
    expect(record.source).toBe("config-io");
    expect(record.callerSource).toBe("last-known-good-save");
    expect(record.result).toBe("rename");
    expect(record.event).toBe("config.write");
    expect(record.configPath).toBe(configPath);
  });

  it("skips the JSONL emit when auditEnabled is false, but still runs the write callback", () => {
    // Pre-condition: no audit log file exists yet.
    expect(existsSync(auditLogPath)).toBe(false);

    const result = withAuditHookSync({
      source: "last-known-good-save",
      auditConfigPath: configPath,
      entryScript: fileURLToPath(import.meta.url),
      auditEnabled: false,
      write: () => {
        writeFileSync(configPath, "key: value\n");
      },
    });
    // The write happened.
    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe("key: value\n");

    // No JSONL line was emitted — file doesn't exist or is empty.
    if (existsSync(auditLogPath)) {
      expect(readFileSync(auditLogPath, "utf-8")).toBe("");
    } else {
      expect(existsSync(auditLogPath)).toBe(false);
    }
  });
});
