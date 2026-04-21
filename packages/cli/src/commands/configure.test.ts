// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the configure CLI command registration.
 *
 * Verifies that the configure command is registered with the expected
 * options: --config and --section.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerConfigureCommand } from "./configure.js";

describe("registerConfigureCommand", () => {
  it("registers the configure command with --config and --section options", () => {
    const program = new Command();
    registerConfigureCommand(program);

    const configureCmd = program.commands.find((c) => c.name() === "configure");
    expect(configureCmd).toBeDefined();
    expect(configureCmd!.description()).toBe(
      "Interactively manage configuration",
    );

    const optionNames = configureCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--section");
  });
});
