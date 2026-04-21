// SPDX-License-Identifier: Apache-2.0
/**
 * Agent command behavior tests.
 *
 * Tests agent command behaviors: list/create/configure/delete including RPC
 * payloads, output formatting, confirmation guards, and error handling.
 * Uses mocked RPC layer.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient from rpc-client at module level for ESM hoisting
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/agent for ensureWorkspace/resolveWorkspaceDir used in create
vi.mock("@comis/agent", () => ({
  ensureWorkspace: vi.fn(async () => ({ dir: "/tmp/test", configFile: "", memoryDir: "" })),
  resolveWorkspaceDir: vi.fn((_config: unknown, name: string) => `/tmp/test-workspace/${name}`),
}));

// Dynamic imports after mocks
const { registerAgentCommand } = await import("./agent.js");
const { withClient } = await import("../client/rpc-client.js");
const { ensureWorkspace, resolveWorkspaceDir } = await import("@comis/agent");

/**
 * Agent data matching what config.get returns for the agents section.
 */
const AGENTS_DATA = {
  agents: {
    assistant: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5-20250929",
      bindings: ["channel:discord-main"],
    },
    moderator: {
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    },
  },
};

describe("agent list table output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Mock withClient: agent list calls withClient(async (client) => { ... })
    // Inside, it calls config.get for "agents" then "routing" and merges results.
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", AGENTS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders agents in table format with name, provider, model, bindings columns", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list"]);

    const output = getSpyOutput(consoleSpy.log);
    // Table should contain agent data
    expect(output).toContain("assistant");
    expect(output).toContain("anthropic");
    expect(output).toContain("claude-sonnet-4-5-20250929");
    expect(output).toContain("moderator");
    expect(output).toContain("openai");
    expect(output).toContain("gpt-4o");

    // Table should contain column headers
    expect(output).toContain("Name");
    expect(output).toContain("Provider");
    expect(output).toContain("Model");
    expect(output).toContain("Bindings");
  });
});

describe("agent list JSON output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", AGENTS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON array when --format json is used", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ name: string; provider: string; model: string }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.name).toBe("assistant");
    expect(parsed[0]!.provider).toBe("anthropic");
    expect(parsed[0]!.model).toBe("claude-sonnet-4-5-20250929");
    expect(parsed[1]!.name).toBe("moderator");
    expect(parsed[1]!.provider).toBe("openai");
    expect(parsed[1]!.model).toBe("gpt-4o");
  });
});

describe("agent list empty", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", { agents: {} })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows info message when no agents configured", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No agents configured");
  });
});

describe("agent create sends correct RPC", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends agents.create RPC with agentId and config containing provider and model", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync([
      "node", "test", "agent", "create", "my-agent",
      "--provider", "anthropic",
      "--model", "claude-sonnet-4-5-20250929",
    ]);

    expect(callSpy).toHaveBeenCalledWith("agents.create", {
      agentId: "my-agent",
      config: {
        name: "my-agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
      },
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("my-agent");
    expect(output).toContain("created");
  });
});

describe("agent create initializes workspace", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(ensureWorkspace).mockReset();
    vi.mocked(resolveWorkspaceDir).mockReset();
    vi.mocked(ensureWorkspace).mockResolvedValue({ dir: "/tmp/test", configFile: "", memoryDir: "" } as never);
    vi.mocked(resolveWorkspaceDir).mockReturnValue("/tmp/test-workspace/basic-agent");
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls ensureWorkspace and resolveWorkspaceDir to initialize agent workspace", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "create", "basic-agent"]);

    // agents.create config should only have name (no provider/model since not specified)
    expect(callSpy).toHaveBeenCalledWith("agents.create", {
      agentId: "basic-agent",
      config: { name: "basic-agent" },
    });

    expect(vi.mocked(resolveWorkspaceDir)).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: undefined }),
      "basic-agent",
    );
    expect(vi.mocked(ensureWorkspace)).toHaveBeenCalled();
  });
});

describe("agent configure sends only specified fields", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends only provider when only --provider specified", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "configure", "my-agent", "--provider", "openai"]);

    expect(callSpy).toHaveBeenCalledWith("agents.update", {
      agentId: "my-agent",
      config: { provider: "openai" },
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("my-agent");
    expect(output).toContain("updated");
  });

  it("sends only defaultModel when only --model specified", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "configure", "my-agent", "--model", "gpt-4o"]);

    expect(callSpy).toHaveBeenCalledWith("agents.update", {
      agentId: "my-agent",
      config: { model: "gpt-4o" },
    });
  });

  it("sends both fields when both --provider and --model specified", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync([
      "node", "test", "agent", "configure", "my-agent",
      "--provider", "openai",
      "--model", "gpt-4o",
    ]);

    expect(callSpy).toHaveBeenCalledWith("agents.update", {
      agentId: "my-agent",
      config: { provider: "openai", model: "gpt-4o" },
    });
  });
});

describe("agent configure no options warning", () => {
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

  it("warns and returns early when no options specified", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "configure", "my-agent"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No settings specified");

    // withClient should NOT have been called (returns early before RPC)
    expect(vi.mocked(withClient)).not.toHaveBeenCalled();
  });
});

describe("agent delete with --yes calls agents.delete", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends agents.delete when --yes flag provided", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "delete", "test-agent", "--yes"]);

    expect(callSpy).toHaveBeenCalledWith("agents.delete", {
      agentId: "test-agent",
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("test-agent");
    expect(output).toContain("deleted");
  });
});

describe("agent delete without --yes in non-TTY", () => {
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

  it("exits with code 1 and confirmation-required error in non-TTY", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    // In test env, process.stdin.isTTY is undefined (falsy) so delete without --yes should exit
    try {
      await program.parseAsync(["node", "test", "agent", "delete", "test-agent"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Confirmation required");
  });
});

describe("agent commands handle daemon-offline", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Mock withClient to reject with daemon offline error
    vi.mocked(withClient).mockRejectedValue(
      new Error("Daemon not running. Start with: comis daemon start"),
    );
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("agent list exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    try {
      await program.parseAsync(["node", "test", "agent", "list"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to list agents");
  });

  it("agent create exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    try {
      await program.parseAsync(["node", "test", "agent", "create", "test-agent"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to create agent");
  });

  it("agent delete --yes exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    try {
      await program.parseAsync(["node", "test", "agent", "delete", "test-agent", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to delete agent");
  });
});

describe("extractAgents field normalization", () => {
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

  it("normalizes both provider/defaultProvider and model/defaultModel field names", async () => {
    // Use provider/model (not defaultProvider/defaultModel) to test normalization
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", {
          agents: {
            "alt-agent": {
              provider: "google",
              model: "gemini-pro",
            },
          },
        })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);

    await program.parseAsync(["node", "test", "agent", "list", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ name: string; provider: string; model: string }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("alt-agent");
    expect(parsed[0]!.provider).toBe("google");
    expect(parsed[0]!.model).toBe("gemini-pro");
  });
});
