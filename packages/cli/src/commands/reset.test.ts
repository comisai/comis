/**
 * Tests for the reset CLI command registration.
 *
 * Verifies that the reset command is registered with the expected
 * target argument and --yes, --config options.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerResetCommand } from "./reset.js";

describe("registerResetCommand", () => {
  it("registers the reset command with target argument", () => {
    const program = new Command();
    registerResetCommand(program);

    const resetCmd = program.commands.find((c) => c.name() === "reset");
    expect(resetCmd).toBeDefined();
    expect(resetCmd!.description()).toBe("Reset sessions, config, or workspace");

    // Should have <target> argument
    const argNames = resetCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("target");
  });

  it("has --yes and --config options", () => {
    const program = new Command();
    registerResetCommand(program);

    const resetCmd = program.commands.find((c) => c.name() === "reset");
    expect(resetCmd).toBeDefined();

    const optionNames = resetCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--yes");
    expect(optionNames).toContain("--config");
  });
});
