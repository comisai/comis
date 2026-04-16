/**
 * Tests for security CLI commands.
 *
 * Verifies command registration, subcommand structure, and options.
 */

import { Command } from "commander";
import { describe, it, expect, beforeEach } from "vitest";
import { registerSecurityCommand } from "./security.js";

describe("registerSecurityCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerSecurityCommand(program);
  });

  it("registers the security command group", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    expect(securityCmd).toBeDefined();
    expect(securityCmd!.description()).toBe("Security audit and remediation tools");
  });

  it("registers audit subcommand", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    const auditCmd = securityCmd!.commands.find((c) => c.name() === "audit");
    expect(auditCmd).toBeDefined();
    expect(auditCmd!.description()).toBe("Run security audit checks");
  });

  it("registers fix subcommand", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    const fixCmd = securityCmd!.commands.find((c) => c.name() === "fix");
    expect(fixCmd).toBeDefined();
    expect(fixCmd!.description()).toBe("Auto-remediate security findings (dry-run by default)");
  });

  it("audit subcommand has --config, --format, --severity options", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    const auditCmd = securityCmd!.commands.find((c) => c.name() === "audit");
    const opts = auditCmd!.options;

    const configOpt = opts.find((o) => o.long === "--config");
    expect(configOpt).toBeDefined();

    const formatOpt = opts.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();

    const severityOpt = opts.find((o) => o.long === "--severity");
    expect(severityOpt).toBeDefined();
  });

  it("has both audit and fix subcommands under security", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    const subcommands = securityCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual(["audit", "fix"]);
  });

  it("shows help text for security command", () => {
    const securityCmd = program.commands.find((c) => c.name() === "security");
    const helpText = securityCmd!.helpInformation();
    expect(helpText).toContain("security");
    expect(helpText).toContain("audit");
    expect(helpText).toContain("fix");
  });
});
