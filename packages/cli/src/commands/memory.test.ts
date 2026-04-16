/**
 * Tests for memory query commands.
 *
 * Verifies command registration, subcommand structure, options,
 * and safety checks for the memory command group.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerMemoryCommand } from "./memory.js";

describe("registerMemoryCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
  });

  it("registers the memory command group", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    expect(memoryCmd).toBeDefined();
    expect(memoryCmd!.description()).toBe("Memory management");
  });

  it("registers search subcommand with options", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const searchCmd = memoryCmd!.commands.find((c) => c.name() === "search");
    expect(searchCmd).toBeDefined();
    expect(searchCmd!.description()).toBe("Search memory entries");

    const limitOpt = searchCmd!.options.find((o) => o.long === "--limit");
    expect(limitOpt).toBeDefined();
    const formatOpt = searchCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers inspect subcommand with format option", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const inspectCmd = memoryCmd!.commands.find((c) => c.name() === "inspect");
    expect(inspectCmd).toBeDefined();
    expect(inspectCmd!.description()).toBe("Display full details of a memory entry");

    const formatOpt = inspectCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers stats subcommand", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const statsCmd = memoryCmd!.commands.find((c) => c.name() === "stats");
    expect(statsCmd).toBeDefined();
    expect(statsCmd!.description()).toBe("Display memory statistics");
  });

  it("registers clear subcommand with safety options", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const clearCmd = memoryCmd!.commands.find((c) => c.name() === "clear");
    expect(clearCmd).toBeDefined();
    expect(clearCmd!.description()).toBe("Clear memory entries matching a filter");

    const filterOpt = clearCmd!.options.find((o) => o.long === "--filter");
    expect(filterOpt).toBeDefined();
    const tenantOpt = clearCmd!.options.find((o) => o.long === "--tenant");
    expect(tenantOpt).toBeDefined();
    const yesOpt = clearCmd!.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
  });

  it("has all four subcommands under memory", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const subcommands = memoryCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual(["clear", "inspect", "search", "stats"]);
  });

  it("shows help text for memory command", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const helpText = memoryCmd!.helpInformation();
    expect(helpText).toContain("memory");
    expect(helpText).toContain("search");
    expect(helpText).toContain("inspect");
    expect(helpText).toContain("stats");
    expect(helpText).toContain("clear");
  });
});

describe("memory search error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "search", "test query"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to search memory");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("memory clear safety checks", () => {
  it("requires at least one filter", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "clear", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("At least one filter is required");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("requires --yes flag in non-TTY mode", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync([
        "node",
        "test",
        "memory",
        "clear",
        "--filter",
        "memoryType=conversation",
      ]);
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

describe("memory inspect error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to inspect memory entry");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("memory stats error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "stats"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to fetch memory stats");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
