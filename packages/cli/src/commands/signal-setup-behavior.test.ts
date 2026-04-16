/**
 * Signal setup command behavior tests: TTY detection, Java check, signal-cli detection.
 *
 * Tests TTY detection, Java version validation, and existing signal-cli detection
 * by mocking child_process (execFileSync) and @clack/prompts. Covers configure
 * and reinstall options for existing installs.
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

// ---------- Module-level mocks (BEFORE any imports from signal-setup.ts) ----------

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
  outro: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// ---------- Dynamic imports after mocks ----------

const { registerSignalSetupCommand } = await import("./signal-setup.js");
const childProcess = await import("node:child_process");
const p = await import("@clack/prompts");

// ---------- Helpers ----------

/** Build a program with signal-setup command registered and parse given argv. */
async function parseSignalSetup(argv: string[]): Promise<void> {
  const program = createTestProgram();
  registerSignalSetupCommand(program);
  await program.parseAsync(argv);
}

// ---------- Tests ----------

describe("signal-setup detects non-TTY and exits", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // Ensure non-TTY
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("exits with error in non-TTY environment", async () => {
    try {
      await parseSignalSetup(["node", "test", "signal-setup"]);
    } catch {
      // process.exit called
    }

    // Assert process.exit(1) was called
    expect(exitSpy.spy).toHaveBeenCalledWith(1);

    // Assert console.error output contains "interactive terminal"
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("interactive terminal");
  });
});

describe("signal-setup checks Java version", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // Ensure TTY so we get past the TTY check
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("reports error when Java is not found", async () => {
    // All execFileSync calls throw (Java not installed)
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("command not found");
    });

    // User cancels when asked to continue without Java
    vi.mocked(p.confirm).mockResolvedValue(false);
    vi.mocked(p.isCancel).mockReturnValue(false);

    await parseSignalSetup(["node", "test", "signal-setup"]);

    // Assert p.log.error was called with message containing "Java 21+"
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Java 21+"),
    );

    // Assert p.cancel was called (setup cancelled after user declines)
    expect(p.cancel).toHaveBeenCalled();
  });

  it("warns when Java version is too old", async () => {
    // execFileSync: java -version throws with old version on stderr
    vi.mocked(childProcess.execFileSync).mockImplementation((file: unknown) => {
      if (String(file) === "java") {
        const err = new Error("command failed") as Error & { stderr: string };
        err.stderr = 'openjdk version "11.0.2" 2019-01-15';
        throw err;
      }
      throw new Error("command not found");
    });

    // User cancels when asked to continue with incompatible Java
    vi.mocked(p.confirm).mockResolvedValue(false);
    vi.mocked(p.isCancel).mockReturnValue(false);

    await parseSignalSetup(["node", "test", "signal-setup"]);

    // Assert p.log.warning was called with message containing "21+" and "11"
    expect(p.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("21+"),
    );
    expect(p.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("11"),
    );

    // Assert p.cancel was called (setup cancelled)
    expect(p.cancel).toHaveBeenCalled();
  });

  it("proceeds past Java check when version is sufficient", async () => {
    // execFileSync: java -version throws with Java 21 on stderr, signal-cli throws
    vi.mocked(childProcess.execFileSync).mockImplementation((file: unknown) => {
      if (String(file) === "java") {
        const err = new Error("command failed") as Error & { stderr: string };
        err.stderr = 'openjdk version "21.0.1" 2023-10-17';
        throw err;
      }
      throw new Error("command not found");
    });

    // Signal-cli not found -> goes to install step
    // User cancels at install method selection
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.select).mockResolvedValue(cancelSymbol as unknown as string);
    vi.mocked(p.isCancel).mockImplementation(
      (value) => value === cancelSymbol,
    );

    await parseSignalSetup(["node", "test", "signal-setup"]);

    // Assert the spinner.stop was called (Java check completed)
    // The flow should have proceeded past Java check to signal-cli check
    // and then to install step where the user cancelled
    const spinnerInstance = vi.mocked(p.spinner).mock.results[0]?.value;
    expect(spinnerInstance.stop).toHaveBeenCalledWith(
      expect.stringContaining("Java 21"),
    );
  });
});

describe("signal-setup detects existing signal-cli", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // Ensure TTY
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("detects existing installation and offers configure vs reinstall", async () => {
    // execFileSync: Java 21 found (stderr), signal-cli found (stdout)
    vi.mocked(childProcess.execFileSync).mockImplementation((file: unknown, args?: unknown) => {
      const argsArr = Array.isArray(args) ? args : [];
      if (String(file) === "java") {
        const err = new Error("command failed") as Error & { stderr: string };
        err.stderr = 'openjdk version "21.0.1" 2023-10-17';
        throw err;
      }
      if (String(file) === "signal-cli" && argsArr.includes("--version")) {
        return "signal-cli 0.13.2";
      }
      throw new Error("command not found");
    });

    // User selects "configure" at signal-cli action prompt
    vi.mocked(p.select).mockResolvedValue("configure");

    // User cancels at phone number text prompt
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.text).mockResolvedValue(cancelSymbol as unknown as string);
    vi.mocked(p.isCancel).mockImplementation(
      (value) => value === cancelSymbol,
    );

    await parseSignalSetup(["node", "test", "signal-setup"]);

    // Assert p.log.info was called with message containing "already installed" and version
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("already installed"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("0.13.2"),
    );

    // Assert p.select was called with options including configure and reinstall
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "configure" }),
          expect.objectContaining({ value: "install" }),
        ]),
      }),
    );
  });

  it("proceeds to installation when signal-cli is not found", async () => {
    // execFileSync: Java 21 found (stderr), signal-cli NOT found
    vi.mocked(childProcess.execFileSync).mockImplementation((file: unknown) => {
      if (String(file) === "java") {
        const err = new Error("command failed") as Error & { stderr: string };
        err.stderr = 'openjdk version "21.0.1" 2023-10-17';
        throw err;
      }
      throw new Error("command not found");
    });

    // checkSignalCli returns "install" (no existing installation)
    // User cancels at installSignalCli's select prompt
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.select).mockResolvedValue(cancelSymbol as unknown as string);
    vi.mocked(p.isCancel).mockImplementation(
      (value) => value === cancelSymbol,
    );

    await parseSignalSetup(["node", "test", "signal-setup"]);

    // Assert p.select was called with installation method options
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Installation method:",
      }),
    );

    // Assert p.cancel was called (user cancelled at install step)
    expect(p.cancel).toHaveBeenCalled();
  });
});
