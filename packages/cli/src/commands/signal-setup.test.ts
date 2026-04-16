/**
 * Tests for the signal-setup CLI command.
 *
 * Verifies:
 * - Command registration with expected description
 * - No execSync usage (all migrated to execFileSync for command injection prevention)
 * - execFileSync is used for all external command execution
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerSignalSetupCommand } from "./signal-setup.js";

describe("registerSignalSetupCommand", () => {
  it("registers the signal-setup command", () => {
    const program = new Command();
    registerSignalSetupCommand(program);

    const signalCmd = program.commands.find((c) => c.name() === "signal-setup");
    expect(signalCmd).toBeDefined();
    expect(signalCmd!.description()).toBe(
      "Install and configure Signal CLI for the Signal channel adapter",
    );
  });
});

describe("signal-setup command injection prevention", () => {
  const source = readFileSync(new URL("./signal-setup.ts", import.meta.url), "utf-8");

  it("does not import execSync (only execFileSync)", () => {
    // execSync should not appear anywhere -- all migrated to execFileSync
    expect(source).not.toMatch(/\bexecSync\b/);
  });

  it("uses execFileSync for external command execution", () => {
    // Should have multiple execFileSync calls (download, extract, symlink, verify, etc.)
    const matches = source.match(/\bexecFileSync\b/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(5);
  });

  it("does not use shell string interpolation for commands", () => {
    // No backtick template strings passed to any exec function
    // This pattern catches: tryExec(`...${var}...`) or execSync(`...${var}...`)
    expect(source).not.toMatch(/(?:tryExec|execSync)\s*\(\s*`/);
  });
});
