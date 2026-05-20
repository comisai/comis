// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the sessions CLI command registration AND the
 * `comis sessions report show` rendering path.
 *
 * Two test blocks below:
 *
 *   - `registerSessionsCommand` / `formatRelativeTime` — verify the
 *     subcommand wiring (list / inspect / delete / report show / list).
 *
 *   - `renderSystemPromptReport — Tools/Skills lines never render
 *     'undefined entries'` — OBS-REVIEW-02 fix coverage. Any non-array
 *     `entries` value must render an honest `?` instead of the
 *     misleading literal `undefined`.
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import {
  registerSessionsCommand,
  formatRelativeTime,
  renderSystemPromptReport,
} from "./sessions.js";

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
// OBS-REVIEW-02: `comis sessions report show` Tools/Skills lines must
// never render the literal "undefined entries". The old code used a
// truthy-check (`tools?.entries`) that fired for any non-null shape,
// then evaluated `.length` which is `undefined` for non-array values.
// The fix uses `Array.isArray(...)`. Defensive-shape: when entries is
// truthy but not an array, surface a literal `?` rather than crash or
// render `undefined`.
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
