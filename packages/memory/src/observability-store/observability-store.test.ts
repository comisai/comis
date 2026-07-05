// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore SystemPromptReport CRUD smoke tests.
 *
 * Uses better-sqlite3 in-memory DB so that `initSchema(db, 1536)`
 * creates the full schema before exercising the store. Three
 * behavior-named cases: insert + retrieve latest, insert + list with
 * limit, and validation degrade.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { systemNowMs } from "@comis/core";
import { initSchema } from "../schema.js";
import { createObservabilityStore } from "./index.js";
import { reduceFleetWindow } from "./fleet-window-rollup.js";
import { tokenUsageFromRow, type TokenUsageDbRow } from "./observability-row-shapes.js";
import type {
  ObservabilityStore,
  SystemPromptReportRow,
  TokenUsageRow,
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
    endReason: string;
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
    endReason: "success",
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

  it("reduces over ALL in-window rows per session_key: additive fields SUM, state fields take the latest (a session emits one summary row per execution)", () => {
    // A session's summary rows are per-EXECUTION snapshots (each execution
    // emits its own cost/turns/toolStats). Representing the session by its
    // latest row alone under-reports every additive field — observed live: a
    // 4-execution session that spent ~$0.50 was fleet-reported at $0.03 (the
    // final execution's cost), with toolStats {} despite 10 real tool calls.
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.13, turnCount: 1, endReason: "success" }),
    });
    store.insertDiagnostic({
      timestamp: 2_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({
        degraded: true,
        costUsd: 0.27,
        turnCount: 6,
        breakerTripCount: 2,
        toolStats: { web_fetch: { ok: 1, failed: 3 }, edit: { ok: 1, failed: 1 } },
        topErrorKinds: { dependency: 3 },
        endReason: "spend_exceeded",
      }),
    });
    store.insertDiagnostic({
      timestamp: 3_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s1",
      message: "session:summary",
      details: summaryDetails({
        degraded: true,
        costUsd: 0.03,
        turnCount: 1,
        toolStats: { web_fetch: { ok: 2, failed: 0 } },
        topErrorKinds: { dependency: 1, validation: 2 },
        endReason: "spend_exceeded",
      }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    expect(rollups).toHaveLength(1);
    const r = rollups[0]!;
    expect(r.sessionKey).toBe("s1");
    // Additive fields: the SUM across the session's in-window executions.
    expect(r.costUsd).toBeCloseTo(0.43);
    expect(r.turnCount).toBe(8);
    expect(r.breakerTripCount).toBe(2);
    expect(r.toolStats).toEqual({ web_fetch: { ok: 3, failed: 3 }, edit: { ok: 1, failed: 1 } });
    expect(r.topErrorKinds).toEqual({ dependency: 4, validation: 2 });
    // State fields: any degraded execution degrades the session; the named
    // cause is the latest DEGRADED execution's endReason.
    expect(r.degraded).toBe(true);
    expect(r.endReason).toBe("spend_exceeded");
    expect(r.source).toBe("runtime");
    expect(r.lastTs).toBe(3_000);
  });

  it("keeps the degradation cause when a later clean execution follows the degraded one (endReason = latest degraded row's cause)", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s-recovered",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0.2, turnCount: 2, endReason: "context_exhausted" }),
    });
    store.insertDiagnostic({
      timestamp: 2_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "s-recovered",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.1, turnCount: 1, endReason: "success" }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    expect(rollups).toHaveLength(1);
    const r = rollups[0]!;
    // The session saw a degradation in-window: degraded stays true and the
    // NAMED cause survives (degradedByCause buckets on it) even though the
    // latest execution ended clean.
    expect(r.degraded).toBe(true);
    expect(r.endReason).toBe("context_exhausted");
    expect(r.costUsd).toBeCloseTo(0.3);
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

  it("parses source from details and exposes it on the rollup (the field synthetic-source filtering reads)", () => {
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

  it("QT2/QT3: parses endReason from details and exposes it on the rollup (the field degradedByCause aggregates on)", () => {
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "ctx-exhausted-1",
      message: "session:summary",
      details: summaryDetails({ degraded: true, endReason: "context_exhausted" }),
    });
    // A pre-change row whose details JSON has NO endReason field — parse-default
    // to "unknown" (additive read-time default, not a migration shim).
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "warning",
      sessionKey: "legacy-1",
      message: "session:summary",
      details: JSON.stringify({ degraded: true, costUsd: 0, toolStats: {}, breakerTripCount: 0, turnCount: 0, topErrorKinds: {}, source: "runtime" }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    const byKey = Object.fromEntries(rollups.map((r) => [r.sessionKey, r]));
    expect(byKey["ctx-exhausted-1"]!.endReason).toBe("context_exhausted");
    // Missing endReason ⇒ stable "unknown" default (never undefined / a crash).
    expect(byKey["legacy-1"]!.endReason).toBe("unknown");
  });

  it("does not abort the scan on a non-object `details` (\"null\"/primitive JSON degrade-on-error)", () => {
    // `details = "null"` is VALID JSON that parses to JS `null`; an unguarded
    // `d.degraded` then throws TypeError and aborts the WHOLE fleet aggregate —
    // the exact failure the file's "a corrupt details never aborts the scan"
    // contract forbids. Seed the toxic shapes alongside valid rows.
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "toxic-null",
      message: "session:summary",
      details: "null", // parses to JS null (NOT a JSON.parse syntax error)
    });
    store.insertDiagnostic({
      timestamp: 1_100,
      category: "session_summary",
      severity: "info",
      sessionKey: "toxic-number",
      message: "session:summary",
      details: "42", // parses to a primitive number
    });
    store.insertDiagnostic({
      timestamp: 1_200,
      category: "session_summary",
      severity: "info",
      sessionKey: "toxic-array",
      message: "session:summary",
      details: "[1,2,3]", // parses to an array (typeof === "object" but not a record)
    });
    store.insertDiagnostic({
      timestamp: 1_300,
      category: "session_summary",
      severity: "info",
      sessionKey: "valid-1",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0.5, turnCount: 3 }),
    });
    store.insertDiagnostic({
      timestamp: 1_400,
      category: "session_summary",
      severity: "info",
      sessionKey: "valid-2",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.2, turnCount: 1 }),
    });

    // Must NOT throw — the non-object rows are skipped (degrade-on-error), the
    // valid rows survive.
    const rollups = store.aggregateSessionsInWindow(0);
    const keys = rollups.map((r) => r.sessionKey).sort();
    expect(keys).toEqual(["valid-1", "valid-2"]);
    const v1 = rollups.find((r) => r.sessionKey === "valid-1")!;
    expect(v1.degraded).toBe(true);
    expect(v1.costUsd).toBe(0.5);
  });

  it("does not let a malformed nested toolStats/topErrorKinds value reach the rollup", () => {
    // toolStats carries a number-instead-of-{ok,failed}; topErrorKinds carries a
    // string-instead-of-number. The blind `as` cast would pass these straight
    // through; they must instead be validated/dropped so the rollup exposes only
    // well-typed shapes (finite numbers, {ok,failed} objects).
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "malformed-nested",
      message: "session:summary",
      details: JSON.stringify({
        degraded: false,
        costUsd: 0,
        breakerTripCount: 0,
        turnCount: 0,
        source: "runtime",
        // write = bare number (invalid); Read = valid {ok,failed}.
        toolStats: { write: 5, Read: { ok: 2, failed: 1 } },
        // timeout = string (invalid); dependency = valid number.
        topErrorKinds: { timeout: "5", dependency: 3 },
      }),
    });

    const rollups = store.aggregateSessionsInWindow(0);
    expect(rollups).toHaveLength(1);
    const r = rollups[0]!;

    // The valid nested entries survive with correct types.
    expect(r.toolStats.Read).toEqual({ ok: 2, failed: 1 });
    expect(r.topErrorKinds.dependency).toBe(3);

    // The malformed entries must NOT appear as corrupt values: `write` is either
    // absent or a finite {ok,failed}; `timeout` is either absent or a finite number.
    if ("write" in r.toolStats) {
      expect(Number.isFinite(r.toolStats.write.ok)).toBe(true);
      expect(Number.isFinite(r.toolStats.write.failed)).toBe(true);
    }
    if ("timeout" in r.topErrorKinds) {
      expect(typeof r.topErrorKinds.timeout).toBe("number");
      expect(Number.isFinite(r.topErrorKinds.timeout)).toBe(true);
    }

    // End-to-end: feeding the rollup into the fleet reducer must yield finite numbers
    // (this is the corruption the reducer would otherwise propagate).
    const fleet = reduceFleetWindow(rollups, { excludeSynthetic: true });
    for (const s of Object.values(fleet.toolStats)) {
      expect(Number.isFinite(s.ok)).toBe(true);
      expect(Number.isFinite(s.failed)).toBe(true);
    }
    for (const n of Object.values(fleet.topErrorKinds)) {
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("keeps a session whose only in-window row is not the global-latest (windowed MAX(id) subquery)", () => {
    // Session "D" has an in-window row (higher timestamp) AND a later-INSERTED
    // (higher id) but BACKDATED row whose timestamp falls OUTSIDE the window. An
    // unwindowed MAX(id) subquery picks the backdated row, the outer window
    // predicate then excludes it, and session D vanishes — silently under-counting.
    const SINCE = 1_000;

    // id=1: in-window row for D (ts above the window floor).
    store.insertDiagnostic({
      timestamp: 9_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "D",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0.9, turnCount: 9 }),
    });
    // id=2: LATER-inserted but BACKDATED row for D (ts below the window floor —
    // clock skew / replay / two-daemon write).
    store.insertDiagnostic({
      timestamp: 50,
      category: "session_summary",
      severity: "info",
      sessionKey: "D",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.1, turnCount: 1 }),
    });
    // A control session entirely in-window so the result is non-empty either way.
    store.insertDiagnostic({
      timestamp: 8_000,
      category: "session_summary",
      severity: "info",
      sessionKey: "E",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0.2, turnCount: 2 }),
    });

    const rollups = store.aggregateSessionsInWindow(SINCE);
    const keys = rollups.map((r) => r.sessionKey).sort();
    // Session D MUST still appear, represented by its latest IN-WINDOW row (id=1).
    expect(keys).toEqual(["D", "E"]);
    const d = rollups.find((r) => r.sessionKey === "D")!;
    expect(d.lastTs).toBe(9_000); // the in-window row, not the backdated id=2 row
    expect(d.degraded).toBe(true);
    expect(d.costUsd).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// The obs_token_usage cost-correctness columns + the dead cache_retention DROP
// + the obs_audit_events DDL, plus the load-bearing insertTokenUsageStmt
// write-path round-trip.
//
// These prove the schema change (ensureObsTokenColumns + the table-rebuild) AND
// the FIXED prepared statement move together: without the statement edit, Test 6's
// real insert→read-back either throws on the dropped cache_retention column or
// silently never persists the 5 new columns.
// ---------------------------------------------------------------------------

/** A minimal valid TokenUsageRow with the cost-correctness fields populated. */
function makeTokenRow(overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    timestamp: 1_700_000_000_000,
    traceId: "trace-1",
    agentId: "agent-1",
    channelId: "chan-1",
    sessionKey: "sess-1",
    provider: "anthropic",
    model: "claude-3-opus",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costInput: 0.001,
    costOutput: 0.002,
    costTotal: 0.003,
    costCacheRead: 0.0001,
    costCacheWrite: 0.0002,
    cacheSaved: 0.0005,
    latencyMs: 1234,
    ...overrides,
  };
}

describe("schema — obs_token_usage cost-correctness columns + cache_retention DROP", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  function tokenCols(): Set<string> {
    return new Set(
      (db.prepare(`PRAGMA table_info(obs_token_usage)`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
  }

  it("Test 1: obs_token_usage gains the 5 cost-correctness columns", () => {
    const cols = tokenCols();
    expect(cols.has("warmup_turn")).toBe(true);
    expect(cols.has("cache_eligible")).toBe(true);
    expect(cols.has("cost_correction")).toBe(true);
    expect(cols.has("pending_cache_investment_usd")).toBe(true);
    expect(cols.has("pricing_state")).toBe(true);
  });

  it("Test 2: obs_token_usage no longer has the dead cache_retention column", () => {
    expect(tokenCols().has("cache_retention")).toBe(false);
  });

  it("Test 3: ensureObsTokenColumns is idempotent — re-running initSchema does not throw and the column set is stable", () => {
    const before = [...tokenCols()].sort();
    expect(() => initSchema(db, 1536)).not.toThrow();
    const after = [...tokenCols()].sort();
    expect(after).toEqual(before);
    // the rebuild guard must be a no-op the second time (cache_retention stays gone).
    expect(tokenCols().has("cache_retention")).toBe(false);
  });

  it("Test 4: the obs_audit_events table + both indexes exist", () => {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='obs_audit_events'`)
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("obs_audit_events");

    const indexes = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='obs_audit_events'`)
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    expect(indexes.has("obs_audit_scope")).toBe(true);
    expect(indexes.has("obs_audit_kind")).toBe(true);
  });

  it("Test 5: a DB with pre-existing obs_token_usage rows survives the cache_retention rebuild verbatim", () => {
    // Simulate a pre-176 DB: a fresh DB without the migration, carrying the dead
    // cache_retention column + one row, then re-run initSchema to trigger the rebuild.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE obs_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL, trace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        channel_id TEXT DEFAULT '', session_key TEXT DEFAULT '',
        provider TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
        cost_input REAL NOT NULL, cost_output REAL NOT NULL, cost_total REAL NOT NULL,
        cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0,
        cache_saved REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL,
        cache_retention TEXT DEFAULT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO obs_token_usage (timestamp, trace_id, agent_id, provider, model,
          prompt_tokens, completion_tokens, total_tokens, cost_input, cost_output, cost_total,
          latency_ms, cache_retention)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(42, "t-legacy", "agent-legacy", "anthropic", "claude-legacy", 7, 3, 10, 0.5, 0.6, 1.1, 99, "ttl-5m");

    initSchema(legacy, 1536);

    const cols = new Set(
      (legacy.prepare(`PRAGMA table_info(obs_token_usage)`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(cols.has("cache_retention")).toBe(false);
    expect(cols.has("warmup_turn")).toBe(true);

    const row = legacy
      .prepare(`SELECT cost_total, provider, model FROM obs_token_usage WHERE trace_id = ?`)
      .get("t-legacy") as { cost_total: number; provider: string; model: string };
    expect(row.cost_total).toBe(1.1);
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-legacy");
    legacy.close();
  });
});

describe("ObservabilityStore — insertTokenUsage write-path round-trip", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("Test 6: insertTokenUsage does not throw and the 5 new columns persist + read back (REAL round-trip, not a mock)", () => {
    expect(() =>
      store.insertTokenUsage(
        makeTokenRow({
          warmupTurn: true,
          cacheEligible: false,
          costCorrection: 0.01,
          pendingCacheInvestmentUsd: 0.02,
          pricingState: "priced",
        }),
      ),
    ).not.toThrow();

    const raw = db.prepare(`SELECT * FROM obs_token_usage`).get() as TokenUsageDbRow;
    const back = tokenUsageFromRow(raw);
    expect(back.warmupTurn).toBe(true);
    expect(back.cacheEligible).toBe(false);
    expect(back.costCorrection).toBe(0.01);
    expect(back.pendingCacheInvestmentUsd).toBe(0.02);
    expect(back.pricingState).toBe("priced");
    // the existing fields still round-trip unchanged.
    expect(back.costTotal).toBe(0.003);
    expect(back.provider).toBe("anthropic");
  });

  it("Test 6b: omitted optional new fields persist as NULL → undefined on read-back (no throw)", () => {
    expect(() => store.insertTokenUsage(makeTokenRow())).not.toThrow();
    const raw = db.prepare(`SELECT * FROM obs_token_usage`).get() as TokenUsageDbRow;
    const back = tokenUsageFromRow(raw);
    expect(back.warmupTurn).toBeUndefined();
    expect(back.cacheEligible).toBeUndefined();
    expect(back.costCorrection).toBeUndefined();
    expect(back.pendingCacheInvestmentUsd).toBeUndefined();
    expect(back.pricingState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The `tool_tag` column: the IDENTICAL 6th additive guarded-ALTER via
// ensureObsTokenColumns (the same migration added the 5 cost-correctness
// columns), + the insertTokenUsageStmt lockstep persist of the JSON-stringified
// DISTINCT tool array. The tag is content-free (tool NAMES/ids only — never
// args/output); per-tool $ attribution itself is best-effort/labeled and lives
// on the emit, not in the persisted shape.
//
// Test 7 (column presence) + Test 8 (real round-trip stores+reads
// ["bash","read"]) + Test 9 (an existing 5-column DB gains tool_tag with its
// pre-existing rows read back tool_tag NULL — survive-verbatim) all fail on
// pre-patch because the column does not exist / insertTokenUsage drops toolTag.
// ---------------------------------------------------------------------------
describe("schema — obs_token_usage tool_tag column (the 6th additive ALTER)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  it("Test 7: ensureObsTokenColumns adds the tool_tag column", () => {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(obs_token_usage)`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(cols.has("tool_tag")).toBe(true);
  });

  it("Test 9: a DB with the 5 cost-correctness cols but no tool_tag gains it; pre-existing rows read tool_tag NULL (verbatim survival)", () => {
    // Simulate a DB that predates tool_tag: the 5 cost-correctness columns
    // present, tool_tag absent, carrying one row.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE obs_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL, trace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        channel_id TEXT DEFAULT '', session_key TEXT DEFAULT '',
        provider TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
        cost_input REAL NOT NULL, cost_output REAL NOT NULL, cost_total REAL NOT NULL,
        cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0,
        cache_saved REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL,
        warmup_turn INTEGER, cache_eligible INTEGER, cost_correction REAL,
        pending_cache_investment_usd REAL, pricing_state TEXT
      );
    `);
    legacy
      .prepare(
        `INSERT INTO obs_token_usage (timestamp, trace_id, agent_id, provider, model,
          prompt_tokens, completion_tokens, total_tokens, cost_input, cost_output, cost_total,
          latency_ms, pricing_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, "t-pre-tooltag", "agent-x", "anthropic", "claude-x", 5, 5, 10, 0.1, 0.2, 0.3, 50, "priced");

    initSchema(legacy, 1536);

    const cols = new Set(
      (legacy.prepare(`PRAGMA table_info(obs_token_usage)`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(cols.has("tool_tag")).toBe(true);

    // The pre-existing row survives verbatim; its tool_tag is NULL.
    const row = legacy
      .prepare(`SELECT cost_total, pricing_state, tool_tag FROM obs_token_usage WHERE trace_id = ?`)
      .get("t-pre-tooltag") as { cost_total: number; pricing_state: string; tool_tag: string | null };
    expect(row.cost_total).toBe(0.3);
    expect(row.pricing_state).toBe("priced");
    expect(row.tool_tag).toBeNull();
    legacy.close();
  });
});

describe("ObservabilityStore — insertTokenUsage tool_tag persist round-trip", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("Test 8: a row with toolTag ['bash','read'] persists as the JSON array and reads back (REAL round-trip)", () => {
    expect(() =>
      store.insertTokenUsage(makeTokenRow({ toolTag: ["bash", "read"] })),
    ).not.toThrow();

    const rawCol = db.prepare(`SELECT tool_tag FROM obs_token_usage`).get() as { tool_tag: string | null };
    // Stored as a JSON-stringified DISTINCT tool array (content-free — names only).
    expect(rawCol.tool_tag).toBe(JSON.stringify(["bash", "read"]));
    // And the full-row camelCase mapper reads it back as a string[] (end-to-end).
    const raw = db.prepare(`SELECT * FROM obs_token_usage`).get() as TokenUsageDbRow;
    expect(tokenUsageFromRow(raw).toolTag).toEqual(["bash", "read"]);
  });

  it("Test 8b: a row with NO toolTag persists tool_tag NULL → undefined on read-back (no throw, no shim)", () => {
    expect(() => store.insertTokenUsage(makeTokenRow())).not.toThrow();
    const rawCol = db.prepare(`SELECT tool_tag FROM obs_token_usage`).get() as { tool_tag: string | null };
    expect(rawCol.tool_tag).toBeNull();
    const raw = db.prepare(`SELECT * FROM obs_token_usage`).get() as TokenUsageDbRow;
    expect(tokenUsageFromRow(raw).toolTag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getRollingSpendUsd(windowMs): the spend-accumulator's BOOT rehydration read
// (NOT a per-check read). A per-agent SUM(cost_total) over the rolling window
// from obs_token_usage. The rows ARE the durability — this is the accumulator's
// one source of truth at boot, replacing any per-check SQL re-sum.
//
// obs_token_usage has NO tenant_id column (schema.ts) — the boot read groups
// by agent_id ONLY; per-tenant accrues live-from-boot (documented honest
// degradation). The window bound is derived from systemNowMs() inside
// the method (the prune() precedent in observability-reset.ts), so the tests seed
// timestamps relative to a captured `now` with offsets far larger than any
// wall-clock drift between the two systemNowMs() reads.
// ---------------------------------------------------------------------------
describe("ObservabilityStore — getRollingSpendUsd (boot rehydration)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("returns the per-agent rolling SUM(cost_total) over the window", () => {
    const now = systemNowMs();
    // agent-a: two in-window rows (0.10 + 0.25 = 0.35).
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 1_000, costTotal: 0.10 }));
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 2_000, costTotal: 0.25 }));
    // agent-b: one in-window row (0.40).
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-b", timestamp: now - 3_000, costTotal: 0.40 }));

    const rows = store.getRollingSpendUsd(ONE_HOUR_MS);
    const byAgent = Object.fromEntries(rows.map((r) => [r.agentId, r.totalCostUsd]));

    expect(rows).toHaveLength(2);
    expect(byAgent["agent-a"]).toBeCloseTo(0.35, 10);
    expect(byAgent["agent-b"]).toBeCloseTo(0.40, 10);
  });

  it("excludes a row older than the window (window-bounded)", () => {
    const now = systemNowMs();
    // In-window.
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 1_000, costTotal: 0.10 }));
    // Out-of-window: 2h ago, window is 1h — must NOT be summed.
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 2 * ONE_HOUR_MS, costTotal: 99.0 }));

    const rows = store.getRollingSpendUsd(ONE_HOUR_MS);
    const byAgent = Object.fromEntries(rows.map((r) => [r.agentId, r.totalCostUsd]));

    // Only the in-window 0.10 counts; the 99.0 row is excluded.
    expect(byAgent["agent-a"]).toBeCloseTo(0.10, 10);
  });

  it("matches a direct SQL SUM(cost_total) GROUP BY agent_id for the same window (same source of truth)", () => {
    const now = systemNowMs();
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 1_000, costTotal: 0.10 }));
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", timestamp: now - 2_000, costTotal: 0.25 }));
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-b", timestamp: now - 3_000, costTotal: 0.40 }));
    // An out-of-window row both paths must equally exclude.
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-b", timestamp: now - 5 * ONE_HOUR_MS, costTotal: 7.0 }));

    const windowMs = ONE_HOUR_MS;
    const method = Object.fromEntries(
      store.getRollingSpendUsd(windowMs).map((r) => [r.agentId, r.totalCostUsd]),
    );

    // Direct hand-written SQL SUM for the same window. The method derives its
    // `since` from systemNowMs() internally; bind a floor below the in-window
    // rows but above the out-of-window one so the two agree on membership.
    const sinceFloor = now - windowMs;
    const direct = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT agent_id, SUM(cost_total) AS total_cost
             FROM obs_token_usage WHERE timestamp >= ? GROUP BY agent_id`,
          )
          .all(sinceFloor) as { agent_id: string; total_cost: number }[]
      ).map((r) => [r.agent_id, r.total_cost]),
    );

    expect(method).toEqual(direct);
    // And the values are the expected in-window sums.
    expect(method["agent-a"]).toBeCloseTo(0.35, 10);
    expect(method["agent-b"]).toBeCloseTo(0.40, 10);
  });

  it("returns an empty array when there are no rows in the window", () => {
    expect(store.getRollingSpendUsd(ONE_HOUR_MS)).toEqual([]);
  });

  it("spend-queries.ts validates rows via createRowMapper/parseRows (NO inline `as {...}[]` cast — AGENTS.md §6.8)", () => {
    // The cast `.all(since) as { agent_id; total_cost }[]` bypassed the Zod row
    // validation §6.8 mandates (the untyped-sqlite arch gate's regex only catches
    // NAMED-type casts, so an inline OBJECT-literal cast slipped through silently).
    // The boot-read must route rows through a mapper like the cloned-from
    // observability-queries.ts agentAggMapper.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "spend-queries.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Routes the rows through a Zod mapper (parseRows), not a blind cast.
    expect(stripped).toMatch(/\.parseRows\(/);
    // No inline object-literal cast on the statement result (the §6.8 violation).
    expect(stripped).not.toMatch(/\.all\([^)]*\)\s+as\s+\{/);
  });
});

// ---------------------------------------------------------------------------
// aggregateQuarterHourly: the aggregateHourly SQL with a 900000-ms (15-min)
// divisor in place of 3600000. The CONSERVATION pin: 4 distinct quarter-hour
// buckets inside one hour SUM (cost + tokens + callCount + cacheSaved) to that
// hour's single aggregateHourly bucket. The export rows additionally carry a
// pricingState/missingPricingCount coverage column so a finance review sees how
// trustworthy the number is — content-free (a count + the dominant 3-state
// enum), never a body/secret/query.
//
// aggregateQuarterHourly does not exist on the store pre-patch, so the import +
// call fail to type-check / throw — the conservation + coverage asserts cannot
// run until the 900000 aggregate + its pricing-coverage columns land.
// ---------------------------------------------------------------------------
describe("ObservabilityStore — aggregateQuarterHourly (the 900000-ms bucket)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const QUARTER_HOUR_MS = 15 * 60 * 1000;

  it("the 4 quarter-hour buckets SUM to the single hourly total over the same window (conservation)", () => {
    // Anchor all rows inside ONE clean hour (hourStart is a multiple of 3600000),
    // one row in each of the four 15-min buckets. The quarter-hour split must
    // reconstruct the hour exactly.
    const hourStart = 4 * ONE_HOUR_MS; // a clean hour boundary (= a multiple of 900000 too)
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 1_000, costTotal: 0.10, totalTokens: 100, cacheSaved: 0.01 }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + QUARTER_HOUR_MS + 2_000, costTotal: 0.20, totalTokens: 200, cacheSaved: 0.02 }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 2 * QUARTER_HOUR_MS + 3_000, costTotal: 0.30, totalTokens: 300, cacheSaved: 0.03 }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 3 * QUARTER_HOUR_MS + 4_000, costTotal: 0.40, totalTokens: 400, cacheSaved: 0.04 }),
    );

    const hourly = store.aggregateHourly(hourStart);
    const quarter = store.aggregateQuarterHourly(hourStart);

    // One hour bucket; four quarter-hour buckets.
    expect(hourly).toHaveLength(1);
    expect(quarter).toHaveLength(4);

    // Every quarter bucket key is a multiple of 900000 and inside the hour.
    for (const q of quarter) {
      expect(q.bucket % QUARTER_HOUR_MS).toBe(0);
      expect(q.bucket).toBeGreaterThanOrEqual(hourStart);
      expect(q.bucket).toBeLessThan(hourStart + ONE_HOUR_MS);
    }

    // CONSERVATION: the four quarter buckets reconstruct the hour to the cent.
    const qCost = quarter.reduce((s, q) => s + q.totalCost, 0);
    const qTokens = quarter.reduce((s, q) => s + q.totalTokens, 0);
    const qCalls = quarter.reduce((s, q) => s + q.callCount, 0);
    const qCacheSaved = quarter.reduce((s, q) => s + q.totalCacheSaved, 0);
    expect(qCost).toBeCloseTo(hourly[0]!.totalCost, 10);
    expect(qTokens).toBe(hourly[0]!.totalTokens);
    expect(qCalls).toBe(hourly[0]!.callCount);
    expect(qCacheSaved).toBeCloseTo(hourly[0]!.totalCacheSaved, 10);
    // And the hour itself is the sum of the four planted rows.
    expect(hourly[0]!.totalCost).toBeCloseTo(1.0, 10);
  });

  it("carries a pricingState/missingPricingCount coverage column per bucket (content-free trustworthiness)", () => {
    const hourStart = 8 * ONE_HOUR_MS;
    // Bucket 0: two priced rows + one unknown-priced row → missingPricingCount 1,
    // dominant state "priced".
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 1_000, costTotal: 0.10, pricingState: "priced" }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 2_000, costTotal: 0.20, pricingState: "priced" }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 3_000, costTotal: 0.0, pricingState: "unknown" }),
    );
    // Bucket 1: a single free row → missingPricingCount 0, dominant "free".
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + QUARTER_HOUR_MS + 1_000, costTotal: 0.0, pricingState: "free" }),
    );

    const quarter = store.aggregateQuarterHourly(hourStart).sort((a, b) => a.bucket - b.bucket);
    expect(quarter).toHaveLength(2);

    // Bucket 0: 3 rows, exactly one is "unknown" → the coverage count is 1.
    expect(quarter[0]!.missingPricingCount).toBe(1);
    expect(quarter[0]!.pricingState).toBe("priced");
    // Bucket 1: a single fully-known free row → no missing pricing.
    expect(quarter[1]!.missingPricingCount).toBe(0);
    expect(quarter[1]!.pricingState).toBe("free");
  });

  it("buckets a pre-tool_tag-era NULL pricing_state row as 'unknown' coverage (degrade honestly, never crash)", () => {
    const hourStart = 12 * ONE_HOUR_MS;
    // A row with NO pricingState (persists NULL) must count toward missingPricingCount —
    // a NULL pricing signal is the opposite of trustworthy.
    store.insertTokenUsage(makeTokenRow({ timestamp: hourStart + 1_000, costTotal: 0.5 }));
    const quarter = store.aggregateQuarterHourly(hourStart);
    expect(quarter).toHaveLength(1);
    expect(quarter[0]!.missingPricingCount).toBe(1);
    expect(quarter[0]!.totalCost).toBeCloseTo(0.5, 10);
  });

  it("honors the agent/provider/model filter as BOUND parameters (the export's SPA-equivalent filters)", () => {
    const hourStart = 16 * ONE_HOUR_MS;
    // Two agents, two providers in the same bucket; the filter must isolate one.
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 1_000, agentId: "agent-a", provider: "anthropic", model: "claude-x", costTotal: 0.10 }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 2_000, agentId: "agent-b", provider: "openai", model: "gpt-x", costTotal: 0.90 }),
    );

    // No filter → both rows in the bucket (0.10 + 0.90 = 1.0).
    const all = store.aggregateQuarterHourly(hourStart);
    expect(all).toHaveLength(1);
    expect(all[0]!.totalCost).toBeCloseTo(1.0, 10);

    // Agent filter → only agent-a's 0.10.
    const onlyA = store.aggregateQuarterHourly(hourStart, { agent: "agent-a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.totalCost).toBeCloseTo(0.10, 10);

    // Provider + model filter → only the openai/gpt-x row's 0.90.
    const onlyOpenai = store.aggregateQuarterHourly(hourStart, { provider: "openai", model: "gpt-x" });
    expect(onlyOpenai).toHaveLength(1);
    expect(onlyOpenai[0]!.totalCost).toBeCloseTo(0.90, 10);

    // A filter that matches nothing → an empty result (no crash, no full-scan leak).
    expect(store.aggregateQuarterHourly(hourStart, { agent: "nobody" })).toEqual([]);
  });

  it("aggregateHourlyCost: the 60-min sibling buckets identically + honors the filter", () => {
    const hourStart = 18 * ONE_HOUR_MS;
    // Two rows in the same hour bucket (one priced, one unknown pricing_state).
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 1_000, agentId: "agent-a", costTotal: 0.10, pricingState: "priced" }),
    );
    store.insertTokenUsage(
      makeTokenRow({ timestamp: hourStart + 2_000, agentId: "agent-a", costTotal: 0.40 }),
    );

    const hourly = store.aggregateHourlyCost(hourStart);
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.totalCost).toBeCloseTo(0.50, 10);
    // One row has no pricing_state → it counts as missing (NOT catalog-backed).
    expect(hourly[0]!.missingPricingCount).toBe(1);

    // The bound filter isolates the agent (parameterized, never interpolated).
    expect(store.aggregateHourlyCost(hourStart, { agent: "nobody" })).toEqual([]);
  });

  it("pricingCoverage: the daemon-wide three-state count (priced / free / unknown)", () => {
    store.insertTokenUsage(makeTokenRow({ costTotal: 0.10, pricingState: "priced" }));
    store.insertTokenUsage(makeTokenRow({ costTotal: 0.10, pricingState: "free" }));
    // No pricing_state → the unknown/NULL fall-through.
    store.insertTokenUsage(makeTokenRow({ costTotal: 0.10 }));

    const coverage = store.pricingCoverage();
    expect(coverage.priced).toBe(1);
    expect(coverage.free).toBe(1);
    expect(coverage.unknown).toBe(1);

    // The sinceMs lower bound is honored: a FRESH (in-window) priced row is seen,
    // while the 3 default-timestamp rows above (2023) fall outside the window.
    const now = systemNowMs();
    store.insertTokenUsage(makeTokenRow({ timestamp: now - 10_000, costTotal: 0.10, pricingState: "priced" }));
    const windowed = store.pricingCoverage(now - 1_000_000);
    expect(windowed.priced).toBe(1);
    expect(windowed.free).toBe(0);
    expect(windowed.unknown).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateToolCostByAgent(agentId, sinceMs): the REAL per-tool even-split that
// turns the persisted `tool_tag` distinct-tool set into a per-tool cost share.
// The tool_tag column only ever held the distinct tool-NAME set + asserted the
// even-split in a bridge-level comment/test; no query ever projected it, so the
// billing per-tool table was permanently empty in prod.
//
// The even-split (the comment's promise, now a real contract): for a row whose
// tool_tag lists N distinct tools, EACH tool is attributed cost_total/N (+
// total_tokens/N, 1/N call share), summed per tool across the agent's rows.
//
// THE CONSERVATION INVARIANT (the load-bearing assertion): Σ per-tool cost ===
// Σ row cost_total. The split redistributes a turn's cost across its tools; it
// never creates or destroys dollars. Content-free: tool names + numbers only.
//
// These FAIL on pre-wiring code because aggregateToolCostByAgent does not exist.
// ---------------------------------------------------------------------------
describe("ObservabilityStore — aggregateToolCostByAgent (even-split + conservation)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("even-splits a multi-tool turn's cost/tokens/calls across its distinct tools", () => {
    // One turn for agent-a fired bash + read; cost 0.30, tokens 200.
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.30, totalTokens: 200, toolTag: ["bash", "read"] }),
    );

    const rows = store.aggregateToolCostByAgent("agent-a");
    const byTool = new Map(rows.map((r) => [r.tool, r]));

    // Even split: each of the 2 tools gets half the turn's cost/tokens + a 0.5 call share.
    expect(byTool.get("bash")!.cost).toBeCloseTo(0.15, 10);
    expect(byTool.get("read")!.cost).toBeCloseTo(0.15, 10);
    expect(byTool.get("bash")!.tokens).toBeCloseTo(100, 10);
    expect(byTool.get("read")!.tokens).toBeCloseTo(100, 10);
    expect(byTool.get("bash")!.calls).toBeCloseTo(0.5, 10);
    expect(byTool.get("read")!.calls).toBeCloseTo(0.5, 10);
  });

  it("CONSERVATION: Σ per-tool cost === Σ row cost_total across many rows", () => {
    // Three rows for agent-a with varying tool counts; one single-tool, one
    // 3-tool, one repeated tool (distinct collapses to 1) — plus a NULL-tag row
    // that contributes to cost_total but is NOT attributable to any tool.
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.30, totalTokens: 300, toolTag: ["bash", "read", "edit"] }),
    );
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.10, totalTokens: 100, toolTag: ["bash"] }),
    );
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.05, totalTokens: 50, toolTag: ["read", "read"] }),
    );
    // A no-tool turn — its cost is real spend but attributable to no tool.
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.07, totalTokens: 70 }),
    );

    const rows = store.aggregateToolCostByAgent("agent-a");

    // Conservation: the per-tool shares sum to the cost of the ATTRIBUTABLE rows
    // (the rows that carry a non-null tool_tag — 0.30 + 0.10 + 0.05 = 0.45). The
    // no-tool 0.07 turn is correctly excluded (it has no tool to attribute to).
    const sumToolCost = rows.reduce((s, r) => s + r.cost, 0);
    expect(sumToolCost).toBeCloseTo(0.45, 10);

    // Same conservation for tokens (300 + 100 + 50 = 450).
    const sumToolTokens = rows.reduce((s, r) => s + r.tokens, 0);
    expect(sumToolTokens).toBeCloseTo(450, 10);

    // And for the call share: each attributable row contributes exactly 1.0 of
    // call mass split across its tools — 3 attributable rows ⇒ 3.0 total.
    const sumCalls = rows.reduce((s, r) => s + r.calls, 0);
    expect(sumCalls).toBeCloseTo(3.0, 10);
  });

  it("scopes to the requested agent only (no cross-agent leak)", () => {
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", costTotal: 0.20, toolTag: ["bash"] }));
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-b", costTotal: 0.99, toolTag: ["bash"] }));

    const aRows = store.aggregateToolCostByAgent("agent-a");
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.tool).toBe("bash");
    expect(aRows[0]!.cost).toBeCloseTo(0.20, 10);
  });

  it("honors the sinceMs lower bound", () => {
    const now = systemNowMs();
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", timestamp: now - 10_000, costTotal: 0.10, toolTag: ["bash"] }),
    );
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", timestamp: now - 10_000_000, costTotal: 0.90, toolTag: ["read"] }),
    );

    // Only the recent row is in-window.
    const recent = store.aggregateToolCostByAgent("agent-a", now - 1_000_000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.tool).toBe("bash");
    expect(recent[0]!.cost).toBeCloseTo(0.10, 10);
  });

  it("returns an empty array for an agent with only NULL-tag rows (honest empty)", () => {
    store.insertTokenUsage(makeTokenRow({ agentId: "agent-a", costTotal: 0.10 }));
    expect(store.aggregateToolCostByAgent("agent-a")).toEqual([]);
  });

  it("DEGRADES on a corrupt/non-array tool_tag — the row contributes nothing, no throw, no NaN", () => {
    // Persist one VALID multi-tool row, then directly inject rows whose tool_tag
    // is malformed (not valid JSON / a non-array JSON literal) — bypassing
    // insertTokenUsage's JSON.stringify to simulate a corrupted column. The
    // parseDistinctTools degrade-on-malformed path must skip them (no throw, and
    // they add nothing to any tool's share).
    store.insertTokenUsage(
      makeTokenRow({ agentId: "agent-a", costTotal: 0.20, totalTokens: 100, toolTag: ["bash"] }),
    );
    const insertRaw = db.prepare(`
      INSERT INTO obs_token_usage (
        timestamp, trace_id, agent_id, channel_id, session_key, provider, model,
        prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
        cost_input, cost_output, cost_total, cost_cache_read, cost_cache_write, cache_saved,
        latency_ms, tool_tag
      ) VALUES (
        1700000000000, 't-bad', 'agent-a', '', '', 'anthropic', 'claude-3-opus',
        10, 10, 50, 0, 0, 0.001, 0.001, 0.99, 0, 0, 0, 100, ?
      )
    `);
    insertRaw.run("{not valid json");   // a corrupt JSON blob → JSON.parse throws → []
    insertRaw.run('"a-bare-string"');    // valid JSON but NOT an array → []
    insertRaw.run("42");                  // valid JSON literal, non-array → []

    // No throw, and ONLY the valid bash row's cost is attributed (the 3 corrupt
    // rows contribute nothing — they have no distinct-tool set).
    const rows = store.aggregateToolCostByAgent("agent-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe("bash");
    expect(rows[0]!.cost).toBeCloseTo(0.20, 10);
    // Conservation still holds: the corrupt rows' $ are simply not tool-attributable.
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(0.20, 10);
  });
});
