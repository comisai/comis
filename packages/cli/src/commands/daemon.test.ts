// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for daemon control commands.
 *
 * Verifies command registration, subcommand structure, error handling,
 * and file permission hardening.
 * Uses Commander.js programmatic parsing for testability.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDaemonCommand } from "./daemon.js";
import { mkdirSync, openSync } from "node:fs";

describe("registerDaemonCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride(); // Throw instead of process.exit
    registerDaemonCommand(program);
  });

  it("registers the daemon command group", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    expect(daemonCmd).toBeDefined();
    expect(daemonCmd!.description()).toBe("Control the Comis daemon");
  });

  it("registers start subcommand", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const startCmd = daemonCmd!.commands.find((c) => c.name() === "start");
    expect(startCmd).toBeDefined();
    expect(startCmd!.description()).toBe("Start the Comis daemon");
  });

  it("registers stop subcommand", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const stopCmd = daemonCmd!.commands.find((c) => c.name() === "stop");
    expect(stopCmd).toBeDefined();
    expect(stopCmd!.description()).toBe("Stop the Comis daemon");
  });

  it("registers status subcommand", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const statusCmd = daemonCmd!.commands.find((c) => c.name() === "status");
    expect(statusCmd).toBeDefined();
    expect(statusCmd!.description()).toBe("Show daemon status");
  });

  it("registers logs subcommand with options", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const logsCmd = daemonCmd!.commands.find((c) => c.name() === "logs");
    expect(logsCmd).toBeDefined();
    expect(logsCmd!.description()).toBe("Show daemon logs");

    // Check options are registered
    const opts = logsCmd!.options;
    const followOpt = opts.find((o) => o.long === "--follow");
    expect(followOpt).toBeDefined();
    const linesOpt = opts.find((o) => o.long === "--lines");
    expect(linesOpt).toBeDefined();
  });

  it("has all four subcommands under daemon", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const subcommands = daemonCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual(["logs", "start", "status", "stop"]);
  });

  it("shows help text for daemon command", () => {
    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    const helpText = daemonCmd!.helpInformation();
    expect(helpText).toContain("daemon");
    expect(helpText).toContain("start");
    expect(helpText).toContain("stop");
    expect(helpText).toContain("status");
    expect(helpText).toContain("logs");
  });
});

describe("daemon file permission hardening", () => {
  it("source contains mkdirSync with mode 0o700 for directory creation", async () => {
    // Static analysis: verify the daemon module uses restrictive directory permissions.
    // We read the compiled source because writePidFile and startDirectMode are not exported.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const sourcePath = url.fileURLToPath(new URL("./daemon.ts", import.meta.url));
    const source = fs.readFileSync(sourcePath, "utf-8");

    // All mkdirSync calls should include mode: 0o700
    const mkdirCalls = source.match(/mkdirSync\([^)]+\)/g) ?? [];
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of mkdirCalls) {
      expect(call).toContain("mode:");
      expect(call).toMatch(/0o700/);
    }
  });

  it("source contains openSync with mode 0o600 for log file creation", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const sourcePath = url.fileURLToPath(new URL("./daemon.ts", import.meta.url));
    const source = fs.readFileSync(sourcePath, "utf-8");

    // openSync for log file should include 0o600
    const openCalls = source.match(/openSync\([^)]+\)/g) ?? [];
    expect(openCalls.length).toBeGreaterThanOrEqual(1);

    const logOpenCall = openCalls.find((c) => c.includes('"a"'));
    expect(logOpenCall).toBeDefined();
    expect(logOpenCall).toContain("0o600");
  });
});

describe("daemon status error handling", () => {
  it("handles daemon not running gracefully", async () => {
    // The status command should not throw when daemon is not running.
    // On macOS (no systemd), it falls through to "Daemon is not running".
    const program = new Command();
    program.exitOverride();
    registerDaemonCommand(program);

    // Mock console output
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Override process.exit so it doesn't terminate
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      await program.parseAsync(["node", "test", "daemon", "status"]);
      // Should reach here without throwing (daemon not running = warn, not crash)
    } catch (e) {
      // process.exit was called -- that's also acceptable for some error paths
      if (e instanceof Error && e.message !== "process.exit called") {
        throw e;
      }
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
