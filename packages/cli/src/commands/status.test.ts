// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the status CLI command registration.
 *
 * Verifies that the status command is registered with the expected
 * option: --format.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "./status.js";

describe("registerStatusCommand", () => {
  it("registers the status command with --format option", () => {
    const program = new Command();
    registerStatusCommand(program);

    const statusCmd = program.commands.find((c) => c.name() === "status");
    expect(statusCmd).toBeDefined();
    expect(statusCmd!.description()).toBe(
      "Display system status overview",
    );

    const optionNames = statusCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--format");
  });
});
