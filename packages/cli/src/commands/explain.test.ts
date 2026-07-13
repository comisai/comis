// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis explain` CLI command.
 *
 * Covers arg routing (sessionKey vs traceId), --format json, --depth full
 * threading, the table-view render, and the RPC-error → exit(1) path.
 *
 * Mirrors the established `trace.test.ts` seam: `withClient` is mocked via
 * importOriginal so the REAL `callTyped` runs (it parses BOTH request and
 * response against `ObsExplainContract`/`IncidentReportSchema`), while
 * `withSpinner` is a pass-through. Params threaded into `client.call` are
 * captured to assert sessionKey/traceId routing and depth.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObsExplainContract } from "@comis/core";
import type { RpcClient } from "../client/rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient at module level (ESM hoisting); importOriginal keeps the real
// callTyped so request/response Zod validation actually runs end-to-end.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock withSpinner to pass-through (no ora spinner in tests).
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock the offline assembler so fallback tests run without a data dir.
vi.mock("../util/offline-obs.js", () => ({
  assembleIncidentReportOffline: vi.fn(),
  resolveOfflineDataDir: vi.fn(() => "/fake/.comis"),
}));

// Dynamic imports after mocks.
const { registerExplainCommand } = await import("./explain.js");
const { withClient } = await import("../client/rpc-client.js");
const { assembleIncidentReportOffline } = await import("../util/offline-obs.js");

/**
 * A minimal-but-valid IncidentReport — must satisfy IncidentReportSchema
 * because the real callTyped parses the response. likelyRootCause is non-null
 * so the table-view's root-cause branch is exercised.
 */
const FAKE_REPORT = {
  schemaVersion: 1 as const,
  sessionKey: "default:user123:telegram:1717000000",
  traceId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  agentId: "default",
  channel: { type: "telegram", id: "user123" },
  outcome: { endReason: "completed_with_tool_errors", degraded: true, severity: "degraded" as const },
  cost: { costUsd: 1.32, totalTokens: 735800, cacheReadRatio: 0 },
  timing: { durationMs: 247740, turnCount: 25 },
  toolStats: { web_fetch: { ok: 2, failed: 8, topErrorKind: "dependency" } },
  failures: [],
  breakerTimeline: [],
  offloads: [],
  summary: "14 tool failures across 25 turns",
  likelyRootCause: {
    code: "content_heuristic_misclassification",
    detail: "a substring match flipped status-200 successes to failures",
    suggestedNextSteps: ["audit the web_fetch failureDetector rule"],
  },
  suggestedNextSteps: ["obs.explain depth=full"],
  truncations: [],
};

/**
 * Build a mock RpcClient whose `call` records the params threaded through
 * callTyped (the shared createMockRpcClient discards params) and returns the
 * fake report. The recorded (method, params) pair drives routing assertions.
 */
function captureClient(): {
  client: RpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve(FAKE_REPORT);
    },
    close(): void {},
    onNotification(): void {},
  };
  return { client, calls };
}

describe("comis explain routes a sessionKey (contains ':') to { sessionKey }", () => {
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

  it("threads obs.explain { sessionKey, depth: summary } when the arg contains a colon", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(ObsExplainContract.method);
    expect(calls[0]?.params).toEqual({
      sessionKey: "default:user123:telegram:1717000000",
      depth: "summary",
    });
  });
});

describe("comis explain routes a UUID (no ':') to { traceId }", () => {
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

  it("threads obs.explain { traceId, depth: summary } when the arg has no colon", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({
      traceId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      depth: "summary",
    });
  });
});

describe("comis explain routes a root- prefixed arg to { rootRunId }", () => {
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

  it("threads { rootRunId, depth } when the arg starts with 'root-session-' (synthetic root)", async () => {
    // The `root-` prefix is the disambiguator. A synthetic in-process
    // root is `root-session-<key>` — it contains ':' but MUST route to rootRunId,
    // NOT sessionKey (the prefix check is FIRST).
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "root-session-default:u:c:1",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(ObsExplainContract.method);
    expect(calls[0]?.params).toEqual({ rootRunId: "root-session-default:u:c:1", depth: "summary" });
  });

  it("threads { rootRunId, depth } when the arg starts with 'root-' (a real spawned root id)", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "root-abc-123"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ rootRunId: "root-abc-123", depth: "summary" });
  });
});

describe("comis explain --format json emits machine-readable JSON", () => {
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

  it("prints JSON.stringify of the report (json branch) when --format json is set", async () => {
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
      "--format",
      "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { sessionKey?: string };
    expect(parsed.sessionKey).toBe("default:user123:telegram:1717000000");
  });
});

describe("comis explain default (table) renders key report fields", () => {
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

  it("renders summary and root-cause lines (not raw JSON) when no --format is given", async () => {
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("14 tool failures across 25 turns");
    expect(output).toContain("content_heuristic_misclassification");
    // The token figure names its basis so it doesn't read as the same "tok" as
    // fleet's (which excludes cache). explain = the full model-call ledger.
    expect(output).toContain("735800 tok (incl cache reads)");
    // The table branch must NOT have emitted the whole report as JSON.
    expect(() => JSON.parse(output)).toThrow();
  });
});

describe("comis explain table view tolerates a null likelyRootCause and empty next-steps", () => {
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

  it("omits the root-cause line and renders no next-steps when both are absent", async () => {
    const cleanReport = {
      ...FAKE_REPORT,
      summary: "completed; no failures",
      likelyRootCause: null,
      suggestedNextSteps: [],
    };
    const client: RpcClient = {
      call: () => Promise.resolve(cleanReport),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("completed; no failures");
    expect(output).not.toContain("Root cause");
    expect(output).not.toContain("→");
  });

  it("renders a 'Did you mean' block with candidate keys on a 0-record miss (the lossy-key friction)", async () => {
    const missReport = {
      ...FAKE_REPORT,
      summary: "no activity found for this session",
      likelyRootCause: null,
      suggestedNextSteps: [],
      coverage: {
        trajectory: { found: false, records: 0 },
        rollup: { present: false },
        offloads: { pointersResolved: 0, pointersTotal: 0 },
        candidateSessionKeys: [
          "default:678314278:678314278:peer:678314278",
          "default:111:111:peer:111",
        ],
      },
    };
    const client: RpcClient = {
      call: () => Promise.resolve(missReport),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "telegram:678314278"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Did you mean");
    expect(output).toContain("default:678314278:678314278:peer:678314278");
  });

  it("does NOT render 'Did you mean' when the session resolved records (no candidate list)", async () => {
    const client: RpcClient = {
      call: () => Promise.resolve(FAKE_REPORT), // FAKE_REPORT has no candidateSessionKeys
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    expect(getSpyOutput(consoleSpy.log)).not.toContain("Did you mean");
  });
});

// ---------------------------------------------------------------------------
// The spawn-tree render block — the table view lists each node's
// leaseId/caps/tools (and DENIED for nodes with denials); --format json emits
// report.spawnTree for free (it rides json(report)).
// ---------------------------------------------------------------------------

// A report carrying a 2-level spawn tree (root + a child with a denial). Must
// satisfy IncidentReportSchema (the real callTyped parses the response).
const SPAWN_REPORT = {
  ...FAKE_REPORT,
  summary: "unattended run; spawned one child",
  likelyRootCause: null,
  suggestedNextSteps: [],
  spawnTree: [
    {
      leaseId: "L-root",
      rootRunId: "R",
      agentId: "default",
      caps: ["orch:read"],
      toolsInvoked: ["memory_search"],
      denials: [],
    },
    {
      leaseId: "L-child",
      parentLeaseId: "L-root",
      rootRunId: "R",
      agentId: "default",
      caps: ["orch:web"],
      toolsInvoked: ["web_fetch"],
      denials: ["orch:web"],
    },
  ],
};

describe("comis explain renders the spawn-tree (TREE)", () => {
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

  it("table view prints a Spawn tree block with each node's leaseId/caps/tools and DENIED for denials", async () => {
    const client: RpcClient = {
      call: () => Promise.resolve(SPAWN_REPORT),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Spawn tree:");
    expect(output).toContain("L-root");
    expect(output).toContain("memory_search");
    expect(output).toContain("L-child");
    // The child names its parent edge and its denied cap.
    expect(output).toContain("L-root"); // child parent edge references the root lease
    expect(output).toContain("DENIED");
    expect(output).toContain("orch:web");
    // The table branch must NOT have emitted the whole report as JSON.
    expect(() => JSON.parse(output)).toThrow();
  });

  it("bounds a hot node's tools render with a (+N more) suffix — no unbounded table line", async () => {
    const HOT_REPORT = {
      ...FAKE_REPORT,
      summary: "busy root",
      likelyRootCause: null,
      suggestedNextSteps: [],
      spawnTree: [
        {
          leaseId: "L-root",
          rootRunId: "R",
          agentId: "default",
          caps: ["orch:read"],
          toolsInvoked: Array.from({ length: 30 }, (_, i) => `tool_${String(i).padStart(2, "0")}`),
          denials: [],
        },
      ],
    };
    const client: RpcClient = {
      call: () => Promise.resolve(HOT_REPORT),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    const output = getSpyOutput(consoleSpy.log);
    // The head of the list is shown…
    expect(output).toContain("tool_00");
    // …but the table does NOT inline all 30 tools — the tail is summarized.
    expect(output).not.toContain("tool_29");
    expect(output).toMatch(/\+\d+ more/);
    // --format json still carries the full list (asserted in the json test).
  });

  it("--format json emits report.spawnTree", async () => {
    const client: RpcClient = {
      call: () => Promise.resolve(SPAWN_REPORT),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
      "--format",
      "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { spawnTree?: Array<{ leaseId: string }> };
    expect(parsed.spawnTree).toHaveLength(2);
    expect(parsed.spawnTree![1]!.leaseId).toBe("L-child");
  });

  it("table view omits the Spawn tree block when the report carries no spawnTree", async () => {
    // FAKE_REPORT has no spawnTree — the block is presence-conditional.
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).not.toContain("Spawn tree:");
  });
});

describe("comis explain --depth full threads depth:'full' through to the contract", () => {
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

  it("threads depth: full into the obs.explain params when --depth full is set", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
      "--depth",
      "full",
    ]);

    expect(calls[0]?.params).toEqual({
      sessionKey: "default:user123:telegram:1717000000",
      depth: "full",
    });
  });
});

describe("comis explain with an RPC error prints error and exits with code 1", () => {
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

  it("calls error() and process.exit(1) when the obs.explain call rejects", async () => {
    const client: RpcClient = {
      call: () => Promise.reject(new Error("Admin access required")),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "explain",
        "default:user123:telegram:1717000000",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("explain failed");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Obs honesty: when the session-end rollup is unresolved, the outcome line must
// NOT present the defaulted "unknown" endReason as authoritative — it caveats
// "rollup unresolved" so an operator does not read it as a real finding.
// (Without the caveat, a webhook session could report endReason:unknown plus a
// real cost — a self-inconsistent line; the rollup-absent caveat names the gap.)
// ---------------------------------------------------------------------------

describe("comis explain caveats an unresolved outcome when the rollup is absent", () => {
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

  const UNRESOLVED_REPORT = {
    ...FAKE_REPORT,
    outcome: { endReason: "unknown", degraded: false, severity: "ok" as const },
    summary: "0 tool failures across 0 turns",
    likelyRootCause: null,
    suggestedNextSteps: [],
    coverage: {
      trajectory: { found: false, records: 0 },
      rollup: { present: false },
      offloads: { pointersResolved: 0, pointersTotal: 0 },
      toolStats: { reconciled: true, rollupSource: "last-execution" as const, divergentTools: [] },
    },
  };

  it("renders 'rollup unresolved' when endReason is unknown AND coverage.rollup.present is false", async () => {
    const client: RpcClient = {
      call: () => Promise.resolve(UNRESOLVED_REPORT),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:hook:devtask:x:webhook"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("rollup unresolved");
  });

  it("does NOT caveat a resolved outcome (rollup present, real endReason)", async () => {
    // FAKE_REPORT has endReason=completed_with_tool_errors (resolved) → no caveat.
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).not.toContain("rollup unresolved");
  });
});

// ---------------------------------------------------------------------------
// Offline fallback wiring.
// ---------------------------------------------------------------------------

describe("comis explain offline fallback", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(assembleIncidentReportOffline).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("falls back to the offline assembler when the gateway is unreachable", async () => {
    vi.mocked(withClient).mockRejectedValue(
      new Error("Cannot connect to daemon at ws://localhost:4766/ws."),
    );
    vi.mocked(assembleIncidentReportOffline).mockResolvedValue(FAKE_REPORT as never);

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"]);

    expect(assembleIncidentReportOffline).toHaveBeenCalledWith("/fake/.comis", {
      sessionKey: "default:user123:telegram:1717000000",
      depth: "summary",
    });
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  it("--offline assembles locally without touching the gateway", async () => {
    vi.mocked(assembleIncidentReportOffline).mockResolvedValue(FAKE_REPORT as never);

    const program = createTestProgram();
    registerExplainCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "explain",
      "default:user123:telegram:1717000000",
      "--offline",
    ]);

    expect(withClient).not.toHaveBeenCalled();
    expect(assembleIncidentReportOffline).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back on a gateway token rejection — the daemon is up; surface the auth error", async () => {
    vi.mocked(withClient).mockRejectedValue(
      new Error(
        "Gateway rejected the token (WS close 4001 Unauthorized) — the daemon IS running and listening. " +
          "Set COMIS_GATEWAY_TOKEN (env var or ~/.comis/.env) to a token matching a gateway.tokens entry.",
      ),
    );

    const program = createTestProgram();
    registerExplainCommand(program);
    // The exit spy throws to halt the action (test-helpers contract).
    await program
      .parseAsync(["node", "test", "explain", "default:user123:telegram:1717000000"])
      .catch(() => undefined);

    expect(assembleIncidentReportOffline).not.toHaveBeenCalled();
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const stderr = consoleSpy.error.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("COMIS_GATEWAY_TOKEN");
    expect(stderr).toContain("--offline");
  });
});
