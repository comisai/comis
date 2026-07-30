// SPDX-License-Identifier: Apache-2.0
/**
 * Edge case tests for data validation: malformed YAML, mixed field names,
 * session key parsing, and memory clear scope safety.
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

// Mock RPC layer at module level for ESM hoisting.
// Use importOriginal-based mock so callTyped resolves to the real wrapper
// while withClient is mocked.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock spinner to pass-through
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/core for ensureWorkspace/resolveWorkspaceDir used in agent create.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    ensureWorkspace: vi.fn(async () => ({ dir: "/tmp/test", configFile: "", memoryDir: "" })),
    resolveWorkspaceDir: vi.fn((_config: unknown, name: string) => `/tmp/test-workspace/${name}`),
  };
});

// Dynamic imports after mocks
const { registerSessionsCommand } = await import("./sessions.js");
const { registerAgentCommand } = await import("./agent.js");
const { registerMemoryCommand } = await import("./memory.js");
const { withClient } = await import("../client/rpc-client.js");

describe("conversation ref rendering edge cases", () => {
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

  // `sessions inspect` takes an OPAQUE conversation ref plus explicit tenant and
  // agent authority; it does not split the argument into tenant/user/channel
  // parts. These cover an awkwardly-shaped ref reaching the renderer intact.
  const historyResponse = (key: string) => ({
    session: {
      key,
      agentId: "default",
      channelType: "telegram",
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      compactions: 0,
      resetCount: 0,
      createdAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_000_000,
    },
    messages: [],
    total: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
  });

  async function inspectRef(ref: string, key = ref): Promise<void> {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient().onCall("session.history", historyResponse(key)).build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "inspect", ref, "--tenant", "t1", "--agent", "a1",
    ]);
  }

  it("renders a single-token ref without a channel separator", async () => {
    await inspectRef("simplekey");

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain("simplekey");
  });

  it("renders the session key row even when the store returns an empty key", async () => {
    await inspectRef("conv-empty", "");

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain("Session Key");
  });

  it("echoes a colon-bearing ref verbatim rather than splitting it into parts", async () => {
    await inspectRef("t:u:c:extra:parts");

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain("t:u:c:extra:parts");
  });

  it("echoes a ref carrying email and fragment characters verbatim", async () => {
    await inspectRef("tenant-1:user@email:channel#room");

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain("tenant-1:user@email:channel#room");
  });

  it("sends the ref and the tenant and agent authority through to session.history", async () => {
    const seen: unknown[] = [];
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient().onCall("session.history", historyResponse("k")).build();
      const inner = mockClient.call.bind(mockClient);
      mockClient.call = async (method: string, params?: unknown) => {
        if (method === "session.history") seen.push(params);
        return inner(method, params as never);
      };
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync([
      "node", "test", "sessions", "inspect", "conv-ref-1", "--tenant", "t1", "--agent", "a1",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ tenant_id: "t1", agent_id: "a1", conversation_ref: "conv-ref-1" });
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
        .onCall("config.read", {
          "bare-agent": { bindings: ["ch:1"] },
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
        .onCall("config.read", {
          broken: "not-an-object",
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
        .onCall("config.read", {
          "null-agent": { provider: null, model: null },
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
        .onCall("config.read", {
          "new-style": {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
          },
          "old-style": {
            defaultProvider: "openai",
            defaultModel: "gpt-4o",
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
// Memory clear no-scope rejection
// ============================================================

describe("memory clear no-scope rejection", () => {
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

  it("rejects clear without explicit authority before confirmation", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await expect(
      program.parseAsync(["node", "test", "memory", "clear"]),
    ).rejects.toThrow("required option '--tenant <tenantId>' not specified");
  });

  it("rejects clear with --yes but no authority", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await expect(
      program.parseAsync(["node", "test", "memory", "clear", "--yes"]),
    ).rejects.toThrow("required option '--tenant <tenantId>' not specified");
  });

  it("rejects the unsupported filter option", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "memory",
        "clear",
        "--filter",
        "badfilter",
        "--yes",
        "--tenant",
        "test-tenant",
        "--agent",
        "test-agent",
      ]),
    ).rejects.toThrow("unknown option '--filter'");

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  it("accepts an explicit tenant-agent scope with --yes", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.flush", {
          flushed: true,
          entriesRemoved: 0,
          scope: { tenantId: "default", agentId: "default" },
        })
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
      "--tenant",
      "default",
      "--agent",
      "default",
      "--yes",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("cleared");
  });
});
