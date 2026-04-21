// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the CLI entry point (cli.ts).
 *
 * Verifies that all 16 commands are registered on the root program,
 * program metadata is correct, and subcommand structure is intact.
 * Does NOT re-test command behavior (covered by per-command behavior tests).
 *
 * The cli.ts module calls program.parseAsync(process.argv) on import as a
 * side effect. We mock parseAsync to a no-op before importing so the test
 * focuses on wiring, not parse execution.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Command } from "commander";

// Mock parseAsync on the Command prototype BEFORE importing cli.ts
// so the auto-invocation at module level becomes a no-op.
vi.mock("commander", async (importOriginal) => {
  const mod = await importOriginal<typeof import("commander")>();
  const OriginalCommand = mod.Command;

  class MockedCommand extends OriginalCommand {
    override async parseAsync(
      _argv?: readonly string[],
      _options?: { from?: "node" | "electron" | "user" },
    ): Promise<this> {
      // No-op: prevent cli.ts from actually parsing process.argv
      return this;
    }
  }

  return { ...mod, Command: MockedCommand };
});

let program: Command;

beforeAll(async () => {
  const cli = await import("./cli.js");
  program = cli.program;
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("CLI entry point", () => {
  describe("program metadata", () => {
    it("has the correct program name", () => {
      expect(program.name()).toBe("comis");
    });

    it("has the correct description", () => {
      expect(program.description()).toContain("AI agent management CLI");
    });

    it("has a semver version", () => {
      expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("command registration", () => {
    const expectedCommands = [
      "daemon",
      "config",
      "agent",
      "channel",
      "memory",
      "security",
      "doctor",
      "init",
      "configure",
      "status",
      "health",
      "models",
      "pm2",
      "sessions",
      "reset",
      "secrets",
      "signal-setup",
      "uninstall",
    ] as const;

    it("registers exactly 18 commands", () => {
      expect(program.commands).toHaveLength(18);
    });

    it.each(expectedCommands)("registers the '%s' command", (name) => {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd).toBeDefined();
    });

    it("has no duplicate command names", () => {
      const names = program.commands.map((c) => c.name());
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });

  describe("subcommand structure", () => {
    it("daemon has start, stop, status, and logs subcommands", () => {
      const daemon = program.commands.find((c) => c.name() === "daemon");
      expect(daemon).toBeDefined();
      const subNames = daemon!.commands.map((c) => c.name()).sort();
      expect(subNames).toEqual(["logs", "start", "status", "stop"]);
    });

    it("config has at least one subcommand", () => {
      const config = program.commands.find((c) => c.name() === "config");
      expect(config).toBeDefined();
      expect(config!.commands.length).toBeGreaterThanOrEqual(1);
    });

    it("agent has at least one subcommand", () => {
      const agent = program.commands.find((c) => c.name() === "agent");
      expect(agent).toBeDefined();
      expect(agent!.commands.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("program export", () => {
    it("exports the program object", () => {
      expect(program).toBeDefined();
      expect(typeof program.name).toBe("function");
      expect(typeof program.parseAsync).toBe("function");
    });
  });
});
