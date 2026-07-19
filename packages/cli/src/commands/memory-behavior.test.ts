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

// ── memory search/inspect via the contracted RPCs ─────────────────────────────
//
// `memory search` rides memory.search_files (hybrid FTS + vector search) and
// `memory inspect` rides memory.browse (the page is scanned client-side for the
// id, since no dedicated by-id read RPC exists). These assert the happy-path
// rendering through those contracted RPCs.

describe("memory search/inspect render via the contracted RPCs", () => {
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

  it("memory search renders the matched entries via the contracted RPC", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    vi.mocked(withClient).mockImplementation(async (fn) =>
      fn({
        call: vi.fn().mockResolvedValue({
          results: [
            { id: "mem-001-full", content: "User prefers dark mode", score: 0.91, tags: [], createdAt: 1 },
          ],
        }),
      } as never),
    );

    await program.parseAsync([
      "node", "test", "memory", "search", "dark mode",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalledWith(1);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("mem-001-");
    expect(out).toContain("dark mode");
  });

  it("memory inspect renders the entry detail found by id prefix via memory.browse", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);
    vi.mocked(withClient).mockImplementation(async (fn) =>
      fn({
        call: vi.fn().mockResolvedValue({
          entries: [{ id: "mem-001-full", content: "User prefers dark mode", trustLevel: "learned" }],
          total: 1,
          offset: 0,
          limit: 1000,
          hasMore: false,
        }),
      } as never),
    );

    await program.parseAsync([
      "node", "test", "memory", "inspect", "mem-001",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalledWith(1);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("dark mode");
    expect(out).toContain("learned");
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
      // the recall-counter overlay that `comis memory stats` now folds in.
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

    await program.parseAsync([
      "node", "test", "memory", "stats",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

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
      "--tenant", "test-tenant", "--agent", "test-agent",
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

    await program.parseAsync([
      "node", "test", "memory", "stats",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No memory statistics available");
  });
});

// ── memory clear requires an explicit RPC-backed scope ──────────

describe("memory clear requires an explicit scope", () => {
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

  it("rejects a clear command without explicit tenant-agent authority", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await expect(
      program.parseAsync(["node", "test", "memory", "clear", "--yes"]),
    ).rejects.toThrow("required option '--tenant <tenantId>' not specified");
    expect(withClient).not.toHaveBeenCalled();
  });
});

// ── memory clear rejects the unsupported widening filter ────────

describe("memory clear rejects the unsupported filter option", () => {
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

  it("rejects --filter before issuing a broader memory.flush RPC", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await expect(
      program.parseAsync([
        "node", "test", "memory", "clear", "--filter", "memoryType=conversation", "--yes",
        "--tenant", "test-tenant", "--agent", "test-agent",
      ]),
    ).rejects.toThrow("unknown option '--filter'");

    expect(callSpy).not.toHaveBeenCalled();
  });
});

// ── memory clear with explicit authority ───────────────────────

describe("memory clear with explicit authority", () => {
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

  it("sends memory.flush RPC with tenant_id and agent_id", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear", "--tenant", "test-tenant",
      "--agent", "test-agent", "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {
      tenant_id: "test-tenant",
      agent_id: "test-agent",
    });

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Memory entries cleared");
  });
});

// ── memory clear with both supported scopes ─────────────────────

describe("memory clear with both tenant and agent", () => {
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

  it("sends memory.flush RPC with tenant_id and agent_id", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "clear",
      "--tenant", "test-tenant",
      "--agent", "agent-a",
      "--yes",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.flush", {
      tenant_id: "test-tenant",
      agent_id: "agent-a",
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
        "node", "test", "memory", "clear", "--tenant", "test-tenant",
        "--agent", "agent-a",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Confirmation required");
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

  // NOTE: the daemon-offline cases for memory search/inspect live in
  // edge-rpc-errors.test.ts (exit 1 with an actionable message when the RPC
  // rejects).

  it("memory stats exits 1 with descriptive error when daemon is offline", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    try {
      await program.parseAsync([
        "node", "test", "memory", "stats",
        "--tenant", "test-tenant", "--agent", "test-agent",
      ]);
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
        "node", "test", "memory", "clear", "--tenant", "test-tenant",
        "--agent", "agent-a", "--yes",
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
// Diagnostic subcommands — dispatch + render behavior.
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
      "--trace-id", "t-A", "--tenant", "test-tenant",
      "--agent", "agent-x", "--limit", "50",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.recall_trace", {
      session_key: "sess-A",
      trace_id: "t-A",
      tenant_id: "test-tenant",
      agent_id: "agent-x",
      limit: 50,
    });
  });

  it("supports --format json (raw passthrough of records)", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "recall-trace", "sess-A", "--format", "json",
      "--tenant", "test-tenant", "--agent", "test-agent",
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
      await program.parseAsync([
        "node", "test", "memory", "recall-trace", "sess-A",
        "--tenant", "test-tenant", "--agent", "test-agent",
      ]);
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
      "node", "test", "memory", "observations", "--tenant", "test-tenant",
      "--agent", "agent-y", "--limit", "25",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.observations", {
      tenant_id: "test-tenant",
      agent_id: "agent-y",
      limit: 25,
    });
  });

  it("renders id / content-preview / proofCount in table output", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "observations",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

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
      "node", "test", "memory", "entities", "--tenant", "test-tenant",
      "--agent", "agent-z", "--limit", "10",
    ]);

    expect(callSpy).toHaveBeenCalledWith("memory.entities", {
      tenant_id: "test-tenant",
      agent_id: "agent-z",
      limit: 10,
    });
  });

  it("renders id / name / mentionCount in table output", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "entities",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("ent-1");
    expect(output).toContain("Globex");
    expect(output).toContain("5");
  });
});

// ── memory stats folds in the recall counters ──────────────────────────────

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

    await program.parseAsync([
      "node", "test", "memory", "stats",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    const methods = callSpy.mock.calls.map((c) => c[0] as string);
    expect(methods).toContain("memory.stats");
    expect(methods).toContain("memory.recall_stats");
  });

  it("surfaces lane usage + rerank-fallback rate + recall hit rate in --format json", async () => {
    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "stats", "--format", "json",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

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

    await program.parseAsync([
      "node", "test", "memory", "stats",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    // Fail-open: base stats still rendered, no non-zero exit.
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Total Entries");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  // The recall overlay must NOT swallow the error silently — it leaves a
  // breadcrumb so an operator debugging "blank recall counters" can see the
  // call was attempted and why it was skipped (the failure is otherwise
  // indistinguishable from "counters not wired"). Still fail-open (no exit).
  it("surfaces a non-fatal breadcrumb when memory.recall_stats fails, without exiting", async () => {
    callSpy = vi.fn().mockImplementation(async (method: string) => {
      if (method === "memory.stats") return STATS_DATA;
      throw new Error("Admin access required for memory recall stats");
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ call: callSpy, close: vi.fn() }));

    const program = createTestProgram();
    registerMemoryCommand(program);

    await program.parseAsync([
      "node", "test", "memory", "stats",
      "--tenant", "test-tenant", "--agent", "test-agent",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    // Breadcrumb surfaced (info() → console.log), carrying the underlying cause.
    expect(output).toContain("Recall counters unavailable");
    expect(output).toContain("Admin access required for memory recall stats");
    // Still fail-open: base stats rendered, no non-zero exit.
    expect(output).toContain("Total Entries");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});
