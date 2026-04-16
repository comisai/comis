/**
 * Unit tests for the secrets CLI commands.
 *
 * Tests all 6 subcommands: init, set, get, list, delete, import.
 * Uses mocked dependencies for deterministic testing without filesystem
 * or database access.
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
import { ok, err } from "@comis/shared";
import type { SecretStorePort, SecretMetadata } from "@comis/core";

// --- Mock store factory ---

function createMockStore(
  overrides?: Partial<SecretStorePort>,
): SecretStorePort {
  return {
    set: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    getDecrypted: vi
      .fn()
      .mockReturnValue({ ok: true, value: "secret-value" }),
    decryptAll: vi.fn().mockReturnValue({ ok: true, value: new Map() }),
    exists: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue({ ok: true, value: [] }),
    delete: vi.fn().mockReturnValue({ ok: true, value: true }),
    recordUsage: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

// --- Module mocks ---

// Mock node:crypto
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() =>
    Buffer.from(
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "hex",
    ),
  ),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  password: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));

// Mock @comis/core
let mockStore: SecretStorePort = createMockStore();
let mockAuditFindings: unknown[] = [];
vi.mock("@comis/core", () => ({
  parseMasterKey: vi.fn(() => Buffer.alloc(32, 0xaa)),
  createSecretsCrypto: vi.fn(() => ({})),
  loadEnvFile: vi.fn(() => 0),
  safePath: vi.fn((...args: string[]) => args.join("/")),
  sanitizeLogString: vi.fn((s: string) => s),
  auditSecrets: vi.fn(() => mockAuditFindings),
}));

// Mock @comis/memory
vi.mock("@comis/memory", () => ({
  createSqliteSecretStore: vi.fn(() => mockStore),
}));

// Mock output/format.js -- pass through to console for spy capture
vi.mock("../output/format.js", () => ({
  success: vi.fn((msg: string) => console.log(`[success] ${msg}`)),
  error: vi.fn((msg: string) => console.error(`[error] ${msg}`)),
  info: vi.fn((msg: string) => console.log(`[info] ${msg}`)),
  warn: vi.fn((msg: string) => console.log(`[warn] ${msg}`)),
  json: vi.fn((data: unknown) => console.log(JSON.stringify(data, null, 2))),
}));

// Mock output/table.js
vi.mock("../output/table.js", () => ({
  renderTable: vi.fn((_headers: string[], _rows: string[][]) => {
    console.log("[table]");
  }),
}));

// Mock sessions.js -- formatRelativeTime
vi.mock("./sessions.js", () => ({
  formatRelativeTime: vi.fn((ts: number) => `${ts}ms ago`),
}));

// Dynamic imports after mocks
const { registerSecretsCommand } = await import("./secrets.js");
const nodefs = await import("node:fs");
const nodecrypto = await import("node:crypto");
const p = await import("@clack/prompts");
const core = await import("@comis/core");
const memory = await import("@comis/memory");
const { renderTable } = await import("../output/table.js");

// Save TTY state
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

// --- Test suites ---

describe("secrets init", () => {
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

  it("generates a 64-char hex key and prints it", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "init"]);

    const output = getSpyOutput(consoleSpy.log);
    // The mocked randomBytes returns a known 32-byte buffer; hex = 64 chars
    expect(output).toContain(
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
    expect(nodecrypto.randomBytes).toHaveBeenCalledWith(32);
  });

  it("with --write appends key to .env file", async () => {
    // No existing key in file
    vi.mocked(nodefs.readFileSync).mockReturnValue("");

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "init",
      "--write",
    ]);

    // safePath should have been called for .env path
    expect(core.safePath).toHaveBeenCalledWith("/mock-home/.comis", ".env");

    // mkdirSync for the directory
    expect(nodefs.mkdirSync).toHaveBeenCalledWith("/mock-home/.comis", {
      recursive: true,
      mode: 0o700,
    });

    // appendFileSync to write the key
    expect(nodefs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".env"),
      expect.stringContaining("SECRETS_MASTER_KEY="),
    );

    // chmodSync for restrictive permissions
    expect(nodefs.chmodSync).toHaveBeenCalledWith(
      expect.stringContaining(".env"),
      0o600,
    );

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("[success]");
    expect(output).toContain("Master key written");
  });

  it("with --write refuses if SECRETS_MASTER_KEY already exists", async () => {
    vi.mocked(nodefs.readFileSync).mockReturnValue(
      "SECRETS_MASTER_KEY=existingkey123\n",
    );

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "init",
      "--write",
    ]);

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("already exists");

    // Should NOT have written anything
    expect(nodefs.appendFileSync).not.toHaveBeenCalled();
  });

  it("with --write does NOT print key to stdout", async () => {
    vi.mocked(nodefs.readFileSync).mockReturnValue("");

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "init",
      "--write",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    // The 64-char hex key should NOT appear in stdout when --write is used
    expect(output).not.toContain(
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
    // But the success message should still appear
    expect(output).toContain("Master key written");
  });

  it("without --write prints key to stdout", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "init"]);

    const output = getSpyOutput(consoleSpy.log);
    // Without --write, the key SHOULD be printed to stdout
    expect(output).toContain(
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
  });

  it("with --write creates directory if .env file does not exist", async () => {
    // readFileSync throws ENOENT -- file does not exist
    vi.mocked(nodefs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "init",
      "--write",
    ]);

    // Should still proceed to create
    expect(nodefs.mkdirSync).toHaveBeenCalled();
    expect(nodefs.appendFileSync).toHaveBeenCalled();
  });
});

describe("secrets set", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockStore = createMockStore();
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // eslint-disable-next-line no-process-env
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
  });

  it("stores a secret with --value flag", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "set",
      "MY_KEY",
      "--value",
      "myvalue",
    ]);

    expect(mockStore.set).toHaveBeenCalledWith("MY_KEY", "myvalue", {
      provider: undefined,
    });
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("[success]");
    expect(output).toContain("stored successfully");
  });

  it("auto-detects provider from name", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "set",
      "OPENAI_API_KEY",
      "--value",
      "sk-test",
    ]);

    expect(mockStore.set).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-test", {
      provider: "openai",
    });
  });

  it("uses --provider override", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "set",
      "MY_KEY",
      "--value",
      "test",
      "--provider",
      "custom",
    ]);

    expect(mockStore.set).toHaveBeenCalledWith("MY_KEY", "test", {
      provider: "custom",
    });
  });

  it("prints error on store failure", async () => {
    mockStore = createMockStore({
      set: vi
        .fn()
        .mockReturnValue({ ok: false, error: new Error("Store write failed") }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "set",
        "MY_KEY",
        "--value",
        "test",
      ]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("Store write failed");
  });

  it("closes store in finally block", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "set",
      "MY_KEY",
      "--value",
      "test",
    ]);

    expect(mockStore.close).toHaveBeenCalled();
  });
});

describe("secrets get", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockStore = createMockStore();
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // eslint-disable-next-line no-process-env
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64);
    // Default: stdout is not TTY so confirmation is skipped
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("displays secret after confirmation", async () => {
    // Simulate TTY stdout so confirmation guard triggers
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    vi.mocked(p.confirm).mockResolvedValue(true);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "get",
      "MY_KEY",
    ]);

    expect(p.confirm).toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("secret-value");
  });

  it("with --yes skips confirmation", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "get",
      "MY_KEY",
      "--yes",
    ]);

    expect(p.confirm).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("secret-value");
  });

  it("prints error when secret not found", async () => {
    mockStore = createMockStore({
      getDecrypted: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "get",
        "MY_KEY",
        "--yes",
      ]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("not found");
  });

  it("prints error on decryption failure", async () => {
    mockStore = createMockStore({
      getDecrypted: vi
        .fn()
        .mockReturnValue({ ok: false, error: new Error("DECRYPTION_FAILED") }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "get",
        "MY_KEY",
        "--yes",
      ]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("DECRYPTION_FAILED");
  });

  it("cancels when confirmation is declined", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    vi.mocked(p.confirm).mockResolvedValue(false);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "get",
      "MY_KEY",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Cancelled");
    expect(mockStore.getDecrypted).not.toHaveBeenCalled();
  });
});

describe("secrets list", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // eslint-disable-next-line no-process-env
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
  });

  it("renders metadata table", async () => {
    const entries: SecretMetadata[] = [
      {
        name: "OPENAI_API_KEY",
        provider: "openai",
        createdAt: 1000,
        updatedAt: 1000,
        lastUsedAt: 2000,
        usageCount: 5,
      },
      {
        name: "ANTHROPIC_API_KEY",
        provider: "anthropic",
        createdAt: 3000,
        updatedAt: 3000,
        usageCount: 0,
      },
    ];
    mockStore = createMockStore({
      list: vi.fn().mockReturnValue({ ok: true, value: entries }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "list"]);

    expect(renderTable).toHaveBeenCalledWith(
      ["Name", "Provider", "Created", "Last Used", "Usage Count"],
      expect.arrayContaining([
        expect.arrayContaining(["OPENAI_API_KEY", "openai"]),
      ]),
    );
  });

  it("outputs JSON with --format json", async () => {
    const entries: SecretMetadata[] = [
      {
        name: "MY_SECRET",
        provider: "custom",
        createdAt: 1000,
        updatedAt: 1000,
        usageCount: 1,
      },
    ];
    mockStore = createMockStore({
      list: vi.fn().mockReturnValue({ ok: true, value: entries }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "list",
      "--format",
      "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("MY_SECRET");
  });

  it("shows info when no secrets", async () => {
    mockStore = createMockStore({
      list: vi.fn().mockReturnValue({ ok: true, value: [] }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "list"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No secrets stored");
  });

  it("prints error on list failure", async () => {
    mockStore = createMockStore({
      list: vi
        .fn()
        .mockReturnValue({ ok: false, error: new Error("DB read error") }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync(["node", "comis", "secrets", "list"]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("DB read error");
  });
});

describe("secrets delete", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockStore = createMockStore();
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // eslint-disable-next-line no-process-env
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
  });

  it("deletes after confirmation", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "delete",
      "MY_KEY",
    ]);

    expect(p.confirm).toHaveBeenCalled();
    expect(mockStore.delete).toHaveBeenCalledWith("MY_KEY");
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("deleted");
  });

  it("with --yes skips confirmation", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "delete",
      "MY_KEY",
      "--yes",
    ]);

    expect(p.confirm).not.toHaveBeenCalled();
    expect(mockStore.delete).toHaveBeenCalledWith("MY_KEY");
  });

  it("warns when secret not found", async () => {
    mockStore = createMockStore({
      delete: vi.fn().mockReturnValue({ ok: true, value: false }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "delete",
      "MY_KEY",
      "--yes",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("not found");
  });

  it("cancels on declined confirmation", async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "delete",
      "MY_KEY",
    ]);

    expect(mockStore.delete).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Cancelled");
  });

  it("prints error on delete failure", async () => {
    mockStore = createMockStore({
      delete: vi
        .fn()
        .mockReturnValue({ ok: false, error: new Error("DB delete error") }),
    });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "delete",
        "MY_KEY",
        "--yes",
      ]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("DB delete error");
  });
});

describe("secrets import", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockStore = createMockStore();
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // eslint-disable-next-line no-process-env
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
  });

  it("imports secrets from .env file", async () => {
    // loadEnvFile populates the record (via side effect)
    vi.mocked(core.loadEnvFile).mockImplementation(
      (_path: string, record: Record<string, string | undefined>) => {
        record["OPENAI_API_KEY"] = "sk-test";
        record["ANTHROPIC_API_KEY"] = "ant-test";
        return 2;
      },
    );

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "import"]);

    expect(mockStore.set).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-test", {
      provider: "openai",
    });
    expect(mockStore.set).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "ant-test",
      { provider: "anthropic" },
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Imported: OPENAI_API_KEY");
    expect(output).toContain("Imported: ANTHROPIC_API_KEY");
    expect(output).toContain("2 imported");
  });

  it("skips operational variables", async () => {
    vi.mocked(core.loadEnvFile).mockImplementation(
      (_path: string, record: Record<string, string | undefined>) => {
        record["COMIS_CONFIG_PATHS"] = "/etc/foo";
        record["SECRETS_MASTER_KEY"] = "abc";
        return 2;
      },
    );

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "import"]);

    expect(mockStore.set).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Skipped");
    expect(output).toContain("0 imported");
    expect(output).toContain("2 skipped");
  });

  it("uses custom file with --file", async () => {
    vi.mocked(core.loadEnvFile).mockImplementation(
      (_path: string, _record: Record<string, string | undefined>) => {
        return 0;
      },
    );

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "import",
      "--file",
      "/tmp/custom.env",
    ]);

    expect(core.loadEnvFile).toHaveBeenCalledWith(
      "/tmp/custom.env",
      expect.any(Object),
    );
  });

  it("reports errors per entry", async () => {
    vi.mocked(core.loadEnvFile).mockImplementation(
      (_path: string, record: Record<string, string | undefined>) => {
        record["GOOD_KEY"] = "good-value";
        record["BAD_KEY"] = "bad-value";
        return 2;
      },
    );

    // First call succeeds, second fails
    const setFn = vi
      .fn()
      .mockReturnValueOnce({ ok: true, value: undefined })
      .mockReturnValueOnce({
        ok: false,
        error: new Error("Encryption failed"),
      });
    mockStore = createMockStore({ set: setFn });
    vi.mocked(memory.createSqliteSecretStore).mockReturnValue(mockStore);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "import"]);

    const logOutput = getSpyOutput(consoleSpy.log);
    const errorOutput = getSpyOutput(consoleSpy.error);

    // Should have both success and failure
    expect(logOutput).toContain("1 imported");
    expect(logOutput).toContain("1 failed");
    expect(errorOutput).toContain("Failed");
  });

  it("prints error when file not found", async () => {
    vi.mocked(core.loadEnvFile).mockReturnValue(-1);

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync(["node", "comis", "secrets", "import"]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("File not found");
  });
});

describe("openSecretStore error handling", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let savedMasterKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    // eslint-disable-next-line no-process-env
    savedMasterKey = process.env["SECRETS_MASTER_KEY"];
    // Ensure no master key is set
    // eslint-disable-next-line no-process-env
    delete process.env["SECRETS_MASTER_KEY"];
    // loadEnvFile should NOT populate the key
    vi.mocked(core.loadEnvFile).mockImplementation(() => 0);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    if (savedMasterKey !== undefined) {
      // eslint-disable-next-line no-process-env
      process.env["SECRETS_MASTER_KEY"] = savedMasterKey;
    } else {
      // eslint-disable-next-line no-process-env
      delete process.env["SECRETS_MASTER_KEY"];
    }
  });

  it("throws when SECRETS_MASTER_KEY not set", async () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync(["node", "comis", "secrets", "list"]);
    } catch {
      // process.exit mock throws
    }

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("SECRETS_MASTER_KEY not set");
  });
});

describe("secrets audit", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    mockAuditFindings = [];
    // existsSync returns false by default (no files found)
    vi.mocked(nodefs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("registers the audit subcommand", () => {
    const program = createTestProgram();
    registerSecretsCommand(program);

    const secrets = program.commands.find((c) => c.name() === "secrets");
    expect(secrets).toBeDefined();
    const audit = secrets?.commands.find((c) => c.name() === "audit");
    expect(audit).toBeDefined();
  });

  it("reports no files found when nothing exists", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(false);

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "audit"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No config files or .env found to audit");
  });

  it("outputs empty JSON array with --json when no findings", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "audit",
      "--json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it("outputs success message when no findings in table mode", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "audit"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No plaintext secrets detected");
  });

  it("renders findings table when findings exist", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/mock-home/.comis/config.yaml",
        jsonPath: "channels.telegram.botToken",
        message: "Plaintext secret detected in field 'botToken'",
      },
    ];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "audit"]);

    expect(renderTable).toHaveBeenCalledWith(
      ["Severity", "Code", "Path", "Message"],
      expect.arrayContaining([
        expect.arrayContaining(["ERROR", "PLAINTEXT_SECRET"]),
      ]),
    );
  });

  it("--json outputs findings as JSON array", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [
      {
        code: "KNOWN_PROVIDER_ENV",
        severity: "warn",
        file: "/mock-home/.comis/.env",
        jsonPath: "ANTHROPIC_API_KEY",
        message: "Known anthropic secret found",
      },
    ];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "audit",
      "--json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].code).toBe("KNOWN_PROVIDER_ENV");
  });

  it("--check exits non-zero when findings exist", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/config.yaml",
        jsonPath: "channels.telegram.botToken",
        message: "Plaintext secret",
      },
    ];

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "audit",
        "--check",
      ]);
    } catch {
      // process.exit mock throws
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("--check does not exit when no findings", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "audit",
      "--check",
    ]);

    expect(process.exit).not.toHaveBeenCalled();
  });

  it("--check --json exits non-zero with JSON output", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/config.yaml",
        jsonPath: "apiKey",
        message: "Plaintext secret",
      },
    ];

    const program = createTestProgram();
    registerSecretsCommand(program);

    try {
      await program.parseAsync([
        "node",
        "comis",
        "secrets",
        "audit",
        "--json",
        "--check",
      ]);
    } catch {
      // process.exit mock throws
    }

    // JSON output should still be printed
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    // And exit code should be 1
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("displays finding summary counts", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/config.yaml",
        jsonPath: "botToken",
        message: "Plaintext secret",
      },
      {
        code: "KNOWN_PROVIDER_ENV",
        severity: "warn",
        file: "/.env",
        jsonPath: "OPENAI_API_KEY",
        message: "Known provider env",
      },
    ];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync(["node", "comis", "secrets", "audit"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("1 error(s)");
    expect(output).toContain("1 warning(s)");
  });

  it("uses custom config paths with --config", async () => {
    vi.mocked(nodefs.existsSync).mockReturnValue(true);
    mockAuditFindings = [];

    const program = createTestProgram();
    registerSecretsCommand(program);

    await program.parseAsync([
      "node",
      "comis",
      "secrets",
      "audit",
      "--config",
      "/custom/config.yaml",
    ]);

    expect(core.auditSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        configPaths: ["/custom/config.yaml"],
      }),
    );
  });
});
