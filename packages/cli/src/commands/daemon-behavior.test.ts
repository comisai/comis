/**
 * Daemon command behavior tests: start, stop, status, logs.
 *
 * Tests daemon command behaviors by mocking file system, child_process,
 * node:os, and RPC client. Verifies correct process management, PID file
 * handling, status reporting, log reading, and error output.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// ---------- Module-level mocks (BEFORE any imports from daemon.ts) ----------

// promisifiedExec is the mock for promisify(execFile). We attach it via
// the custom promisify symbol so daemon.ts's `const exec = promisify(execFile)`
// uses this mock directly.
const promisifiedExec = vi.fn();
const mockExecFile = Object.assign(vi.fn(), {
  [promisify.custom]: promisifiedExec,
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: mockExecFile,
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 99),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => "/tmp/test-home") },
  homedir: vi.fn(() => "/tmp/test-home"),
}));

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// ---------- Dynamic imports after mocks ----------

const { registerDaemonCommand } = await import("./daemon.js");
const { withClient } = await import("../client/rpc-client.js");
const childProcess = await import("node:child_process");
const fs = await import("node:fs");

// ---------- Helpers ----------

/** Build a program with daemon commands registered and parse given argv. */
async function parseDaemon(argv: string[]): Promise<void> {
  const program = createTestProgram();
  registerDaemonCommand(program);
  await program.parseAsync(argv);
}

// ---------- Tests ----------

describe("daemon start", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    processKillSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("spawns detached node process and writes PID file", async () => {
    // No systemd, no existing PID, daemon binary exists
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      // Daemon binary path check -- return true for any path containing daemon
      if (path.includes("daemon")) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const fakeChild = {
      pid: 12345,
      unref: vi.fn(),
      on: vi.fn(),
    };
    vi.mocked(childProcess.spawn).mockReturnValue(fakeChild as never);

    // Mock fetch for waitForReady() health polling
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await parseDaemon(["node", "test", "daemon", "start"]);

    // Assert spawn was called with node and daemon path
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    expect(cmd).toBe("node");
    expect(args).toBeInstanceOf(Array);
    expect((args as string[])[0]).toContain("daemon");
    expect(opts).toMatchObject({
      detached: true,
      stdio: ["ignore", 99, 99],
    });

    // Assert PID file was written
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("daemon.pid"),
      "12345",
    );

    // Assert child was unrefed
    expect(fakeChild.unref).toHaveBeenCalled();

    // Assert output contains success message with PID
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Daemon started and ready");
    expect(output).toContain("12345");
  });

  it("detects already-running daemon and warns", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });
    // PID file returns existing PID
    vi.mocked(fs.readFileSync).mockReturnValue("54321");

    // process.kill(pid, 0) does NOT throw => process is alive
    processKillSpy.mockImplementation(() => true);

    await parseDaemon(["node", "test", "daemon", "start"]);

    // Assert spawn was NOT called
    expect(childProcess.spawn).not.toHaveBeenCalled();

    // Assert warning output
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("already running");
    expect(output).toContain("54321");
  });
});

describe("daemon stop", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    processKillSpy.mockRestore();
  });

  it("sends SIGTERM, process dies, removes PID file", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });
    // PID file contains 12345
    vi.mocked(fs.readFileSync).mockReturnValue("12345");

    // Track kill calls: first check alive (sig 0) -> alive, SIGTERM succeeds,
    // next check alive (sig 0) -> dead (throw)
    let sigTermSent = false;
    processKillSpy.mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        // Before SIGTERM: alive. After SIGTERM: dead.
        if (sigTermSent) {
          throw new Error("ESRCH");
        }
        return true;
      }
      if (signal === "SIGTERM") {
        sigTermSent = true;
        return true;
      }
      return true;
    });

    await parseDaemon(["node", "test", "daemon", "stop"]);

    // Assert SIGTERM was sent to the correct PID
    expect(processKillSpy).toHaveBeenCalledWith(12345, "SIGTERM");

    // Assert PID file was removed
    expect(fs.unlinkSync).toHaveBeenCalled();

    // Assert success message
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Daemon stopped");
  });

  it("handles stale PID file (process not alive)", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });
    // PID file contains stale PID
    vi.mocked(fs.readFileSync).mockReturnValue("99999");

    // process.kill(99999, 0) throws -> process not alive
    processKillSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    await parseDaemon(["node", "test", "daemon", "stop"]);

    // Assert output indicates stale PID
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("not running");
    expect(output).toContain("stale PID");

    // Assert PID file was cleaned up
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it("handles missing PID file", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return false;
    });
    // readFileSync throws (no PID file)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await parseDaemon(["node", "test", "daemon", "stop"]);

    // Assert output indicates no PID file
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("not running");
    expect(output).toContain("no PID file");
  });
});

describe("daemon status", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    processKillSpy.mockRestore();
  });

  it("shows running state via RPC with details", async () => {
    // withClient resolves successfully with config data
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({
        call: vi.fn().mockResolvedValue({
          tenantId: "test-tenant",
          gateway: { host: "localhost", port: 3100 },
        }),
        close: vi.fn(),
      });
    });
    // PID file exists
    vi.mocked(fs.readFileSync).mockReturnValue("12345");

    await parseDaemon(["node", "test", "daemon", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("running");
    expect(output).toContain("12345");
    expect(output).toContain("test-tenant");
    expect(output).toContain("localhost");
    expect(output).toContain("3100");
  });

  it("falls back to PID file when RPC fails", async () => {
    // withClient rejects (daemon not reachable via RPC)
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });
    // PID file contains 12345
    vi.mocked(fs.readFileSync).mockReturnValue("12345");

    // Process is alive
    processKillSpy.mockImplementation(() => true);

    await parseDaemon(["node", "test", "daemon", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("running");
    expect(output).toContain("12345");
  });

  it("shows not-running when no PID file and no daemon", async () => {
    // withClient rejects
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return false;
    });
    // No PID file
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await parseDaemon(["node", "test", "daemon", "status"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("not running");
  });
});

describe("daemon logs", () => {
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

  it("reads from log file via tail in non-systemd mode", async () => {
    // No systemd, log file exists
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });

    // Mock promisified exec -- daemon.ts uses `const exec = promisify(execFile)`
    // which resolves to { stdout, stderr }
    promisifiedExec.mockResolvedValue({
      stdout: "log line 1\nlog line 2",
      stderr: "",
    });

    await parseDaemon(["node", "test", "daemon", "logs"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("log line 1");
    expect(output).toContain("log line 2");
  });

  it("warns when log file is missing", async () => {
    // No systemd, no log file
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return false;
    });

    await parseDaemon(["node", "test", "daemon", "logs"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Log file not found");
  });
});

describe("daemon logs --follow", () => {
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

  it("spawns tail -f with correct args and stdio inherit", async () => {
    // No systemd, log file exists
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });

    const fakeChild = { on: vi.fn(), pid: 999 };
    vi.mocked(childProcess.spawn).mockReturnValue(fakeChild as never);

    await parseDaemon(["node", "test", "daemon", "logs", "--follow"]);

    // Assert spawn was called with tail command
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    expect(cmd).toBe("tail");

    // Assert follow flag is present
    const argsArr = args as string[];
    expect(argsArr).toContain("-f");

    // Assert default lines count
    expect(argsArr).toContain("-n");
    expect(argsArr).toContain("50");

    // Assert stdio inherit for direct terminal streaming
    expect(opts).toMatchObject({ stdio: "inherit" });

    // Assert error handler was registered
    expect(fakeChild.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("--follow with custom --lines passes correct count", async () => {
    // No systemd, log file exists
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });

    const fakeChild = { on: vi.fn(), pid: 999 };
    vi.mocked(childProcess.spawn).mockReturnValue(fakeChild as never);

    await parseDaemon(["node", "test", "daemon", "logs", "--follow", "--lines", "100"]);

    const [, args] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    const argsArr = args as string[];
    expect(argsArr).toContain("-n");
    expect(argsArr).toContain("100");
    expect(argsArr).toContain("-f");
  });
});

describe("daemon commands error handling", () => {
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

  it("daemon start error: reports failure and exits 1", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      // Daemon binary exists
      if (path.includes("daemon")) return true;
      return false;
    });
    // No existing PID
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    // spawn throws an error
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      throw new Error("spawn failed");
    });

    try {
      await parseDaemon(["node", "test", "daemon", "start"]);
    } catch {
      // process.exit called
    }

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to start daemon");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  it("daemon stop error: throws unexpected error and exits 1", async () => {
    // No systemd
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "/run/systemd/system") return false;
      return true;
    });
    // PID file contains 12345
    vi.mocked(fs.readFileSync).mockReturnValue("12345");

    // process.kill behavior: signal 0 returns true (alive), but SIGTERM throws
    // an unexpected error that isn't caught by the stop code's normal flow.
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(
      (_pid: number, signal?: string | number) => {
        if (signal === 0) return true; // alive
        if (signal === "SIGTERM") throw new Error("Unexpected SIGTERM failure");
        return true;
      },
    );

    try {
      await parseDaemon(["node", "test", "daemon", "stop"]);
    } catch {
      // process.exit called
    }

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to stop daemon");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    processKillSpy.mockRestore();
  });
});
