// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for config validation command.
 *
 * Verifies command registration, subcommand structure, and config validation
 * behavior including valid defaults and error reporting.
 */

import { Command } from "commander";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerConfigCommand } from "./config.js";

describe("registerConfigCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
  });

  it("registers the config command group", () => {
    const configCmd = program.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();
    expect(configCmd!.description()).toBe("Configuration management");
  });

  it("registers validate subcommand", () => {
    const configCmd = program.commands.find((c) => c.name() === "config");
    const validateCmd = configCmd!.commands.find((c) => c.name() === "validate");
    expect(validateCmd).toBeDefined();
    expect(validateCmd!.description()).toBe("Validate configuration files");
  });

  it("validate subcommand has --config option", () => {
    const configCmd = program.commands.find((c) => c.name() === "config");
    const validateCmd = configCmd!.commands.find((c) => c.name() === "validate");
    const configOpt = validateCmd!.options.find((o) => o.long === "--config");
    expect(configOpt).toBeDefined();
  });
});

describe("config validate execution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "comis-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates empty config file (defaults apply)", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "");

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      // Should succeed -- empty config is valid (defaults apply)
      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toContain("valid");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("validates valid YAML config", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      `logLevel: debug
tenantId: test-tenant
`,
    );

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toContain("valid");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports errors for invalid config", async () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logLevel: "invalid-level",
      }),
    );

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      // Should not reach here
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      // Expected: process.exit called for invalid config
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("validation failed");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("handles missing config files gracefully", async () => {
    const missingPath = path.join(tmpDir, "nonexistent.yaml");

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", missingPath]);
      // Missing file is skipped, defaults validate
      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toContain("not found");
      expect(allOutput).toContain("valid");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("reports Zod errors with path info", async () => {
    const configPath = path.join(tmpDir, "config.json");
    // Use unknown key to trigger strict mode error
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        unknownTopLevelKey: "should fail",
      }),
    );

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      expect.unreachable("Should have called process.exit");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("validation failed");
      // Should mention the unrecognized key
      expect(errOutput).toContain("unknownTopLevelKey");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
