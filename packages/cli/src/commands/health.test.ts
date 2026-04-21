// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the health CLI command registration.
 *
 * Verifies that the health command is registered with the expected
 * options: --config, --format, and --all.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerHealthCommand } from "./health.js";

describe("registerHealthCommand", () => {
  it("registers the health command with --config, --format, and --all options", () => {
    const program = new Command();
    registerHealthCommand(program);

    const healthCmd = program.commands.find((c) => c.name() === "health");
    expect(healthCmd).toBeDefined();
    expect(healthCmd!.description()).toBe("Show system health issues");

    const optionNames = healthCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--format");
    expect(optionNames).toContain("--all");
  });
});
