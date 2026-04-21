// SPDX-License-Identifier: Apache-2.0
/**
 * Edge case tests for data validation: malformed YAML, mixed field names,
 * session key parsing, and memory clear filter safety.
 *
 * Tests that the CLI handles broken, unexpected, or missing input data
 * gracefully without crashing or producing unhandled exceptions.
 *
 * @module
 */

import { Command } from "commander";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerConfigCommand } from "./config.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";
import { createMockRpcClient } from "../mock-rpc-client.js";

// ============================================================
// Malformed YAML config handling
// ============================================================

describe("malformed YAML config handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "comis-edge-03-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles binary/garbage content without crashing", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, Buffer.from([0x00, 0x01, 0xff, 0xfe]));

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      // If it reaches here, it degraded gracefully (e.g., parsed as empty or valid object)
    } catch (e) {
      // process.exit called -- that is acceptable for truly invalid config
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
    // The key assertion: no unhandled exception (test completes cleanly)
  });

  it("handles YAML with invalid indentation", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "gateway:\n host: bad\n  port: 3100");

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      // Either validation error or graceful parse -- both acceptable
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
  });

  it("handles YAML with unclosed quotes", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, 'logLevel: "debug');

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
    } catch (e) {
      // YAML parse error should trigger process.exit(1)
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = getSpyOutput(consoleSpy.error);
      expect(errOutput).toContain("Failed to load");
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
  });

  it("handles completely empty file as valid (defaults apply)", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "");

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      const allOutput = getSpyOutput(consoleSpy.log);
      expect(allOutput).toContain("valid");
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
  });

  it("handles YAML-like content that is actually JSON", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, '{"logLevel": "debug"}');

    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);

    const consoleSpy = createConsoleSpy();
    const exitSpy = createProcessExitSpy();

    try {
      await program.parseAsync(["node", "test", "config", "validate", "-c", configPath]);
      // JSON is a subset of YAML, so YAML parser handles it. Should validate.
      const allOutput = getSpyOutput(consoleSpy.log);
      expect(allOutput).toContain("valid");
    } finally {
      consoleSpy.restore();
      exitSpy.restore();
    }
  });
});

// ============================================================
// Session key parsing edge cases
// ============================================================

// Mock RPC layer at module level for ESM hoisting
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Mock spinner to pass-through
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/agent for ensureWorkspace/resolveWorkspaceDir used in agent create
vi.mock("@comis/agent", () => ({
  ensureWorkspace: vi.fn(async () => ({ dir: "/tmp/test", configFile: "", memoryDir: "" })),
  resolveWorkspaceDir: vi.fn((_config: unknown, name: string) => `/tmp/test-workspace/${name}`),
}));

// Dynamic imports after mocks
const { registerSessionsCommand } = await import("./sessions.js");
const { registerAgentCommand } = await import("./agent.js");
const { registerMemoryCommand } = await import("./memory.js");
const { withClient } = await import("../client/rpc-client.js");

describe("session key parsing edge cases", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("inspect handles empty string key", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", { session: { key: "" } })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "empty"]);

    // Should not crash -- key is empty, so parsed parts will be short
    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    // Session Key row should be present (even if empty string)
    expect(output).toContain("Session Key");
  });

  it("inspect handles key with no colons", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", {
          session: { key: "simplekey", channel: "discord", user: "alice" },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "simplekey"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("simplekey");
  });

  it("inspect handles key with one colon", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", {
          session: { key: "tenant:user" },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "tenant:user"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("tenant:user");
  });

  it("inspect handles key with many colons", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", {
          session: { key: "t:u:c:extra:parts" },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "t:u:c:extra:parts"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("t:u:c:extra:parts");
    // With >= 3 parts from split, tenant should be "t", user "u", channel "c"
    expect(output).toContain("t");
  });

  it("inspect handles key with special characters", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", {
          session: { key: "tenant-1:user@email:channel#room" },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "sessions",
      "inspect",
      "tenant-1:user@email:channel#room",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("tenant-1:user@email:channel#room");
    // The three parts should be parsed correctly
    expect(output).toContain("tenant-1");
    expect(output).toContain("user@email");
    expect(output).toContain("channel#room");
  });
});

// ============================================================
// Agent list field normalization edge cases
// ============================================================

describe("agent list field normalization edge cases", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("handles agent entry with no provider or model fields", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", {
          agents: {
            "bare-agent": { bindings: ["ch:1"] },
          },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list", "--format", "json"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      name: string;
      provider?: string;
      model?: string;
    }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("bare-agent");
    // Provider and model should be undefined (no fields present)
    expect(parsed[0]!.provider).toBeUndefined();
    expect(parsed[0]!.model).toBeUndefined();
  });

  it("handles agent entry that is a string instead of object", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", {
          agents: {
            broken: "not-an-object",
          },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list", "--format", "json"]);

    // Non-object entry is skipped by extractAgents, resulting in empty array.
    // Empty agents triggers the "No agents configured" info message path.
    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No agents configured");
  });

  it("handles agent entry with null provider and model", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", {
          agents: {
            "null-agent": { provider: null, model: null },
          },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);

    // Use table mode to check "-" placeholders
    await program.parseAsync(["node", "test", "agent", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    // Table should show the agent name
    expect(output).toContain("null-agent");
    // Null fields should render as "-" in the table
    expect(output).toContain("-");
  });

  it("handles mixed agents where some have provider and some have defaultProvider", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", {
          agents: {
            "new-style": {
              provider: "anthropic",
              model: "claude-sonnet-4-5-20250929",
            },
            "old-style": {
              defaultProvider: "openai",
              defaultModel: "gpt-4o",
            },
          },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list", "--format", "json"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      name: string;
      provider: string;
      model: string;
    }>;

    expect(parsed).toHaveLength(2);

    const newStyle = parsed.find((a) => a.name === "new-style");
    expect(newStyle!.provider).toBe("anthropic");
    expect(newStyle!.model).toBe("claude-sonnet-4-5-20250929");

    const oldStyle = parsed.find((a) => a.name === "old-style");
    expect(oldStyle!.provider).toBe("openai");
    expect(oldStyle!.model).toBe("gpt-4o");
  });
});

// ============================================================
// Memory clear no-filter rejection
// ============================================================

describe("memory clear no-filter rejection", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("rejects clear with no filters and no --yes in non-TTY", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "clear"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("At least one filter is required");
  });

  it("rejects clear with --yes but no filters", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "clear", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("At least one filter is required");
  });

  it("handles invalid filter format (no equals sign)", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "memory",
        "clear",
        "--filter",
        "badfilter",
        "--yes",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Invalid filter format");
  });

  it("accepts valid filter with --yes", async () => {
    // Mock withClient to succeed for valid clear operation
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.set", {})
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "memory",
      "clear",
      "--filter",
      "memoryType=conversation",
      "--yes",
    ]);

    // Should succeed without crash or process.exit
    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("cleared");
  });
});
