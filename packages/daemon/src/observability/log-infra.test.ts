/**
 * Tests for logging infrastructure: log level manager and log transport.
 */

import { createLogger, type ComisLogger } from "@comis/infra";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLogLevelManager, expandTilde, createFileTransport, isPm2Managed } from "./log-infra.js";
import os from "node:os";
import type { LoggingConfig } from "@comis/core";

// ===========================================================================
// Log Level Manager tests
// ===========================================================================

function createTestLogger(level = "info"): ComisLogger {
  return createLogger({ name: "test-levels", level });
}

describe("createLogLevelManager", () => {
  it('getLogger("agent") returns a child logger with {module: "agent"} binding', () => {
    const root = createTestLogger();
    const manager = createLogLevelManager(root);

    const agentLogger = manager.getLogger("agent");

    expect(agentLogger).toBeDefined();
    expect(typeof agentLogger.info).toBe("function");
    // Pino child loggers have bindings that include the module field
    // We verify by checking that it's not the same object as root
    expect(agentLogger).not.toBe(root);
  });

  it('getLogger("agent") called twice returns the same cached instance', () => {
    const root = createTestLogger();
    const manager = createLogLevelManager(root);

    const first = manager.getLogger("agent");
    const second = manager.getLogger("agent");

    expect(first).toBe(second);
  });

  it("different modules return different logger instances", () => {
    const root = createTestLogger();
    const manager = createLogLevelManager(root);

    const agent = manager.getLogger("agent");
    const memory = manager.getLogger("memory");

    expect(agent).not.toBe(memory);
  });

  it('setLevel("agent", "debug") changes that logger\'s level', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    const agentLogger = manager.getLogger("agent");
    expect(agentLogger.level).toBe("info"); // inherits from root

    manager.setLevel("agent", "debug");
    expect(agentLogger.level).toBe("debug");
  });

  it('setGlobalLevel("warn") changes root logger level', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    expect(root.level).toBe("info");

    manager.setGlobalLevel("warn");
    expect(root.level).toBe("warn");
  });

  it("setLevel for non-existent module does nothing (no error)", () => {
    const root = createTestLogger();
    const manager = createLogLevelManager(root);

    // Should not throw
    expect(() => manager.setLevel("nonexistent", "debug")).not.toThrow();
  });

  it('setLevel silently rejects invalid level "verbose"', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    const agentLogger = manager.getLogger("agent");
    expect(agentLogger.level).toBe("info");

    manager.setLevel("agent", "verbose");
    // Level should remain unchanged -- "verbose" is not a valid level
    expect(agentLogger.level).toBe("info");
  });

  it('setLevel silently rejects arbitrary invalid level', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    const agentLogger = manager.getLogger("agent");
    manager.setLevel("agent", "notALevel");
    expect(agentLogger.level).toBe("info");
  });

  it('setGlobalLevel silently rejects invalid level "notALevel"', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    manager.setGlobalLevel("notALevel");
    // Root level should remain unchanged
    expect(root.level).toBe("info");
  });

  it('setGlobalLevel accepts valid level "debug"', () => {
    const root = createTestLogger("info");
    const manager = createLogLevelManager(root);

    manager.setGlobalLevel("debug");
    expect(root.level).toBe("debug");
  });
});

// ===========================================================================
// Log Transport tests
// ===========================================================================

describe("expandTilde", () => {
  it("replaces leading ~ with homedir", () => {
    const result = expandTilde("~/.comis/logs/daemon.log");
    expect(result).toBe(`${os.homedir()}/.comis/logs/daemon.log`);
  });

  it("replaces bare ~ with homedir", () => {
    const result = expandTilde("~");
    expect(result).toBe(os.homedir());
  });

  it("does not replace ~ in the middle of a path", () => {
    const result = expandTilde("/home/user/~file.log");
    expect(result).toBe("/home/user/~file.log");
  });

  it("returns absolute paths unchanged", () => {
    const result = expandTilde("/var/log/daemon.log");
    expect(result).toBe("/var/log/daemon.log");
  });
});

describe("isPm2Managed", () => {
  let originalPm2Home: string | undefined;

  beforeEach(() => {
    originalPm2Home = process.env.PM2_HOME;
  });

  afterEach(() => {
    if (originalPm2Home === undefined) {
      delete process.env.PM2_HOME;
    } else {
      process.env.PM2_HOME = originalPm2Home;
    }
  });

  it("returns true when PM2_HOME is set", () => {
    process.env.PM2_HOME = "/home/user/.pm2";
    expect(isPm2Managed()).toBe(true);
  });

  it("returns false when PM2_HOME is not set", () => {
    delete process.env.PM2_HOME;
    expect(isPm2Managed()).toBe(false);
  });

  it("returns false when PM2_HOME is empty string", () => {
    process.env.PM2_HOME = "";
    expect(isPm2Managed()).toBe(false);
  });
});

describe("createFileTransport", () => {
  const defaultConfig: LoggingConfig = {
    filePath: "~/.comis/logs/daemon.log",
    maxSize: "10m",
    maxFiles: 5,
    compress: false,
  };

  let originalPm2Home: string | undefined;

  beforeEach(() => {
    originalPm2Home = process.env.PM2_HOME;
    // Default: no PM2 (direct run mode)
    delete process.env.PM2_HOME;
  });

  afterEach(() => {
    if (originalPm2Home === undefined) {
      delete process.env.PM2_HOME;
    } else {
      process.env.PM2_HOME = originalPm2Home;
    }
  });

  it("returns pino-roll and stdout when not under pm2", () => {
    const transport = createFileTransport(defaultConfig);

    expect(transport.targets).toHaveLength(2);
    expect(transport.targets[0]!.target).toBe("pino-roll");
    expect(transport.targets[1]!.target).toBe("pino/file");
  });

  it("returns only pino-roll when under pm2 (stdout skipped)", () => {
    process.env.PM2_HOME = "/home/user/.pm2";
    const transport = createFileTransport(defaultConfig);

    expect(transport.targets).toHaveLength(1);
    expect(transport.targets[0]!.target).toBe("pino-roll");
  });

  it("expands tilde in filePath for pino-roll", () => {
    const transport = createFileTransport(defaultConfig);
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;

    expect(rollOpts.file).toBe(`${os.homedir()}/.comis/logs/daemon.log`);
    expect(rollOpts.file).not.toContain("~");
  });

  it("passes maxSize as size to pino-roll", () => {
    const transport = createFileTransport({ ...defaultConfig, maxSize: "50m" });
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;

    expect(rollOpts.size).toBe("50m");
  });

  it("sets mkdir:true for auto-creating log directories", () => {
    const transport = createFileTransport(defaultConfig);
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;

    expect(rollOpts.mkdir).toBe(true);
  });

  it("sets removeOtherLogFiles:true in limit", () => {
    const transport = createFileTransport(defaultConfig);
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;
    const limit = rollOpts.limit as Record<string, unknown>;

    expect(limit.removeOtherLogFiles).toBe(true);
    expect(limit.count).toBe(5);
  });

  it("uses maxFiles as limit.count", () => {
    const transport = createFileTransport({ ...defaultConfig, maxFiles: 10 });
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;
    const limit = rollOpts.limit as Record<string, unknown>;

    expect(limit.count).toBe(10);
  });

  it("stdout target uses fd=1", () => {
    const transport = createFileTransport(defaultConfig);
    // Without PM2: stdout is the second target (index 1)
    const stdoutOpts = transport.targets[1]!.options as Record<string, unknown>;

    expect(stdoutOpts.destination).toBe(1);
  });

  it("handles absolute path without tilde", () => {
    const transport = createFileTransport({
      ...defaultConfig,
      filePath: "/var/log/comis/daemon.log",
    });
    const rollOpts = transport.targets[0]!.options as Record<string, unknown>;

    expect(rollOpts.file).toBe("/var/log/comis/daemon.log");
  });

  it("applies level to all targets when provided", () => {
    const transport = createFileTransport(defaultConfig, "debug");

    for (const target of transport.targets) {
      expect(target.level).toBe("debug");
    }
  });

  it("omits level from targets when not provided", () => {
    const transport = createFileTransport(defaultConfig);

    for (const target of transport.targets) {
      expect(target.level).toBeUndefined();
    }
  });
});
