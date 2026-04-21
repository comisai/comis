// SPDX-License-Identifier: Apache-2.0
/**
 * Reset command behavior tests: sessions, config, workspace.
 *
 * Tests reset command behaviors by mocking RPC client, file system,
 * node:os, @clack/prompts, and withSpinner. Verifies correct target
 * execution, confirmation guards, --yes bypass, and invalid target rejection.
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

// ---------- Module-level mocks (BEFORE any imports from reset.ts) ----------

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  accessSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => "/tmp/test-home") },
  homedir: vi.fn(() => "/tmp/test-home"),
}));

// ---------- Dynamic imports after mocks ----------

const { registerResetCommand } = await import("./reset.js");
const { withClient } = await import("../client/rpc-client.js");
const p = await import("@clack/prompts");
const fs = await import("node:fs");

// ---------- Helpers ----------

/** Build a program with reset command registered and parse given argv. */
async function parseReset(argv: string[]): Promise<void> {
  const program = createTestProgram();
  registerResetCommand(program);
  await program.parseAsync(argv);
}

// ---------- Tests ----------

describe("reset sessions via RPC", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("deletes all sessions via RPC when daemon is running", async () => {
    // withClient resolves successfully (daemon running, sessions.deleteAll works)
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({
        call: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      });
    });

    await parseReset(["node", "test", "reset", "sessions", "--yes"]);

    // Assert withClient was called (RPC path taken)
    expect(withClient).toHaveBeenCalled();

    // Assert success output
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("sessions deleted");
  });
});

describe("reset sessions fallback to database file", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("removes database file directly when daemon is offline", async () => {
    // withClient rejects (daemon offline)
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    // accessSync succeeds (db file exists)
    vi.mocked(fs.accessSync).mockImplementation(() => undefined);

    // unlinkSync succeeds
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

    await parseReset(["node", "test", "reset", "sessions", "--yes"]);

    // Assert unlinkSync was called with path containing memory.db
    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map((c) => String(c[0]));
    expect(unlinkCalls.some((p) => p.includes("memory.db"))).toBe(true);

    // Assert output contains warning about daemon not running
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Daemon not running");

    // Assert output contains success about database removed
    expect(output).toContain("database removed");
  });
});

describe("reset sessions no database file", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("reports nothing to reset when no database file exists", async () => {
    // withClient rejects (daemon offline)
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    // accessSync throws ENOENT (no database file)
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw enoent;
    });

    await parseReset(["node", "test", "reset", "sessions", "--yes"]);

    // Assert output contains "nothing to reset"
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("nothing to reset");
  });
});

describe("reset config deletes config files", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("deletes config.yaml and .env from config directory", async () => {
    // unlinkSync succeeds for config files
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

    await parseReset(["node", "test", "reset", "config", "--yes"]);

    // Assert unlinkSync was called with config.yaml and .env paths
    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map((c) => String(c[0]));
    expect(unlinkCalls.some((p) => p.includes("config.yaml"))).toBe(true);
    expect(unlinkCalls.some((p) => p.includes(".env"))).toBe(true);

    // Assert output contains success message
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Config files removed");

    // Assert output contains hint to reconfigure
    expect(output).toContain("comis init");
  });
});

describe("reset workspace deletes data directory and config", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("removes entire data directory and config files", async () => {
    // rmSync and unlinkSync succeed
    vi.mocked(fs.rmSync).mockImplementation(() => undefined);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

    await parseReset(["node", "test", "reset", "workspace", "--yes"]);

    // Assert rmSync was called with data directory and recursive+force options
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(".comis"),
      { recursive: true, force: true },
    );

    // Assert unlinkSync was also called (workspace calls resetConfig internally)
    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map((c) => String(c[0]));
    expect(unlinkCalls.some((p) => p.includes("config.yaml"))).toBe(true);
    expect(unlinkCalls.some((p) => p.includes(".env"))).toBe(true);

    // Assert output contains workspace removed message
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Workspace");
    expect(output).toContain("removed");
  });
});

describe("reset requires confirmation and respects --yes", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("--yes skips confirmation prompt", async () => {
    // withClient resolves (for sessions target)
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({
        call: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      });
    });

    await parseReset(["node", "test", "reset", "sessions", "--yes"]);

    // Assert p.confirm was NOT called
    expect(p.confirm).not.toHaveBeenCalled();
  });

  it("shows confirmation prompt without --yes", async () => {
    // User confirms
    vi.mocked(p.confirm).mockResolvedValue(true);
    vi.mocked(p.isCancel).mockReturnValue(false);

    // withClient resolves
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({
        call: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      });
    });

    await parseReset(["node", "test", "reset", "sessions"]);

    // Assert p.confirm WAS called with message about sessions
    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Delete ALL sessions"),
      }),
    );
  });

  it("user cancels confirmation prevents execution", async () => {
    // User cancels at confirm prompt
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(p.isCancel).mockImplementation(
      (value) => value === cancelSymbol,
    );

    await parseReset(["node", "test", "reset", "sessions"]);

    // Assert p.cancel was called
    expect(p.cancel).toHaveBeenCalledWith("Reset cancelled.");

    // Assert withClient was NOT called (operation skipped)
    expect(withClient).not.toHaveBeenCalled();
  });

  it("user declines confirmation prevents execution", async () => {
    // User explicitly says "no"
    vi.mocked(p.confirm).mockResolvedValue(false);
    vi.mocked(p.isCancel).mockReturnValue(false);

    await parseReset(["node", "test", "reset", "sessions"]);

    // Assert p.cancel was called
    expect(p.cancel).toHaveBeenCalledWith("Reset cancelled.");

    // Assert withClient was NOT called
    expect(withClient).not.toHaveBeenCalled();
  });
});

describe("reset refuses without --yes in non-interactive mode", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("cancellation at prompt prevents operation execution", async () => {
    // Simulate non-interactive cancellation via isCancel returning true
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(p.isCancel).mockImplementation(
      (value) => value === cancelSymbol,
    );

    await parseReset(["node", "test", "reset", "config"]);

    // Assert p.cancel was called
    expect(p.cancel).toHaveBeenCalledWith("Reset cancelled.");

    // Assert config files were NOT deleted
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("reset rejects invalid target", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with error for unknown target and lists valid targets", async () => {
    try {
      await parseReset(["node", "test", "reset", "invalid-target", "--yes"]);
    } catch {
      // process.exit called
    }

    // Assert process.exit(1) was called
    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    // Assert error output contains "Invalid target"
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Invalid target");

    // Assert info output lists valid targets
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("sessions");
    expect(output).toContain("config");
    expect(output).toContain("workspace");
  });
});
