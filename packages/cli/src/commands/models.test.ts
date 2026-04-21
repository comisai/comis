// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the models CLI command registration.
 *
 * Verifies that the models command is registered with list and set
 * subcommands, each having the expected options and arguments.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerModelsCommand } from "./models.js";

describe("registerModelsCommand", () => {
  it("registers the models command with list and set subcommands", () => {
    const program = new Command();
    registerModelsCommand(program);

    const modelsCmd = program.commands.find((c) => c.name() === "models");
    expect(modelsCmd).toBeDefined();
    expect(modelsCmd!.description()).toBe("Model management");

    const subcommandNames = modelsCmd!.commands.map((c) => c.name());
    expect(subcommandNames).toContain("list");
    expect(subcommandNames).toContain("set");
  });

  it("list subcommand has --provider and --format options", () => {
    const program = new Command();
    registerModelsCommand(program);

    const modelsCmd = program.commands.find((c) => c.name() === "models");
    const listCmd = modelsCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();

    const optionNames = listCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--provider");
    expect(optionNames).toContain("--format");
  });

  it("set subcommand has agent and model arguments", () => {
    const program = new Command();
    registerModelsCommand(program);

    const modelsCmd = program.commands.find((c) => c.name() === "models");
    const setCmd = modelsCmd!.commands.find((c) => c.name() === "set");
    expect(setCmd).toBeDefined();

    // Commander stores arguments as _args with required flag
    const argNames = setCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("agent");
    expect(argNames).toContain("model");

    const optionNames = setCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--config");
  });
});
