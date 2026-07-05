// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the support-bundle CLI command registration.
 *
 * Verifies that the command is registered with the documented options
 * (--since, --format, --config, --session, --deep) and their defaults.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerSupportBundleCommand } from "./support-bundle.js";

describe("registerSupportBundleCommand", () => {
  it("registers the support-bundle command with --since, --format, --config, --session, --deep options", () => {
    const program = new Command();
    registerSupportBundleCommand(program);

    const cmd = program.commands.find((c) => c.name() === "support-bundle");
    expect(cmd).toBeDefined();

    const optionNames = cmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--since");
    expect(optionNames).toContain("--format");
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--session");
    expect(optionNames).toContain("--deep");

    // --since mirrors `comis fleet`: a 24-hour window by default.
    const since = cmd!.options.find((o) => o.long === "--since");
    expect(since!.defaultValue).toBe("24");

    // Human-readable table is the default surface; json is opt-in.
    const format = cmd!.options.find((o) => o.long === "--format");
    expect(format!.defaultValue).toBe("table");

    // -c is the short alias for --config.
    const config = cmd!.options.find((o) => o.long === "--config");
    expect(config!.short).toBe("-c");
  });
});
