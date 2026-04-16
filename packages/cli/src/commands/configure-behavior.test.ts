/**
 * Configure command behavior tests.
 *
 * Tests configure command behaviors: detects non-TTY and exits,
 * reads existing config and presents sections for editing, handles missing
 * config, --section jumps directly to section, rejects unknown section,
 * and validation failure prevents saving. Uses mocked @clack/prompts,
 * @comis/core, and node:fs.
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

// Mock @clack/prompts for interactive prompts
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

// Mock @comis/core for config functions
vi.mock("@comis/core", () => ({
  getConfigSections: vi.fn(() => ["gateway", "logging", "channels", "agents"]),
  getFieldMetadata: vi.fn(() => []),
  validatePartial: vi.fn(() => ({ config: {}, validSections: [], errors: [] })),
  loadConfigFile: vi.fn(() => ({ ok: true, value: {} })),
  sanitizeLogString: vi.fn((s: string) => s),
}));

// Mock node:fs for config file operations
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Dynamic imports after mocks
const { registerConfigureCommand } = await import("./configure.js");
const p = await import("@clack/prompts");
const core = await import("@comis/core");
const fs = await import("node:fs");

// Save original isTTY for restoration
const originalIsTTY = process.stdin.isTTY;

/**
 * Helper to parse the configure command with given argv.
 */
async function parseConfigure(argv: string[]): Promise<void> {
  const program = createTestProgram();
  registerConfigureCommand(program);
  await program.parseAsync(argv);
}

describe("configure detects non-TTY and exits", () => {
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

  it("exits with code 1 and error message when stdin is not a TTY", async () => {
    try {
      await parseConfigure(["node", "test", "configure"]);
    } catch {
      // process.exit mock throws
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("interactive terminal");
  });
});

describe("configure reads existing config and presents sections", () => {
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

  it("loads config, presents section selection, edits fields, validates, and saves", async () => {
    // Configure loadConfigFile to return existing config
    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: { gateway: { host: "127.0.0.1", port: 3100 } },
    } as ReturnType<typeof core.loadConfigFile>);

    // Configure getConfigSections
    vi.mocked(core.getConfigSections).mockReturnValue([
      "gateway",
      "logging",
      "agents",
    ]);

    // Configure getFieldMetadata for gateway section
    vi.mocked(core.getFieldMetadata).mockReturnValue([
      {
        path: "gateway.host",
        type: "string",
        description: "Gateway host",
        immutable: false,
      },
      {
        path: "gateway.port",
        type: "number",
        description: "Gateway port",
        immutable: false,
      },
    ]);

    // Section selection -> gateway
    vi.mocked(p.select).mockResolvedValueOnce("gateway");

    // Text prompts for gateway fields: host then port
    vi.mocked(p.text)
      .mockResolvedValueOnce("0.0.0.0") // host
      .mockResolvedValueOnce("3200"); // port (returned as string by p.text, converted to number by promptForField)

    // validatePartial returns no errors
    vi.mocked(core.validatePartial).mockReturnValue({
      config: {},
      validSections: ["gateway"],
      errors: [],
    });

    // fs.readFileSync returns valid YAML for YAML document creation
    vi.mocked(fs.readFileSync).mockReturnValue(
      'gateway:\n  host: "127.0.0.1"\n  port: 3100\n',
    );

    // Confirm "edit another section?" -> false (exit loop)
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await parseConfigure(["node", "test", "configure"]);

    // Assert intro was called
    expect(p.intro).toHaveBeenCalledWith("Comis Configuration Editor");

    // Assert config was loaded and info shown
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Loaded configuration"),
    );

    // Assert section selection was presented with section names
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "gateway", label: "gateway" }),
        ]),
      }),
    );

    // Assert config was written (validation passed)
    expect(fs.writeFileSync).toHaveBeenCalled();

    // Assert success message
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("updated"),
    );
  });
});

describe("configure handles missing config file", () => {
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

  it("shows warning and continues with empty config when file not found", async () => {
    // Configure loadConfigFile to return FILE_NOT_FOUND
    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: false,
      error: { code: "FILE_NOT_FOUND", message: "Config file not found" },
    } as ReturnType<typeof core.loadConfigFile>);

    vi.mocked(core.getConfigSections).mockReturnValue([
      "gateway",
      "logging",
    ]);

    // Section selection -> gateway
    vi.mocked(p.select).mockResolvedValueOnce("gateway");

    // getFieldMetadata returns empty array (no editable fields)
    vi.mocked(core.getFieldMetadata).mockReturnValue([]);

    // Confirm "edit another section?" -> false (exit loop)
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await parseConfigure(["node", "test", "configure"]);

    // Assert warning about missing file
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("empty config"),
    );
  });
});

describe("configure --section jumps directly to section", () => {
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

  it("skips section selection and jumps directly to specified section", async () => {
    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: {},
    } as ReturnType<typeof core.loadConfigFile>);

    vi.mocked(core.getConfigSections).mockReturnValue([
      "gateway",
      "logging",
      "agents",
    ]);

    // getFieldMetadata for gateway returns editable fields
    vi.mocked(core.getFieldMetadata).mockReturnValue([
      {
        path: "gateway.host",
        type: "string",
        description: "Gateway host",
        immutable: false,
        default: "127.0.0.1",
      },
    ]);

    // Text prompt for gateway.host field
    vi.mocked(p.text).mockResolvedValueOnce("0.0.0.0");

    // validatePartial passes
    vi.mocked(core.validatePartial).mockReturnValue({
      config: {},
      validSections: ["gateway"],
      errors: [],
    });

    // fs.readFileSync returns valid YAML
    vi.mocked(fs.readFileSync).mockReturnValue("gateway:\n  host: '127.0.0.1'\n");

    // Confirm "edit another section?" -> false (exit loop)
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await parseConfigure([
      "node",
      "test",
      "configure",
      "--section",
      "gateway",
    ]);

    // Assert p.select was NOT called (jumped directly)
    expect(p.select).not.toHaveBeenCalled();

    // Assert p.log.step was called with the section name
    expect(p.log.step).toHaveBeenCalledWith(
      expect.stringContaining("gateway"),
    );
  });
});

describe("configure --section rejects unknown section", () => {
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

  it("exits with error and shows available sections for unknown section", async () => {
    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: {},
    } as ReturnType<typeof core.loadConfigFile>);

    vi.mocked(core.getConfigSections).mockReturnValue([
      "gateway",
      "logging",
    ]);

    try {
      await parseConfigure([
        "node",
        "test",
        "configure",
        "--section",
        "nonexistent",
      ]);
    } catch {
      // process.exit mock throws
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown section"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("gateway"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("logging"),
    );
  });
});

describe("configure validation failure prevents save", () => {
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

  it("does not write config when validatePartial returns errors", async () => {
    vi.mocked(core.loadConfigFile).mockReturnValue({
      ok: true,
      value: {},
    } as ReturnType<typeof core.loadConfigFile>);

    vi.mocked(core.getConfigSections).mockReturnValue([
      "gateway",
      "logging",
    ]);

    // getFieldMetadata returns one editable field
    vi.mocked(core.getFieldMetadata).mockReturnValue([
      {
        path: "gateway.port",
        type: "number",
        description: "Gateway port",
        immutable: false,
      },
    ]);

    // Text prompt returns a value (will differ from undefined currentValue)
    vi.mocked(p.text).mockResolvedValueOnce("invalid-port");

    // validatePartial returns errors
    vi.mocked(core.validatePartial).mockReturnValue({
      config: {},
      validSections: [],
      errors: [
        {
          section: "gateway",
          error: { code: "VALIDATION_ERROR" as const, message: "Invalid port" },
        },
      ],
    });

    // Confirm "edit another section?" -> false (exit loop)
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await parseConfigure([
      "node",
      "test",
      "configure",
      "--section",
      "gateway",
    ]);

    // Assert fs.writeFileSync was NOT called (validation failed)
    expect(fs.writeFileSync).not.toHaveBeenCalled();

    // Assert error was reported
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Validation failed"),
    );
  });
});
