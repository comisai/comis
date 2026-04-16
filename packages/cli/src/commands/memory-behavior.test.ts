/**
 * Memory command behavior tests.
 *
 * Tests memory search/inspect/stats/clear behaviors including RPC
 * payloads, output formatting, safety guards, confirmation flow,
 * and error handling. Uses mocked RPC layer.
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

// Dynamic imports after mocks
const { registerMemoryCommand } = await import("./memory.js");
const { withClient } = await import("../client/rpc-client.js");

/**
 * Sample search results with varying scores for table formatting tests.
 */
const SEARCH_RESULTS = {
  results: [
    {
      id: "mem-001",
      content:
        "User prefers dark mode and compact layout settings for the dashboard interface",
      score: 0.92,
      createdAt: "2026-01-15T11:00:00Z",
    },
    {
      id: "mem-002",
      content: "Project deadline is March 15",
      score: 0.85,
      createdAt: "2026-01-14T09:30:00Z",
    },
    {
      id: "mem-003",
      content: "API key rotation scheduled",
      score: 0.45,
      createdAt: "2026-01-13T16:00:00Z",
    },
  ],
};

/**
 * Full memory entry for inspect tests.
 */
const INSPECT_ENTRY = {
  entry: {
    id: "mem-001",
    content: "User prefers dark mode",
    memoryType: "conversation",
    trustLevel: "high",
    tenantId: "test-tenant",
    sessionKey: "discord:guild-123:chan-456:user-789",
    createdAt: "2026-01-15T11:00:00Z",
    updatedAt: "2026-01-15T12:00:00Z",
    metadata: { source: "extraction" },
  },
};

/**
 * Stats object for stats display tests.
 */
const STATS_DATA = {
  stats: {
    totalEntries: 150,
    averageScore: 0.82,
    oldestEntry: "2025-12-01",
    byMemoryType: "conversation: 100, extraction: 50",
  },
};

// ── memory search table output ──────────────────────────────────

describe("memory search table output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.search", SEARCH_RESULTS)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders search results in table with score percentages and truncated content", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "search", "dark mode"]);

    const output = getSpyOutput(consoleSpy.log);

    // Score percentages should appear
    expect(output).toContain("92%");
    expect(output).toContain("85%");
    expect(output).toContain("45%");

    // First result content is >60 chars, should be truncated with "..."
    expect(output).toContain("...");
    // Should NOT contain the full untruncated content
    expect(output).not.toContain(
      "User prefers dark mode and compact layout settings for the dashboard interface",
    );

    // Result count
    expect(output).toContain("3 results found");
  });
});

// ── memory search no results ───────────────────────────────────

describe("memory search no results", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.search", { results: [] })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows info message when no results found", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "search", "nonexistent"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No matching entries found");
  });
});

// ── memory search invalid limit ────────────────────────────────

describe("memory search invalid limit", () => {
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

  it("exits with error when limit is negative", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "memory", "search", "test", "--limit", "-1",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Invalid limit");
  });
});

// ── memory search --limit constrains result count ───────────────

describe("memory search --limit constrains result count", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    callSpy = vi.fn().mockResolvedValue({ results: [] });
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("passes limit parameter to memory.search RPC call", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "search", "test query", "--limit", "5",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.search", {
      query: "test query",
      limit: 5,
    });
  });
});

// ── memory search --format json ─────────────────────────────────

describe("memory search --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.search", SEARCH_RESULTS)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON array of search results", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "search", "test", "--format", "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{
      id: string;
      content: string;
      score: number;
      createdAt: string;
    }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.id).toBe("mem-001");
    expect(parsed[0]!.content).toContain("dark mode");
    expect(parsed[0]!.score).toBe(0.92);
    expect(parsed[0]!.createdAt).toBe("2026-01-15T11:00:00Z");
    expect(parsed[1]!.id).toBe("mem-002");
    expect(parsed[2]!.id).toBe("mem-003");
  });
});

// ── memory inspect full details ─────────────────────────────────

describe("memory inspect full details", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", INSPECT_ENTRY)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays full entry details as key-value pairs", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "inspect", "mem-001"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("mem-001");
    expect(output).toContain("User prefers dark mode");
    expect(output).toContain("conversation");
    expect(output).toContain("high");
    expect(output).toContain("test-tenant");
    expect(output).toContain("discord:guild-123:chan-456:user-789");
    expect(output).toContain("extraction");
  });
});

// ── memory inspect --format json ───────────────────────────────

describe("memory inspect --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", INSPECT_ENTRY)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON of the full entry", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "inspect", "mem-001", "--format", "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.id).toBe("mem-001");
    expect(parsed.content).toBe("User prefers dark mode");
    expect(parsed.memoryType).toBe("conversation");
    expect(parsed.trustLevel).toBe("high");
    expect(parsed.tenantId).toBe("test-tenant");
    expect(parsed.sessionKey).toBe("discord:guild-123:chan-456:user-789");
    expect(parsed.metadata).toEqual({ source: "extraction" });
  });
});

// ── memory inspect non-existent ────────────────────────────────

describe("memory inspect non-existent", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", { entry: undefined })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows warning when entry not found", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "inspect", "nonexistent-id",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No entry found with ID: nonexistent-id");
  });
});

// ── memory stats display ────────────────────────────────────────

describe("memory stats display", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", STATS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays stats with human-readable formatted keys", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "stats"]);

    const output = getSpyOutput(consoleSpy.log);
    // camelCase keys should be converted to Title Case
    expect(output).toContain("Total Entries");
    expect(output).toContain("Average Score");
    expect(output).toContain("Oldest Entry");
    expect(output).toContain("By Memory Type");
    // Values should appear
    expect(output).toContain("150");
    expect(output).toContain("0.82");
  });
});

// ── memory stats --format json ─────────────────────────────────

describe("memory stats --format json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", STATS_DATA)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs valid JSON of stats object", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "stats", "--format", "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.totalEntries).toBe(150);
    expect(parsed.averageScore).toBe(0.82);
  });
});

// ── memory stats empty ─────────────────────────────────────────

describe("memory stats empty", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("memory.inspect", { stats: {} })
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows info message when no stats available", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "stats"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No memory statistics available");
  });
});

// ── memory clear requires at least one filter ───────────────────

describe("memory clear requires at least one filter", () => {
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

  it("exits with safety error when no filters provided", async () => {
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
});

// ── memory clear rejects invalid filter format ─────────────────

describe("memory clear rejects invalid filter format", () => {
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

  it("exits with error for invalid filter format", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "memory", "clear", "--filter", "invalidformat", "--yes",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Invalid filter format");
  });
});

// ── memory clear with --yes and --filter sends RPC ──────────────

describe("memory clear with --yes and --filter sends RPC", () => {
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

  it("sends config.set RPC with parsed filter params", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--filter", "memoryType=conversation", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("config.set", {
      section: "memory",
      key: "clear",
      value: { memoryType: "conversation" },
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Memory entries cleared");
  });
});

// ── memory clear with --yes and --tenant ───────────────────────

describe("memory clear with --yes and --tenant", () => {
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

  it("sends config.set RPC with tenantId param", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--tenant", "test-tenant", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("config.set", {
      section: "memory",
      key: "clear",
      value: { tenantId: "test-tenant" },
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Memory entries cleared");
  });
});

// ── memory clear with both --filter and --tenant ───────────────

describe("memory clear with both --filter and --tenant", () => {
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

  it("sends config.set RPC with both filter and tenant params", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear",
      "--filter", "memoryType=conversation",
      "--tenant", "test-tenant",
      "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("config.set", {
      section: "memory",
      key: "clear",
      value: { memoryType: "conversation", tenantId: "test-tenant" },
    });
  });
});

// ── memory clear without --yes in non-TTY exits ────────────────

describe("memory clear without --yes in non-TTY exits", () => {
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

  it("exits with confirmation-required error in non-TTY mode", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "memory", "clear", "--filter", "memoryType=conversation",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Confirmation required");
  });
});

// ── memory clear with filter containing = in value ─────────────

describe("memory clear with filter containing = in value", () => {
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

  it("correctly parses filter value containing = signs", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--filter", "content=has=equals", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("config.set", {
      section: "memory",
      key: "clear",
      value: { content: "has=equals" },
    });
  });
});

// ── memory commands handle daemon offline ───────────────────────

describe("memory commands handle daemon offline", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(withClient).mockRejectedValue(
      new Error("Daemon not running. Start with: comis daemon start"),
    );
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("memory search exits 1 with descriptive error when daemon is offline", async () => {
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

  it("memory inspect exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to inspect memory entry");
  });

  it("memory stats exits 1 with descriptive error when daemon is offline", async () => {
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

  it("memory clear exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "memory", "clear", "--filter", "memoryType=test", "--yes",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Failed to clear memory");
  });
});
