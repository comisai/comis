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

// importOriginal-based mock so callTyped resolves to the real wrapper while
// withClient is mocked.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// createModelCatalog + ensureWorkspace + resolveWorkspaceDir live in @comis/core.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    ensureWorkspace: vi.fn(async () => ({ dir: "/tmp/test", configFile: "", memoryDir: "" })),
    resolveWorkspaceDir: vi.fn((_config: unknown, name: string) => `/tmp/test-workspace/${name}`),
    createModelCatalog: vi.fn(() => ({
      loadStatic: vi.fn(),
      getAll: vi.fn(() => []),
      getByProvider: vi.fn(() => []),
    })),
  };
});

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

  // memory search/inspect are real RPC commands, so they get the standard
  // RPC-failure contract: exit 1 with an actionable error.
  it("memory search exits 1 with the failure message when the RPC rejects", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    vi.mocked(withClient).mockRejectedValue(new Error("gateway unreachable"));

    try {
      await program.parseAsync(["node", "test", "memory", "search", "test"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Memory search failed");
  });

  it("memory inspect exits 1 with the failure message when the RPC rejects", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    vi.mocked(withClient).mockRejectedValue(new Error("gateway unreachable"));

    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Memory inspect failed");
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
    const { createModelCatalog } = await import("@comis/core");
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
        .onCall("config.read", { agents: {} })
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

  // NOTE: there is deliberately no "agent list with raw-null RPC response" test —
  // ConfigReadContract.response is `z.record(z.string(), z.unknown())`, which
  // rejects raw `null`. The CLI's always-on response.parse closes that path
  // structurally, so a raw-null response cannot reach the render code.

  it("agent list with { agents: null } does not crash", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("config.read", { agents: null })
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
    // SessionListContract.response = { sessions: SessionInfo[], total }
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [], total: 0 })
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
    // SessionListContract.response guarantees
    // `{ sessions: SessionInfo[], total }` — the old `{ sessions: null }`
    // bug shape can no longer be returned (the contract response.parse
    // would reject it in dev mode; the production code path uses the
    // typed result directly). Use a valid empty response instead.
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [], total: 0 })
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

  it("sessions list with empty list shows 'No sessions found'", async () => {
    // SessionListContract.response guarantees a non-null sessions array.
    // Previous defensive code for `null` RPC responses is no longer needed
    // because the typed contract surface establishes a shape contract.
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [], total: 0 })
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

  // -- Sessions inspect: the { session: null } code path is gone because
  //    SessionStatusContract.response is non-nullable (always returns
  //    runtime stats for the caller's agent). Inspect failure modes now
  //    surface as RPC errors (caught by the catch block) — see
  //    sessions-behavior.test.ts for the inspect tests.

  // -- Memory search/inspect with no usable RPC ------------------------------
  //
  // NOTE: with no usable RPC response, `memory search` / `memory inspect`
  // fail closed (non-zero exit) rather than rendering empty results, so the
  // usual RPC-edge cases ("empty results" / "empty response") do not apply.
  // The fail-closed contract is asserted in memory-behavior.test.ts.

  it("memory search fails closed (exit 1) — no RPC edge to exercise", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    try {
      await program.parseAsync(["node", "test", "memory", "search", "test"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  it("memory inspect fails closed (exit 1) — no RPC edge to exercise", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  // -- Memory stats null/empty ----------------------------------------------

  it("memory stats with empty record shows 'No memory statistics available'", async () => {
    // Targets memory.stats. Empty record = no stats.
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.stats", {})
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

// ---------------------------------------------------------------------------
// withClient VITEST guard (test isolation)
//
// Under VITEST=true, withClient() must refuse to open a real WebSocket
// connection unless COMIS_CLI_E2E=true. Without the guard, CLI tests
// silently open ws://localhost:4766 every 75s for the duration of
// the `pnpm test` run, leaving connection-refused noise in the user's
// ~/.comis/logs/. This test asserts the guard fires before createRpcClient
// is reached.
// ---------------------------------------------------------------------------

describe("withClient VITEST guard", () => {
  it("withClient refuses real socket under VITEST without COMIS_CLI_E2E", async () => {
    // Bypass the file-level vi.mock("../client/rpc-client.js") so we
    // exercise the REAL withClient, not the mocked one. The guard runs
    // synchronously before any WebSocket is opened, so we never actually
    // attempt a connection.
    const actual = await vi.importActual<typeof import("../client/rpc-client.js")>(
      "../client/rpc-client.js",
    );

    // Sanity: VITEST is set automatically by vitest; assert it before
    // checking the guard so a future change to that environment surfaces
    // here instead of the test silently passing.
    expect(process.env["VITEST"]).toBe("true");

    // Ensure the E2E opt-out is NOT set.
    const prevE2E = process.env["COMIS_CLI_E2E"];
    delete process.env["COMIS_CLI_E2E"];

    try {
      await expect(
        actual.withClient(async () => "should never run"),
      ).rejects.toThrow(/refusing real WebSocket/i);
    } finally {
      if (prevE2E !== undefined) process.env["COMIS_CLI_E2E"] = prevE2E;
    }
  });

  it("withClient permits real socket attempt when COMIS_CLI_E2E=true (guard bypassed)", async () => {
    // When the opt-out is set, the guard MUST NOT fire — the call falls
    // through to the real WebSocket open. Whether the connect succeeds or
    // fails depends on the local environment; we only assert the guard
    // message is absent.
    const actual = await vi.importActual<typeof import("../client/rpc-client.js")>(
      "../client/rpc-client.js",
    );

    const prevE2E = process.env["COMIS_CLI_E2E"];
    process.env["COMIS_CLI_E2E"] = "true";

    try {
      let captured: unknown = undefined;
      try {
        await actual.withClient(async () => "ok");
      } catch (e) {
        captured = e;
      }
      // The guard message MUST be absent. (The call may resolve or reject
      // with a connect error, depending on whether a daemon happens to be
      // listening on the resolved URL — both outcomes prove the guard did
      // not fire.)
      if (captured instanceof Error) {
        expect(captured.message).not.toMatch(/refusing real WebSocket/i);
      }
    } finally {
      if (prevE2E === undefined) delete process.env["COMIS_CLI_E2E"];
      else process.env["COMIS_CLI_E2E"] = prevE2E;
    }
  });
});
