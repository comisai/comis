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

// Mock withClient from rpc-client at module level for ESM hoisting
vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

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
 * Session data matching what session.list RPC returns.
 * Uses epoch millisecond numbers for lastActive (matching sessions.ts expectations).
 */
const SESSIONS_DATA = {
  sessions: [
    {
      key: "test-tenant:user-1:discord-main",
      channel: "discord-main",
      user: "user-1",
      lastActive: Date.now() - 5 * 60 * 1000,
      messageCount: 42,
    },
    {
      key: "test-tenant:user-2:telegram-bot",
      channel: "telegram-bot",
      user: "user-2",
      lastActive: Date.now() - 2 * 60 * 60 * 1000,
      messageCount: 7,
    },
    {
      key: "other-tenant:user-3:slack-ws",
      channel: "slack-ws",
      user: "user-3",
      lastActive: Date.now() - 3 * 24 * 60 * 60 * 1000,
      messageCount: 1,
    },
  ],
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

  it("renders sessions in table format with session key, channel, user, and relative time columns", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "list"]);

    const output = getSpyOutput(consoleSpy.log);

    // Session keys
    expect(output).toContain("test-tenant:user-1:discord-main");
    expect(output).toContain("test-tenant:user-2:telegram-bot");
    expect(output).toContain("other-tenant:user-3:slack-ws");

    // Channel names
    expect(output).toContain("discord-main");
    expect(output).toContain("telegram-bot");
    expect(output).toContain("slack-ws");

    // User names
    expect(output).toContain("user-1");
    expect(output).toContain("user-2");
    expect(output).toContain("user-3");

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
      const mockClient = createMockRpcClient()
        .onCall("session.list", { sessions: [] })
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

    await program.parseAsync(["node", "test", "sessions", "list"]);

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

    await program.parseAsync(["node", "test", "sessions", "list", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ key: string; channel: string; user: string }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.key).toBe("test-tenant:user-1:discord-main");
    expect(parsed[0]!.channel).toBe("discord-main");
    expect(parsed[0]!.user).toBe("user-1");
    expect(parsed[1]!.key).toBe("test-tenant:user-2:telegram-bot");
    expect(parsed[2]!.key).toBe("other-tenant:user-3:slack-ws");
  });
});

describe("sessions list --tenant filters by tenant", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({ sessions: [] });
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("passes tenantId filter to session.list RPC call", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "list", "--tenant", "test-tenant"]);

    expect(callSpy).toHaveBeenCalledWith("session.list", expect.objectContaining({ tenantId: "test-tenant" }));
  });
});

describe("sessions inspect full details", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  const SESSION_DETAIL = {
    session: {
      key: "test-tenant:user-1:discord-main",
      channel: "discord-main",
      user: "user-1",
      createdAt: 1705309200000,
      lastActive: 1705314600000,
      messageCount: 42,
      metadata: { topic: "general", lang: "en" },
    },
  };

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", SESSION_DETAIL)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays full session details with parsed key components", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "test-tenant:user-1:discord-main"]);

    const output = getSpyOutput(consoleSpy.log);

    // Session key
    expect(output).toContain("test-tenant:user-1:discord-main");
    // Parsed tenant from key
    expect(output).toContain("test-tenant");
    // Parsed user from key
    expect(output).toContain("user-1");
    // Parsed channel from key
    expect(output).toContain("discord-main");
    // Message count
    expect(output).toContain("42");
    // Metadata
    expect(output).toContain("topic");
    expect(output).toContain("general");
  });
});

describe("sessions inspect --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  const SESSION_DETAIL = {
    session: {
      key: "test-tenant:user-1:discord-main",
      channel: "discord-main",
      user: "user-1",
      createdAt: 1705309200000,
      lastActive: 1705314600000,
      messageCount: 42,
      metadata: { topic: "general", lang: "en" },
    },
  };

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", SESSION_DETAIL)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON of the session object", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "test-tenant:user-1:discord-main", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { key: string; channel: string; user: string; messageCount: number };

    expect(parsed.key).toBe("test-tenant:user-1:discord-main");
    expect(parsed.channel).toBe("discord-main");
    expect(parsed.user).toBe("user-1");
    expect(parsed.messageCount).toBe(42);
  });
});

describe("sessions inspect non-existent", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("session.status", { session: undefined })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows error message for non-existent session key", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "inspect", "nonexistent-key"]);

    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Session not found: nonexistent-key");
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

  it("sends session.delete RPC with correct key when --yes provided", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "delete", "test-tenant:user-1:discord-main", "--yes"]);

    expect(callSpy).toHaveBeenCalledWith("session.delete", { key: "test-tenant:user-1:discord-main" });

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
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "delete", "test-key"]);

    // Confirm was called with message containing the key and warning
    expect(vi.mocked(clackPrompts.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("test-key"),
      }),
    );
    expect(vi.mocked(clackPrompts.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("cannot be undone"),
      }),
    );

    // RPC was sent after confirmation
    expect(callSpy).toHaveBeenCalledWith("session.delete", { key: "test-key" });

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

    await program.parseAsync(["node", "test", "sessions", "delete", "test-key"]);

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

    await program.parseAsync(["node", "test", "sessions", "delete", "test-key"]);

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

  it("preserves full key with multiple colons in RPC call", async () => {
    const program = createTestProgram();
    registerSessionsCommand(program);

    await program.parseAsync(["node", "test", "sessions", "delete", "complex:key:with:colons", "--yes"]);

    expect(callSpy).toHaveBeenCalledWith("session.delete", { key: "complex:key:with:colons" });
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
      await program.parseAsync(["node", "test", "sessions", "list"]);
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
      await program.parseAsync(["node", "test", "sessions", "inspect", "test-key"]);
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
      await program.parseAsync(["node", "test", "sessions", "delete", "test-key", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to delete session");
  });
});
