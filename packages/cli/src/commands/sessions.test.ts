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
 *     CLI2 — calls context.reset_lcd with { session_key } when --yes is passed
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
// Phase 164-03 (RR4): sessions reset-lcd subcommand wiring
//
// CLI1: subcommand is registered under `sessions`
// CLI2: sends context.reset_lcd with { session_key } when --yes is passed
// CLI3: --memory flag threads memory: true to the request
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

/** Minimal context.reset_lcd success response */
const RESET_LCD_RESPONSE = {
  sessionKey: "tenant1:user1:chan1",
  lcdRowsDeleted: 7,
  memoriesDeleted: 0,
};

describe("CLI1: sessions reset-lcd subcommand registration (Phase 164-03)", () => {
  it("CLI1: registerSessionsCommand registers sessions reset-lcd subcommand", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    expect(sessionsCmd).toBeDefined();

    const resetLcdCmd = sessionsCmd!.commands.find((c) => c.name() === "reset-lcd");
    expect(resetLcdCmd).toBeDefined();
    expect(resetLcdCmd!.description()).toContain("LCD");
  });

  it("CLI1b: reset-lcd subcommand has --memory and --yes options", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions")!;
    const resetLcdCmd = sessionsCmd.commands.find((c) => c.name() === "reset-lcd")!;

    const optNames = resetLcdCmd.options.map((o) => o.long);
    expect(optNames).toContain("--memory");
    expect(optNames).toContain("--yes");
  });
});

describe("CLI2: sessions reset-lcd calls context.reset_lcd via callTyped (Phase 164-03)", () => {
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

  it("CLI2: sends context.reset_lcd with session_key when --yes is passed", async () => {
    const capturedParams: unknown[] = [];

    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = {
        call: vi.fn().mockImplementation(async (_method: string, params?: unknown) => {
          capturedParams.push(params);
          return RESET_LCD_RESPONSE;
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
      "sessions", "reset-lcd", "tenant1:user1:chan1",
      "--yes",
    ]);

    expect(vi.mocked(mockedWithClient)).toHaveBeenCalledTimes(1);
    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params["session_key"]).toBe("tenant1:user1:chan1");
  });

  it("CLI2b: output includes lcdRowsDeleted count on success", async () => {
    vi.mocked(mockedWithClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("context.reset_lcd", RESET_LCD_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test",
      "sessions", "reset-lcd", "tenant1:user1:chan1",
      "--yes",
    ]);

    const output = consoleSpy.log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/7/);
  });
});

describe("CLI3: sessions reset-lcd --memory threads memory: true (Phase 164-03)", () => {
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
          return { ...RESET_LCD_RESPONSE, memoriesDeleted: 0 };
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
      "sessions", "reset-lcd", "tenant1:user1:chan1",
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
          return RESET_LCD_RESPONSE;
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
      "sessions", "reset-lcd", "tenant1:user1:chan1",
      "--yes",
    ]);

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params["memory"]).toBeFalsy();
  });
});
