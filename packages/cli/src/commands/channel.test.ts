/**
 * Tests for channel status command.
 *
 * Verifies command registration, subcommand structure, options,
 * and error handling for the channel command group.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerChannelCommand } from "./channel.js";

describe("registerChannelCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerChannelCommand(program);
  });

  it("registers the channel command group", () => {
    const channelCmd = program.commands.find((c) => c.name() === "channel");
    expect(channelCmd).toBeDefined();
    expect(channelCmd!.description()).toBe("Channel management");
  });

  it("registers status subcommand", () => {
    const channelCmd = program.commands.find((c) => c.name() === "channel");
    const statusCmd = channelCmd!.commands.find((c) => c.name() === "status");
    expect(statusCmd).toBeDefined();
    expect(statusCmd!.description()).toBe("Display channel connection status");
  });

  it("status subcommand has --format option", () => {
    const channelCmd = program.commands.find((c) => c.name() === "channel");
    const statusCmd = channelCmd!.commands.find((c) => c.name() === "status");
    const formatOpt = statusCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("shows help text for channel command", () => {
    const channelCmd = program.commands.find((c) => c.name() === "channel");
    const helpText = channelCmd!.helpInformation();
    expect(helpText).toContain("channel");
    expect(helpText).toContain("status");
  });
});

describe("channel status error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerChannelCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "channel", "status"]);
    } catch (e) {
      // Expected: daemon not running causes process.exit
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to get channel status");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
