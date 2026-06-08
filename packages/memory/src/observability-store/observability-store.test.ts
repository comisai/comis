// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore SystemPromptReport CRUD smoke tests.
 *
 * Uses better-sqlite3 in-memory DB so that `initSchema(db, 1536)`
 * creates the full schema before exercising the store. Three
 * behavior-named cases: insert + retrieve latest, insert + list with
 * limit, and validation degrade.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";
import { createObservabilityStore } from "./index.js";
import type {
  ObservabilityStore,
  SystemPromptReportRow,
} from "./observability-store-types.js";

function makeRow(overrides: Partial<SystemPromptReportRow> = {}): SystemPromptReportRow {
  return {
    agentId: "agent-1",
    tenantId: null,
    sessionId: "session-1",
    runId: null,
    generatedAt: 1_700_000_000_000,
    provider: "anthropic",
    model: "claude-3-opus",
    systemChars: 100,
    systemSha256: "deadbeef",
    reportJson: '{"k":1}',
    ...overrides,
  };
}

describe("ObservabilityStore — SystemPromptReport CRUD", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("inserts a SystemPromptReport row and retrieves the latest by (agentId, sessionId)", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));

    const latest = store.latestSystemPromptReport("agent-1", "session-1");
    expect(latest).toBeDefined();
    expect(latest!.generatedAt).toBe(2_000);
    expect(latest!.runId).toBe("run-b");
  });

  it("returns undefined from latestSystemPromptReport when no rows match", () => {
    const latest = store.latestSystemPromptReport("nonexistent-agent", "nonexistent-session");
    expect(latest).toBeUndefined();
  });

  it("lists SystemPromptReports for a session in descending generatedAt order with a limit", () => {
    for (let i = 0; i < 15; i += 1) {
      store.insertSystemPromptReport(makeRow({ generatedAt: 1_000 + i, runId: `run-${i}` }));
    }
    const rows = store.listSystemPromptReports("session-1", 10);
    expect(rows).toHaveLength(10);
    // Descending order
    expect(rows[0]!.generatedAt).toBe(1_014);
    expect(rows[9]!.generatedAt).toBe(1_005);
  });

  it("returns empty array from listSystemPromptReports when no rows match", () => {
    const rows = store.listSystemPromptReports("nonexistent-session", 10);
    expect(rows).toEqual([]);
  });

  it("supports null tenantId and runId via the nullable composite-key columns", () => {
    store.insertSystemPromptReport(
      makeRow({ tenantId: null, runId: null, generatedAt: 100 }),
    );
    const latest = store.latestSystemPromptReport("agent-1", "session-1");
    expect(latest?.tenantId).toBeNull();
    expect(latest?.runId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // runId-in-SQL narrowing — push the optional runId filter into the WHERE
  // clause so an older row with the matching runId is returned even when a
  // newer row (different runId) exists.
  // -------------------------------------------------------------------------
  it("latestSystemPromptReport with runId narrows to the named run", () => {
    // Three rows: latest-by-generatedAt is run-b (gen=2000), but we ask for run-a (gen=1000).
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));

    const result = store.latestSystemPromptReport("agent-1", "session-1", "run-a");
    expect(result?.runId).toBe("run-a");
    expect(result?.generatedAt).toBe(1_000);
  });

  it("latestSystemPromptReport with runId for a non-existent run returns undefined", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    const result = store.latestSystemPromptReport("agent-1", "session-1", "run-nonexistent");
    expect(result).toBeUndefined();
  });

  it("latestSystemPromptReport without runId still returns the most-recent row (regression guard)", () => {
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_000, runId: "run-a" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 2_000, runId: "run-b" }));
    store.insertSystemPromptReport(makeRow({ generatedAt: 1_500, runId: "run-c" }));
    const result = store.latestSystemPromptReport("agent-1", "session-1");
    expect(result?.runId).toBe("run-b");
    expect(result?.generatedAt).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// A1 — aggregateSessionsInWindow (cross-session per-session rollup, GROUP BY)
//
// One scan over obs_diagnostics category='session_summary'; one rollup per
// session_key (latest row wins via MAX(id)); the window predicate excludes
// rows older than sinceMs. The rollup fields (degraded/costUsd/toolStats/
// breakerTripCount/turnCount/topErrorKinds/source) are parsed from the row's
// `details` JSON — proving topErrorKinds + source are now carried INTO the row.
// ---------------------------------------------------------------------------

/** A session_summary `details` JSON payload as written by sessionSummaryEventToRow. */
function summaryDetails(
  overrides: Partial<{
    degraded: boolean;
    costUsd: number;
    toolStats: Record<string, { ok: number; failed: number }>;
    breakerTripCount: number;
    turnCount: number;
    topErrorKinds: Record<string, number>;
    source: string;
  }> = {},
): string {
  return JSON.stringify({
    degraded: false,
    costUsd: 0,
    toolStats: {},
    breakerTripCount: 0,
    turnCount: 0,
    topErrorKinds: {},
    source: "runtime",
    ...overrides,
  });
}

describe("ObservabilityStore — aggregateSessionsInWindow (A1)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("returns one rollup per session_key (GROUP BY) — 2 rows for s1 + 1 for s2 yield exactly 2", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.1, turnCount: 1 }),
    });
    store.insertDiagnostic({
      timestamp: 2_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0.4, turnCount: 4 }),
    });
    store.insertDiagnostic({
      timestamp: 1_500,
      category: "session_summary",
      severity: "info",
      sessionKey: "s2",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.2, turnCount: 2 }),
    });

    const rollups = store.aggregateSessionsInWindow(0);

    // GROUP BY session_key: 3 rows across 2 keys -> 2 rollups.
    expect(rollups).toHaveLength(2);
    const keys = rollups.map((r) => r.sessionKey).sort();
    expect(keys).toEqual(["s1", "s2"]);
  });

  it("reflects the LATEST row per session_key (latest-wins via MAX(id))", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.1, turnCount: 1 }),
    });
    // Later (higher id) row for the SAME key — this is the one that must win.
    store.insertDiagnostic({
      timestamp: 2_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({
        degraded: true,
        costUsd: 0.4,
        turnCount: 4,
        breakerTripCount: 2,
        toolStats: { web_fetch: { ok: 1, failed: 3 } },
        topErrorKinds: { dependency: 3 },
        source: "runtime",
      }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    expect(rollups).toHaveLength(1);
    const r = rollups[0]!;
    expect(r.sessionKey).toBe("s1");
    // Latest (id=2) row's fields, NOT the first row's.
    expect(r.degraded).toBe(true);
    expect(r.costUsd).toBe(0.4);
    expect(r.turnCount).toBe(4);
    expect(r.breakerTripCount).toBe(2);
    expect(r.toolStats).toEqual({ web_fetch: { ok: 1, failed: 3 } });
    expect(r.topErrorKinds).toEqual({ dependency: 3 });
    expect(r.source).toBe("runtime");
    expect(r.lastTs).toBe(2_000);
  });

  it("excludes rows whose timestamp < sinceMs (window predicate)", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "old",
      message: "session:summary",
      details: summaryDetails(),
    });
    store.insertDiagnostic({
      timestamp: 5_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "recent",
      message: "session:summary",
      details: summaryDetails(),
    });

    const rollups = store.aggregateSessionsInWindow(3_000);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.sessionKey).toBe("recent");
  });

  it("ignores non-session_summary categories (category predicate)", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "cache_trace",
      severity: "info",
      sessionKey: "s1",
      message: "not a summary",
      details: summaryDetails(),
    });

    expect(store.aggregateSessionsInWindow(0)).toHaveLength(0);
  });

  it("parses source from details and exposes it on the rollup (the field 159-02 filters on)", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "synthetic-1",
      message: "session:summary",
      details: summaryDetails({ source: "test" }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.source).toBe("test");
  });
});
