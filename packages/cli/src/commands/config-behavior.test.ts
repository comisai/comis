// SPDX-License-Identifier: Apache-2.0
/**
 * Config command behavior tests.
 *
 * Tests config validate behaviors: passes for valid YAML, fails with Zod
 * error paths for invalid config, accepts multiple --config paths with
 * merging, skips missing files gracefully, handles non-array error details,
 * and handles load errors distinct from missing files.
 *
 * Tests config subcommands (show, set, history, diff, rollback) that
 * communicate with daemon via JSON-RPC WebSocket.
 *
 * Uses mocked @comis/core to control loadConfigFile and validateConfig
 * independently of real config parsing, and mocked rpc-client/spinner for
 * RPC subcommand tests.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock @comis/core to control loadConfigFile and validateConfig.
// safePath + PathTraversalError are spread from the real module so the
// sync-tooling helpers (discover.ts, backup.ts) can import them when
// the new sync-tooling tests below pass through to actual implementations.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    AppConfigSchema: {},
    loadConfigFile: vi.fn(),
    validateConfig: vi.fn(),
    deepMerge: vi.fn(
      (a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b }),
    ),
    loadEnvFile: vi.fn(() => 0),
    sanitizeLogString: vi.fn((s: string) => s),
  };
});

// Mock the sync-tooling barrel so the new sync-tooling tests can control
// boundary functions (daemon probe, backup, atomic write) and assert
// applyToDocument call counts. The discovery + render + plan helpers are
// passed through to their actual implementations so the doc.toString()
// preview is byte-realistic.
const mockIsDaemonRunning = vi.fn();
const mockWriteBackup = vi.fn();
const mockAtomicWriteFile = vi.fn();
const mockApplyToDocument = vi.fn();
const mockDiscoverSkills = vi.fn();
const mockReadMcpServers = vi.fn();

vi.mock("../sync-tooling/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync-tooling/index.js")>();
  return {
    ...actual,
    // Boundary fns — fully mocked, set per-test.
    isDaemonRunning: mockIsDaemonRunning,
    writeBackup: mockWriteBackup,
    atomicWriteFile: mockAtomicWriteFile,
    // Discovery — fully mocked (avoid real filesystem walks during tests).
    readMcpServers: mockReadMcpServers,
    discoverSkills: mockDiscoverSkills,
    // applyToDocument — record call args, then delegate to actual so the
    // mutation actually happens and doc.toString() reflects reality.
    applyToDocument: vi.fn((...args: Parameters<typeof actual.applyToDocument>) => {
      mockApplyToDocument(...args);
      return actual.applyToDocument(...args);
    }),
  };
});

// Mock the tooling-fill barrel so the new tooling-fill registration tests
// can capture the OrchestratorOpts the action callback builds without
// actually invoking the orchestrator (LLM calls, supervisor probes, fs
// I/O). Pure helpers (parsers, validators) pass through to the actuals
// in case any test wants to exercise them; runToolingFill itself is
// fully mocked.
const mockRunToolingFill = vi.fn();

vi.mock("../tooling-fill/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../tooling-fill/index.js")>();
  return {
    ...actual,
    runToolingFill: mockRunToolingFill,
  };
});

// Mock RPC client for daemon-connected subcommands
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Mock spinner to execute function immediately (no ora dependency in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn((_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Dynamic imports after mocks
const { registerConfigCommand } = await import("./config.js");
const core = await import("@comis/core");
const { withClient } = await import("../client/rpc-client.js");

// -- config validate passes for valid YAML -----------------------------------

describe("config validate passes for valid YAML", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: { logLevel: "debug", tenantId: "test" },
    } as never);
    vi.mocked(core.validateConfig).mockReturnValue({
      ok: true,
      value: { logLevel: "debug", tenantId: "test" },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 0 and prints 'valid' for valid YAML config", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "validate", "-c", "/fake/config.yaml"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output.toLowerCase()).toContain("valid");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config validate fails with Zod error paths ------------------------------

describe("config validate fails with Zod error paths", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: { logLevel: "invalid-level" },
    } as never);
    vi.mocked(core.validateConfig).mockReturnValue({
      ok: false,
      error: {
        message: "Validation failed",
        details: [
          { path: ["logLevel"], message: "Invalid enum value" },
          { path: ["gateway", "port"], message: "Expected number, received string" },
        ],
      },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 with Zod error paths in stderr for invalid config", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", "/fake/config.yaml"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput.toLowerCase()).toContain("validation failed");
    expect(errOutput).toContain("logLevel");
    expect(errOutput).toContain("gateway.port");
    expect(errOutput).toContain("Invalid enum value");
  });
});

// -- config validate handles non-array error details -------------------------

describe("config validate handles non-array error details", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: { bad: true },
    } as never);
    vi.mocked(core.validateConfig).mockReturnValue({
      ok: false,
      error: { message: "Config parse error", details: null },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("falls back to error.message when details is not an array", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", "/fake/config.yaml"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Config parse error");
  });
});

// -- config validate handles load errors (not FILE_NOT_FOUND) ----------------

describe("config validate handles load errors (not FILE_NOT_FOUND)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: false,
      error: { code: "PARSE_ERROR", message: "Invalid YAML syntax" },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 with load error message for non-FILE_NOT_FOUND errors", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", "/bad.yaml"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Invalid YAML syntax");
  });
});

// -- config validate accepts multiple --config paths -------------------------

describe("config validate accepts multiple --config paths", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Return different success results based on path
    vi.mocked(core.loadConfigFile)
      .mockReturnValueOnce({
        ok: true,
        value: { logLevel: "debug" },
      } as never)
      .mockReturnValueOnce({
        ok: true,
        value: { tenantId: "merged-tenant" },
      } as never);

    vi.mocked(core.deepMerge).mockReturnValue({
      logLevel: "debug",
      tenantId: "merged-tenant",
    });

    vi.mocked(core.validateConfig).mockReturnValue({
      ok: true,
      value: { logLevel: "debug", tenantId: "merged-tenant" },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("loads and merges multiple config files", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync([
      "node", "test", "config", "validate", "-c", "/path/a.yaml", "/path/b.yaml",
    ]);

    expect(core.loadConfigFile).toHaveBeenCalledTimes(2);
    const output = getSpyOutput(consoleSpy.log);
    expect(output.toLowerCase()).toContain("valid");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config validate skips missing files -------------------------------------

describe("config validate skips missing files", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.validateConfig).mockReset();
    vi.mocked(core.deepMerge).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: false,
      error: { code: "FILE_NOT_FOUND", message: "File not found" },
    } as never);
    vi.mocked(core.validateConfig).mockReturnValue({
      ok: true,
      value: {},
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("warns about missing file but still validates with defaults", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "validate", "-c", "/nonexistent.yaml"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output.toLowerCase()).toContain("not found");
    expect(output.toLowerCase()).toContain("valid");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Config subcommand tests (show, set, history, diff, rollback)
// =============================================================================

/**
 * Helper to create a mock RPC client that returns a fixed result.
 */
function mockWithClientResult(result: unknown): void {
  vi.mocked(withClient).mockImplementation(async (fn) => {
    const mockClient = {
      call: vi.fn().mockResolvedValue(result),
      close: vi.fn(),
    };
    return fn(mockClient);
  });
}

/**
 * Helper to create a mock RPC client that rejects with an error.
 */
function mockWithClientError(errorMessage: string): void {
  vi.mocked(withClient).mockImplementation(async (fn) => {
    const mockClient = {
      call: vi.fn().mockRejectedValue(new Error(errorMessage)),
      close: vi.fn(),
    };
    return fn(mockClient);
  });
}

// -- config show displays full config ----------------------------------------

describe("config show displays full config", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({
      config: { agent: { name: "test" }, gateway: { port: 4766 } },
      sections: ["agent", "gateway"],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays section list with key counts when no section argument", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "show"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("agent");
    expect(output).toContain("gateway");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config show <section> displays section details --------------------------

describe("config show <section> displays section details", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ name: "test", budget: { maxTokens: 100000 } });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays key-value pairs for the specified section", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "show", "agent"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("name");
    expect(output).toContain("test");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config show --format json outputs JSON ----------------------------------

describe("config show --format json outputs JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ name: "test" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs raw JSON when --format json is specified", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "show", "agent", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain('"name"');
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config set modifies config with restart warning -------------------------

describe("config set modifies config with restart warning", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ patched: true, restarting: true });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls config.patch RPC and prints success + restart warning", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "set", "agent.budget.maxTokens", "50000"]);

    expect(withClient).toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("agent.budget.maxTokens");
    expect(output.toLowerCase()).toContain("restart");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config set rejects single-segment path ----------------------------------

describe("config set rejects single-segment path", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 with error about section.key requirement", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync(["node", "test", "config", "set", "agent", "50000"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("section.key");
  });
});

// -- config set parses JSON values -------------------------------------------

describe("config set parses JSON values", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let capturedCallArgs: unknown[];

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    capturedCallArgs = [];

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation((...args: unknown[]) => {
          capturedCallArgs = args;
          return Promise.resolve({ patched: true });
        }),
        close: vi.fn(),
      };
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("passes boolean true (not string) when value is 'true'", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "set", "agent.budget.enabled", "true"]);

    expect(withClient).toHaveBeenCalled();
    // capturedCallArgs = ["config.patch", { section, key, value }]
    const params = capturedCallArgs[1] as { section: string; key: string; value: unknown };
    expect(params.value).toBe(true);
    expect(typeof params.value).toBe("boolean");
  });
});

// -- config history displays table -------------------------------------------

describe("config history displays table", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({
      entries: [
        { sha: "abc1234567890", date: "2026-02-25T12:00:00Z", message: "Changed agent.name" },
      ],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders history entries with truncated SHA and message", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "history"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("abc1234");
    expect(output).toContain("Changed");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config history with --limit ---------------------------------------------

describe("config history with --limit", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let capturedCallArgs: unknown[];

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    capturedCallArgs = [];

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation((...args: unknown[]) => {
          capturedCallArgs = args;
          return Promise.resolve({ entries: [] });
        }),
        close: vi.fn(),
      };
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("passes limit parameter to config.history RPC call", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "history", "--limit", "5"]);

    expect(withClient).toHaveBeenCalled();
    const params = capturedCallArgs[1] as { limit: number };
    expect(params.limit).toBe(5);
  });
});

// -- config history shows warning when error returned ------------------------

describe("config history shows warning when error returned", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ entries: [], error: "Config versioning not available" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints warning when entries empty and error returned", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "history"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("not available");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config diff displays colorized output -----------------------------------

describe("config diff displays colorized output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ diff: "+new line\n-old line\n normal" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs diff content via console.log", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "diff"]);

    const output = getSpyOutput(consoleSpy.log);
    // chalk colorization wraps the text but the content is still present
    expect(output).toContain("new line");
    expect(output).toContain("old line");
    expect(output).toContain("normal");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config diff shows info when no changes ----------------------------------

describe("config diff shows info when no changes", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ diff: "" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints 'No config changes' when diff is empty", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "diff"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No config changes");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config rollback with --yes skips prompt ---------------------------------

describe("config rollback with --yes skips prompt", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientResult({ rolledBack: true, sha: "abc1234", restarting: true });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("rolls back config and warns about restart", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await program.parseAsync(["node", "test", "config", "rollback", "abc1234", "--yes"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output.toLowerCase()).toContain("rolled back");
    expect(output.toLowerCase()).toContain("restart");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// -- config rollback RPC error exits 1 ----------------------------------------

describe("config rollback RPC error exits 1", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    mockWithClientError("Config rollback failed");
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 with rollback error message in stderr", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync(["node", "test", "config", "rollback", "abc1234", "--yes"]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput.toLowerCase()).toContain("rollback");
  });
});

// =============================================================================
// Phase 25 — config sync-tooling sub-subcommand
// In-process Commander tests covering registration + inspect/write/overwrite
// modes. Boundary fns (isDaemonRunning, writeBackup, atomicWriteFile) and
// discovery (readMcpServers, discoverSkills) are mocked at the sync-tooling
// barrel so we don't probe the daemon, hit the filesystem, or walk skill
// directories during the test run. applyToDocument is wrapped in a spy that
// delegates to the real implementation so doc.toString() previews are
// byte-realistic.
// =============================================================================

import * as path from "node:path";
import * as fsRaw from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "sync-tooling",
  "__tests__",
  "fixtures",
);
const FIXTURE_NO_TOOLING = path.join(FIXTURES_DIR, "config-no-tooling.yaml");
const FIXTURE_WITH_TOOLING = path.join(FIXTURES_DIR, "config-with-tooling.yaml");

/**
 * Read a fixture YAML file and return the parsed JS shape. Mirrors what
 * `loadConfigFile` would return on success (without the Result wrapper).
 */
function readFixtureAsJs(fixturePath: string): Record<string, unknown> {
  const raw = fsRaw.readFileSync(fixturePath, "utf-8");
  return parseYaml(raw) as Record<string, unknown>;
}

/**
 * Reset all sync-tooling mocks to their default state for inspect-mode happy
 * paths: daemon NOT running, backup ok, atomic write ok, discovery returns
 * the fixture's MCP servers, no skills.
 */
function resetSyncToolingMocks(opts: {
  configJs: Record<string, unknown>;
  mcps?: { name: string; description: undefined }[];
  skills?: Array<{
    name: string;
    description: string | undefined;
    cluster: string | undefined;
    sourceDir: string;
  }>;
}): void {
  vi.mocked(core.loadConfigFile).mockReset();
  vi.mocked(core.loadConfigFile).mockReturnValue({ ok: true, value: opts.configJs } as never);

  mockIsDaemonRunning.mockReset();
  mockIsDaemonRunning.mockResolvedValue(false);

  mockWriteBackup.mockReset();
  mockWriteBackup.mockReturnValue({
    ok: true,
    value: { backupPath: "/tmp/backup-fixture.yaml" },
  } as never);

  mockAtomicWriteFile.mockReset();
  mockAtomicWriteFile.mockReturnValue({ ok: true, value: undefined } as never);

  mockApplyToDocument.mockReset();

  mockReadMcpServers.mockReset();
  mockReadMcpServers.mockReturnValue(opts.mcps ?? []);

  mockDiscoverSkills.mockReset();
  mockDiscoverSkills.mockReturnValue(opts.skills ?? []);
}

// -- Test 1 (SPEC-1 / registration) ------------------------------------------

describe("config sync-tooling is registered with the right options", () => {
  it("registers as the 7th sub-subcommand with --write/--overwrite/--format/--config", () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    const configCmd = program.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();

    const syncCmd = configCmd!.commands.find((c) => c.name() === "sync-tooling");
    expect(syncCmd).toBeDefined();

    const optionFlags = syncCmd!.options.map((o) => o.long);
    expect(optionFlags).toContain("--write");
    expect(optionFlags).toContain("--overwrite");
    expect(optionFlags).toContain("--format");
    expect(optionFlags).toContain("--config");
  });
});

// -- Test 2 (SPEC-2 / inspect happy path) ------------------------------------

describe("config sync-tooling inspect mode prints diff and exits 0", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const stdoutChunks: string[] = [];
  let mtimeBefore: number;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    stdoutChunks.length = 0;
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      });

    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
      skills: [],
    });
    mtimeBefore = fsRaw.statSync(FIXTURE_NO_TOOLING).mtimeMs;
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    stdoutSpy.mockRestore();
  });

  it("exits 0, leaves config.yaml unchanged, and emits a tooling: preview", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      // process.exit(0) is mocked to throw — sentinel pattern.
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockWriteBackup).not.toHaveBeenCalled();
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();

    // mtime unchanged → file not touched (REQ-2 acceptance).
    const mtimeAfter = fsRaw.statSync(FIXTURE_NO_TOOLING).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("tooling:");
  });
});

// -- Test 3 (SPEC-2 / --format json) -----------------------------------------

describe("config sync-tooling --format json emits a parseable JSON payload", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints a single JSON object with discovered/existing/diff/wouldWrite keys", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--format",
        "json",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);

    // The json() helper goes through console.log; the existing test-helpers
    // already spies on console.log via createConsoleSpy.
    const out = getSpyOutput(consoleSpy.log);
    // Find the JSON-shaped chunk and parse it.
    const jsonStart = out.indexOf("{");
    const jsonEnd = out.lastIndexOf("}");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    expect(jsonEnd).toBeGreaterThan(jsonStart);
    const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1)) as Record<
      string,
      unknown
    >;
    expect(parsed).toHaveProperty("discovered");
    expect(parsed).toHaveProperty("existing");
    expect(parsed).toHaveProperty("diff");
    expect(parsed).toHaveProperty("wouldWrite");
  });
});

// -- Test 4 (SPEC-3 / --write happy path) ------------------------------------

describe("config sync-tooling --write writes backup BEFORE atomic write", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls writeBackup before atomicWriteFile and exits 0", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockWriteBackup).toHaveBeenCalledTimes(1);
    expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
    // Strict ordering — backup must complete before atomic write begins.
    const backupOrder = mockWriteBackup.mock.invocationCallOrder[0]!;
    const writeOrder = mockAtomicWriteFile.mock.invocationCallOrder[0]!;
    expect(backupOrder).toBeLessThan(writeOrder);
  });
});

// -- Test 5 (SPEC-8 / daemon-running guard) ----------------------------------

describe("config sync-tooling --write exits 1 when daemon is running", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
    });
    // Override default — daemon is up.
    mockIsDaemonRunning.mockResolvedValue(true);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("never calls writeBackup and emits 'daemon is running' on stderr", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(mockIsDaemonRunning).toHaveBeenCalledTimes(1);
    expect(mockWriteBackup).not.toHaveBeenCalled();
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("daemon is running");
  });
});

// -- Test 6 (D-12 / backup-fail-fast) ----------------------------------------

describe("config sync-tooling --write aborts when writeBackup fails", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
    });
    mockWriteBackup.mockReturnValue({
      ok: false,
      error: { code: "BACKUP_WRITE_FAILED", path: "/x", cause: "ENOSPC: no space left on device" },
    } as never);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 2 and never calls atomicWriteFile when backup write fails", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
    expect(mockWriteBackup).toHaveBeenCalledTimes(1);
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();
  });
});

// -- Test 7 (D-03 / usage error: --overwrite without --write) ----------------

describe("config sync-tooling --overwrite without --write is a usage error", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [{ name: "yfinance", description: undefined }],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits 1 before any I/O — daemon probe never fires", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--overwrite",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(mockIsDaemonRunning).not.toHaveBeenCalled();
    expect(mockWriteBackup).not.toHaveBeenCalled();
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("--overwrite requires --write");
  });
});

// -- Test 8 (D-25 / parse error → exit 3) ------------------------------------

describe("config sync-tooling exits 3 on malformed YAML", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let badYamlPath: string;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Write an unbalanced YAML file to a tmpdir for the parseDocument path.
    const tmpDir = fsRaw.mkdtempSync(path.join(os.tmpdir(), "sync-tooling-test-"));
    badYamlPath = path.join(tmpDir, "config-bad.yaml");
    fsRaw.writeFileSync(
      badYamlPath,
      "integrations:\n  mcp:\n    servers:\n      - name: [unbalanced\n",
      "utf-8",
    );

    // loadConfigFile mock returns ok({}) so the parse-error gate is the
    // only thing that can trigger exit(3) — isolates the behavior under test.
    vi.mocked(core.loadConfigFile).mockReset();
    vi.mocked(core.loadConfigFile).mockReturnValue({ ok: true, value: {} } as never);

    mockIsDaemonRunning.mockReset();
    mockIsDaemonRunning.mockResolvedValue(false);
    mockWriteBackup.mockReset();
    mockAtomicWriteFile.mockReset();
    mockReadMcpServers.mockReset();
    mockReadMcpServers.mockReturnValue([]);
    mockDiscoverSkills.mockReset();
    mockDiscoverSkills.mockReturnValue([]);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    try {
      fsRaw.rmSync(path.dirname(badYamlPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("exits 3 with a YAML-parse error message on stderr", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--config",
        badYamlPath,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(3);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput.toLowerCase()).toMatch(/invalid yaml|failed to parse/);
  });
});

// -- Test 9 (RESEARCH Open Question 2 / nothing to sync) ---------------------

describe("config sync-tooling exits 0 with 'nothing to sync' on empty discovery", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [],
      skills: [],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("--write is a no-op (no backup) when discovery is empty", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockWriteBackup).not.toHaveBeenCalled();
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();

    const out = getSpyOutput(consoleSpy.log);
    expect(out.toLowerCase()).toContain("nothing to sync");
  });
});

// -- Test 9c (inspect mode always renders, even on no-op) -------------------

describe("config sync-tooling inspect mode always renders the diff", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Empty discovery + no tooling block → plan is a no-op, but inspect mode
    // must still render so operators can see what was discovered.
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_NO_TOOLING),
      mcps: [],
      skills: [],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    stdoutSpy.mockRestore();
  });

  it("inspect (no flags) renders the human diff even when plan is a no-op", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockWriteBackup).not.toHaveBeenCalled();
    expect(mockAtomicWriteFile).not.toHaveBeenCalled();

    const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutCalls.toLowerCase()).toContain("discovered mcps");
    expect(stdoutCalls.toLowerCase()).toContain("discovered skills");
  });

  it("inspect --format json emits a parseable JSON document on no-op", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--format",
        "json",
        "--config",
        FIXTURE_NO_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);

    const out = getSpyOutput(consoleSpy.log);
    // Must contain `{` and the canonical inspect JSON keys — proves the JSON
    // path was taken, not the info() short-circuit.
    expect(out).toContain('"discovered"');
    expect(out).toContain('"diff"');
    expect(out).toContain('"wouldWrite"');
  });
});

// -- Test 9b (SPEC-4 / empty discovery still prunes stale hints) -------------

describe("config sync-tooling --write prunes stale hints when discovery is empty", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // Fixture has tooling.mcp.capabilityHints.yfinance from a prior sync;
    // operator has now removed yfinance from integrations.mcp.servers, so
    // discovery returns empty. SPEC-4 requires the stale yfinance hint to
    // be pruned even though no MCPs/skills were discovered.
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_WITH_TOOLING),
      mcps: [],
      skills: [],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("--write writes backup + atomic file when stale hints exist (SPEC-4)", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--config",
        FIXTURE_WITH_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockWriteBackup).toHaveBeenCalledTimes(1);
    expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);

    const out = getSpyOutput(consoleSpy.log);
    expect(out.toLowerCase()).not.toContain("nothing to sync");
  });
});

// -- Test 10 (SPEC-6 / overwrite mode) ---------------------------------------

describe("config sync-tooling --write --overwrite emits the destructive warning", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    resetSyncToolingMocks({
      configJs: readFixtureAsJs(FIXTURE_WITH_TOOLING),
      mcps: [
        { name: "placeholder-mcp", description: undefined },
        { name: "yfinance", description: undefined },
      ],
      skills: [],
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls applyToDocument({ overwrite: true }) and prints the ⚠ overwrote warning", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "sync-tooling",
        "--write",
        "--overwrite",
        "--config",
        FIXTURE_WITH_TOOLING,
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(0);
    expect(mockApplyToDocument).toHaveBeenCalled();
    // Last positional arg is the options object.
    const lastCall = mockApplyToDocument.mock.calls.at(-1) as unknown as [
      unknown,
      unknown,
      { overwrite: boolean },
    ];
    expect(lastCall[2].overwrite).toBe(true);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("overwrote");
  });
});

// =============================================================================
// Phase 26 — config tooling-fill sub-subcommand
// In-process Commander.parseAsync tests covering registration + flag
// plumbing. Spies on `runToolingFill` so the action callback is exercised
// without the orchestrator actually running (no LLM calls, no supervisor
// probes, no fs I/O). Each test asserts the OrchestratorOpts the
// callback builds matches the operator's argv.
// =============================================================================

// -- Test A: tooling-fill registration ---------------------------------------

describe("config tooling-fill is registered with the right options", () => {
  it("registers as the 8th sub-subcommand with all 12 flag definitions", () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    const configCmd = program.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();

    const fillCmd = configCmd!.commands.find(
      (c) => c.name() === "tooling-fill",
    );
    expect(fillCmd).toBeDefined();

    const optionFlags = fillCmd!.options.map((o) => o.long);
    // TOOLFILL-1 / AC-2: documented flags
    expect(optionFlags).toContain("--all");
    expect(optionFlags).toContain("--force");
    expect(optionFlags).toContain("--dry-run");
    expect(optionFlags).toContain("--yes");
    expect(optionFlags).toContain("--restart");
    expect(optionFlags).toContain("--allow-restart");
    // Commander represents `--no-restart` as a negation of `--restart`
    // (longFlag: "--restart", negate: true) — assert via the option's
    // .flags or by counting the boolean restart slots.
    const restartOpt = fillCmd!.options.find((o) => o.long === "--restart");
    expect(restartOpt).toBeDefined();
    const negateRestartOpt = fillCmd!.options.find(
      (o) => o.long === "--no-restart" || o.flags?.includes("--no-restart"),
    );
    expect(negateRestartOpt).toBeDefined();
    expect(optionFlags).toContain("--restart-cmd");
    expect(optionFlags).toContain("--force-no-validate");
    expect(optionFlags).toContain("--config");
    expect(optionFlags).toContain("--agent");
    expect(optionFlags).toContain("--kind");
  });

  it("is the 8th sub-subcommand alongside the existing 7", () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    const configCmd = program.commands.find((c) => c.name() === "config");
    const subNames = configCmd!.commands.map((c) => c.name());
    // The 7 pre-Phase-26 sub-subcommands plus tooling-fill plus help.
    expect(subNames).toContain("validate");
    expect(subNames).toContain("show");
    expect(subNames).toContain("set");
    expect(subNames).toContain("history");
    expect(subNames).toContain("diff");
    expect(subNames).toContain("rollback");
    expect(subNames).toContain("sync-tooling");
    expect(subNames).toContain("tooling-fill");
  });
});

// -- Test B: --all without hint-name plumbs through --------------------------

describe("config tooling-fill --all plumbs all=true through to runToolingFill", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({
      exitCode: 0,
      summary: "filled 1 hint",
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("runs runToolingFill with all=true and undefined hintName", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "--all",
        "--yes",
        "--restart",
      ]);
    } catch (e) {
      // process.exit(0) is mocked to throw — sentinel pattern.
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(mockRunToolingFill).toHaveBeenCalledTimes(1);
    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.all).toBe(true);
    expect(opts.hintName).toBeUndefined();
    expect(opts.yes).toBe(true);
    expect(opts.restart).toBe(true);
  });
});

// -- Test C: bare hint-name + --dry-run plumbs through -----------------------

describe("config tooling-fill <hint> --dry-run plumbs hintName + dryRun", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({ exitCode: 0, summary: "ok" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("runs with hintName='yfinance' and dryRun=true", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "yfinance",
        "--dry-run",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(mockRunToolingFill).toHaveBeenCalledTimes(1);
    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.hintName).toBe("yfinance");
    expect(opts.dryRun).toBe(true);
    expect(opts.all).toBe(false);
  });
});

// -- Test D: --restart-cmd plumbs through ------------------------------------

describe("config tooling-fill --restart-cmd plumbs restartCmd through", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({ exitCode: 0, summary: "ok" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("forwards --restart-cmd value to OrchestratorOpts.restartCmd", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "yfinance",
        "--restart-cmd",
        "echo override",
        "--yes",
        "--restart",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.restartCmd).toBe("echo override");
  });
});

// -- Test E: --kind plumbs through -------------------------------------------

describe("config tooling-fill --kind plumbs kindHint through", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({ exitCode: 0, summary: "ok" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("forwards --kind skills to OrchestratorOpts.kindHint", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "stub-skill",
        "--kind",
        "skills",
        "--yes",
        "--restart",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.kindHint).toBe("skills");
    expect(opts.hintName).toBe("stub-skill");
  });
});

// -- Test F: exit code propagation -------------------------------------------

describe("config tooling-fill exit code propagates from runToolingFill", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({
      exitCode: 7,
      summary: "custom exit",
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls process.exit with the orchestrator's exitCode", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "yfinance",
        "--yes",
        "--restart",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(7);
  });
});

// -- Test G: --no-restart resolves to restart:false --------------------------

describe("config tooling-fill --no-restart plumbs restart=false", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({ exitCode: 0, summary: "ok" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("forwards restart=false when --no-restart is passed", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "yfinance",
        "--yes",
        "--no-restart",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.restart).toBe(false);
  });
});

// -- Test H: --allow-restart alias resolves to restart:true ------------------

describe("config tooling-fill --allow-restart aliases --restart", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockRunToolingFill.mockReset();
    mockRunToolingFill.mockResolvedValue({ exitCode: 0, summary: "ok" });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("forwards restart=true when --allow-restart is passed", async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "config",
        "tooling-fill",
        "yfinance",
        "--yes",
        "--allow-restart",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    const opts = mockRunToolingFill.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.restart).toBe(true);
  });
});
