// SPDX-License-Identifier: Apache-2.0
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

// Mock withClient from rpc-client at module level for ESM hoisting.
// importOriginal-based mock so callTyped resolves to the real wrapper
// while withClient is mocked.
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

// Dynamic imports after mocks
const { registerMemoryCommand } = await import("./memory.js");
const { withClient } = await import("../client/rpc-client.js");

/**
 * Sample search results matching ContextSearchContract.response shape:
 * `{ id, content, type, rank? }` + top-level `total`. Note: the contract
 * does NOT carry `score` or `createdAt` — those fields are stripped by
 * always-on response.parse, so they cannot be asserted on the display
 * output.
 */
const SEARCH_RESULTS = {
  results: [
    {
      id: "mem-001",
      content:
        "User prefers dark mode and compact layout settings for the dashboard interface",
      type: "message" as const,
      rank: -1.0,
    },
    {
      id: "mem-002",
      content: "Project deadline is March 15",
      type: "message" as const,
      rank: -0.8,
    },
    {
      id: "mem-003",
      content: "API key rotation scheduled",
      type: "summary" as const,
      rank: -0.5,
    },
  ],
  total: 3,
};

/**
 * Full memory entry for inspect tests. Targets ContextInspectContract,
 * which returns the entry directly (no `entry: {...}` wrapper).
 */
const INSPECT_ENTRY = {
  id: "mem-001",
  content: "User prefers dark mode",
  memoryType: "conversation",
  trustLevel: "high",
  tenantId: "test-tenant",
  sessionKey: "discord:guild-123:chan-456:user-789",
  createdAt: "2026-01-15T11:00:00Z",
  updatedAt: "2026-01-15T12:00:00Z",
  metadata: { source: "extraction" },
};

/**
 * Stats object for stats display tests. Targets MemoryStatsContract,
 * which returns the stats directly (no `stats: {...}` wrapper).
 */
const STATS_DATA = {
  totalEntries: 150,
  averageScore: 0.82,
  oldestEntry: "2025-12-01",
  byMemoryType: "conversation: 100, extraction: 50",
};

/**
 * Recall-counter snapshot (+ derived rates) for `memory stats`/`recall_stats`
 * tests. Matches MemoryRecallStatsContract.response.
 */
const RECALL_STATS_DATA = {
  laneUsage: { fts: 10, vector: 4, entity: 2 },
  rerankRuns: 4,
  rerankFallbacks: 1,
  consolidationClusters: 3,
  observationsCreated: 6,
  recalls: 8,
  recallsWithHits: 6,
  rerankFallbackRate: 0.25,
  recallHitRate: 0.75,
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
        .onCall("context.search", SEARCH_RESULTS)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders search results in table with truncated content and result count", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "search", "dark mode"]);

    const output = getSpyOutput(consoleSpy.log);

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
        .onCall("context.search", { results: [], total: 0 })
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

    // ContextSearchContract.response = { results: [...], total }
    callSpy = vi.fn().mockResolvedValue({ results: [], total: 0 });
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

    // `context.search` is the actual full-text search surface.
    expect(callSpy).toHaveBeenCalledWith("context.search", {
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
        .onCall("context.search", SEARCH_RESULTS)
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
      type: "message" | "summary";
      rank?: number;
    }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.id).toBe("mem-001");
    expect(parsed[0]!.content).toContain("dark mode");
    expect(parsed[0]!.type).toBe("message");
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
      // context.inspect returns the entry directly (no `entry: {...}` wrapper).
      const mockClient = createMockRpcClient()
        .onCall("context.inspect", INSPECT_ENTRY)
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
        .onCall("context.inspect", INSPECT_ENTRY)
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
      // context.inspect "not found" signal is an empty record.
      const mockClient = createMockRpcClient()
        .onCall("context.inspect", {})
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
      // memory.stats is the base daemon stats surface; memory.recall_stats is
      // the OBS-07 recall-counter overlay that `comis memory stats` now folds in.
      const mockClient = createMockRpcClient()
        .onCall("memory.stats", STATS_DATA)
        .onCall("memory.recall_stats", RECALL_STATS_DATA)
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
        .onCall("memory.stats", STATS_DATA)
        .onCall("memory.recall_stats", RECALL_STATS_DATA)
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
      // Empty record = no stats. recall_stats is stubbed too (best-effort
      // overlay), but the empty base stats short-circuits to the info message.
      const mockClient = createMockRpcClient()
        .onCall("memory.stats", {})
        .onCall("memory.recall_stats", RECALL_STATS_DATA)
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

    // MemoryFlushContract.response = { flushed: true, entriesRemoved, scope: { tenantId, agentId } }
    callSpy = vi.fn().mockImplementation(async (_method: string, params: { tenant_id?: string; agent_id?: string }) => ({
      flushed: true,
      entriesRemoved: 0,
      scope: { tenantId: params.tenant_id ?? "", agentId: params.agent_id ?? null },
    }));
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends memory.flush RPC (--filter is dropped)", async () => {
    // MemoryFlushContract is the actual flush surface. The contract's
    // request only models tenant_id + agent_id (the daemon's actual flush
    // params); arbitrary --filter key=value flags are dropped.
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--filter", "memoryType=conversation", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {});

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

    // MemoryFlushContract.response = { flushed: true, entriesRemoved, scope }
    callSpy = vi.fn().mockImplementation(async (_method: string, params: { tenant_id?: string; agent_id?: string }) => ({
      flushed: true,
      entriesRemoved: 0,
      scope: { tenantId: params.tenant_id ?? "", agentId: params.agent_id ?? null },
    }));
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends memory.flush RPC with tenant_id param", async () => {
    // --tenant flag maps to MemoryFlushContract's tenant_id request field
    // (snake_case — matches the daemon's actual parameter).
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--tenant", "test-tenant", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {
      tenant_id: "test-tenant",
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

    // MemoryFlushContract.response = { flushed: true, entriesRemoved, scope }
    callSpy = vi.fn().mockImplementation(async (_method: string, params: { tenant_id?: string; agent_id?: string }) => ({
      flushed: true,
      entriesRemoved: 0,
      scope: { tenantId: params.tenant_id ?? "", agentId: params.agent_id ?? null },
    }));
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends memory.flush RPC with tenant_id (--filter is dropped)", async () => {
    // Only the --tenant flag maps to a real MemoryFlushContract request
    // field; arbitrary --filter key=value flags are dropped.
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear",
      "--filter", "memoryType=conversation",
      "--tenant", "test-tenant",
      "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {
      tenant_id: "test-tenant",
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

    // MemoryFlushContract.response = { flushed: true, entriesRemoved, scope }
    callSpy = vi.fn().mockImplementation(async (_method: string, params: { tenant_id?: string; agent_id?: string }) => ({
      flushed: true,
      entriesRemoved: 0,
      scope: { tenantId: params.tenant_id ?? "", agentId: params.agent_id ?? null },
    }));
    vi.mocked(withClient).mockImplementation(async (fn) => {
      return fn({ call: callSpy, close: vi.fn() });
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("correctly parses filter value containing = signs (but --filter is dropped from RPC)", async () => {
    // The CLI still parses --filter for the input-validation guard at the
    // top of the action handler (at least one flag is required), but the
    // resulting filter object no longer flows into the RPC call
    // (MemoryFlushContract doesn't model arbitrary filters).
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--filter", "content=has=equals", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {});
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

// ===========================================================================
// OBS-06 diagnostic subcommands — dispatch + render behavior.
// ===========================================================================

// ── memory recall-trace dispatches MemoryRecallTraceContract ────────────────

describe("memory recall-trace dispatch", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    callSpy = vi.fn().mockResolvedValue({
      records: [{ ts: "t", sessionKey: "sess-A", traceId: "t-A", finalCount: 3 }],
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("dispatches memory.recall_trace with session_key + parsed options", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "recall-trace", "sess-A",
      "--trace-id", "t-A", "--agent", "agent-x", "--limit", "50",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.recall_trace", {
      session_key: "sess-A",
      trace_id: "t-A",
      agent_id: "agent-x",
      limit: 50,
    });
  });

  it("supports --format json (raw passthrough of records)", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "recall-trace", "sess-A", "--format", "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
    expect(parsed[0]!.sessionKey).toBe("sess-A");
  });

  it("exits 1 with descriptive error when the RPC fails", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("Admin access required for memory recall trace"));
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync(["node", "test", "memory", "recall-trace", "sess-A"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

// ── memory observations dispatches MemoryObservationsContract ───────────────

describe("memory observations dispatch", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    callSpy = vi.fn().mockResolvedValue({
      observations: [
        { id: "obs-1", content: "preview", proofCount: 3, sourceIds: ["s1"], createdAt: 1 },
      ],
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("dispatches memory.observations with --agent + --limit", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "observations", "--agent", "agent-y", "--limit", "25",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.observations", {
      agent_id: "agent-y",
      limit: 25,
    });
  });

  it("renders id / content-preview / proofCount in table output", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "observations"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("obs-1");
    expect(output).toContain("preview");
    expect(output).toContain("3");
  });
});

// ── memory entities dispatches MemoryEntitiesContract ───────────────────────

describe("memory entities dispatch", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    callSpy = vi.fn().mockResolvedValue({
      entities: [{ id: "ent-1", name: "Globex", mentionCount: 5 }],
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("dispatches memory.entities with --agent + --limit", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "entities", "--agent", "agent-z", "--limit", "10",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.entities", {
      agent_id: "agent-z",
      limit: 10,
    });
  });

  it("renders id / name / mentionCount in table output", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "entities"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("ent-1");
    expect(output).toContain("Globex");
    expect(output).toContain("5");
  });
});

// ── memory stats folds in the recall counters (OBS-07) ──────────────────────

describe("memory stats recall-counter overlay", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let callSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    callSpy = vi.fn().mockImplementation(async (method: string) => {
      if (method === "memory.stats") return STATS_DATA;
      if (method === "memory.recall_stats") return RECALL_STATS_DATA;
      throw new Error(`Unexpected RPC call: ${method}`);
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls BOTH memory.stats and memory.recall_stats", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "stats"]);

    const methods = callSpy.mock.calls.map((c) => c[0] as string);
    expect(methods).toContain("memory.stats");
    expect(methods).toContain("memory.recall_stats");
  });

  it("surfaces lane usage + rerank-fallback rate + recall hit rate in --format json", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "stats", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const recall = parsed.recallStats as Record<string, unknown>;
    expect(recall).toBeDefined();
    expect(recall.laneUsage).toEqual({ fts: 10, vector: 4, entity: 2 });
    expect(recall.rerankFallbackRate).toBe(0.25);
    expect(recall.recallHitRate).toBe(0.75);
  });

  it("still renders base stats when memory.recall_stats fails (best-effort overlay)", async () => {
    callSpy = vi.fn().mockImplementation(async (method: string) => {
      if (method === "memory.stats") return STATS_DATA;
      throw new Error("Admin access required for memory recall stats");
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));

    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "test", "memory", "stats"]);

    // Base stats still rendered; the recall overlay is silently skipped.
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Total Entries");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});
