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

  it("does not abort the scan on a non-object `details` (WR-01: \"null\"/primitive JSON degrade-on-error)", () => {
    // `details = "null"` is VALID JSON that parses to JS `null`; an unguarded
    // `d.degraded` then throws TypeError and aborts the WHOLE fleet aggregate —
    // the exact failure the file's "a corrupt details never aborts the scan
    // (T-159-01)" contract forbids. Seed the toxic shapes alongside valid rows.
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

  it("does not let a malformed nested toolStats/topErrorKinds value reach the rollup (WR-02)", () => {
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

    // End-to-end: feeding the rollup into the A2 reducer must yield finite numbers
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

  it("keeps a session whose only in-window row is not the global-latest (WR-04: windowed MAX(id) subquery)", () => {
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
// PERSIST-02 (observability-excellence WS5) — the obs_token_usage cost-correctness
// columns + the dead cache_retention DROP + the obs_audit_events DDL, plus the
// load-bearing insertTokenUsageStmt write-path round-trip.
//
// These prove the schema change (ensureObsTokenColumns + the table-rebuild) AND
// the FIXED prepared statement move together: without the statement edit, Test 6's
// real insert→read-back either throws on the dropped cache_retention column or
// silently never persists the 5 new columns.
// ---------------------------------------------------------------------------

/** A minimal valid TokenUsageRow with the new PERSIST-02 fields populated. */
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

describe("schema — obs_token_usage PERSIST-02 columns + cache_retention DROP", () => {
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

describe("ObservabilityStore — insertTokenUsage write-path round-trip (PERSIST-02/03)", () => {
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
// SPEND-03 — getRollingSpendUsd(windowMs): the spend-accumulator's BOOT
// rehydration read (NOT a per-check read). A per-agent SUM(cost_total) over the
// rolling window from obs_token_usage. The rows ARE the durability — this is the
// accumulator's one source of truth at boot, replacing any per-check SQL re-sum.
//
// L1: obs_token_usage has NO tenant_id column (schema.ts) — the boot read groups
// by agent_id ONLY; per-tenant accrues live-from-boot (documented honest
// degradation, Plan 03). The window bound is derived from systemNowMs() inside
// the method (the prune() precedent in observability-reset.ts), so the tests seed
// timestamps relative to a captured `now` with offsets far larger than any
// wall-clock drift between the two systemNowMs() reads.
// ---------------------------------------------------------------------------
describe("ObservabilityStore — getRollingSpendUsd (SPEND-03 boot rehydration)", () => {
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
});
