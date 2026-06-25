// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createConfigHandlers, type ConfigHandlerDeps, coerceConfigValue } from "./config-handlers/index.js";
import { z } from "zod";
import { bootstrap } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helper: create temp config env per test
// ---------------------------------------------------------------------------

/**
 * Recognizable daemon build version threaded through the deps fixture so the
 * gateway.status test can assert the version is surfaced on the RPC response
 * (the field `comis doctor`'s version-skew check reads).
 */
const TEST_DAEMON_VERSION = "9.9.9-test";

function createTempConfig(): { dir: string; configPath: string; cleanup: () => void } {
  const dir = join(tmpdir(), `comis-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.local.yaml");
  // Write minimal valid YAML so the handler can read/write
  writeFileSync(configPath, "logLevel: info\n", "utf-8");
  return {
    dir,
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeDeps(configPath: string): ConfigHandlerDeps & { logger: ComisLogger } {
  const result = bootstrap({ configPaths: [configPath], env: {} });
  if (!result.ok) {
    throw new Error(`Bootstrap failed in test: ${result.error.message}`);
  }
  const logger = createMockLogger();
  return {
    container: result.value,
    configPaths: [configPath],
    defaultConfigPaths: [configPath],
    daemonVersion: TEST_DAEMON_VERSION,
    logger,
  };
}

/**
 * Variant of makeDeps that injects an explicit env map into the bootstrap
 * SecretManager. Used by env-ref validation tests so the secrets store can
 * be controlled per-test (FINNHUB_API_KEY present vs absent, etc.).
 */
function makeDepsWithEnv(
  configPath: string,
  env: Record<string, string>,
): ConfigHandlerDeps & { logger: ComisLogger } {
  const result = bootstrap({ configPaths: [configPath], env });
  if (!result.ok) {
    throw new Error(`Bootstrap failed in test: ${result.error.message}`);
  }
  const logger = createMockLogger();
  return {
    container: result.value,
    configPaths: [configPath],
    defaultConfigPaths: [configPath],
    daemonVersion: TEST_DAEMON_VERSION,
    logger,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config.patch", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("schedules SIGUSR2 restart after successful write", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    // SIGUSR2 should NOT have been called yet (it's on a 200ms timer)
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers by 200ms
    vi.advanceTimersByTime(200);

    // Now SIGUSR2 should have been sent
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2");

    // Return value should include restarting: true
    expect(result).toMatchObject({
      patched: true,
      section: "logLevel",
      value: "debug",
      restarting: true,
    });
  });

  it("written config file has mode 0o600", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    const stat = statSync(tempConfig.configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("does NOT schedule restart on validation failure", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // "invalid_level" is not a valid logLevel enum value, so Zod validation will fail
    await expect(
      handlers["config.patch"]!({
        section: "logLevel",
        value: "invalid_level",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow("Config validation failed");

    // Advance timers -- SIGUSR2 should NOT have been called
    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does NOT schedule restart on auth failure", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "viewer",
      }),
    ).rejects.toThrow("Admin access required");

    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  // Config-audit JSONL hook around the atomic write.
  describe("config-audit hook", () => {
    let auditPath: string;
    let prevAuditEnv: string | undefined;

    beforeEach(() => {
      auditPath = join(tempConfig.dir, "config-audit.jsonl");
      // eslint-disable-next-line no-restricted-syntax -- test fixture env override
      prevAuditEnv = process.env["COMIS_CONFIG_AUDIT_LOG"];
      // eslint-disable-next-line no-restricted-syntax -- test fixture env override
      process.env["COMIS_CONFIG_AUDIT_LOG"] = auditPath;
    });

    afterEach(() => {
      // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
      if (prevAuditEnv === undefined) delete process.env["COMIS_CONFIG_AUDIT_LOG"];
      // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
      else process.env["COMIS_CONFIG_AUDIT_LOG"] = prevAuditEnv;
    });

    it("writes a rename audit record on successful patch alongside the EventBus emit", async () => {
      const deps = makeDeps(tempConfig.configPath);
      const handlers = createConfigHandlers(deps);

      const auditEvents: unknown[] = [];
      deps.container.eventBus.on("audit:event", (e) => auditEvents.push(e));

      await handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "admin",
      });
      // The append is launched async — flush microtasks before asserting.
      // setImmediate is patched by fake timers, so drive it explicitly.
      await vi.runAllTimersAsync();

      // EventBus emit still happens (additive — JSONL is not a replacement).
      expect(auditEvents.length).toBeGreaterThan(0);

      // JSONL record present.
      const fs = await import("node:fs");
      expect(fs.existsSync(auditPath)).toBe(true);
      const lines = fs
        .readFileSync(auditPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const record = JSON.parse(lines[lines.length - 1]!) as {
        source: string;
        callerSource: string;
        result: string;
        event: string;
      };
      // `source` is the fixed literal "config-io"; legacy
      // call-site identity ("config-patch-rpc") moves to `callerSource`.
      // Discriminant is `event`, not `phase`.
      expect(record.source).toBe("config-io");
      expect(record.callerSource).toBe("config-patch-rpc");
      expect(record.result).toBe("rename");
      expect(record.event).toBe("config.write");
    });

    it("writes a rejected audit record on schema-validation failure", async () => {
      // Use real timers for this test — fakeTimers patches setImmediate
      // which blocks the suppressError microtask chain in the audit
      // hook's finally block.
      vi.useRealTimers();

      const deps = makeDeps(tempConfig.configPath);
      const handlers = createConfigHandlers(deps);

      await expect(
        handlers["config.patch"]!({
          section: "logLevel",
          value: "invalid_level",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Config validation failed");
      await new Promise((resolve) => setImmediate(resolve));

      const fs = await import("node:fs");
      expect(fs.existsSync(auditPath)).toBe(true);
      const lines = fs
        .readFileSync(auditPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const record = JSON.parse(lines[lines.length - 1]!) as { result: string };
      expect(record.result).toBe("rejected");
    });

    it("rejected audit record carries the validator's errorMessage", async () => {
      // Previously the `rejected` outcome swallowed the rejection reason — the
      // persisted JSONL line only had `result: "rejected"` with no
      // errorMessage, so operators had to grep daemon logs to find why a
      // config.patch failed. Now the validator text rides through to
      // the JSONL record's errorMessage field.
      vi.useRealTimers();

      const deps = makeDeps(tempConfig.configPath);
      const handlers = createConfigHandlers(deps);

      await expect(
        handlers["config.patch"]!({
          section: "logLevel",
          value: "invalid_level",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Config validation failed");
      await new Promise((resolve) => setImmediate(resolve));

      const fs = await import("node:fs");
      const lines = fs
        .readFileSync(auditPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      const record = JSON.parse(lines[lines.length - 1]!) as { result: string; errorMessage?: string };
      expect(record.result).toBe("rejected");
      expect(record.errorMessage).toBeTruthy();
      // The validator's message must surface the validation failure context.
      expect(record.errorMessage).toMatch(/[Cc]onfig|[Vv]alidation|[Ii]nvalid/);
    });

    // The audit append is gated on deps.auditEnabled — when
    // explicitly false, neither buildConfigAuditBase nor
    // appendConfigAuditWithOutcome runs.
    it("skips the audit JSONL append when deps.auditEnabled === false", async () => {
      vi.useRealTimers();

      const baseDeps = makeDeps(tempConfig.configPath);
      const deps = { ...baseDeps, auditEnabled: false };
      const handlers = createConfigHandlers(deps);

      await handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "admin",
      });
      await new Promise((resolve) => setImmediate(resolve));

      const fs = await import("node:fs");
      // The audit log must NOT have been touched.
      if (fs.existsSync(auditPath)) {
        const after = fs.statSync(auditPath).size;
        expect(after).toBe(0);
      } else {
        expect(fs.existsSync(auditPath)).toBe(false);
      }

      // This test runs on REAL timers, so the successful patch scheduled a real
      // 200ms setTimeout -> process.kill(pid, "SIGUSR2"). `.unref()` keeps it from
      // holding the loop open, but it still FIRES if the worker is alive at 200ms
      // (which it is under full-workspace load). Drain it into the mocked killSpy
      // BEFORE afterEach runs restoreAllMocks — otherwise the real process.kill
      // fires post-restore and terminates the vitest worker.
      await vi.waitFor(() => expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2"));
    });

    it("writes the audit JSONL line when deps.auditEnabled === true (symmetric positive)", async () => {
      // Gates the negative test above: ensures the audit log path is
      // correctly threaded, and that the default-true contract works
      // for callers that explicitly pass true.
      vi.useRealTimers();

      const baseDeps = makeDeps(tempConfig.configPath);
      const deps = { ...baseDeps, auditEnabled: true };
      const handlers = createConfigHandlers(deps);

      await handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "admin",
      });
      await new Promise((resolve) => setImmediate(resolve));

      const fs = await import("node:fs");
      expect(fs.existsSync(auditPath)).toBe(true);
      const lines = fs
        .readFileSync(auditPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Real-timer successful patch: drain the real 200ms SIGUSR2 restart timer
      // into the mocked killSpy before afterEach restores process.kill. See the
      // sibling auditEnabled:false test for the full rationale.
      await vi.waitFor(() => expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2"));
    });
  });
});

describe("config.patch rate limiting", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("allows 5 patches in quick succession", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    for (let i = 0; i < 5; i++) {
      const result = await handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      });
      expect(result).toHaveProperty("patched", true);
    }
  });

  it("rejects 6th patch with rate limit error including wait guidance", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Exhaust 5 tokens
    for (let i = 0; i < 5; i++) {
      await handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      });
    }

    // 6th should fail with rate limit error
    await expect(
      handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      }),
    ).rejects.toThrow(/rate limit exceeded/i);

    // Verify wait guidance in error message
    await expect(
      handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      }),
    ).rejects.toThrow(/try again in \d+ seconds/i);
  });

  it("does not consume rate limit tokens for unauthorized requests", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Unauthorized request should not consume tokens
    await expect(
      handlers["config.patch"]!({
        _trustLevel: "viewer",
        section: "logLevel",
        value: "debug",
      }),
    ).rejects.toThrow(/admin access required/i);

    // Should still allow 5 valid patches
    for (let i = 0; i < 5; i++) {
      const result = await handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      });
      expect(result).toHaveProperty("patched", true);
    }
  });
});

// ---------------------------------------------------------------------------
// Audit event tests
// ---------------------------------------------------------------------------

describe("config.patch audit events", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("emits audit:event with outcome success on successful patch", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const auditListener = vi.fn();
    deps.container.eventBus.on("audit:event", auditListener);

    const handlers = createConfigHandlers(deps);
    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    expect(auditListener).toHaveBeenCalledTimes(1);
    expect(auditListener).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "config.patch",
        classification: "destructive",
        outcome: "success",
        metadata: expect.objectContaining({ section: "logLevel" }),
      }),
    );
  });

  it("emits audit:event with outcome failure on validation error", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const auditListener = vi.fn();
    deps.container.eventBus.on("audit:event", auditListener);

    const handlers = createConfigHandlers(deps);
    await expect(
      handlers["config.patch"]!({
        section: "logLevel",
        value: "invalid_level",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow("Config validation failed");

    expect(auditListener).toHaveBeenCalledTimes(1);
    expect(auditListener).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "config.patch",
        classification: "destructive",
        outcome: "failure",
        metadata: expect.objectContaining({
          section: "logLevel",
          error: expect.stringContaining("Config validation failed"),
        }),
      }),
    );
  });

  it("does NOT emit audit event on auth failure (rejected before business logic)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const auditListener = vi.fn();
    deps.container.eventBus.on("audit:event", auditListener);

    const handlers = createConfigHandlers(deps);
    await expect(
      handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "viewer",
      }),
    ).rejects.toThrow("Admin access required");

    expect(auditListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structured logging tests
// ---------------------------------------------------------------------------

describe("config.patch structured logging", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("logs at INFO with canonical fields on success", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "config.patch",
        outcome: "success",
        section: "logLevel",
      }),
      expect.any(String),
    );
  });

  it("logs at WARN with canonical fields on failure", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "logLevel",
        value: "invalid_level",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow("Config validation failed");

    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "config.patch",
        outcome: "failure",
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Rate limit WARN logging tests
// ---------------------------------------------------------------------------

describe("rate limit WARN logging", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("logs at WARN with hint and errorKind when rate limited", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Exhaust 5 rate limit tokens
    for (let i = 0; i < 5; i++) {
      await handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      });
    }

    // 6th should trigger rate limit
    await expect(
      handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      }),
    ).rejects.toThrow(/rate limit exceeded/i);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "config.patch",
        hint: expect.stringContaining("rate limit"),
        errorKind: "validation",
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// config.apply tests
// ---------------------------------------------------------------------------

describe("config.apply", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("replaces section atomically and schedules SIGUSR2 restart", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.apply"]!({
      section: "scheduler",
      value: { cron: { enabled: true } },
      _trustLevel: "admin",
    });

    // Return value
    expect(result).toMatchObject({ applied: true, section: "scheduler", restarting: true });

    // SIGUSR2 should not have been called yet (200ms timer)
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers by 200ms
    vi.advanceTimersByTime(200);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2");

    // Verify YAML was written with full replacement (not deep merge)
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const { parse: parseYaml } = await import("yaml");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const scheduler = parsed.scheduler as Record<string, unknown>;
    // The scheduler section should contain exactly what we passed (plus Zod defaults are NOT in the YAML;
    // the YAML stores the raw value we wrote, and Zod defaults fill in at load time)
    expect(scheduler).toEqual({ cron: { enabled: true } });
  });

  it("written config file has mode 0o600 after apply", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await handlers["config.apply"]!({
      section: "scheduler",
      value: { cron: { enabled: true } },
      _trustLevel: "admin",
    });

    const stat = statSync(tempConfig.configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects non-admin callers", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.apply"]!({
        section: "scheduler",
        value: { cron: { enabled: true } },
        _trustLevel: "viewer",
      }),
    ).rejects.toThrow("Admin access required");

    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("rejects immutable sections", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.apply"]!({
        section: "security",
        value: {},
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects invalid config with validation error", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // logLevel is a top-level string enum, not an object section.
    // Passing an invalid enum value should fail Zod validation.
    await expect(
      handlers["config.apply"]!({
        section: "logLevel",
        value: "not_a_valid_level",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow("Config validation failed");
  });

  it("emits audit:event on success", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const auditListener = vi.fn();
    deps.container.eventBus.on("audit:event", auditListener);

    const handlers = createConfigHandlers(deps);
    await handlers["config.apply"]!({
      section: "scheduler",
      value: { cron: { enabled: true } },
      _trustLevel: "admin",
    });

    expect(auditListener).toHaveBeenCalledTimes(1);
    expect(auditListener).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "config.apply",
        classification: "destructive",
        outcome: "success",
        metadata: expect.objectContaining({ section: "scheduler" }),
      }),
    );
  });

  it("shares rate limit with config.patch", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Exhaust 5 tokens using config.patch
    for (let i = 0; i < 5; i++) {
      await handlers["config.patch"]!({
        _trustLevel: "admin",
        section: "logLevel",
        value: "debug",
      });
    }

    // config.apply should now be rate limited (shares the same bucket)
    await expect(
      handlers["config.apply"]!({
        section: "scheduler",
        value: { cron: { enabled: true } },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/rate limit exceeded/i);
  });
});

// ---------------------------------------------------------------------------
// Env var reference preservation tests
// ---------------------------------------------------------------------------

describe("env var reference preservation", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("config.patch writes ${VAR} syntax literally to YAML file", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Patch tenantId with an env var reference
    await handlers["config.patch"]!({
      section: "tenantId",
      value: "${TENANT_NAME}",
      _trustLevel: "admin",
    });

    // Read the raw YAML file from disk (no env substitution)
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const { parse: parseYaml } = await import("yaml");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    // The ${VAR} syntax must be preserved literally in the YAML file
    expect(parsed.tenantId).toBe("${TENANT_NAME}");
  });

  it("env var reference survives read-patch-read round-trip", async () => {
    // Bootstrap from a clean config (no env var refs yet)
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // First patch: write an env var reference into tenantId
    await handlers["config.patch"]!({
      section: "tenantId",
      value: "${INSTANCE_NAME}",
      _trustLevel: "admin",
    });

    // Verify it was written
    const { parse: parseYaml } = await import("yaml");
    const rawAfterFirst = readFileSync(tempConfig.configPath, "utf-8");
    const parsedAfterFirst = parseYaml(rawAfterFirst) as Record<string, unknown>;
    expect(parsedAfterFirst.tenantId).toBe("${INSTANCE_NAME}");

    // Second patch: change a DIFFERENT field -- the existing ${INSTANCE_NAME} must survive
    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    // Read the raw YAML file back from disk
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    // The ${INSTANCE_NAME} reference must still be present (not corrupted by the logLevel patch)
    expect(parsed.tenantId).toBe("${INSTANCE_NAME}");
    // The patched field must also be correct
    expect(parsed.logLevel).toBe("debug");
  });

  it("config.patch with ${VAR} value passes Zod validation for string fields", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // ${MY_TENANT} is a valid string, so Zod .string() validation accepts it
    const result = await handlers["config.patch"]!({
      section: "tenantId",
      value: "${MY_TENANT}",
      _trustLevel: "admin",
    });

    expect(result).toMatchObject({ patched: true, section: "tenantId", value: "${MY_TENANT}" });
  });
});

// ---------------------------------------------------------------------------
// Env var reference validation
// ---------------------------------------------------------------------------

describe("config.patch env var reference validation", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  // The gateway-patch on integrations.mcp.servers is REJECTED
  // before the env-ref validator runs. The env-validator logic itself is
  // unchanged and still exercised by persistToConfig at the AppConfigSchema
  // safeParse boundary. The tests below assert that the single-writer
  // guard supersedes the env-validator pathway for the gateway-patch
  // surface — the env-validator's behaviors are covered by unit tests on
  // `findUnresolvedEnvRefs` + the persistMcpServers integration tests.

  it("gateway-patch on integrations.mcp.servers is rejected before the env-ref validator (enabled:false placeholder)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "finnhub",
            transport: "stdio",
            command: "uvx",
            args: ["mcp-finnhub"],
            env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
            enabled: false,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("gateway-patch on integrations.mcp.servers is rejected before the env-ref validator (enabled:true missing ref)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "finnhub",
            transport: "stdio",
            command: "uvx",
            args: ["mcp-finnhub"],
            env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("gateway-patch on integrations.mcp.servers is rejected even when the secret resolves", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, { FINNHUB_API_KEY: "abc123" });
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "finnhub",
            transport: "stdio",
            command: "uvx",
            args: ["mcp-finnhub"],
            env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("gateway-patch on integrations.mcp.servers is rejected for multi-server payloads (route to mcp_manage)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "context7",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            enabled: true,
          },
          {
            name: "finnhub",
            transport: "stdio",
            command: "uvx",
            args: ["mcp-finnhub"],
            env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("gateway-patch on integrations.mcp.servers is rejected for many-missing-vars payloads", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "multi",
            transport: "stdio",
            command: "noop",
            env: {
              VAR_A: "${A}",
              VAR_B: "${B}",
              VAR_C: "${C}",
              VAR_D: "${D}",
            },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // Non-MCP patch: single-writer guard + env-validator both skipped entirely.
  it("skips validator entirely for non-MCP patches", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    // logLevel patch — has no integrations.mcp.servers — must succeed even
    // when the secrets store is empty.
    const result = await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    expect(result).toMatchObject({ patched: true });
  });

  // Empty servers array — even this no-op shape is rejected. The
  // single-writer invariant treats integrations.mcp.servers as fully managed
  // by mcp_manage, no exceptions for "vacuous" payloads.
  it("rejects even an empty servers-array patch (no carve-out for no-op shapes)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // Parent-path bypass shapes must produce the
  // mcp_manage redirect, not the generic "immutable path" message that
  // arises if the patch slips past the single-writer guard and into the
  // isImmutableConfigPath check.

  it("parent-path bypass via { section:'integrations', key:'mcp', value:{ servers:[...] } } returns the mcp_manage redirect", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp",
        value: { servers: [] },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("parent-path bypass via { section:'integrations', value:{ mcp:{ servers:[...] } } } returns the mcp_manage redirect", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        value: { mcp: { servers: [] } },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("parent-path bypass via { path:'integrations.mcp', value:{ servers:[...] } } returns the mcp_manage redirect", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp",
        value: { servers: [] },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("parent-path bypass via { path:'integrations', value:{ mcp:{ servers:[...] } } } returns the mcp_manage redirect", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        path: "integrations",
        value: { mcp: { servers: [] } },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("parent-path NEGATIVE — { section:'integrations', value:{ media:{...} } } does NOT match (unrelated subtree)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, {});
    const handlers = createConfigHandlers(deps);

    // This patch touches integrations.media (which is mutable), not mcp.servers —
    // single-writer guard must NOT fire. Whether the patch ultimately succeeds depends on schema
    // validation downstream; the assertion here is purely that the mcp_manage
    // redirect is NOT raised.
    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        value: { media: {} },
        _trustLevel: "admin",
      }),
    ).rejects.not.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });
});

// ---------------------------------------------------------------------------
// Config webhook delivery tests
// ---------------------------------------------------------------------------

/** Flush all pending microtasks so fire-and-forget promises settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("config webhook delivery", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
    mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    tempConfig.cleanup();
  });

  it("config.patch delivers webhook with payload when url is configured", async () => {
    const deps = makeDeps(tempConfig.configPath);
    deps.configWebhook = { url: "https://example.com/hook", timeoutMs: 3000 };
    const handlers = createConfigHandlers(deps);

    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    // Flush fire-and-forget promise
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual(expect.objectContaining({ "Content-Type": "application/json" }));

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.event).toBe("config.changed");
    expect(body.method).toBe("config.patch");
    expect(body.section).toBe("logLevel");
    // Timestamp is ISO format
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp as string).toISOString()).toBe(body.timestamp);
  });

  it("config.patch skips webhook when url is not configured", async () => {
    const deps = makeDeps(tempConfig.configPath);
    // No configWebhook set (or empty)
    deps.configWebhook = {};
    const handlers = createConfigHandlers(deps);

    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("config.apply delivers webhook with method config.apply", async () => {
    const deps = makeDeps(tempConfig.configPath);
    deps.configWebhook = { url: "https://example.com/hook" };
    const handlers = createConfigHandlers(deps);

    await handlers["config.apply"]!({
      section: "scheduler",
      value: { cron: { enabled: true } },
      _trustLevel: "admin",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.method).toBe("config.apply");
    expect(body.section).toBe("scheduler");
  });

  it("webhook delivery failure does not block config.patch response", async () => {
    const deps = makeDeps(tempConfig.configPath);
    deps.configWebhook = { url: "https://example.com/hook" };
    // Configure fetch to reject with network error
    mockFetch.mockRejectedValue(new Error("Network error"));
    const handlers = createConfigHandlers(deps);

    // Should still succeed despite webhook failure
    const result = await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    expect(result).toMatchObject({ patched: true, section: "logLevel", value: "debug" });

    // Flush fire-and-forget promise so error is silenced
    await vi.advanceTimersByTimeAsync(0);

    // fetch was called but failed -- config write still succeeded
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("webhook includes HMAC signature when secret is configured", async () => {
    const deps = makeDeps(tempConfig.configPath);
    deps.configWebhook = { url: "https://example.com/hook", secret: "test-secret" };
    const handlers = createConfigHandlers(deps);

    await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["X-Webhook-Signature"]).toBeDefined();
    expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify the signature is correct by computing it ourselves
    const { createHmac } = await import("node:crypto");
    const expectedSig = createHmac("sha256", "test-secret")
      .update(opts.body as string)
      .digest("hex");
    expect(headers["X-Webhook-Signature"]).toBe(`sha256=${expectedSig}`);
  });
});

// ---------------------------------------------------------------------------
// config.gc tests
// ---------------------------------------------------------------------------

describe("config.gc", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("requires admin trust", async () => {
    const deps = makeDeps(tempConfig.configPath);
    deps.configGitManager = {
      gc: vi.fn().mockResolvedValue({ ok: true, value: { prunedObjects: true } }),
    } as unknown as ConfigHandlerDeps["configGitManager"];
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.gc"]!({ _trustLevel: "viewer" }),
    ).rejects.toThrow("Admin access required");
  });

  it("runs garbage collection", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const mockGc = vi.fn().mockResolvedValue({ ok: true, value: { prunedObjects: true } });
    deps.configGitManager = {
      gc: mockGc,
    } as unknown as ConfigHandlerDeps["configGitManager"];
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.gc"]!({ _trustLevel: "admin" });

    expect(mockGc).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ gc: true });
    // Should NOT have squash fields when olderThan is not provided
    expect(result).not.toHaveProperty("squashed");
  });

  it("runs squash when olderThan is provided", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const mockGc = vi.fn().mockResolvedValue({ ok: true, value: { prunedObjects: true } });
    const mockSquash = vi.fn().mockResolvedValue({
      ok: true,
      value: { squashedCount: 5, newRootSha: "abc123def456" },
    });
    deps.configGitManager = {
      gc: mockGc,
      squash: mockSquash,
    } as unknown as ConfigHandlerDeps["configGitManager"];
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.gc"]!({
      olderThan: "2026-01-01T00:00:00Z",
      _trustLevel: "admin",
    });

    expect(mockGc).toHaveBeenCalledTimes(1);
    expect(mockSquash).toHaveBeenCalledWith("2026-01-01T00:00:00Z");
    expect(result).toMatchObject({
      gc: true,
      squashed: 5,
      newRootSha: "abc123def456",
    });
  });

  it("returns error when git unavailable", async () => {
    const deps = makeDeps(tempConfig.configPath);
    // No configGitManager set
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.gc"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("Config versioning not available");
  });
});

// ---------------------------------------------------------------------------
// Trust-level enforcement on read handlers
// ---------------------------------------------------------------------------

describe("config.read admin trust enforcement", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  it("rejects without _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(handlers["config.read"]!({})).rejects.toThrow(
      "Admin access required for config read",
    );
  });

  it("rejects with non-admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.read"]!({ _trustLevel: "user" }),
    ).rejects.toThrow("Admin access required for config read");
  });

  it("succeeds with admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.read"]!({ _trustLevel: "admin" });
    expect(result).toHaveProperty("config");
    expect(result).toHaveProperty("sections");
  });

  it("reads a specific section with admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.read"]!({
      section: "logLevel",
      _trustLevel: "admin",
    });
    // logLevel returns the redacted value directly
    expect(result).toBeDefined();
  });
});

describe("config.schema admin trust enforcement", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  it("rejects without admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(handlers["config.schema"]!({})).rejects.toThrow(
      "Admin access required for config schema",
    );
  });

  it("succeeds with admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.schema"]!({ _trustLevel: "admin" });
    expect(result).toHaveProperty("schema");
    expect(result).toHaveProperty("sections");
  });
});

describe("config.history admin trust enforcement", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  it("rejects without admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(handlers["config.history"]!({})).rejects.toThrow(
      "Admin access required for config history",
    );
  });

  it("succeeds with admin _trustLevel (no git)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.history"]!({
      _trustLevel: "admin",
    })) as { entries: unknown[]; error?: string };
    // No git manager, so entries is empty with error message
    expect(result.entries).toEqual([]);
  });
});

describe("config.diff admin trust enforcement", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  it("rejects without admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(handlers["config.diff"]!({})).rejects.toThrow(
      "Admin access required for config diff",
    );
  });

  it("succeeds with admin _trustLevel (no git)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.diff"]!({
      _trustLevel: "admin",
    })) as { diff: string; error?: string };
    expect(result.diff).toBe("");
  });
});

// ---------------------------------------------------------------------------
// config.patch type coercion tests
// ---------------------------------------------------------------------------

describe("config.patch type coercion", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("coerces string 'true' to boolean true", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // watchEnabled is z.boolean() — sending "true" (string) should be coerced to true (boolean)
    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.skills.watchEnabled",
      value: "true",
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    // Read back the written YAML and verify the value is boolean true, not string "true"
    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, Record<string, unknown>>>;
    expect(agents.default.skills.watchEnabled).toBe(true);
    expect(typeof agents.default.skills.watchEnabled).toBe("boolean");
  });

  it("coerces string 'false' to boolean false", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.skills.watchEnabled",
      value: "false",
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, Record<string, unknown>>>;
    expect(agents.default.skills.watchEnabled).toBe(false);
    expect(typeof agents.default.skills.watchEnabled).toBe("boolean");
  });

  it("coerces numeric string '42' to number 42", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // maxSteps is z.number().int().positive() — sending "42" should be coerced to 42
    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.maxSteps",
      value: "42",
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, unknown>>;
    expect(agents.default.maxSteps).toBe(42);
    expect(typeof agents.default.maxSteps).toBe("number");
  });

  it("preserves actual string values unchanged", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // tenantId is a top-level string field — string values should stay as strings
    const result = await handlers["config.patch"]!({
      section: "tenantId",
      value: "my-tenant",
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.tenantId).toBe("my-tenant");
    expect(typeof parsed.tenantId).toBe("string");
  });

  it("coerces JSON-stringified array to real array", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // channels.discord.allowedChannelIds expects an array — send as JSON string
    const result = await handlers["config.patch"]!({
      section: "scheduler",
      key: "cron",
      value: '{"enabled":"true","maxConcurrentRuns":"3"}',
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const scheduler = parsed.scheduler as Record<string, Record<string, unknown>>;
    // JSON string should have been parsed, and nested values coerced
    expect(scheduler.cron.enabled).toBe(true);
    expect(typeof scheduler.cron.enabled).toBe("boolean");
    expect(scheduler.cron.maxConcurrentRuns).toBe(3);
    expect(typeof scheduler.cron.maxConcurrentRuns).toBe("number");
  });

  it("coerces JSON-stringified object to real object with nested coercion", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Send a JSON-stringified object — should be parsed and nested values coerced
    const result = await handlers["config.patch"]!({
      section: "scheduler",
      key: "cron",
      value: '{"enabled":"false","maxConcurrentRuns":"5"}',
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const scheduler = parsed.scheduler as Record<string, Record<string, unknown>>;
    expect(scheduler.cron.enabled).toBe(false);
    expect(typeof scheduler.cron.enabled).toBe("boolean");
    expect(scheduler.cron.maxConcurrentRuns).toBe(5);
    expect(typeof scheduler.cron.maxConcurrentRuns).toBe("number");
  });

  it("does not parse invalid JSON strings", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Invalid JSON should fall through as a plain string.
    // For a string field like tenantId, the string "[not json" is accepted as-is.
    const result = await handlers["config.patch"]!({
      section: "tenantId",
      value: "[not json",
      _trustLevel: "admin",
    });

    // The value passes through unchanged as a string (not parsed as JSON)
    expect(result).toHaveProperty("patched", true);
    expect(result).toHaveProperty("value", "[not json");

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.tenantId).toBe("[not json");
    expect(typeof parsed.tenantId).toBe("string");
  });

  it("coerces values in nested objects", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Patch scheduler.cron with an object containing boolean and number as strings
    const result = await handlers["config.patch"]!({
      section: "scheduler",
      key: "cron",
      value: { enabled: "true", maxConcurrentRuns: "5" },
      _trustLevel: "admin",
    });

    expect(result).toHaveProperty("patched", true);

    const { parse: parseYaml } = await import("yaml");
    const raw = readFileSync(tempConfig.configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const scheduler = parsed.scheduler as Record<string, Record<string, unknown>>;
    expect(scheduler.cron.enabled).toBe(true);
    expect(typeof scheduler.cron.enabled).toBe("boolean");
    expect(scheduler.cron.maxConcurrentRuns).toBe(5);
    expect(typeof scheduler.cron.maxConcurrentRuns).toBe("number");
  });

  // -------------------------------------------------------------------------
  // config.patch on integrations.mcp.servers is REJECTED — the
  // z.record(string,string) env + headers preservation behavior is now
  // exercised on the persistToConfig writer path (covered by the
  // mcp-handlers tests). The coerceConfigValue + AppConfigSchema.safeParse
  // logic that originally enforced the preservation invariant is unchanged
  // and still runs inside persistToConfig.
  // -------------------------------------------------------------------------
  it("config.patch on integrations.mcp.servers is rejected (env z.record preservation moves to persistMcpServers)", async () => {
    const deps = makeDepsWithEnv(tempConfig.configPath, { GEMINI_API_KEY: "test-gemini-key" });
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "gemini-image",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@jimothy-snicket/gemini-image-mcp"],
            env: {
              GEMINI_API_KEY: "${GEMINI_API_KEY}",
              MAX_REQUESTS_PER_HOUR: "20",
              MAX_COST_PER_HOUR: "5",
            },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("config.patch on integrations.mcp.servers is rejected (headers z.record preservation moves to persistMcpServers)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [
          {
            name: "remote-mcp",
            transport: "http",
            url: "https://example.com/mcp",
            headers: {
              "X-Rate-Limit": "42",
              "X-Retry-Count": "3",
              Authorization: "Bearer abc",
            },
            enabled: true,
          },
        ],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // -------------------------------------------------------------------------
  // config.apply-style coercion preserves z.record(string,string) env values
  // on a section-level payload.
  //
  // We can't drive this end-to-end through `handlers["config.apply"]` because
  // `integrations` is in IMMUTABLE_CONFIG_PREFIXES
  // (core/src/config/immutable-keys.ts:88), so config.apply rejects the
  // section-level replace BEFORE reaching the coercion pipeline. There is no
  // other mutable section that contains z.record(z.string(), z.string()).
  //
  // Instead, we exercise the config.apply callsite's coercion path directly
  // via `resolveSchemaForPath(AppConfigSchema, "integrations", undefined)` +
  // `coerceConfigValue`, which is exactly what the handler does at line 512.
  // This proves the section-level coercion path (signature + undefined key at
  // section level) without being gated by immutability policy. The patch-based
  // tests above already cover end-to-end persistence via config.patch.
  // -------------------------------------------------------------------------
  it("config.apply-style section coercion preserves z.record(string,string) env values", async () => {
    const { AppConfigSchema } = await import("@comis/core");
    const { resolveSchemaForPath } = await import("./config-handlers/index.js");

    const sectionValue = {
      mcp: {
        servers: [
          {
            name: "gemini-image",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@jimothy-snicket/gemini-image-mcp"],
            env: {
              GEMINI_API_KEY: "${GEMINI_API_KEY}",
              MAX_REQUESTS_PER_HOUR: "20",
              MAX_COST_PER_HOUR: "5",
            },
            enabled: true,
          },
        ],
      },
    };

    // Mirror config.apply's line-512 call exactly: section resolution with
    // undefined key (the whole section is being replaced).
    const subSchema = resolveSchemaForPath(AppConfigSchema, "integrations", undefined);
    const coerced = coerceConfigValue(sectionValue, subSchema) as {
      mcp: { servers: Array<Record<string, unknown>> };
    };

    const env = coerced.mcp.servers[0]!.env as Record<string, unknown>;

    // MAX_REQUESTS_PER_HOUR must survive as the string "20", not number 20.
    expect(env.MAX_REQUESTS_PER_HOUR).toBe("20");
    expect(typeof env.MAX_REQUESTS_PER_HOUR).toBe("string");
    expect(env.MAX_COST_PER_HOUR).toBe("5");
    expect(typeof env.MAX_COST_PER_HOUR).toBe("string");
    // env-var reference preserved verbatim.
    expect(env.GEMINI_API_KEY).toBe("${GEMINI_API_KEY}");
    // Validate against the real schema — if coercion turned strings into
    // numbers, z.record(string,string) would reject.
    const validation = AppConfigSchema.shape.integrations.safeParse(coerced);
    expect(validation.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Direct unit test of coerceConfigValue with a ZodUnion containing a
  // ZodString branch: numeric-looking strings must pass through (bias toward
  // loud failure rather than silent coercion).
  // -------------------------------------------------------------------------
  it("passes strings through when target is ZodUnion containing a ZodString branch", () => {
    const unionSchema = z.union([z.string(), z.number()]);
    expect(coerceConfigValue("42", unionSchema)).toBe("42");
    expect(coerceConfigValue("true", unionSchema)).toBe("true");
    expect(coerceConfigValue("hello", unionSchema)).toBe("hello");
  });
});

describe("gateway.status admin trust enforcement", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  it("rejects without admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(handlers["gateway.status"]!({})).rejects.toThrow(
      "Admin access required for gateway status",
    );
  });

  it("rejects with non-admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["gateway.status"]!({ _trustLevel: "viewer" }),
    ).rejects.toThrow("Admin access required for gateway status");
  });

  it("succeeds with admin _trustLevel", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["gateway.status"]!({
      _trustLevel: "admin",
    })) as { pid: number; uptime: number; version?: string };
    expect(result.pid).toBe(process.pid);
    expect(result.uptime).toEqual(expect.any(Number));
  });

  it("surfaces the daemon build version (for comis doctor's version-skew check)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["gateway.status"]!({
      _trustLevel: "admin",
    })) as { version?: string };
    expect(result.version).toBe(TEST_DAEMON_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Daemon-side credential guard for agents.*.{provider,model} patches.
// Verifies config.patch rejects fail-loud when the resulting agent provider
// has no resolvable API key from any source pi-coding-agent would consult at
// runtime.
// ---------------------------------------------------------------------------

describe("config.patch credential guard", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
    originalEnv = { ...process.env };
    // Strip canonical keys we manipulate so per-test state is deterministic.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
  });

  afterEach(() => {
    // Clear any pending fake timers BEFORE swapping to real timers — otherwise
    // the queued setTimeout (e.g., the 200ms SIGUSR2 restart timer) migrates to
    // the real-timer queue and fires after vi.restoreAllMocks() runs, calling
    // the REAL process.kill(pid, "SIGUSR2") which terminates the vitest worker
    // and surfaces as `[vitest-pool]: Worker exited unexpectedly`.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
    process.env = originalEnv;
  });

  it("rejects agents.<id>.provider patch when no source resolves (no entry, no env)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "agents",
        key: "default.provider",
        value: "openrouter",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/Cannot set agent provider to "openrouter"/);

    // Patch must not have triggered a restart
    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("succeeds when canonical env key is set (Source B)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-xxx";
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.provider",
      value: "openrouter",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  it("succeeds when providers.entries.<id>.apiKeyName is in secretManager (Source A)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    // Wire a provider entry whose apiKeyName resolves via the bootstrap's
    // secretManager. Seed the env map explicitly — bootstrap no longer
    // falls back to process.env, so the test seeds the SecretManager via
    // makeDepsWithEnv.
    const freshDeps = makeDepsWithEnv(tempConfig.configPath, { OR_KEY: "sk-or-v1-xxx" });
    (freshDeps.container.config as { providers: { entries: Record<string, unknown> } }).providers.entries["openrouter"] = {
      type: "openai",
      name: "OR",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyName: "OR_KEY",
      enabled: true,
      timeoutMs: 120_000,
      maxRetries: 2,
      headers: {},
      capabilities: { providerFamily: "default", dropThinkingBlockModelHints: [], transcriptToolCallIdMode: "default", transcriptToolCallIdModelHints: [] },
      models: [],
    };
    const handlers = createConfigHandlers(freshDeps);
    void deps; // avoid unused-let warning

    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.provider",
      value: "openrouter",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  it("rejection message names the configured apiKeyName when entry exists but secret is missing", async () => {
    const deps = makeDeps(tempConfig.configPath);
    (deps.container.config as { providers: { entries: Record<string, unknown> } }).providers.entries["openrouter"] = {
      type: "openai",
      name: "OR",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyName: "OR_KEY",
      enabled: true,
      timeoutMs: 120_000,
      maxRetries: 2,
      headers: {},
      capabilities: { providerFamily: "default", dropThinkingBlockModelHints: [], transcriptToolCallIdMode: "default", transcriptToolCallIdModelHints: [] },
      models: [],
    };
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "agents",
        key: "default.provider",
        value: "openrouter",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/apiKeyName is "OR_KEY"/);
  });

  it("does NOT fire on non-credential agent patches (maxSteps)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // No providerEntries / no env → guard would reject if it fired.
    // maxSteps is not a provider/model field, so guard is a no-op.
    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.maxSteps",
      value: "50",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  it("does NOT fire on model-only patches when provider is unchanged", async () => {
    const deps = makeDeps(tempConfig.configPath);
    // Seed agent at a provider that has NO resolvable credential — guard
    // would reject if it fired. Patch only `.model` (not `.provider`); the
    // resolved targetProvider equals the current provider, so the guard
    // must short-circuit. Stale-broken-config detection moves to the next
    // chat turn (fail-loud at the request boundary), not at patch time.
    (deps.container.config as { agents: Record<string, unknown> }).agents["default"] = {
      name: "Stale",
      model: "qwen/qwen3-coder",
      provider: "openrouter",
      maxSteps: 25,
    };
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.model",
      value: "qwen/qwen3-coder-latest",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  it("succeeds when OAuth-only provider has a configured + loadable profile (Source C)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    // Seed an oauthCredentialStore stub that confirms the profile exists.
    (deps as ConfigHandlerDeps).oauthCredentialStore = {
      has: async (id: string) => ({ ok: true, value: id === "openai-codex:user_a@example.com" }),
      get: async () => ({ ok: true, value: undefined }),
      set: async () => ({ ok: true, value: undefined }),
      delete: async () => ({ ok: true, value: false }),
      list: async () => ({ ok: true, value: [] }),
    } as unknown as ConfigHandlerDeps["oauthCredentialStore"];
    // Seed the agent's oauthProfiles config so the resolver consults Source C.
    (deps.container.config as { agents: Record<string, unknown> }).agents["default"] = {
      name: "Codex",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic", // start somewhere arbitrary
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      maxSteps: 25,
    };
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "agents",
      key: "default.provider",
      value: "openai-codex",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  it("rejects with OAuth-aware copy when OAuth profile is configured but loader reports missing", async () => {
    const deps = makeDeps(tempConfig.configPath);
    (deps as ConfigHandlerDeps).oauthCredentialStore = {
      has: async () => ({ ok: true, value: false }),
      get: async () => ({ ok: true, value: undefined }),
      set: async () => ({ ok: true, value: undefined }),
      delete: async () => ({ ok: true, value: false }),
      list: async () => ({ ok: true, value: [] }),
    } as unknown as ConfigHandlerDeps["oauthCredentialStore"];
    (deps.container.config as { agents: Record<string, unknown> }).agents["default"] = {
      name: "Codex",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      maxSteps: 25,
    };
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "agents",
        key: "default.provider",
        value: "openai-codex",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/comis auth login --provider openai-codex/);
  });

  it("provider-change to OAuth-only provider with NO oauthProfiles config falls through to standard rejection", async () => {
    const deps = makeDeps(tempConfig.configPath);
    (deps.container.config as { agents: Record<string, unknown> }).agents["default"] = {
      name: "Plain",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      maxSteps: 25,
    };
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "agents",
        key: "default.provider",
        value: "openai-codex",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/Cannot set agent provider to "openai-codex"/);
  });
});

// ---------------------------------------------------------------------------
// Gateway-patch single-writer guard for integrations.mcp.servers
//
// The mcp_manage RPC (mcp.connect / mcp.disconnect) is the canonical writer of
// integrations.mcp.servers via persistToConfig. Direct gateway(action:"patch")
// against any path under that prefix is rejected at the handler entry — BEFORE
// the rate-limit consume and BEFORE the Zod contract.parse — so:
//   1. admins probing the boundary do not burn their 5-per-60s budget,
//   2. the LLM-visible error message contains a routing hint (mcp_manage),
//   3. the existing handler flow runs unchanged for every other section/key.
//
// The guard mirrors the immutable-paths precedent at config-write.ts:144-152.
// It does NOT remove the MUTABLE_CONFIG_OVERRIDES entry for
// integrations.mcp.servers at immutable-keys.ts:38 — persistToConfig (in
// mcp-handlers) needs that override entry to write through.
// ---------------------------------------------------------------------------

describe("config.patch single-writer guard (integrations.mcp.servers)", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  // Test 1: path-format (legacy dot-notation).
  it("rejects gateway-patch with path: 'integrations.mcp.servers' and routes the caller to mcp_manage", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const callPromise = handlers["config.patch"]!({
      path: "integrations.mcp.servers",
      value: [{ name: "foo", transport: "stdio", command: "echo" }],
      _trustLevel: "admin",
    });

    // Error message must surface ALL of: the path, mcp_manage, connect, disconnect.
    await expect(callPromise).rejects.toThrow(/integrations\.mcp\.servers/);
    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/mcp_manage/);
    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/connect/);
    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/disconnect/);

    // No daemon restart was scheduled — guard fires before the write pipeline.
    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  // Test 2: section/key format (canonical wire shape).
  it("rejects gateway-patch with section/key shape ('integrations' / 'mcp.servers')", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // Test 3: sub-path (e.g., toggling enabled on a single server entry).
  it("rejects gateway-patch on sub-paths like 'mcp.servers.0.enabled'", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers.0.enabled",
        value: false,
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // Test 4: error precedence — guard fires BEFORE the rate-limit consume.
  // Strategy: invoke the rejected handler 10 times (more than the 5/min
  // budget), then verify that 5 legitimate patches still succeed. If the
  // guard burned tokens, the 5th legitimate patch would be rate-limited.
  it("guard does NOT consume rate-limit tokens (admins can probe without burning budget)", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // Hammer the guard 10 times — far more than the 5/60s bucket would tolerate.
    for (let i = 0; i < 10; i++) {
      await expect(
        handlers["config.patch"]!({
          section: "integrations",
          key: "mcp.servers",
          value: [{ name: `probe-${i}`, transport: "stdio", command: "echo" }],
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/mcp_manage/);
    }

    // Now 5 legitimate non-MCP patches must still all succeed (rate-limit
    // budget was not consumed by the rejected probes).
    for (let i = 0; i < 5; i++) {
      const result = await handlers["config.patch"]!({
        section: "logLevel",
        value: "debug",
        _trustLevel: "admin",
      });
      expect(result).toMatchObject({ patched: true });
    }
  });

  // Test 5: non-match on sibling integrations path (github).
  // The guard prefix-matches "integrations.mcp.servers" — sibling paths like
  // "integrations.github" must fall through to the existing handler flow.
  // integrations.github isn't itself mutable so the patch ultimately fails
  // for unrelated reasons — but it must NOT be rejected with the single-writer message.
  it("does NOT over-match: a sibling integrations.* path is not blocked by the guard", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "github",
        value: { token: "x" },
        _trustLevel: "admin",
      }),
    ).rejects.toThrow();

    // Inspect the actual thrown message — it must NOT mention "mcp_manage"
    // (i.e., the existing handler flow rejected it for its own reasons, not the single-writer guard).
    let err: unknown;
    try {
      await handlers["config.patch"]!({
        section: "integrations",
        key: "github",
        value: { token: "x" },
        _trustLevel: "admin",
      });
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).not.toMatch(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  // Test 6: non-match on unrelated top-level section.
  it("does NOT over-match: an unrelated top-level section is not blocked by the guard", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    // logLevel is a top-level mutable scalar — the existing handler flow
    // must reach the write pipeline (returns patched: true).
    const result = await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });
    expect(result).toMatchObject({ patched: true });
  });

  // Test 7: admin-trust precedence — the existing trustLevel check at
  // config-write.ts:74-76 must STILL fire FIRST for non-admin callers, even
  // when the patch targets integrations.mcp.servers. Order is:
  //   trust-check → routing-redirect → rate-limit → contract.parse → ...
  it("admin-trust check fires before guard (non-admin callers get 'Admin access required')", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "user", // non-admin
      }),
    ).rejects.toThrow(/Admin access required for config modification/);
  });
});

// ---------------------------------------------------------------------------
// config.read never echoes MCP server headers credentials
//
// Regression guard: config.read calls redactForDisplay(deps.container.config)
// at config-read.ts:64, which deep-walks the object and replaces any string
// value whose parent key matches isSecretFieldName() with "[REDACTED]".
// isSecretFieldName covers: "authorization", "cookie", "x-api-key" (and more).
//
// These tests pin the correct behavior so that removing redactForDisplay from
// config-read.ts:53/64 would flip them failing and CI would catch the regression.
// ---------------------------------------------------------------------------

describe("config.read never echoes MCP server headers credentials", () => {
  let tempConfig: ReturnType<typeof createTempConfig>;

  beforeEach(() => {
    tempConfig = createTempConfig();
  });

  afterEach(() => {
    tempConfig.cleanup();
  });

  /**
   * Inject a single MCP server entry with plaintext credential headers
   * directly into the bootstrapped container's config. This bypasses the
   * write path so we can test the read-side masking in isolation.
   */
  function makeDepsWithMcpHeaders(headers: Record<string, string>) {
    const deps = makeDeps(tempConfig.configPath);
    // Direct mutation of the live config object to inject the MCP server.
    // The handler reads deps.container.config, so this controls what
    // redactForDisplay receives.
    const config = deps.container.config as Record<string, unknown>;
    config["integrations"] = {
      mcp: {
        servers: [
          {
            name: "myserver",
            transport: "stdio",
            command: "some-command",
            headers,
          },
        ],
      },
    };
    return deps;
  }

  it("masks Authorization header value in full config.read response", async () => {
    // Regression guard: removing redactForDisplay from config-read.ts:64 would flip this failing.
    const deps = makeDepsWithMcpHeaders({
      Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "Content-Type": "application/json",
    });
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.read"]!({
      _trustLevel: "admin",
    })) as {
      config: {
        integrations: { mcp: { servers: Array<{ headers: Record<string, string> }> } };
      };
    };

    const headers = result.config.integrations.mcp.servers[0]!.headers;
    expect(headers.Authorization).toBe("[REDACTED]");
    // Non-secret header passes through unmasked
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("masks Cookie header value in section read ('integrations')", async () => {
    // Regression guard: removing redactForDisplay from config-read.ts:53 would flip this failing.
    const deps = makeDepsWithMcpHeaders({
      Cookie: "session=abc123",
      "X-Request-Id": "trace-1234",
    });
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.read"]!({
      section: "integrations",
      _trustLevel: "admin",
    })) as {
      mcp: { servers: Array<{ headers: Record<string, string> }> };
    };

    const headers = result.mcp.servers[0]!.headers;
    expect(headers.Cookie).toBe("[REDACTED]");
    // Non-secret header passes through unmasked
    expect(headers["X-Request-Id"]).toBe("trace-1234");
  });

  it("masks X-Api-Key header value in full config.read response", async () => {
    // Regression guard: removing redactForDisplay from config-read.ts:64 would flip this failing.
    const deps = makeDepsWithMcpHeaders({
      "X-Api-Key": "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.read"]!({
      _trustLevel: "admin",
    })) as {
      config: {
        integrations: { mcp: { servers: Array<{ headers: Record<string, string> }> } };
      };
    };

    const headers = result.config.integrations.mcp.servers[0]!.headers;
    expect(headers["X-Api-Key"]).toBe("[REDACTED]");
  });

  it("masks ${VAR}-form Authorization header value (ref form is still field-name-redacted)", async () => {
    // redactForDisplay is field-name-based, not value-based.
    // Even a ${VAR} reference under the Authorization key is masked in config.read output.
    // The operator uses secrets_manage to list variable names — config.read need not reveal them.
    // Regression guard: removing redactForDisplay from config-read.ts:64 would flip this failing.
    const deps = makeDepsWithMcpHeaders({
      Authorization: "Bearer ${MCP_MYSERVER__AUTHORIZATION}",
    });
    const handlers = createConfigHandlers(deps);

    const result = (await handlers["config.read"]!({
      _trustLevel: "admin",
    })) as {
      config: {
        integrations: { mcp: { servers: Array<{ headers: Record<string, string> }> } };
      };
    };

    const headers = result.config.integrations.mcp.servers[0]!.headers;
    // Field-name based masking: the Authorization key causes [REDACTED] regardless of value form.
    expect(headers.Authorization).toBe("[REDACTED]");
  });
});
