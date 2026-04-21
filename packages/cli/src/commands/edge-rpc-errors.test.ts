// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-cutting RPC failure and null/empty response edge case tests.
 *
 * Verifies every RPC-dependent command exits with code 1 and displays an
 * error message when the RPC call fails (connection refused, timeout, etc).
 * Also verifies commands handle null, undefined, and empty-object RPC
 * responses without crashing, producing graceful info messages instead.
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

// ---------------------------------------------------------------------------
// Module-level mocks (ESM hoisting)
// ---------------------------------------------------------------------------

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@comis/agent", () => ({
  ensureWorkspace: vi.fn(async () => ({ dir: "/tmp/test", configFile: "", memoryDir: "" })),
  resolveWorkspaceDir: vi.fn((_config: unknown, name: string) => `/tmp/test-workspace/${name}`),
  createModelCatalog: vi.fn(() => ({
    loadStatic: vi.fn(),
    getAll: vi.fn(() => []),
    getByProvider: vi.fn(() => []),
  })),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

// Dynamic imports after mocks
const { registerAgentCommand } = await import("./agent.js");
const { registerChannelCommand } = await import("./channel.js");
const { registerSessionsCommand } = await import("./sessions.js");
const { registerMemoryCommand } = await import("./memory.js");
const { registerModelsCommand } = await import("./models.js");
const { withClient } = await import("../client/rpc-client.js");

// ---------------------------------------------------------------------------
// RPC failure → exit code 1
// ---------------------------------------------------------------------------

describe("RPC failure exit code 1", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // All commands should fail with an RPC connection error
    vi.mocked(withClient).mockRejectedValue(new Error("RPC connection failed"));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  // -- Agent commands -------------------------------------------------------

  it("agent list exits 1 on RPC failure", async () => {
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

  it("agent create exits 1 on RPC failure", async () => {
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

  it("agent configure exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerAgentCommand(program);

    try {
      await program.parseAsync(["node", "test", "agent", "configure", "test-agent", "--provider", "openai"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to update agent");
  });

  it("agent delete --yes exits 1 on RPC failure", async () => {
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

  // -- Channel commands -----------------------------------------------------

  it("channel status exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerChannelCommand(program);

    try {
      await program.parseAsync(["node", "test", "channel", "status"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed");
  });

  // -- Session commands -----------------------------------------------------

  it("sessions list exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync(["node", "test", "sessions", "list"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to list sessions");
  });

  it("sessions inspect exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync(["node", "test", "sessions", "inspect", "test:key:1"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to inspect session");
  });

  it("sessions delete --yes exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync(["node", "test", "sessions", "delete", "some-key", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to delete session");
  });

  // -- Memory commands ------------------------------------------------------

  it("memory search exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "search", "test"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to search memory");
  });

  it("memory inspect exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to inspect memory");
  });

  it("memory stats exits 1 on RPC failure", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "stats"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to fetch memory stats");
  });

  // -- Models commands ------------------------------------------------------

  it("models list exits 1 on RPC failure when local fallback also fails", async () => {
    // models list has a local fallback via createModelCatalog. To test the
    // outer catch, we need the entire loadModels chain to throw. The RPC mock
    // already rejects, and the @comis/agent mock returns an empty catalog,
    // so loadModels will return [] rather than throw. We mock loadModels to
    // actually throw by making withClient reject AND making createModelCatalog
    // throw an error as well.
    const { createModelCatalog } = await import("@comis/agent");
    vi.mocked(createModelCatalog).mockImplementation(() => {
      throw new Error("Catalog unavailable");
    });

    const program = createTestProgram();
    registerModelsCommand(program);

    try {
      await program.parseAsync(["node", "test", "models", "list"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to list models");

    // Restore createModelCatalog for other tests
    vi.mocked(createModelCatalog).mockImplementation(() => ({
      loadStatic: vi.fn(),
      getAll: vi.fn(() => []),
      getByProvider: vi.fn(() => []),
    }));
  });
});

// ---------------------------------------------------------------------------
// Null/empty RPC response → graceful handling
// ---------------------------------------------------------------------------

describe("null/empty RPC response handling", () => {
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

  // -- Agent list empty/null ------------------------------------------------

  it("agent list with empty agents object shows 'No agents configured'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", { agents: {} })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);
    await program.parseAsync(["node", "test", "agent", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No agents configured");
  });

  it("agent list with null RPC response does not crash", async () => {
    // client.call returns null; spreading null produces {}, extractAgents({}) returns []
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", null)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);
    await program.parseAsync(["node", "test", "agent", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No agents configured");
  });

  it("agent list with { agents: null } does not crash", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.get", { agents: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerAgentCommand(program);
    await program.parseAsync(["node", "test", "agent", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No agents configured");
  });

  // -- Sessions list empty/null ---------------------------------------------

  it("sessions list with empty sessions array shows 'No sessions found'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [] })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync(["node", "test", "sessions", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No sessions found");
  });

  it("sessions list with { sessions: null } does not crash", async () => {
    // result.sessions ?? [] → null ?? [] → [] — shows "No sessions found"
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync(["node", "test", "sessions", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No sessions found");
  });

  it("sessions list with null RPC response shows 'No sessions found'", async () => {
    // client.call returns null; new code uses optional chaining so null?.sessions ?? []
    // produces empty array → graceful "No sessions found" message
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", null)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync(["node", "test", "sessions", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No sessions found");
  });

  // -- Sessions inspect null ------------------------------------------------

  it("sessions inspect with { session: null } shows 'Session not found'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", { session: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerSessionsCommand(program);
    await program.parseAsync(["node", "test", "sessions", "inspect", "test:key:1"]);

    // Session not found is logged via error() (stderr)
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Session not found");
    // Should not crash/exit -- the command handles missing sessions gracefully
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  // -- Memory search empty/null ---------------------------------------------

  it("memory search with empty results shows 'No matching entries found'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.search", { results: [] })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);
    await program.parseAsync(["node", "test", "memory", "search", "test"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No matching entries found");
  });

  it("memory search with { results: null } does not crash", async () => {
    // result.results ?? [] → null ?? [] → [] — shows "No matching entries found"
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.search", { results: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);
    await program.parseAsync(["node", "test", "memory", "search", "test"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No matching entries found");
  });

  // -- Memory inspect null --------------------------------------------------

  it("memory inspect with { entry: null } shows 'No entry found'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", { entry: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);
    await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No entry found");
  });

  // -- Memory stats null/empty ----------------------------------------------

  it("memory stats with { stats: null } shows 'No memory statistics available'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", { stats: null })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);
    await program.parseAsync(["node", "test", "memory", "stats"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No memory statistics available");
  });

  it("memory stats with { stats: {} } shows 'No memory statistics available'", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", { stats: {} })
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerMemoryCommand(program);
    await program.parseAsync(["node", "test", "memory", "stats"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No memory statistics available");
  });
});
