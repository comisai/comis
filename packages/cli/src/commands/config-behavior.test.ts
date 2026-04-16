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

// Mock @comis/core to control loadConfigFile and validateConfig
vi.mock("@comis/core", () => ({
  AppConfigSchema: {},
  loadConfigFile: vi.fn(),
  validateConfig: vi.fn(),
  deepMerge: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })),
  sanitizeLogString: vi.fn((s: string) => s),
}));

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
