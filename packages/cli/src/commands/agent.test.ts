// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for agent management commands.
 *
 * Verifies command registration, subcommand structure, options,
 * and error handling for the agent command group.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAgentCommand } from "./agent.js";

describe("registerAgentCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAgentCommand(program);
  });

  it("registers the agent command group", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    expect(agentCmd).toBeDefined();
    expect(agentCmd!.description()).toBe("Agent management");
  });

  it("registers list subcommand with --format option", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const listCmd = agentCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();
    expect(listCmd!.description()).toBe("List all configured agents");

    const formatOpt = listCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers create subcommand with name argument and options", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const createCmd = agentCmd!.commands.find((c) => c.name() === "create");
    expect(createCmd).toBeDefined();
    expect(createCmd!.description()).toBe("Create a new agent configuration");

    const providerOpt = createCmd!.options.find((o) => o.long === "--provider");
    expect(providerOpt).toBeDefined();
    const modelOpt = createCmd!.options.find((o) => o.long === "--model");
    expect(modelOpt).toBeDefined();
  });

  it("registers configure subcommand with name argument", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const configureCmd = agentCmd!.commands.find((c) => c.name() === "configure");
    expect(configureCmd).toBeDefined();
    expect(configureCmd!.description()).toBe("Update an existing agent's settings");
  });

  it("registers delete subcommand with --yes option", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const deleteCmd = agentCmd!.commands.find((c) => c.name() === "delete");
    expect(deleteCmd).toBeDefined();
    expect(deleteCmd!.description()).toBe("Delete an agent configuration");

    const yesOpt = deleteCmd!.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
  });

  it("has all five subcommands under agent", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const subcommands = agentCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual(["configure", "create", "delete", "list", "models"]);
  });

  it("shows help text for agent command", () => {
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    const helpText = agentCmd!.helpInformation();
    expect(helpText).toContain("agent");
    expect(helpText).toContain("list");
    expect(helpText).toContain("create");
    expect(helpText).toContain("configure");
    expect(helpText).toContain("delete");
  });
});

describe("agent list error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "list"]);
    } catch (e) {
      // Expected: daemon not running causes process.exit
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to list agents");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("agent configure validation", () => {
  it("warns when no options are specified", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "configure", "my-agent"]);
      // Should reach here without process.exit (it's just a warning)
      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toContain("No settings specified");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("agent delete confirmation", () => {
  it("requires --yes flag in non-TTY mode", async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentCommand(program);

    // Simulate non-TTY (stdin.isTTY is undefined in test environment)
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "agent", "delete", "test-agent"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Confirmation required");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
