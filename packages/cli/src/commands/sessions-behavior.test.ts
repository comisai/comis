// SPDX-License-Identifier: Apache-2.0
/**
 * Session command behavior tests.
 *
 * Tests session command behaviors: list/inspect/delete including RPC payloads,
 * output formatting, confirmation flow via @clack/prompts, and daemon-offline
 * error handling. Uses mocked RPC layer.
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

// Mock withClient from rpc-client at module level for ESM hoisting.
// importOriginal-based so callTyped resolves to the real wrapper while
// withClient is mocked. Same pattern as agent-behavior.test.ts.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @clack/prompts for delete confirmation tests
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

// Dynamic imports after mocks
const { registerSessionsCommand } = await import("./sessions.js");
const { withClient } = await import("../client/rpc-client.js");
const clackPrompts = await import("@clack/prompts");

/**
 * Session data matching `SessionListContract.response`:
 * `{ sessions: SessionInfo[], total }` where SessionInfo carries
 * `conversationRef/agentId/kind/messageCount/updatedAt/createdAt`.
 * The CLI renders the canonical conversation reference and agent partition
 * returned by the session list contract.
 */
const SESSIONS_DATA = {
  sessions: [
    {
      conversationRef: "conversation-ref-1",
      agentId: "default",
      kind: "discord",
      messageCount: 42,
      updatedAt: Date.now() - 5 * 60 * 1000,
      createdAt: Date.now() - 60 * 60 * 1000,
    },
    {
      conversationRef: "conversation-ref-2",
      agentId: "default",
      kind: "telegram",
      messageCount: 7,
      updatedAt: Date.now() - 2 * 60 * 60 * 1000,
      createdAt: Date.now() - 3 * 60 * 60 * 1000,
    },
    {
      conversationRef: "conversation-ref-3",
      agentId: "default",
      kind: "slack",
      messageCount: 1,
      updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
    },
  ],
  total: 3,
};

describe("sessions list table output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", SESSIONS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders sessions with conversation reference agent kind and relative time", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "list",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    const output = getSpyOutput(consoleSpy.log);

    expect(output).toContain("conversation-ref-1");
    expect(output).toContain("conversation-ref-2");
    expect(output).toContain("conversation-ref-3");
    expect(output).toContain("default");
    expect(output).toContain("discord");
    expect(output).toContain("telegram");
    expect(output).toContain("slack");

    // Relative time strings
    expect(output).toContain("5m ago");
    expect(output).toContain("2h ago");
    expect(output).toContain("3d ago");

    // Summary count
    expect(output).toContain("3 sessions");
  });
});

describe("sessions list empty", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      // SessionListContract.response = { sessions: [...], total }
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [], total: 0 })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows info message when no sessions found", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "list",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No sessions found");
  });
});

describe("sessions list --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.list", SESSIONS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON array of session entries", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "list", "--format", "json",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      conversationRef: string;
      agentId: string;
      kind: string;
    }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.conversationRef).toBe("conversation-ref-1");
    expect(parsed[0]!.agentId).toBe("default");
    expect(parsed[0]!.kind).toBe("discord");
    expect(parsed[1]!.conversationRef).toBe("conversation-ref-2");
    expect(parsed[2]!.conversationRef).toBe("conversation-ref-3");
  });
});

describe("sessions list explicit authority", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // SessionListContract.response = { sessions: [...], total }
    callSpy = vi.fn().mockResolvedValue({ sessions: [], total: 0 });
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls session.list with explicit tenant and agent authority", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "list",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    expect(callSpy).toHaveBeenCalledWith("session.list", {
      tenant_id: "test-tenant",
      agent_id: "default",
    });
  });
});

describe("sessions inspect full details", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  const SESSION_HISTORY = {
    session: {
      key: "default:agent:default:user_a:telegram:peer:user_a",
      agentId: "default",
      channelType: "telegram",
      messageCount: 2,
      totalTokens: 1234,
      inputTokens: 1000,
      outputTokens: 234,
      toolCalls: 3,
      compactions: 1,
      resetCount: 0,
      createdAt: 100,
      lastActiveAt: 200,
    },
    messages: [
      { role: "user", content: "check the build", timestamp: 100 },
      { role: "assistant", content: "build passed", timestamp: 200 },
    ],
    total: 45,
    offset: 20,
    limit: 2,
    hasMore: true,
  };

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue(SESSION_HISTORY);
    vi.mocked(withClient).mockImplementation(async (fn) =>
      fn({ call: callSpy, close: vi.fn() }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays the requested conversation history instead of unrelated agent totals", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "sessions",
      "inspect",
      "cv_test",
      "--tenant",
      "test-tenant",
      "--agent",
      "default",
      "--offset",
      "20",
      "--limit",
      "2",
    ]);

    const output = getSpyOutput(consoleSpy.log);

    expect(output).toContain("cv_test");
    expect(output).toContain("default:agent:default:user_a:telegram:peer:user_a");
    expect(output).toContain("default");
    expect(output).toContain("1234");
    expect(output).toContain("check the build");
    expect(output).toContain("Showing 21-22 of 45");
    expect(output).toContain("Next page: --offset 22 --limit 2");
    expect(output).not.toContain("Max Steps");
    expect(callSpy).toHaveBeenCalledWith("session.history", {
      tenant_id: "test-tenant",
      agent_id: "default",
      conversation_ref: "cv_test",
      offset: 20,
      limit: 2,
    });
  });
});

describe("sessions inspect --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  const SESSION_HISTORY = {
    session: {
      key: "default:agent:default:user_a:telegram:peer:user_a",
      agentId: "default",
      channelType: "telegram",
      messageCount: 1,
      totalTokens: 1234,
      inputTokens: 1000,
      outputTokens: 234,
      toolCalls: 3,
      compactions: 0,
      resetCount: 0,
      createdAt: 100,
      lastActiveAt: 200,
    },
    messages: [{ role: "user", content: "check the build", timestamp: 100 }],
    total: 1,
    offset: 0,
    limit: 20,
    hasMore: false,
  };

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.history", SESSION_HISTORY)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON for the requested conversation history", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "sessions",
      "inspect",
      "cv_test",
      "--tenant",
      "test-tenant",
      "--agent",
      "default",
      "--format",
      "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as {
      session: { key: string; totalTokens: number };
      messages: Array<{ content: string }>;
    };

    expect(parsed.session.key).toBe("default:agent:default:user_a:telegram:peer:user_a");
    expect(parsed.session.totalTokens).toBe(1234);
    expect(parsed.messages[0]?.content).toBe("check the build");
  });
});

describe("sessions delete with --yes sends RPC", () => {
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

  it("sends session.delete with explicit authority and conversation reference", async () => {
    callSpy.mockResolvedValue({
      conversationRef: "conversation-ref-1",
      deleted: true,
      transcript: { messages: [], metadata: {}, messageCount: 0 },
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "delete", "conversation-ref-1", "--yes",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    expect(callSpy).toHaveBeenCalledWith("session.delete", {
      tenant_id: "test-tenant",
      agent_id: "default",
      conversation_ref: "conversation-ref-1",
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("deleted");
  });
});

describe("sessions delete without --yes prompts and confirms", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(clackPrompts.confirm).mockReset();
    vi.mocked(clackPrompts.isCancel).mockReset();
    vi.mocked(clackPrompts.cancel).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(clackPrompts.confirm).mockResolvedValue(true);
    vi.mocked(clackPrompts.isCancel).mockReturnValue(false);

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prompts for confirmation and sends RPC when confirmed", async () => {
    callSpy.mockResolvedValue({
      conversationRef: "conversation-ref-1",
      deleted: true,
      transcript: { messages: [], metadata: {}, messageCount: 0 },
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "delete", "conversation-ref-1",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    // Confirm was called with message containing the key and warning
    expect(vi.mocked(clackPrompts.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("conversation-ref-1"),
      }),
    );
    expect(vi.mocked(clackPrompts.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("cannot be undone"),
      }),
    );

    expect(callSpy).toHaveBeenCalledWith("session.delete", {
      tenant_id: "test-tenant",
      agent_id: "default",
      conversation_ref: "conversation-ref-1",
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("deleted");
  });
});

describe("sessions delete cancelled by user", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(clackPrompts.confirm).mockReset();
    vi.mocked(clackPrompts.isCancel).mockReset();
    vi.mocked(clackPrompts.cancel).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // User says "no" to confirmation
    vi.mocked(clackPrompts.confirm).mockResolvedValue(false);
    vi.mocked(clackPrompts.isCancel).mockReturnValue(false);

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("does not send RPC when user declines confirmation", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "delete", "conversation-ref-1",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    // RPC should NOT have been called
    expect(callSpy).not.toHaveBeenCalled();

    // Cancel message shown
    expect(vi.mocked(clackPrompts.cancel)).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
  });
});

describe("sessions delete cancelled via Ctrl+C (isCancel)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(clackPrompts.confirm).mockReset();
    vi.mocked(clackPrompts.isCancel).mockReset();
    vi.mocked(clackPrompts.cancel).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    // Ctrl+C produces a cancel symbol
    const cancelSymbol = Symbol("cancel");
    vi.mocked(clackPrompts.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(clackPrompts.isCancel).mockReturnValue(true);

    callSpy = vi.fn().mockResolvedValue({});
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("does not send RPC when user presses Ctrl+C", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "delete", "conversation-ref-1",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    // RPC should NOT have been called
    expect(callSpy).not.toHaveBeenCalled();

    // Cancel was called
    expect(vi.mocked(clackPrompts.cancel)).toHaveBeenCalled();
  });
});

describe("sessions delete preserves complex keys", () => {
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

  it("preserves an opaque conversation reference in the RPC call", async () => {
    callSpy.mockResolvedValue({
      conversationRef: "opaque:reference:with:colons",
      deleted: true,
      transcript: { messages: [], metadata: {}, messageCount: 0 },
    });

    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync([
      "node", "test", "sessions", "delete", "opaque:reference:with:colons", "--yes",
      "--tenant", "test-tenant", "--agent", "default",
    ]);

    expect(callSpy).toHaveBeenCalledWith("session.delete", {
      tenant_id: "test-tenant",
      agent_id: "default",
      conversation_ref: "opaque:reference:with:colons",
    });
  });
});

describe("session commands handle daemon offline", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(clackPrompts.confirm).mockReset();
    vi.mocked(clackPrompts.isCancel).mockReset();
    vi.mocked(clackPrompts.cancel).mockReset();
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

  it("sessions list exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "sessions", "list",
        "--tenant", "test-tenant", "--agent", "default",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to list sessions");
  });

  it("sessions inspect exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "sessions", "inspect", "test-key",
        "--tenant", "test-tenant", "--agent", "default",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to inspect session");
  });

  it("sessions delete --yes exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "sessions", "delete", "conversation-ref-1", "--yes",
        "--tenant", "test-tenant", "--agent", "default",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to delete session");
  });
});
