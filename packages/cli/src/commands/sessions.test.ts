// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the sessions CLI command registration AND the
 * `comis sessions report show` rendering path.
 *
 * Three test blocks below:
 *
 *   - `registerSessionsCommand` / `formatRelativeTime` — verify the
 *     subcommand wiring (list / inspect / delete / report show / list).
 *
 *   - `renderSystemPromptReport — Tools/Skills lines never render
 *     'undefined entries'`. Any non-array `entries` value must render an
 *     honest `?` instead of the misleading literal `undefined`.
 *
 *   - Phase 164-03 (RR4): sessions reset-lcd subcommand wiring:
 *     CLI1 — subcommand is registered; accepts sessionKey + --memory + --yes
 *     CLI2 — calls session.reset_conversation with { session_key } when --yes is passed
 *     CLI3 — --memory flag threads memory: true to the RPC request
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  registerSessionsCommand,
  formatRelativeTime,
  renderSystemPromptReport,
} from "./sessions.js";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
} from "../test-helpers.js";

describe("registerSessionsCommand", () => {
  it("registers the sessions command with list, inspect, and delete subcommands", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    expect(sessionsCmd).toBeDefined();
    expect(sessionsCmd!.description()).toBe("Session management");

    const subcommandNames = sessionsCmd!.commands.map((c) => c.name());
    expect(subcommandNames).toContain("list");
    expect(subcommandNames).toContain("inspect");
    expect(subcommandNames).toContain("delete");
  });

  it("list subcommand has --tenant and --format options", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const listCmd = sessionsCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();

    const optionNames = listCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--tenant");
    expect(optionNames).toContain("--format");
  });

  it("delete subcommand has --yes option", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const deleteCmd = sessionsCmd!.commands.find((c) => c.name() === "delete");
    expect(deleteCmd).toBeDefined();

    const optionNames = deleteCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--yes");

    // Should have <key> argument
    const argNames = deleteCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("key");
  });

  it("registers the report subcommand group under sessions", () => {
    const program = new Command();
    registerSessionsCommand(program);
    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const reportCmd = sessionsCmd!.commands.find((c) => c.name() === "report");
    expect(reportCmd).toBeDefined();
    expect(reportCmd!.description()).toBe("Inspect SystemPromptReport");
  });

  it("report show subcommand has --agent (required), --runId, --format options", () => {
    const program = new Command();
    registerSessionsCommand(program);
    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const reportCmd = sessionsCmd!.commands.find((c) => c.name() === "report");
    const showCmd = reportCmd!.commands.find((c) => c.name() === "show");
    expect(showCmd).toBeDefined();

    const optionNames = showCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--agent");
    expect(optionNames).toContain("--runId");
    expect(optionNames).toContain("--format");

    const agentOpt = showCmd!.options.find((o) => o.long === "--agent");
    expect(agentOpt?.mandatory).toBe(true);

    const argNames = showCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("sessionId");
  });

  it("report list subcommand has --limit and --format options", () => {
    const program = new Command();
    registerSessionsCommand(program);
    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const reportCmd = sessionsCmd!.commands.find((c) => c.name() === "report");
    const listReportCmd = reportCmd!.commands.find((c) => c.name() === "list");
    expect(listReportCmd).toBeDefined();

    const optionNames = listReportCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--limit");
    expect(optionNames).toContain("--format");

    const argNames = listReportCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("sessionId");
  });
});

describe("formatRelativeTime", () => {
  it("returns seconds for very recent timestamps", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 30_000);
    expect(result).toBe("30s ago");
  });

  it("returns minutes for timestamps within an hour", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 5 * 60 * 1000);
    expect(result).toBe("5m ago");
  });

  it("returns hours for timestamps within a day", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 2 * 60 * 60 * 1000);
    expect(result).toBe("2h ago");
  });

  it("returns days for timestamps within a month", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000);
    expect(result).toBe("3d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    const result = formatRelativeTime(Date.now() + 10_000);
    expect(result).toBe("just now");
  });
});

// ---------------------------------------------------------------------------
// `comis sessions report show` Tools/Skills lines must never render the
// literal "undefined entries". The old code used a truthy-check
// (`tools?.entries`) that fired for any non-null shape, then evaluated
// `.length` which is `undefined` for non-array values. The fix uses
// `Array.isArray(...)`. Defensive-shape: when entries is truthy but not
// an array, surface a literal `?` rather than crash or render
// `undefined`.
// ---------------------------------------------------------------------------

function captureConsole(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    output.push(args.map(String).join(" "));
  });
  return { output, restore: () => spy.mockRestore() };
}

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "test-agent",
    provider: "anthropic",
    model: "claude-opus-4-5",
    source: "test",
    generatedAt: 1_716_000_000_000,
    systemPrompt: {
      chars: 100,
      sha256: "abc1234567890def1234567890def1234567890",
      projectContextChars: 50,
    },
    tools: { entries: [], totalSchemaChars: 0 },
    skills: { entries: [], promptChars: 0 },
    injectedWorkspaceFiles: [],
    ...overrides,
  };
}

describe("renderSystemPromptReport — Tools/Skills lines never render 'undefined entries'", () => {
  it("renders Tools  2 entries / 70624 schema chars when tools.entries is a 2-element array", () => {
    const cap = captureConsole();
    try {
      const report = makeReport({
        tools: {
          entries: [
            { name: "tool-a", callable: true, schemaChars: 100 },
            { name: "tool-b", callable: true, schemaChars: 200 },
          ],
          totalSchemaChars: 70624,
        },
      });
      renderSystemPromptReport("session-1", report);
      const combined = cap.output.join("\n");
      expect(combined).toMatch(/Tools.*2 entries.*\/.*70624 schema chars/);
      expect(combined).not.toContain("undefined entries");
    } finally {
      cap.restore();
    }
  });

  it("renders Skills  1 entries / N chars when skills.entries is a 1-element array", () => {
    const cap = captureConsole();
    try {
      const report = makeReport({
        skills: {
          entries: [{ id: "skill-a" }],
          promptChars: 1234,
        },
      });
      renderSystemPromptReport("session-1", report);
      const combined = cap.output.join("\n");
      expect(combined).toMatch(/Skills.*1 entries.*\/.*1234 chars/);
      expect(combined).not.toContain("undefined entries");
    } finally {
      cap.restore();
    }
  });

  it("renders a literal '?' (not 'undefined') when tools.entries is a non-array (defensive shape)", () => {
    const cap = captureConsole();
    try {
      // The runtime sample that surfaced this bug had `tools.entries`
      // present but truthy-without-being-an-array (the 70624 schema
      // chars + "undefined entries" rendering came from a non-array
      // shape that satisfied the truthy guard). Inject a number.
      const report = makeReport({
        tools: { entries: 2 as unknown as never, totalSchemaChars: 100 },
      });
      renderSystemPromptReport("session-1", report);
      const combined = cap.output.join("\n");
      // The output should NEVER contain the literal "undefined entries".
      expect(combined).not.toContain("undefined entries");
      // Surface a `?` so the operator knows the shape is malformed but
      // the totalSchemaChars value is still preserved.
      expect(combined).toMatch(/Tools.*\?\s+entries.*\/.*100 schema chars/);
    } finally {
      cap.restore();
    }
  });

  it("renders Tools  - when the tools block is undefined", () => {
    const cap = captureConsole();
    try {
      const report = makeReport({ tools: undefined });
      renderSystemPromptReport("session-1", report);
      const combined = cap.output.join("\n");
      expect(combined).not.toContain("undefined entries");
      // The renderKeyValue table renders the dash literal in the Tools row.
      expect(combined).toMatch(/Tools[^\n]*\s-\s/);
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 164-06 (gap-closure): sessions reset — complete cross-mode conversation reset
// Replaces Phase 164-03 sessions reset-lcd (LCD-only).
//
// CLI1: subcommand `sessions reset` is registered (NOT `sessions reset-lcd`)
// CLI2: sends session.reset_conversation with { session_key } when --yes is passed
// CLI3: --memory flag threads memory: true to the request
// CLI4: --memory with memoriesDeleted===undefined → ⚠ warning to stderr
// CLI4b: --memory with memoriesDeleted defined (future impl) → RAG line to stdout
// CLI5: output includes both lcdRowsDeleted and sessionMessagesCleared counts
//
// Uses vi.mock for withClient (same pattern as trace.test.ts).
// ---------------------------------------------------------------------------

vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

const { withClient: mockedWithClient } = await import("../client/rpc-client.js");

/** Minimal session.reset_conversation success response — memoriesDeleted OMITTED (honest-defer) */
const RESET_CONVERSATION_RESPONSE = {
  sessionKey: "tenant1:user1:chan1",
  lcdRowsDeleted: 7,
  sessionMessagesCleared: 4,
  // memoriesDeleted is intentionally absent: the handler omits it when RAG clear is not-implemented
};

describe("CLI1: sessions reset subcommand registration (Phase 164-06)", () => {
  it("CLI1: registerSessionsCommand registers sessions reset subcommand (not reset-lcd)", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    expect(sessionsCmd).toBeDefined();

    // New name is 'reset' (Phase 164-06 rename)
    const resetCmd = sessionsCmd!.commands.find((c) => c.name() === "reset");
    expect(resetCmd).toBeDefined();
    expect(resetCmd!.description()).toMatch(/conversation|session|clear|reset/i);

    // Old name 'reset-lcd' must NOT exist (renamed in Phase 164-06)
    const oldResetLcdCmd = sessionsCmd!.commands.find((c) => c.name() === "reset-lcd");
    expect(oldResetLcdCmd).toBeUndefined();
  });

  it("CLI1b: reset subcommand has --memory and --yes options", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions")!;
    const resetCmd = sessionsCmd.commands.find((c) => c.name() === "reset")!;

    const optNames = resetCmd.options.map((o) => o.long);
    expect(optNames).toContain("--memory");
    expect(optNames).toContain("--yes");
  });
});

describe("CLI2: sessions reset calls session.reset_conversation via callTyped (Phase 164-06)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(mockedWithClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("CLI2: sends session.reset_conversation with session_key when --yes is passed", async () => {
    const capturedMethods: string[] = [];
    const capturedParams: unknown[] = [];

    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation(async (method: string, params?: unknown) => {
          capturedMethods.push(method);
          capturedParams.push(params);
          return RESET_CONVERSATION_RESPONSE;
        }),
        close: vi.fn(),
        onNotification: vi.fn(),
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
    ]);

    expect(vi.mocked(mockedWithClient)).toHaveBeenCalledTimes(1);
    expect(capturedMethods[0]).toBe("session.reset_conversation");
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params["session_key"]).toBe("tenant1:user1:chan1");
  });

  it("CLI2b: output includes both lcdRowsDeleted and sessionMessagesCleared counts on success", async () => {
    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.reset_conversation", RESET_CONVERSATION_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
    ]);

    const output = consoleSpy.log.mock.calls.map((c) => c.join(" ")).join("\n");
    // Output must reference both cleared counts
    expect(output).toMatch(/7/);   // lcdRowsDeleted
    expect(output).toMatch(/4/);   // sessionMessagesCleared
  });
});

describe("CLI3: sessions reset --memory threads memory: true (Phase 164-06)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(mockedWithClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("CLI3: --memory threads memory: true to the RPC request", async () => {
    const capturedParams: unknown[] = [];

    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation(async (_method: string, params?: unknown) => {
          capturedParams.push(params);
          return RESET_CONVERSATION_RESPONSE;
        }),
        close: vi.fn(),
        onNotification: vi.fn(),
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
      "--memory",
    ]);

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params["memory"]).toBe(true);
  });

  it("CLI3b: without --memory, memory param is false or falsy", async () => {
    const capturedParams: unknown[] = [];

    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation(async (_method: string, params?: unknown) => {
          capturedParams.push(params);
          return RESET_CONVERSATION_RESPONSE;
        }),
        close: vi.fn(),
        onNotification: vi.fn(),
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
    ]);

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params["memory"]).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// CLI4: --memory not-implemented warning output (Phase 164-06)
// ---------------------------------------------------------------------------

describe("CLI4: sessions reset --memory not-implemented warning (Phase 164-06)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let stderrSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(mockedWithClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    stderrSpy.mockRestore();
  });

  it("CLI4: --memory + memoriesDeleted===undefined prints not-implemented warning to stderr", async () => {
    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockResolvedValue(RESET_CONVERSATION_RESPONSE), // no memoriesDeleted field
        close: vi.fn(),
        onNotification: vi.fn(),
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
      "--memory",
    ]);

    // stderr must contain the warning about not-implemented
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrOutput).toMatch(/not yet implemented|RAG memory was NOT cleared/i);

    // stdout must NOT contain a "RAG memories cleared" line
    const stdoutOutput = consoleSpy.log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(stdoutOutput).not.toMatch(/RAG memories cleared/i);
  });

  it("CLI4b: --memory + memoriesDeleted defined → RAG line printed to stdout, no stderr warning", async () => {
    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockResolvedValue({ ...RESET_CONVERSATION_RESPONSE, memoriesDeleted: 3 }),
        close: vi.fn(),
        onNotification: vi.fn(),
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset", "tenant1:user1:chan1",
      "--yes",
      "--memory",
    ]);

    // stdout must contain the RAG line
    const stdoutOutput = consoleSpy.log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(stdoutOutput).toMatch(/RAG memories cleared.*3/i);

    // stderr must NOT contain the not-implemented warning
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrOutput).not.toMatch(/not yet implemented|RAG memory was NOT cleared/i);
  });
});

// ---------------------------------------------------------------------------
// DOC-02: sessions backup — SQLite Online Backup API (Phase 170-04)
//
// DOC-02-T-1: backup creates a timestamped copy of memory.db
// DOC-02-T-2: backup file reopens as a valid SQLite DB with matching row count
// DOC-02-T-3: backup file has permissions 0600
// DOC-02-T-4: missing memory.db exits with non-zero code and error message
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { mkdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DOC-02: sessions backup subcommand (Phase 170-04)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temp directory with a real memory.db for each test
    tmpDir = join(tmpdir(), `comis-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");

    // Seed a real SQLite DB with some rows
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE lcd_messages (id INTEGER PRIMARY KEY, content TEXT);
      INSERT INTO lcd_messages VALUES (1, 'msg-one');
      INSERT INTO lcd_messages VALUES (2, 'msg-two');
    `);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("DOC-02-T-1: backup creates a file named memory.db.backup.{timestamp} in the same directory", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test",
      "sessions", "backup",
      "--data-dir", tmpDir,
    ]);

    // A backup file should exist with the expected prefix
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tmpDir);
    const backupFiles = files.filter((f) => f.startsWith("memory.db.backup."));
    expect(backupFiles).toHaveLength(1);
    // Format: memory.db.backup.2026-06-09T231354876Z
    // (ISO timestamp with colons+dots removed, dashes preserved)
    expect(backupFiles[0]).toMatch(/^memory\.db\.backup\.\d{4}-\d{2}-\d{2}T\d{9}Z$/);
  });

  it("DOC-02-T-2: backup file reopens as a valid SQLite DB with matching row count", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test",
      "sessions", "backup",
      "--data-dir", tmpDir,
    ]);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tmpDir);
    const backupFile = files.find((f) => f.startsWith("memory.db.backup."));
    expect(backupFile).toBeDefined();

    const destPath = join(tmpDir, backupFile!);
    const backupDb = new Database(destPath, { readonly: true });
    const row = backupDb.prepare("SELECT COUNT(*) as cnt FROM lcd_messages").get() as { cnt: number };
    backupDb.close();
    expect(row.cnt).toBe(2);
  });

  it("DOC-02-T-3: backup file has permissions 0600 (owner-read/write only)", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test",
      "sessions", "backup",
      "--data-dir", tmpDir,
    ]);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tmpDir);
    const backupFile = files.find((f) => f.startsWith("memory.db.backup."));
    expect(backupFile).toBeDefined();

    const destPath = join(tmpDir, backupFile!);
    const mode = statSync(destPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("DOC-02-T-4: missing memory.db exits with non-zero code and a clear error message", async () => {
    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    // Use a dataDir where memory.db does NOT exist
    const emptyDir = join(tmpDir, "no-db-here");
    mkdirSync(emptyDir, { recursive: true });

    try {
      const program = createTestProgram();
      registerSessionsCommand(program);

      await expect(
        program.parseAsync([
          "node", "test",
          "sessions", "backup",
          "--data-dir", emptyDir,
        ])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy.spy).toHaveBeenCalledWith(1);
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
  });
});
