/**
 * Init wizard command behavior tests.
 *
 * Tests init command behaviors: detects non-TTY and exits,
 * --quick uses quickstart flow, interactive mode uses wizard architecture.
 * Uses mocked @clack/prompts and wizard flow modules.
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

// Mock @clack/prompts with all symbols/functions the clack-adapter uses
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    note: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    isCancel: vi.fn(() => false),
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      success: vi.fn(),
    },
  };
});

// Mock the wizard state module to intercept runWizardFlow
vi.mock("../wizard/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/state.js")>();
  return {
    ...actual,
    runWizardFlow: vi.fn(async () => ({ completedSteps: [] })),
  };
});

// Dynamic imports after mocks
const { registerInitCommand } = await import("./init.js");
const { runWizardFlow } = await import("../wizard/state.js");

// Save original isTTY for restoration
const originalIsTTY = process.stdin.isTTY;

describe("init detects non-TTY and exits", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
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

  it("exits with code 1 and helpful error when stdin is not a TTY", async () => {
    const program = createTestProgram();
    registerInitCommand(program);

    try {
      await program.parseAsync(["node", "test", "init"]);
    } catch {
      // process.exit mock throws
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("interactive terminal");
  });

  it("does not call runWizardFlow when non-TTY", async () => {
    const program = createTestProgram();
    registerInitCommand(program);

    try {
      await program.parseAsync(["node", "test", "init"]);
    } catch {
      // process.exit mock throws
    }

    expect(runWizardFlow).not.toHaveBeenCalled();
  });
});

describe("init --quick uses quickstart flow", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
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

  it("calls runWizardFlow with quickstart flow", async () => {
    vi.mocked(runWizardFlow).mockResolvedValue({ completedSteps: [] });

    const program = createTestProgram();
    registerInitCommand(program);
    await program.parseAsync(["node", "test", "init", "--quick"]);

    expect(runWizardFlow).toHaveBeenCalledOnce();
    expect(runWizardFlow).toHaveBeenCalledWith(
      "quickstart",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ flow: "quickstart" }),
    );
  });

  it("passes initial state with flow pre-set to quickstart", async () => {
    vi.mocked(runWizardFlow).mockResolvedValue({ completedSteps: [] });

    const program = createTestProgram();
    registerInitCommand(program);
    await program.parseAsync(["node", "test", "init", "--quick"]);

    const initialState = vi.mocked(runWizardFlow).mock.calls[0][3];
    expect(initialState).toBeDefined();
    expect(initialState!.flow).toBe("quickstart");
  });
});

describe("init without --quick uses advanced flow", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
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

  it("calls runWizardFlow with advanced flow when no --quick flag", async () => {
    vi.mocked(runWizardFlow).mockResolvedValue({ completedSteps: [] });

    const program = createTestProgram();
    registerInitCommand(program);
    await program.parseAsync(["node", "test", "init"]);

    expect(runWizardFlow).toHaveBeenCalledOnce();
    expect(runWizardFlow).toHaveBeenCalledWith(
      "advanced",
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("does not pass initial state without --quick", async () => {
    vi.mocked(runWizardFlow).mockResolvedValue({ completedSteps: [] });

    const program = createTestProgram();
    registerInitCommand(program);
    await program.parseAsync(["node", "test", "init"]);

    const initialState = vi.mocked(runWizardFlow).mock.calls[0][3];
    expect(initialState).toBeUndefined();
  });
});
