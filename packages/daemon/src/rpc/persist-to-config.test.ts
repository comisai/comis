import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { persistToConfig, _resetSigusr1Timer, _resetMutationFence, enterConfigMutationFence, leaveConfigMutationFence, type PersistToConfigDeps, type PersistToConfigOpts } from "./persist-to-config.js";
import { AppConfigSchema } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid config that passes AppConfigSchema. All sections have defaults,
 *  so an empty object parses cleanly. We only need to supply a valid container.config. */
function makeMinimalConfig() {
  return AppConfigSchema.parse({});
}

/** Minimal valid YAML that, when merged with container.config, produces a valid AppConfig. */
function makeMinimalYaml(): string {
  return yamlStringify({ logLevel: "info" });
}

function makeDeps(overrides: Partial<PersistToConfigDeps> = {}): PersistToConfigDeps {
  return {
    container: {
      config: makeMinimalConfig(),
      eventBus: { emit: vi.fn() },
    } as unknown as PersistToConfigDeps["container"],
    configPaths: [],
    defaultConfigPaths: [],
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeOpts(overrides: Partial<PersistToConfigOpts> = {}): PersistToConfigOpts {
  return {
    patch: {},
    actionType: "test.action",
    entityId: "test-entity",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("persistToConfig", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persist-test-"));
    configPath = join(tempDir, "config.local.yaml");
    writeFileSync(configPath, makeMinimalYaml(), "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Success: reads existing YAML, deep-merges patch, writes updated file
  // -----------------------------------------------------------------------
  it("success: reads existing YAML, deep-merges patch, writes updated file", async () => {
    // Write initial YAML with a default agent
    const initialYaml = yamlStringify({
      agents: {
        default: {
          name: "Original",
          model: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
        },
      },
    });
    writeFileSync(configPath, initialYaml, "utf-8");

    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: {
        agents: {
          newbot: {
            name: "NewBot",
            model: "gpt-4o",
            provider: "openai",
          },
        },
      },
      actionType: "agents.create",
      entityId: "newbot",
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configPath).toBe(configPath);
    }

    // Read back from disk and verify both agents exist
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, unknown>;
    expect(agents.default).toBeDefined();
    expect(agents.newbot).toBeDefined();
    expect((agents.newbot as Record<string, unknown>).name).toBe("NewBot");
    // Original agent preserved
    expect((agents.default as Record<string, unknown>).name).toBe("Original");
  });

  // -----------------------------------------------------------------------
  // 1b. Success: written config file has mode 0o600
  // -----------------------------------------------------------------------
  it("success: written config file has mode 0o600", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    const result = await persistToConfig(deps, opts);
    expect(result.ok).toBe(true);

    const stat = statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // -----------------------------------------------------------------------
  // 2. Success: creates parent directory if missing
  // -----------------------------------------------------------------------
  it("success: creates parent directory if missing", async () => {
    const nestedPath = join(tempDir, "subdir", "nested", "config.local.yaml");

    const deps = makeDeps({ configPaths: [nestedPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(true);
    expect(existsSync(nestedPath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Success: starts from empty object if config file does not exist
  // -----------------------------------------------------------------------
  it("success: starts from empty object if config file does not exist", async () => {
    const newPath = join(tempDir, "brand-new-config.yaml");

    const deps = makeDeps({ configPaths: [newPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(true);
    const raw = readFileSync(newPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.logLevel).toBe("debug");
  });

  // -----------------------------------------------------------------------
  // 4. Validation failure: returns err when patch produces invalid config
  // -----------------------------------------------------------------------
  it("validation failure: returns err when patch produces invalid config", async () => {
    const originalContent = readFileSync(configPath, "utf-8");

    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: { gateway: { port: "not-a-number" } },
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Config validation failed");
    }

    // File should NOT have been modified
    const afterContent = readFileSync(configPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  // -----------------------------------------------------------------------
  // 5. Write failure: returns err when filesystem write fails
  // -----------------------------------------------------------------------
  it("write failure: returns err when filesystem write fails", async () => {
    // Path that cannot have mkdirSync succeed
    const impossiblePath = "/dev/null/impossible/config.yaml";

    const deps = makeDeps({ configPaths: [impossiblePath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("persistToConfig failed");
    }
  });

  // -----------------------------------------------------------------------
  // 6. Git success: calls configGitManager.commit on successful write
  // -----------------------------------------------------------------------
  it("git success: calls configGitManager.commit on successful write", async () => {
    const mockCommit = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      configPaths: [configPath],
      configGitManager: { commit: mockCommit } as unknown as PersistToConfigDeps["configGitManager"],
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
      actionType: "config.test",
      entityId: "test-entity",
    });

    await persistToConfig(deps, opts);

    // Allow fire-and-forget .then() to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "logLevel",
        key: "test-entity",
        summary: "config.test: test-entity",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 7. Git failure: does not affect ok() return value
  // -----------------------------------------------------------------------
  it("git failure: does not affect ok() return value", async () => {
    const mockCommit = vi.fn().mockRejectedValue(new Error("git failed"));
    const logger = createMockLogger();
    const deps = makeDeps({
      configPaths: [configPath],
      configGitManager: { commit: mockCommit } as unknown as PersistToConfigDeps["configGitManager"],
      logger,
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    const result = await persistToConfig(deps, opts);

    // Result should still be ok -- git failure is best-effort
    expect(result.ok).toBe(true);

    // Allow fire-and-forget .catch() to resolve
    await new Promise((r) => setTimeout(r, 10));

    // Git failure should be logged at DEBUG
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "persistToConfig",
        outcome: "failure",
      }),
      expect.any(String),
    );
  });

  // -----------------------------------------------------------------------
  // 8. Audit event: emits audit:event on success with destructive classification
  // -----------------------------------------------------------------------
  it("audit event: emits audit:event on success with destructive classification", async () => {
    const emitFn = vi.fn();
    const deps = makeDeps({
      configPaths: [configPath],
      container: {
        config: makeMinimalConfig(),
        eventBus: { emit: emitFn },
      } as unknown as PersistToConfigDeps["container"],
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
      actionType: "test.success",
      entityId: "my-entity",
    });

    await persistToConfig(deps, opts);

    expect(emitFn).toHaveBeenCalledWith(
      "audit:event",
      expect.objectContaining({
        classification: "destructive",
        outcome: "success",
        actionType: "test.success",
        metadata: expect.objectContaining({ entityId: "my-entity" }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 9. Audit event: emits audit:event on failure with outcome failure
  // -----------------------------------------------------------------------
  it("audit event: emits audit:event on failure with outcome failure", async () => {
    // Use an impossible write path to trigger the catch block, which emits the
    // failure audit event. Validation failures return err() early without emitting.
    const emitFn = vi.fn();
    const deps = makeDeps({
      configPaths: ["/dev/null/impossible/config.yaml"],
      container: {
        config: makeMinimalConfig(),
        eventBus: { emit: emitFn },
      } as unknown as PersistToConfigDeps["container"],
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    const result = await persistToConfig(deps, opts);
    expect(result.ok).toBe(false);

    expect(emitFn).toHaveBeenCalledWith(
      "audit:event",
      expect.objectContaining({
        classification: "destructive",
        outcome: "failure",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 11. removePaths: deletes specified keys from YAML output
  // -----------------------------------------------------------------------
  it("removePaths: deletes specified keys from YAML output", async () => {
    // Write YAML with two agents
    const initialYaml = yamlStringify({
      agents: {
        default: {
          name: "Default",
          model: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
        },
        toremove: {
          name: "ToRemove",
          model: "gpt-4o",
          provider: "openai",
        },
      },
    });
    writeFileSync(configPath, initialYaml, "utf-8");

    // Container.config must also have the agent to remove so fullMerged validation works
    const config = makeMinimalConfig();
    (config as Record<string, unknown>).agents = {
      default: { name: "Default", model: "claude-sonnet-4-5-20250929", provider: "anthropic" },
      toremove: { name: "ToRemove", model: "gpt-4o", provider: "openai" },
    };

    const deps = makeDeps({
      configPaths: [configPath],
      container: {
        config,
        eventBus: { emit: vi.fn() },
      } as unknown as PersistToConfigDeps["container"],
    });
    const opts = makeOpts({
      patch: {},
      removePaths: [["agents", "toremove"]],
      actionType: "agents.delete",
      entityId: "toremove",
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(true);

    // Read YAML from disk
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, unknown>;
    expect(agents.toremove).toBeUndefined();
    expect(agents.default).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 12. removePaths: handles non-existent paths gracefully
  // -----------------------------------------------------------------------
  it("removePaths: handles non-existent paths gracefully", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: {},
      removePaths: [["nonexistent", "path"]],
    });

    const result = await persistToConfig(deps, opts);

    expect(result.ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 13. Logging: logs INFO on success with durationMs
  // -----------------------------------------------------------------------
  it("logging: logs INFO on success with durationMs", async () => {
    const logger = createMockLogger();
    const deps = makeDeps({
      configPaths: [configPath],
      logger,
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    await persistToConfig(deps, opts);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "persistToConfig",
        outcome: "success",
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });

  // -----------------------------------------------------------------------
  // 14. Logging: logs WARN on failure with hint and errorKind
  // -----------------------------------------------------------------------
  it("logging: logs WARN on failure with hint and errorKind", async () => {
    const logger = createMockLogger();
    // Use impossible path to trigger write failure (caught by catch block)
    const deps = makeDeps({
      configPaths: ["/dev/null/impossible/config.yaml"],
      logger,
    });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    await persistToConfig(deps, opts);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "persistToConfig",
        outcome: "failure",
        hint: expect.any(String),
        errorKind: "config",
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// SIGUSR1 tests (isolated with fake timers)
// ---------------------------------------------------------------------------

describe("persistToConfig SIGUSR1 scheduling", () => {
  let tempDir: string;
  let configPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempDir = mkdtempSync(join(tmpdir(), "persist-test-sigusr1-"));
    configPath = join(tempDir, "config.local.yaml");
    writeFileSync(configPath, yamlStringify({ logLevel: "info" }), "utf-8");
  });

  afterEach(() => {
    _resetSigusr1Timer();
    _resetMutationFence();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("SIGUSR1: schedules process.kill with 2000ms debounce delay on success", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
    });

    await persistToConfig(deps, opts);

    // SIGUSR1 should NOT have been called yet
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers by 2000ms
    vi.advanceTimersByTime(2000);

    // Now SIGUSR1 should have been sent
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  it("SIGUSR1: coalesces multiple rapid calls into single signal", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    // Call persistToConfig 3 times in quick succession
    await persistToConfig(deps, opts);
    await persistToConfig(deps, opts);
    await persistToConfig(deps, opts);

    // No signal yet
    expect(killSpy).not.toHaveBeenCalled();

    // Advance past the debounce window
    vi.advanceTimersByTime(2000);

    // Only ONE SIGUSR1 should have been sent
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  // -----------------------------------------------------------------------
  // skipRestart suppresses SIGUSR1
  // -----------------------------------------------------------------------

  it("SIGUSR1: NOT scheduled when skipRestart is true", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
      skipRestart: true,
    });

    await persistToConfig(deps, opts);

    // Advance well past the normal 2000ms debounce + extra margin
    vi.advanceTimersByTime(5000);

    // SIGUSR1 should NOT have been called at all
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("SIGUSR1: still scheduled when skipRestart is false (explicit)", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
      skipRestart: false,
    });

    await persistToConfig(deps, opts);

    // Advance past 2000ms debounce
    vi.advanceTimersByTime(2000);

    // SIGUSR1 should have been called
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  it("SIGUSR1: still scheduled when skipRestart is omitted (default behavior)", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({
      patch: { logLevel: "debug" },
      // No skipRestart field
    });

    await persistToConfig(deps, opts);

    // Advance past 2000ms debounce
    vi.advanceTimersByTime(2000);

    // SIGUSR1 should have been called (default behavior preserved)
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  it("SIGUSR1: resets timer on each call (debounce)", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    // First call starts the timer
    await persistToConfig(deps, opts);

    // Advance 1500ms (within 2000ms window)
    vi.advanceTimersByTime(1500);
    expect(killSpy).not.toHaveBeenCalled();

    // Second call resets the timer
    await persistToConfig(deps, opts);

    // Advance another 1500ms (3000ms total from first call, but only 1500ms from last)
    vi.advanceTimersByTime(1500);

    // Should NOT have fired yet -- only 1500ms since last call
    expect(killSpy).not.toHaveBeenCalled();

    // Advance the remaining 500ms to complete the 2000ms from last call
    vi.advanceTimersByTime(500);

    // Now it should fire
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });
});

// ---------------------------------------------------------------------------
// Config mutation fence tests
// ---------------------------------------------------------------------------

describe("config mutation fence", () => {
  let tempDir: string;
  let configPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    tempDir = mkdtempSync(join(tmpdir(), "persist-test-fence-"));
    configPath = join(tempDir, "config.local.yaml");
    writeFileSync(configPath, yamlStringify({ logLevel: "info" }), "utf-8");
  });

  afterEach(() => {
    _resetSigusr1Timer();
    _resetMutationFence();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("SIGUSR1 deferred while fence > 0, fires after fence reaches 0", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    // Enter fence before persist
    enterConfigMutationFence();

    await persistToConfig(deps, opts);

    // Advance past the 2000ms debounce
    vi.advanceTimersByTime(2000);

    // SIGUSR1 should NOT fire -- fence is still held
    expect(killSpy).not.toHaveBeenCalled();

    // Release fence
    leaveConfigMutationFence();

    // Advance 500ms for the retry check
    vi.advanceTimersByTime(500);

    // Now SIGUSR1 should fire
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  it("SIGUSR1 fires immediately (after debounce) when fence is 0", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    // No fence -- standard path
    await persistToConfig(deps, opts);

    vi.advanceTimersByTime(2000);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });

  it("multiple fence enter/leave pairs: defers until fully released", async () => {
    const deps = makeDeps({ configPaths: [configPath] });
    const opts = makeOpts({ patch: { logLevel: "debug" } });

    // Enter fence twice
    enterConfigMutationFence();
    enterConfigMutationFence();

    await persistToConfig(deps, opts);

    // Leave once -- fence still > 0
    leaveConfigMutationFence();

    // Advance past debounce + retry
    vi.advanceTimersByTime(2500);

    // Should NOT have fired -- fence still 1
    expect(killSpy).not.toHaveBeenCalled();

    // Leave again -- fence now 0
    leaveConfigMutationFence();

    // Advance 500ms for retry
    vi.advanceTimersByTime(500);

    // Now it should fire
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });
});
