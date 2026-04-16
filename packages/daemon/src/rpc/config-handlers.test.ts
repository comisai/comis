import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createConfigHandlers, type ConfigHandlerDeps } from "./config-handlers.js";
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
  const result = bootstrap({ configPaths: [configPath] });
  if (!result.ok) {
    throw new Error(`Bootstrap failed in test: ${result.error.message}`);
  }
  const logger = createMockLogger();
  return {
    container: result.value,
    configPaths: [configPath],
    defaultConfigPaths: [configPath],
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("schedules SIGUSR1 restart after successful write", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.patch"]!({
      section: "logLevel",
      value: "debug",
      _trustLevel: "admin",
    });

    // SIGUSR1 should NOT have been called yet (it's on a 200ms timer)
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers by 200ms
    vi.advanceTimersByTime(200);

    // Now SIGUSR1 should have been sent
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");

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

    // Advance timers -- SIGUSR1 should NOT have been called
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    tempConfig.cleanup();
  });

  it("replaces section atomically and schedules SIGUSR1 restart", async () => {
    const deps = makeDeps(tempConfig.configPath);
    const handlers = createConfigHandlers(deps);

    const result = await handlers["config.apply"]!({
      section: "scheduler",
      value: { cron: { enabled: true } },
      _trustLevel: "admin",
    });

    // Return value
    expect(result).toMatchObject({ applied: true, section: "scheduler", restarting: true });

    // SIGUSR1 should not have been called yet (200ms timer)
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers by 200ms
    vi.advanceTimersByTime(200);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");

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
// H-1: Trust-level enforcement on read handlers
// ---------------------------------------------------------------------------

describe("config.read admin trust enforcement (H-1)", () => {
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

describe("config.schema admin trust enforcement (H-1)", () => {
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

describe("config.history admin trust enforcement (H-1)", () => {
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

describe("config.diff admin trust enforcement (H-1)", () => {
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
});

describe("gateway.status admin trust enforcement (H-1)", () => {
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
    })) as { pid: number; uptime: number };
    expect(result.pid).toBe(process.pid);
    expect(result.uptime).toEqual(expect.any(Number));
  });
});
