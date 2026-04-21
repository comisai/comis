// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the sessions CLI command registration.
 *
 * Verifies that the sessions command is registered with list, inspect,
 * and delete subcommands, each having the expected options and arguments.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerSessionsCommand, formatRelativeTime } from "./sessions.js";

describe("registerSessionsCommand", () => {
  it("registers the sessions command with list, inspect, and delete subcommands", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    expect(sessionsCmd).toBeDefined();
    expect(sessionsCmd!.description()).toBe("Session management");

    const subcommandNames = sessionsCmd!.commands.map((c) => c.name());
    expect(subcommandNames).toContain("list");
    expect(subcommandNames).toContain("inspect");
    expect(subcommandNames).toContain("delete");
  });

  it("list subcommand has --tenant and --format options", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const listCmd = sessionsCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();

    const optionNames = listCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--tenant");
    expect(optionNames).toContain("--format");
  });

  it("delete subcommand has --yes option", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessionsCmd = program.commands.find((c) => c.name() === "sessions");
    const deleteCmd = sessionsCmd!.commands.find((c) => c.name() === "delete");
    expect(deleteCmd).toBeDefined();

    const optionNames = deleteCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--yes");

    // Should have <key> argument
    const argNames = deleteCmd!.registeredArguments.map((a) => a.name());
    expect(argNames).toContain("key");
  });
});

describe("formatRelativeTime", () => {
  it("returns seconds for very recent timestamps", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 30_000);
    expect(result).toBe("30s ago");
  });

  it("returns minutes for timestamps within an hour", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 5 * 60 * 1000);
    expect(result).toBe("5m ago");
  });

  it("returns hours for timestamps within a day", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 2 * 60 * 60 * 1000);
    expect(result).toBe("2h ago");
  });

  it("returns days for timestamps within a month", () => {
    const now = Date.now();
    const result = formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000);
    expect(result).toBe("3d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    const result = formatRelativeTime(Date.now() + 10_000);
    expect(result).toBe("just now");
  });
});
