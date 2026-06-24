// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.fleet.health` handler + assembler acceptance tests (Phase 161 R2 + H1).
 *
 * Drives the REAL read fan-in (`assembleFleetHealthReport`) over:
 *   - A1/A2: a seeded `:memory:` ObservabilityStore (real `aggregateSessionsInWindow`
 *     + the pure `reduceFleetWindow`),
 *   - A3: a REAL on-disk `<tmpDataDir>/logs/session-index.<date>.jsonl` layout
 *     (AGENTS §2.10 — a fixture-only reader proves the LOGIC, not the path
 *     resolution / day-windowing; the §2.10 rule pins the on-disk contract),
 *   - I-track (Phase 160): seeded `health_signal` / `model_health` / `config_posture`
 *     diagnostic rows via the same store.
 *
 * The ONE clock read (`ClockPort.now()`) is an injected fakeClock — NO
 * Date.now()/new Date() (the globals gate). Post-WR-01 that single instant is
 * threaded as BOTH the A1/I-track window start (`sinceMs`) AND the A3 day-key
 * window upper bound (`nowMs`), so a FIXED (non-real) fake instant drives the
 * whole report coherently — the CLOCK-INDEPENDENT case pins exactly that. Most
 * cases below still seed via `systemNowMs()` so the on-disk day-files land on
 * the real-today key; the clock-independence is proven by the dedicated case.
 *
 * Cases pinned:
 *   1. ASSEMBLY — the 4 sources merge onto FleetHealthReport (sessions/topErrorKinds/
 *      breakerTripTotal/toolStats/cost/activity/findings/coverage), digest-only.
 *   2. DETERMINISM — same data + same fakeClock -> byte-identical reports (X3).
 *   3. BOUNDING — > FLEET_FINDINGS_CAP findings -> capped + a truncations[] entry.
 *   4. H1 admin gate — non-admin _trustLevel rejected at the handler;
 *      stripInternalFields keeps _trustLevel out of the report.
 *   5. EMPTY/HEURISTIC — an empty store + missing day-files -> a clean zero report
 *      whose coverage is self-evidently empty (found:false, daysMissing>0); a
 *      deterministic verdict fires when a fleet signal is present.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { systemDateFrom, systemNowMs, FleetHealthReportSchema } from "@comis/core";
import type { FleetHealthReport } from "@comis/core";
import { pipelineAuthoringGate } from "@comis/observability";
import { pipelineAuthoringAggregateFromRows } from "./fleet-findings.js";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { assembleFleetHealthReport, bindFleetHealthHandlers } from "./fleet-health.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for an epoch ms — mirrors the A3 reader's day-key derivation. */
function dayKeyForMs(ms: number): string {
  return systemDateFrom(ms).toISOString().slice(0, 10);
}

/** A fresh `:memory:` ObservabilityStore with the full schema initialized. */
function makeStore(): ObservabilityStore {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createObservabilityStore(db);
}

/** A `session_summary` `details` JSON payload (mirror sessionSummaryEventToRow). */
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

/** A session_started JSONL object (mirror fleet-session-index.test.ts). */
function startedRow(o: { agentId: string; channelType: string; channelId: string; sessionId?: string }): string {
  return JSON.stringify({
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    ts: new Date(systemNowMs()).toISOString(),
    event: "session_started",
    sessionId: o.sessionId ?? `sess-${o.agentId}`,
    sessionKey: o.sessionId ?? `sess-${o.agentId}`,
    channelType: o.channelType,
    channelId: o.channelId,
    agentId: o.agentId,
    traceIds: ["trace-1"],
  });
}

/** A session_ended JSONL object (mirror fleet-session-index.test.ts). */
function endedRow(o: { exitReason: string; turnCount: number; totalTokens: number; sessionId?: string }): string {
  return JSON.stringify({
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    ts: new Date(systemNowMs()).toISOString(),
    event: "session_ended",
    sessionId: o.sessionId ?? "sess-x",
    exitReason: o.exitReason,
    turnCount: o.turnCount,
    totalTokens: o.totalTokens,
  });
}

/**
 * A tmp dataDir with REAL `logs/session-index.<dayKey>.jsonl` files for today +
 * yesterday (so the A3 reader resolves real day-keys). Returns the absolute path.
 */
function makeDataDirWithActivity(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-health-"));
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const today = dayKeyForMs(systemNowMs());
  const yesterday = dayKeyForMs(systemNowMs() - DAY_MS);
  fs.writeFileSync(
    path.join(logsDir, `session-index.${yesterday}.jsonl`),
    [
      startedRow({ agentId: "agent-a", channelType: "telegram", channelId: "111", sessionId: "s1" }),
      endedRow({ exitReason: "success", turnCount: 3, totalTokens: 100, sessionId: "s1" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(logsDir, `session-index.${today}.jsonl`),
    [
      startedRow({ agentId: "agent-b", channelType: "discord", channelId: "222", sessionId: "s2" }),
      endedRow({ exitReason: "error", turnCount: 2, totalTokens: 50, sessionId: "s2" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  return dataDir;
}

/**
 * Seed the store with two session_summary rows (one degraded), one health_signal,
 * one model_health, one config_posture row. `now` is the fakeClock instant so the
 * rows sit inside the 24h window.
 */
function seedStore(store: ObservabilityStore, now: number): void {
  store.insertDiagnostic({
    timestamp: now - 1_000,
    category: "session_summary",
    severity: "info",
    sessionKey: "s1",
    message: "session:summary",
    details: summaryDetails({
      degraded: false,
      costUsd: 0.1,
      turnCount: 3,
      toolStats: { web_search: { ok: 5, failed: 0 } },
    }),
  });
  store.insertDiagnostic({
    timestamp: now - 500,
    category: "session_summary",
    severity: "warning",
    sessionKey: "s2",
    message: "session:summary",
    details: summaryDetails({
      degraded: true,
      costUsd: 0.4,
      turnCount: 2,
      breakerTripCount: 2,
      topErrorKinds: { tool_timeout: 3 },
      toolStats: { web_search: { ok: 1, failed: 4 } },
      endReason: "context_exhausted",
    }),
  });
  store.insertDiagnostic({
    timestamp: now - 2_000,
    category: "health_signal",
    severity: "warning",
    message: "LCD divergence detected on agent default",
    details: JSON.stringify({ signal: "lcd_divergence", reason: "fail_closed_rollover", conversationId: "c1" }),
  });
  store.insertDiagnostic({
    timestamp: now - 3_000,
    category: "model_health",
    severity: "warning",
    message: "provider degraded",
    details: JSON.stringify({ provider: "anthropic", degraded: true }),
  });
  store.insertDiagnostic({
    timestamp: now - 4_000,
    category: "config_posture",
    severity: "warning",
    message: "gateway TLS disabled",
    details: JSON.stringify({ tlsEnabled: false }),
  });
}

/** Minimal handler deps (mirror obs-explain.test.ts makeDeps). */
function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return { agents: {}, ...overrides } as unknown as ObsHandlerDeps;
}

describe("assembleFleetHealthReport (R2 — 4-source read fan-in)", () => {
  it("merges A1+A2+A3+I-track onto FleetHealthReport (digest-only, with coverage)", async () => {
    const now = systemNowMs();
    const clock = createFakeClock(now);
    const store = makeStore();
    seedStore(store, now);
    const dataDir = makeDataDirWithActivity();

    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock }, 24);

    expect(report.schemaVersion).toBe(1);
    expect(report.windowHours).toBe(24);
    // A1/A2: 2 sessions, 1 degraded.
    expect(report.sessions.total).toBe(2);
    expect(report.sessions.degraded).toBe(1);
    expect(report.sessions.degradedRate).toBeCloseTo(0.5);
    // QT2/QT3: the degraded session is bucketed by its named endReason cause.
    // The clean session (endReason:success) does NOT appear here.
    expect(report.degradedByCause).toEqual({ context_exhausted: 1 });
    // Merged errorKinds (capped) + breaker total + per-tool ok/failed from the reducer.
    expect(report.topErrorKinds).toEqual([{ kind: "tool_timeout", count: 3 }]);
    expect(report.breakerTripTotal).toBe(2);
    expect(report.toolStats.web_search).toEqual({ ok: 6, failed: 4 });
    expect(report.cost.costUsd).toBeCloseTo(0.5);
    // A3 activity (real on-disk day-files).
    expect(report.activity.activeAgents).toEqual(["agent-a", "agent-b"]);
    expect(report.activity.activeChannels).toEqual(["discord:222", "telegram:111"]);
    expect(report.activity.turnTotal).toBe(5);
    expect(report.activity.tokenTotal).toBe(150);
    expect(report.cost.totalTokens).toBe(150);
    expect(report.activity.exitReasons).toEqual({ error: 1, success: 1 });
    // I-track findings carry counts + codes + hints ONLY — no raw message bodies.
    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(typeof f.code).toBe("string");
      expect(typeof f.count).toBe("number");
      expect(typeof f.hint).toBe("string");
      // No raw WARN body leaked into the finding (H1 / digest-only).
      expect(f.detail).not.toContain("LCD divergence detected on agent default");
      expect(f.detail).not.toContain("gateway TLS disabled");
    }
    // Coverage honesty block populated from the real reads.
    expect(report.coverage?.sessionSummary).toEqual({ found: true, rows: 2 });
    expect(report.coverage?.sessionIndex.daysRead).toBe(2);
    expect(report.coverage?.sessionIndex.daysMissing).toBe(0);
    expect(report.coverage?.billing).toEqual({ present: true });
  });

  it("EXCLUDES a synthetic degraded row from sessions.degraded — reconciling with total/degradedRate/degradedByCause (WR-01)", async () => {
    // WR-01: `total` and `degradedRate` are synthetic-excluded (the reducer
    // drops source!=="runtime"), but the absolute `sessions.degraded` was
    // derived from the UNFILTERED store rows — so a `{degraded:true,
    // source:"test"}` row inflated `degraded` (could exceed `total`, disagree
    // with `degradedRate`, and contradict `sum(degradedByCause)`). After the fix
    // all three `sessions` fields share the synthetic-excluded population.
    const now = systemNowMs();
    const clock = createFakeClock(now);
    const store = makeStore();
    // 3 runtime sessions, exactly ONE degraded (context_exhausted).
    store.insertDiagnostic({
      timestamp: now - 100,
      category: "session_summary",
      severity: "warning",
      sessionKey: "r1",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0.2, endReason: "context_exhausted" }),
    });
    store.insertDiagnostic({
      timestamp: now - 200,
      category: "session_summary",
      severity: "info",
      sessionKey: "r2",
      message: "session:summary",
      details: summaryDetails({ degraded: false }),
    });
    store.insertDiagnostic({
      timestamp: now - 300,
      category: "session_summary",
      severity: "info",
      sessionKey: "r3",
      message: "session:summary",
      details: summaryDetails({ degraded: false }),
    });
    // A SYNTHETIC degraded row (source:"test") — must NOT inflate sessions.degraded.
    store.insertDiagnostic({
      timestamp: now - 400,
      category: "session_summary",
      severity: "warning",
      sessionKey: "t1",
      message: "session:summary",
      details: summaryDetails({ degraded: true, source: "test", endReason: "output_starved" }),
    });
    const dataDir = makeDataDirWithActivity();

    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock }, 24);

    // Synthetic-excluded population: 3 runtime sessions, 1 degraded.
    expect(report.sessions.total).toBe(3);
    expect(report.sessions.degraded).toBe(1); // NOT 2 — the synthetic row is excluded.
    expect(report.sessions.degradedRate).toBeCloseTo(1 / 3);
    // sessions.degraded never exceeds total.
    expect(report.sessions.degraded).toBeLessThanOrEqual(report.sessions.total);
    // degraded reconciles with degradedRate exactly.
    expect(report.sessions.degraded / report.sessions.total).toBeCloseTo(report.sessions.degradedRate);
    // And with sum(degradedByCause) (the reducer caps the cause spread but the
    // synthetic row's cause is excluded entirely).
    const sumByCause = Object.values(report.degradedByCause).reduce((a, b) => a + b, 0);
    expect(report.sessions.degraded).toBe(sumByCause);
    expect(report.degradedByCause).not.toHaveProperty("output_starved");
    expect(report.degradedByCause).toEqual({ context_exhausted: 1 });
    // coverage.sessionSummary.rows stays UNFILTERED (read-coverage breadcrumb) —
    // it counts every row read (4), pre-exclusion. This must NOT be reconciled.
    expect(report.coverage?.sessionSummary.rows).toBe(4);
  });

  it("is DETERMINISTIC: same data + same fakeClock -> byte-identical reports", async () => {
    const now = systemNowMs();
    const store = makeStore();
    seedStore(store, now);
    const dataDir = makeDataDirWithActivity();

    const a = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);
    const b = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("CLOCK-INDEPENDENT: the A3 window follows the INJECTED clock, not real Date.now() (WR-01)", async () => {
    // WR-01 regression: the assembler documents "the ONE clock read is the
    // injected ClockPort". A FIXED, historical fake instant (NOT real now) must
    // drive BOTH the A1/I-track window AND the A3 day-key window. We write the
    // session-index day-file keyed to the fixed instant's day; if the A3 reader
    // honoured the injected clock the report reads it (daysRead>0, real tokens).
    // Pre-fix the reader uses its own systemNowMs() (real today) → it looks for
    // a file at the real-today key, misses the historical one → daysRead 0,
    // tokenTotal 0. This FAILS on the pre-patch code.
    const fixedNow = Date.UTC(2021, 5, 15, 12, 0, 0); // 2021-06-15T12:00:00Z — not today
    const fixedClock = createFakeClock(fixedNow);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-health-fixedclock-"));
    const logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const fixedDayKey = dayKeyForMs(fixedNow); // "2021-06-15"
    fs.writeFileSync(
      path.join(logsDir, `session-index.${fixedDayKey}.jsonl`),
      [
        startedRow({ agentId: "agent-h", channelType: "telegram", channelId: "777", sessionId: "h1" }),
        endedRow({ exitReason: "success", turnCount: 4, totalTokens: 321, sessionId: "h1" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const report = await assembleFleetHealthReport({ obsStore: makeStore(), dataDir, clock: fixedClock }, 24);

    // The A3 reader must have located + read the historical-keyed day-file
    // because the window upper bound follows the injected clock.
    expect(report.coverage?.sessionIndex.daysRead).toBe(1);
    expect(report.activity.activeAgents).toEqual(["agent-h"]);
    expect(report.activity.turnTotal).toBe(4);
    expect(report.activity.tokenTotal).toBe(321);
    expect(report.cost.totalTokens).toBe(321);
  });

  it("BOUNDS findings to the cap and records the drop in truncations[]", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Seed many DISTINCT health_signal labels so findings exceed FLEET_FINDINGS_CAP
    // (findings are grouped by the closed `signal` label, so distinct labels are
    // distinct findings).
    for (let i = 0; i < 20; i += 1) {
      store.insertDiagnostic({
        timestamp: now - i * 10,
        category: "health_signal",
        severity: "warning",
        message: `signal ${i}`,
        details: JSON.stringify({ signal: `signal_${i}` }),
      });
    }
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);

    expect(report.findings.length).toBeLessThanOrEqual(8);
    expect(report.truncations.some((t) => t.field === "findings")).toBe(true);
  });

  it("EMPTY: no store rows + no day-files -> a self-evidently empty report (not a clean zero)", async () => {
    const now = systemNowMs();
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-health-empty-"));
    const report = await assembleFleetHealthReport(
      { obsStore: makeStore(), dataDir: emptyDataDir, clock: createFakeClock(now) },
      24,
    );

    expect(report.sessions.total).toBe(0);
    expect(report.sessions.degradedRate).toBe(0);
    // Coverage makes the emptiness self-evident (not masquerading as healthy).
    expect(report.coverage?.sessionSummary.found).toBe(false);
    expect(report.coverage?.sessionIndex.daysMissing).toBeGreaterThan(0);
    // No fleet signal fired -> null verdict (a clean session has no root cause).
    expect(report.likelyRootCause).toBeNull();
  });

  it("GUARDS a non-finite sinceHours: Infinity is clamped to the default window, not a -Infinity bound (IN-01)", async () => {
    // IN-01 defense-in-depth: the contract rejects a non-finite sinceHours at
    // the parse boundary, but the assembler is also reachable directly (the MCP
    // closure) and must not turn a non-finite sinceHours into windowHours:
    // Infinity / sinceMs: -Infinity. The guard clamps to the default window.
    // Pre-fix windowHours is Infinity (RED).
    const now = systemNowMs();
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport(
      { obsStore: makeStore(), dataDir, clock: createFakeClock(now) },
      Number.POSITIVE_INFINITY,
    );

    // The window is clamped to the finite default — never Infinity.
    expect(Number.isFinite(report.windowHours)).toBe(true);
    expect(report.windowHours).toBe(24);
  });

  it("GUARDS a NaN sinceHours: clamps to the default window rather than producing NaN bounds (IN-01)", async () => {
    const now = systemNowMs();
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport(
      { obsStore: makeStore(), dataDir, clock: createFakeClock(now) },
      Number.NaN,
    );
    expect(Number.isFinite(report.windowHours)).toBe(true);
    expect(report.windowHours).toBe(24);
  });

  it("HEURISTIC (W9): acute named degradation outranks chronic config posture below the rate threshold", async () => {
    // Live incident shape: 3 sessions, 1 degraded (rate 0.33 < HIGH threshold)
    // with a NAMED cause, plus a standing TLS-off posture row. The verdict must
    // point at the acute degradation, not the chronic posture.
    const now = systemNowMs();
    const store = makeStore();
    store.insertDiagnostic({
      timestamp: now - 100,
      category: "session_summary",
      severity: "warning",
      sessionKey: "s-degraded",
      message: "session:summary",
      details: summaryDetails({ degraded: true, costUsd: 0, turnCount: 2, endReason: "context_exhausted" }),
    });
    for (const key of ["s-clean-1", "s-clean-2"]) {
      store.insertDiagnostic({
        timestamp: now - 100,
        category: "session_summary",
        severity: "info",
        sessionKey: key,
        message: "session:summary",
        details: summaryDetails({ degraded: false, costUsd: 0, turnCount: 1 }),
      });
    }
    store.insertDiagnostic({
      timestamp: now - 200,
      category: "config_posture",
      severity: "warning",
      message: "gateway TLS disabled",
      details: JSON.stringify({ tlsEnabled: false }),
    });
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);

    expect(report.likelyRootCause?.code).toBe("fleet_acute_degradation");
    expect(report.likelyRootCause?.detail).toContain("context_exhausted");
    expect(report.likelyRootCause?.suggestedNextSteps.join(" | ")).toContain("comis explain");
  });

  it("HEURISTIC (W9): chronic config posture still wins when no session degraded", async () => {
    const now = systemNowMs();
    const store = makeStore();
    store.insertDiagnostic({
      timestamp: now - 100,
      category: "session_summary",
      severity: "info",
      sessionKey: "s-clean",
      message: "session:summary",
      details: summaryDetails({ degraded: false, costUsd: 0, turnCount: 1 }),
    });
    store.insertDiagnostic({
      timestamp: now - 200,
      category: "config_posture",
      severity: "warning",
      message: "gateway TLS disabled",
      details: JSON.stringify({ tlsEnabled: false }),
    });
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);

    expect(report.likelyRootCause?.code).toBe("fleet_config_posture");
  });

  it("HEURISTIC: a high degraded rate yields a deterministic likelyRootCause verdict", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Three sessions, all degraded -> degradedRate 1.0 (> the fleet threshold).
    for (const key of ["s1", "s2", "s3"]) {
      store.insertDiagnostic({
        timestamp: now - 100,
        category: "session_summary",
        severity: "warning",
        sessionKey: key,
        message: "session:summary",
        details: summaryDetails({ degraded: true, costUsd: 0.1, turnCount: 1 }),
      });
    }
    const dataDir = makeDataDirWithActivity();
    const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);

    expect(report.likelyRootCause).not.toBeNull();
    expect(report.likelyRootCause?.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// KNOB-03 (Phase 176): the dedicated config_posture:served_below_configured
// finding. Count comes from the LATEST config_posture row's details JSON
// (posture is STANDING STATE, not cumulative — research Open Q3 resolution),
// parsed defensively (the healthSignalLabel clone: malformed/missing/non-number
// folds to 0, never throws — T-176-13).
// ---------------------------------------------------------------------------

/** A config_posture `details` JSON in the buildConfigPostureRecord shape. */
function postureDetails(servedBelowConfiguredCount: unknown): string {
  return JSON.stringify({
    tlsOff: false,
    allowInsecureHttp: false,
    stranded: [],
    canaryFallbackActive: false,
    servedBelowConfiguredCount,
  });
}

/** Insert one config_posture row at `timestamp` with the given raw details. */
function insertPostureRow(store: ObservabilityStore, timestamp: number, details: string): void {
  store.insertDiagnostic({
    timestamp,
    category: "config_posture",
    severity: "warning",
    message: "config_posture",
    details,
  });
}

/** A fresh empty tmp dataDir (the A3 reader soft-fails to daysMissing). */
function emptyDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-served-below-"));
}

// ---------------------------------------------------------------------------
// TELEM-02 (Plan 173-04) — the pipelineAuthoringGate verdict surfaced on the
// FleetHealthReport. Seeds `pipeline_authoring` health_signal rows, asserts the
// assembler computes pipelineAuthoringGate(pipelineAuthoringAggregateFromRows())
// and surfaces it, AND that the returned report ROUND-TRIPS the verdict through
// FleetHealthReportSchema.parse() (guards against schema/daemon drift).
// ---------------------------------------------------------------------------

/** Insert one `pipeline_authoring` health_signal row at `ts`. */
function insertPipelineAuthoringRow(
  store: ObservabilityStore,
  ts: number,
  tier: string,
  schemaValid: boolean,
): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: schemaValid ? "info" : "warning",
    message: "pipeline:authored",
    details: JSON.stringify({ signal: "pipeline_authoring", action: "define", tier, schemaValid, repaired: false }),
  });
}

describe("assembleFleetHealthReport — TELEM-02 pipelineAuthoringGate verdict", () => {
  it("surfaces buildAuthor:true when >= 20 small-tier rows are materially below frontier — and the verdict round-trips .parse()", async () => {
    const now = systemNowMs();
    const clock = createFakeClock(now);
    const store = makeStore();
    // 20 small-tier authorings, all invalid (0% valid); 5 frontier, all valid (100%).
    for (let i = 0; i < 20; i++) insertPipelineAuthoringRow(store, now - (i + 1) * 10, "small", false);
    for (let i = 0; i < 5; i++) insertPipelineAuthoringRow(store, now - (i + 100) * 10, "frontier", true);

    const report = await assembleFleetHealthReport({ obsStore: store, dataDir: emptyDataDir(), clock }, 24);

    expect(report.pipelineAuthoringGate).toBeDefined();
    expect(report.pipelineAuthoringGate?.buildAuthor).toBe(true);
    // The verdict SURVIVES the wire parse (BLOCKER-1 guard against schema drift).
    const parsed = FleetHealthReportSchema.parse(report);
    expect(parsed.pipelineAuthoringGate?.buildAuthor).toBe(true);
  });

  it("surfaces buildAuthor:false (defer) when there is no pipeline_authoring telemetry (the build-from-scratch state)", async () => {
    const now = systemNowMs();
    const clock = createFakeClock(now);
    const store = makeStore();
    seedStore(store, now); // health_signal rows, but NONE are pipeline_authoring.

    const report = await assembleFleetHealthReport({ obsStore: store, dataDir: emptyDataDir(), clock }, 24);

    expect(report.pipelineAuthoringGate?.buildAuthor).toBe(false);
    expect(report.pipelineAuthoringGate?.reason).toMatch(/insufficient telemetry/);
    // Round-trips the defer verdict too.
    const parsed = FleetHealthReportSchema.parse(report);
    expect(parsed.pipelineAuthoringGate?.buildAuthor).toBe(false);
  });

  it("the reducer + the gate COMPOSE: the report's verdict equals pipelineAuthoringGate(pipelineAuthoringAggregateFromRows(rows)) — one deterministic path", async () => {
    const now = systemNowMs();
    const clock = createFakeClock(now);
    const store = makeStore();
    for (let i = 0; i < 25; i++) insertPipelineAuthoringRow(store, now - (i + 1) * 10, "small", i % 5 === 0);
    for (let i = 0; i < 4; i++) insertPipelineAuthoringRow(store, now - (i + 100) * 10, "frontier", true);

    const report = await assembleFleetHealthReport({ obsStore: store, dataDir: emptyDataDir(), clock }, 24);

    // Recompute via the SAME windowed rows the assembler reads.
    const rows = store.queryDiagnostics({ category: "health_signal" });
    const expected = pipelineAuthoringGate(pipelineAuthoringAggregateFromRows(rows));
    expect(report.pipelineAuthoringGate).toEqual(expected);
  });
});

describe("buildFindings — config_posture:served_below_configured (KNOB-03)", () => {
  it("KNOB-03-3: emits the dedicated finding with the row's count, the provider-count detail, and the Ollama-knob hint", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertPostureRow(store, now - 1_000, postureDetails(2));

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );

    const finding = report.findings.find((f) => f.code === "config_posture:served_below_configured");
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(2);
    expect(finding?.detail).toBe("Ollama served context window below configured for 2 provider(s)");
    expect(finding?.hint).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(finding?.hint).toMatch(/num_ctx/);
  });

  it("RESOLVE-01: emits config_posture:chimeric_model from the latest posture row's chimericModelCount (incident ffe11736)", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertPostureRow(
      store,
      now - 1_000,
      JSON.stringify({
        tlsOff: false,
        allowInsecureHttp: false,
        stranded: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        chimericModelCount: 1,
      }),
    );

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );

    const finding = report.findings.find((f) => f.code === "config_posture:chimeric_model");
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.detail).toMatch(/native provider \+ a foreign model family|chimera/i);
    expect(finding?.hint).toMatch(/provider/i);
  });

  it("KNOB-03-4: reads the LATEST row only (standing state, not cumulative) — a newer 0 suppresses an older 3; a newer 1 emits count 1", async () => {
    const now = systemNowMs();

    // Newer row (count 0) inserted FIRST so any insertion-order shortcut picks
    // the wrong row — the impl must scan for max timestamp.
    const storeSuppressed = makeStore();
    insertPostureRow(storeSuppressed, now - 1_000, postureDetails(0));
    insertPostureRow(storeSuppressed, now - 5_000, postureDetails(3));
    const reportSuppressed = await assembleFleetHealthReport(
      { obsStore: storeSuppressed, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );
    expect(
      reportSuppressed.findings.some((f) => f.code === "config_posture:served_below_configured"),
    ).toBe(false);

    // Newer row count 1 over an older count 3 → finding count 1 (never 3 or 4).
    const storeLatest = makeStore();
    insertPostureRow(storeLatest, now - 1_000, postureDetails(1));
    insertPostureRow(storeLatest, now - 5_000, postureDetails(3));
    const reportLatest = await assembleFleetHealthReport(
      { obsStore: storeLatest, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );
    const finding = reportLatest.findings.find(
      (f) => f.code === "config_posture:served_below_configured",
    );
    expect(finding?.count).toBe(1);
  });

  it("KNOB-03-5: folds malformed / missing-field / non-number details to 0 without throwing, keeps the generic rollup, and a valid LATEST row still emits over an older malformed one", async () => {
    const now = systemNowMs();

    // Each defensive fold variant as the (only, hence latest) posture row:
    // (a) not JSON at all, (b) valid JSON missing the field, (c) non-number field.
    const variants = [
      "not json",
      JSON.stringify({ tlsOff: true, allowInsecureHttp: false, stranded: [], canaryFallbackActive: false }),
      postureDetails("two"),
    ];
    for (const details of variants) {
      const store = makeStore();
      insertPostureRow(store, now - 1_000, details);
      const report = await assembleFleetHealthReport(
        { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
        24,
      );
      // No served finding, no throw — and the generic config_posture rollup
      // finding is still emitted (the malformed row only loses its count).
      expect(report.findings.some((f) => f.code === "config_posture:served_below_configured")).toBe(false);
      expect(report.findings.some((f) => f.code === "config_posture")).toBe(true);
    }

    // An older malformed row never blocks the valid LATEST row's count.
    const store = makeStore();
    insertPostureRow(store, now - 5_000, "not json");
    insertPostureRow(store, now - 1_000, postureDetails(2));
    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );
    expect(
      report.findings.find((f) => f.code === "config_posture:served_below_configured")?.count,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// OBS-01 / Phase 180 — the two dedicated multilingual fleet findings.
// script_zero_hit rows group by (scriptClass, lane) into one finding per group
// reading exactly "N non-Latin zero-hit searches (script=X, lane=Y)";
// summary_language_mismatch rows roll up to one count whose hint names
// contextEngine.compaction.strongerSummarizerModel. Both are dedicated branches
// (the KNOB-03 precedent) — the generic `health_signal:<label>` loop must NOT
// also emit a finding for these labels (no double-report). Counts/enums/hints
// only — never raw WARN bodies (the v2.15 fleet rule).
// RED: the dedicated branches do not exist yet, so today these surface only via
// the generic `health_signal:script_zero_hit` rollup (wrong code + wrong detail
// string + no named hint), failing every assertion below.
// ---------------------------------------------------------------------------

/** Insert one health_signal row at `ts` with the given details JSON. */
function insertHealthSignal(store: ObservabilityStore, ts: number, details: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "context:script_zero_hit",
    details,
  });
}

describe("buildFindings — OBS-01 script_zero_hit dedicated finding", () => {
  it("emits one finding per (scriptClass, lane) group with the exact detail string and the doctor-repair hint", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Two hebrew/tri + one hebrew/word + one arabic/scan → 3 distinct groups.
    insertHealthSignal(store, now - 1, JSON.stringify({ signal: "script_zero_hit", scriptClass: "hebrew", lane: "tri", conversationId: "c1" }));
    insertHealthSignal(store, now - 2, JSON.stringify({ signal: "script_zero_hit", scriptClass: "hebrew", lane: "tri", conversationId: "c2" }));
    insertHealthSignal(store, now - 3, JSON.stringify({ signal: "script_zero_hit", scriptClass: "hebrew", lane: "word", conversationId: "c3" }));
    insertHealthSignal(store, now - 4, JSON.stringify({ signal: "script_zero_hit", scriptClass: "arabic", lane: "scan", conversationId: "c4" }));

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );

    const heTri = report.findings.find(
      (f) => f.code === "script_zero_hit" && f.detail.includes("script=hebrew, lane=tri"),
    );
    expect(heTri).toBeDefined();
    expect(heTri?.count).toBe(2);
    expect(heTri?.detail).toBe("2 non-Latin zero-hit searches (script=hebrew, lane=tri)");
    expect(heTri?.hint).toMatch(/comis doctor --repair/);

    expect(
      report.findings.some((f) => f.code === "script_zero_hit" && f.detail === "1 non-Latin zero-hit searches (script=hebrew, lane=word)"),
    ).toBe(true);
    expect(
      report.findings.some((f) => f.code === "script_zero_hit" && f.detail === "1 non-Latin zero-hit searches (script=arabic, lane=scan)"),
    ).toBe(true);

    // No double-report: the generic health_signal:script_zero_hit rollup must NOT appear.
    expect(report.findings.some((f) => f.code === "health_signal:script_zero_hit")).toBe(false);

    // Bounded payload: no raw WARN body / query text in any finding detail.
    for (const f of report.findings) {
      expect(f.detail).not.toMatch(/conversationId|c1|c2|c3|c4/);
    }
  });
});

describe("buildFindings — OBS-01 summary_language_mismatch dedicated finding", () => {
  it("rolls up to one count whose hint names contextEngine.compaction.strongerSummarizerModel", async () => {
    const now = systemNowMs();
    const store = makeStore();
    for (let i = 0; i < 3; i += 1) {
      store.insertDiagnostic({
        timestamp: now - i,
        category: "health_signal",
        severity: "warning",
        message: "context:summary_language_mismatch",
        details: JSON.stringify({ signal: "summary_language_mismatch", sourceScript: "hebrew", summaryScript: "latin", depth: 1 }),
      });
    }

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );

    const finding = report.findings.find((f) => f.code === "summary_language_mismatch");
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(3);
    expect(finding?.hint).toMatch(/contextEngine\.compaction\.strongerSummarizerModel/);
    // No double-report via the generic rollup.
    expect(report.findings.some((f) => f.code === "health_signal:summary_language_mismatch")).toBe(false);
  });
});

describe("buildFindings — GENQ-01 generation_quality dedicated finding", () => {
  it("rolls up the memory-generation passes to one count whose hint names the R6 memory-ops knob", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Mixed passes + issue flags — all roll into the one generation_quality count.
    const rows = [
      { pass: "user_representation", languageMismatch: true, emptyOutput: false, formatViolation: false },
      { pass: "consolidation", languageMismatch: false, emptyOutput: false, formatViolation: true },
      { pass: "reasoning", languageMismatch: true, emptyOutput: false, formatViolation: false },
    ];
    rows.forEach((r, i) =>
      store.insertDiagnostic({
        timestamp: now - i,
        category: "health_signal",
        severity: "warning",
        message: "memory:generation_quality",
        details: JSON.stringify({ signal: "generation_quality", sourceScript: "hebrew", outputScript: "latin", ...r }),
      }),
    );

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );

    const finding = report.findings.find((f) => f.code === "generation_quality");
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(3);
    expect(finding?.hint).toMatch(/capabilityClass/);
    expect(finding?.hint).toMatch(/memory/i);
    // No double-report via the generic health_signal:<label> rollup.
    expect(report.findings.some((f) => f.code === "health_signal:generation_quality")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FLEET-01/02/04 (Phase 220-03) — the AUTONOMY block on the FleetHealthReport.
// The assembler reads DurableRunPort.countByStatus(sinceMs) (orphaned/revoked +
// running/completed for the degraded-rate denominator) AND the health_signal
// rows Plan 01 persists (resumed/killed counts + the worst rootRunId). The
// breaker subset reads back from the synthetic-excluded reduceFleetWindow
// (degradedByCause["denial_breaker"]), NEVER re-derived. Deterministic (one
// clock read, no Date.now()), content-free, admin-gated unchanged.
//
// RED: there is no autonomy block, no durableRuns dep — every assertion fails on
// the pre-patch code.
// ---------------------------------------------------------------------------

/** The `countByStatus` windowed shape (mirror DurableRunPort.countByStatus). */
type DurableStatusCounts = { orphaned: number; revoked: number; running: number; completed: number };

/**
 * A fake DurableRunPort whose `countByStatus` returns a fixed windowed count. The
 * assembler ONLY calls `countByStatus`; the other DurableRunPort methods are
 * never reached, so they are stub `ok`-returns that throw if (unexpectedly) called.
 */
function fakeDurableRuns(counts: DurableStatusCounts): import("@comis/core").DurableRunPort {
  const unexpected = (): never => {
    throw new Error("fakeDurableRuns: only countByStatus is expected to be called");
  };
  return {
    countByStatus: async (_sinceMs: number) => ({ ok: true as const, value: counts }),
    upsertCheckpoint: unexpected,
    listResumable: unexpected,
    getByRootRun: unexpected,
    markOrphaned: unexpected,
    markCompleted: unexpected,
    touchHeartbeat: unexpected,
    invalidateForRevoke: unexpected,
    allocateOutwardStep: unexpected,
  } as unknown as import("@comis/core").DurableRunPort;
}

/** Insert a Plan-01 `durable_orphaned` health_signal row (closed reason + rootRunId). */
function insertOrphanedRow(store: ObservabilityStore, ts: number, reason: string, rootRunId: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "durable:orphaned",
    details: JSON.stringify({ signal: "durable_orphaned", reason, rootRunId }),
  });
}

/** Insert a Plan-01 `durable_resumed` health_signal row (healthy recovery — info). */
function insertResumedRow(store: ObservabilityStore, ts: number, rootRunId: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "info",
    message: "durable:resumed",
    details: JSON.stringify({ signal: "durable_resumed", stepIndex: 3, rootRunId }),
  });
}

/** Insert a Plan-01 `autonomy_revoked` health_signal row (revoked count + rootRunId). */
function insertRevokedRow(store: ObservabilityStore, ts: number, revoked: number, rootRunId: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "autonomy:revoked",
    details: JSON.stringify({ signal: "autonomy_revoked", revoked, rootRunId }),
  });
}

/** Insert a Plan-01 `autonomy_killed` health_signal row (killed count + rootRunId). */
function insertKilledRow(store: ObservabilityStore, ts: number, killed: number, rootRunId: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "autonomy:killed",
    details: JSON.stringify({ signal: "autonomy_killed", killed, rootRunId }),
  });
}

/** Insert a FLEET-02 (220-05) `autonomy_denial_breaker` health_signal row — the
 *  capability-denial breaker (Phase 217) tripped + aborted the run tree. Content-free:
 *  the closed signal label + the rootRunId (an id) + count ONLY. This is the EVENT-
 *  sourced source (an `execution:aborted{reason:"denial_breaker"}`-class abort), NOT a
 *  session endReason / breakerTripCount — the existing `breakerTrips` read-back can
 *  NEVER see it. */
function insertDenialBreakerRow(store: ObservabilityStore, ts: number, rootRunId: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "autonomy:denial_breaker_tripped",
    details: JSON.stringify({ signal: "autonomy_denial_breaker", denialBreakerTrips: 1, rootRunId }),
  });
}

/** A session_summary row for a real breaker-tripped run: breakerTripCount >= 1. The FLEET-02
 *  breaker source is the summed breakerTripCount (→ breakerTripTotal), NOT the endReason —
 *  `denial_breaker` is never a session endReason, only an execution:aborted event reason. */
function insertBreakerDegradedRow(store: ObservabilityStore, ts: number, sessionKey: string): void {
  store.insertDiagnostic({
    timestamp: ts,
    category: "session_summary",
    severity: "warning",
    sessionKey,
    message: "session:summary",
    details: summaryDetails({ degraded: true, costUsd: 0.3, breakerTripCount: 1, endReason: "context_exhausted" }),
  });
}

describe("assembleFleetHealthReport — FLEET-01/02/04 autonomy block", () => {
  it("FLEET-01: surfaces autonomy run counts + degradedRate from countByStatus (orphaned+revoked degraded; deterministic)", async () => {
    const now = systemNowMs();
    const store = makeStore();
    const dataDir = emptyDataDir();
    // running:5 completed:12 orphaned:2 revoked:1 → total 20, degraded (orphaned+revoked) 3, rate 0.15.
    const durableRuns = fakeDurableRuns({ orphaned: 2, revoked: 1, running: 5, completed: 12 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir, clock: createFakeClock(now), durableRuns },
      24,
    );

    expect(report.autonomy).toBeDefined();
    expect(report.autonomy?.runs.total).toBe(20);
    expect(report.autonomy?.runs.degraded).toBe(3);
    expect(report.autonomy?.runs.degradedRate).toBeCloseTo(3 / 20);
    expect(report.autonomy?.orphaned).toBe(2);
    expect(report.autonomy?.revoked).toBe(1);
    // degraded never exceeds total (T-220-11 metric integrity).
    expect(report.autonomy!.runs.degraded).toBeLessThanOrEqual(report.autonomy!.runs.total);

    // DETERMINISM: same input → byte-identical report (T-220-12).
    const a = await assembleFleetHealthReport(
      { obsStore: store, dataDir, clock: createFakeClock(now), durableRuns: fakeDurableRuns({ orphaned: 2, revoked: 1, running: 5, completed: 12 }) },
      24,
    );
    const b = await assembleFleetHealthReport(
      { obsStore: store, dataDir, clock: createFakeClock(now), durableRuns: fakeDurableRuns({ orphaned: 2, revoked: 1, running: 5, completed: 12 }) },
      24,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("FLEET-01: resumed + killed counts come from the health_signal rows (event-sourced; kill separable from revoke)", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // countByStatus folds kill→revoked in the table; resumed/killed are event-sourced.
    insertResumedRow(store, now - 100, "root-res1");
    insertResumedRow(store, now - 200, "root-res2");
    insertKilledRow(store, now - 300, 1, "root-kill1");
    const durableRuns = fakeDurableRuns({ orphaned: 1, revoked: 2, running: 3, completed: 4 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );

    // resumed from the 2 durable_resumed rows; killed from the 1 autonomy_killed row.
    expect(report.autonomy?.resumed).toBe(2);
    expect(report.autonomy?.killed).toBe(1);
    // revoked stays the crash-surviving countByStatus value (2) — distinct from killed (1).
    expect(report.autonomy?.revoked).toBe(2);
    expect(report.autonomy?.killed).not.toBe(report.autonomy?.revoked);
  });

  it("FLEET-02: breakerTrips reads back the synthetic-excluded breakerTripTotal; budgetBreaches from the breach rows", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Two breaker-tripped sessions (breakerTripCount:1 each) → breakerTripTotal = 2.
    insertBreakerDegradedRow(store, now - 100, "b1");
    insertBreakerDegradedRow(store, now - 200, "b2");
    // A budget-breach health_signal (the node_budget_exceeded label is the breach source).
    store.insertDiagnostic({
      timestamp: now - 300,
      category: "health_signal",
      severity: "warning",
      message: "subagent:budget_exceeded",
      details: JSON.stringify({ signal: "node_budget_exceeded", capSource: "node" }),
    });
    const durableRuns = fakeDurableRuns({ orphaned: 0, revoked: 0, running: 2, completed: 2 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );

    // breakerTrips equals the synthetic-excluded breakerTripTotal (2) — summed breakerTripCount.
    expect(report.autonomy?.breakerTrips).toBe(2);
    expect(report.breakerTripTotal).toBe(2); // the real read-back source (NOT a denial_breaker endReason).
    // budgetBreaches reflects the node_budget_exceeded breach count (1).
    expect(report.autonomy?.budgetBreaches).toBe(1);
  });

  // FLEET-02 (Phase 220-05) — the milestone-audit gap. A Phase-217 capability-DENIAL
  // breaker trip (`execution:aborted{reason:"denial_breaker"}`) was INVISIBLE to
  // `comis fleet`: its trip is never a session endReason and never a breakerTripCount,
  // so the existing `breakerTrips` read-back (← breakerTripTotal ← summed
  // breakerTripCount, the TOOL-failure breaker) ALWAYS shows 0, and the aborted run
  // lands in durable status 'completed' (not orphaned/revoked) → 0 in every other
  // count too. The fix EVENT-SOURCES it into a content-free `autonomy_denial_breaker`
  // health_signal row → a SEPARATE `denialBreakerTrips` count (the `killed`-separable-
  // from-`revoked` mold). RED: pre-patch there is no `denialBreakerTrips` field.
  it("FLEET-02: a denial-breaker trip surfaces as denialBreakerTrips (event-sourced), SEPARABLE from the tool-breaker breakerTrips", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // Two denial-breaker-aborted run trees (the Phase-217 capability-denial breaker).
    insertDenialBreakerRow(store, now - 100, "root-deny-1");
    insertDenialBreakerRow(store, now - 200, "root-deny-2");
    // A tool-failure breaker session (breakerTripCount:1) — the EXISTING breakerTrips
    // source. It must NOT be conflated with the denial-breaker count.
    insertBreakerDegradedRow(store, now - 300, "tool-b1");
    // The aborted runs land in durable status 'completed' (NOT orphaned/revoked) —
    // exactly the milestone finding: zero in runs.degraded/orphaned/revoked/killed.
    const durableRuns = fakeDurableRuns({ orphaned: 0, revoked: 0, running: 0, completed: 5 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );

    // The NEW count surfaces the 2 denial-breaker trips (event-sourced from the rows).
    expect(report.autonomy?.denialBreakerTrips).toBe(2);
    // SEPARABLE: the tool-breaker breakerTrips read-back is the summed breakerTripCount
    // (1), UNREGRESSED and distinct from the denial-breaker count.
    expect(report.autonomy?.breakerTrips).toBe(1);
    expect(report.breakerTripTotal).toBe(1); // the tool-breaker read-back source.
    expect(report.autonomy?.denialBreakerTrips).not.toBe(report.autonomy?.breakerTrips);
    // The denial-breaker-aborted runs were 'completed' in the table — so the OTHER
    // counts stay 0 (proving the gap: only denialBreakerTrips catches them).
    expect(report.autonomy?.runs.degraded).toBe(0);
    expect(report.autonomy?.orphaned).toBe(0);
    expect(report.autonomy?.killed).toBe(0);
    expect(report.autonomy?.revoked).toBe(0);
  });

  it("FLEET-02: a denial-breaker trip is a dedicated finding AND its worst rootRunId is drillable; CONTENT-FREE", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertDenialBreakerRow(store, now - 100, "root-deny-worst");
    const durableRuns = fakeDurableRuns({ orphaned: 0, revoked: 0, running: 1, completed: 1 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );

    // A dedicated finding names the denial-breaker trip + a copy-pasteable explain ref.
    const denialFinding = report.findings.find((f) => f.code === "autonomy_denial_breaker");
    expect(denialFinding).toBeDefined();
    expect(denialFinding?.count).toBe(1);
    expect(denialFinding?.hint).toMatch(/comis explain|denialBreakerN/);
    // NOT double-counted as a generic `health_signal:autonomy_denial_breaker` rollup.
    expect(report.findings.some((f) => f.code === "health_signal:autonomy_denial_breaker")).toBe(false);
    // The worst-run pick CAN include the denial-breaker root (a degraded autonomy run).
    expect(report.autonomy?.worstRootRunId).toBe("root-deny-worst");

    // CONTENT-FREE: no bearer/secret/path leaks anywhere in the report JSON. (The
    // dedicated finding's detail/hint carry STATIC operator guidance — authored
    // constants, not echoed runtime bodies — so they legitimately name the breaker
    // mechanism; that is identical to every other finding's static hint and is NOT
    // a body leak.) The content-free invariant is enforced at the ROW: the persisted
    // `autonomy_denial_breaker` details carry ONLY the closed triple (signal /
    // denialBreakerTrips / rootRunId) — the engine's runtime free-text deny reason
    // is NEVER persisted, so it can never reach the report from the data side.
    const j = JSON.stringify(report);
    expect(j).not.toMatch(/Bearer|sk-|secret/i);
    expect(j).not.toMatch(/\/home\/|\/tmp\//);
    // The row's details JSON (the data-sourced surface) is the closed triple ONLY —
    // no runtime body field smuggled through (this is what an untrusted row could leak).
    const denialRow = store
      .queryDiagnostics({ category: "health_signal" })
      .find((r) => r.message === "autonomy:denial_breaker_tripped");
    const details = JSON.parse(denialRow?.details ?? "{}") as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(["denialBreakerTrips", "rootRunId", "signal"]);
  });

  it("FLEET-02: round-trips FleetHealthReportSchema.parse() with denialBreakerTrips (additive-optional, no drift)", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertDenialBreakerRow(store, now - 100, "root-deny-rt");
    const durableRuns = fakeDurableRuns({ orphaned: 0, revoked: 0, running: 1, completed: 1 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );
    const parsed = FleetHealthReportSchema.parse(report);
    expect(parsed.autonomy?.denialBreakerTrips).toBe(1);
  });

  it("FLEET-04: names the worst autonomy run's rootRunId AND a verdict suggests `comis explain <rootRunId>`", async () => {
    const now = systemNowMs();
    const store = makeStore();
    // A degraded autonomy run (orphaned) carries a rootRunId.
    insertOrphanedRow(store, now - 100, "not_resumable", "root-worst-abc");
    const durableRuns = fakeDurableRuns({ orphaned: 1, revoked: 0, running: 2, completed: 5 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );

    // The block names the worst rootRunId (a real id from the orphaned row).
    expect(report.autonomy?.worstRootRunId).toBe("root-worst-abc");
    // AND a FLEET verdict names it in a `comis explain <id>` suggestion (likelyRootCause
    // or a finding — at least one surface points the operator at the worst run).
    const verdictText = [
      report.likelyRootCause?.detail ?? "",
      ...(report.likelyRootCause?.suggestedNextSteps ?? []),
      ...report.findings.flatMap((f) => [f.detail, f.hint]),
    ].join(" | ");
    expect(verdictText).toMatch(/comis explain/);
    expect(report.likelyRootCause?.code).toBe("fleet_autonomy_degradation");
    expect(report.likelyRootCause?.detail).toContain("root-worst-abc");
  });

  it("CONTENT-FREE: the whole report JSON carries no body/secret even with autonomy rows present", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertOrphanedRow(store, now - 100, "invalid_caps", "root-x");
    insertRevokedRow(store, now - 200, 1, "root-y");
    const durableRuns = fakeDurableRuns({ orphaned: 1, revoked: 1, running: 1, completed: 1 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );
    const json = JSON.stringify(report);
    // No bearer/secret/path/free-text reason sentence anywhere.
    expect(json).not.toMatch(/Bearer|sk-|secret-lease/i);
    expect(json).not.toMatch(/\/home\/|\/tmp\//);
    expect(json).not.toMatch(/dropped its heartbeat at/i);
  });

  it("HONEST DEGRADATION: with no durableRuns dep AND no autonomy rows, the autonomy block is OMITTED (offline-style boot)", async () => {
    const now = systemNowMs();
    const store = makeStore();
    seedStore(store, now); // non-autonomy health_signal rows only.

    // No durableRuns dep (the offline CLI / non-durability boot).
    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now) },
      24,
    );
    expect(report.autonomy).toBeUndefined();
  });

  it("admin gate + report shape unchanged: the report still round-trips FleetHealthReportSchema.parse() with the autonomy block", async () => {
    const now = systemNowMs();
    const store = makeStore();
    insertOrphanedRow(store, now - 100, "resume_failed", "root-p");
    const durableRuns = fakeDurableRuns({ orphaned: 1, revoked: 0, running: 1, completed: 1 });

    const report = await assembleFleetHealthReport(
      { obsStore: store, dataDir: emptyDataDir(), clock: createFakeClock(now), durableRuns },
      24,
    );
    // The autonomy block SURVIVES the wire parse (schema/daemon drift guard).
    const parsed = FleetHealthReportSchema.parse(report);
    expect(parsed.autonomy?.orphaned).toBe(1);
    expect(parsed.autonomy?.worstRootRunId).toBe("root-p");
  });
});

describe("bindFleetHealthHandlers (H1 — admin dual-layer gate)", () => {
  it("admin gate: missing _trustLevel:admin throws", async () => {
    const handlers = bindFleetHealthHandlers(makeDeps({ obsStore: makeStore(), clock: createFakeClock(systemNowMs()) }));
    await expect(handlers["obs.fleet.health"]!({ sinceHours: 24 })).rejects.toThrow(/Admin/i);
    await expect(handlers["obs.fleet.health"]!({ sinceHours: 24, _trustLevel: "user" })).rejects.toThrow(/Admin/i);
  });

  it("stripInternalFields: _trustLevel never reaches the parsed params / report", async () => {
    const dataDir = makeDataDirWithActivity();
    const handlers = bindFleetHealthHandlers(
      makeDeps({ obsStore: makeStore(), dataDir, clock: createFakeClock(systemNowMs()) }),
    );
    const r = (await handlers["obs.fleet.health"]!({
      sinceHours: 24,
      _trustLevel: "admin",
    })) as FleetHealthReport & { _trustLevel?: unknown };
    expect(r._trustLevel).toBeUndefined();
    expect(r.schemaVersion).toBe(1);
  });

  it("applies the 24h default when sinceHours is omitted (handler-body default)", async () => {
    const dataDir = makeDataDirWithActivity();
    const handlers = bindFleetHealthHandlers(
      makeDeps({ obsStore: makeStore(), dataDir, clock: createFakeClock(systemNowMs()) }),
    );
    const r = (await handlers["obs.fleet.health"]!({ _trustLevel: "admin" })) as FleetHealthReport;
    expect(r.windowHours).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// 161-02: the clock seam is LOAD-BEARING — the wired handler MUST receive a
// clock (buildRpcDispatchDeps threads boot.clock into ObservabilityApiDeps.clock).
// The handler asserts `deps.clock!`; an unwired clock throws at request time.
// These pins prove (a) the clock-wired handler returns a real report (NOT a
// clock-undefined throw), and (b) the absent-clock state genuinely fails — so
// the buildRpcDispatchDeps `clock: c.clock` wiring is not decorative.
// ---------------------------------------------------------------------------

describe("bindFleetHealthHandlers (161-02 — boot.clock wiring is load-bearing)", () => {
  it("the clock-wired handler returns a FleetHealthReport (NOT a clock-undefined throw)", async () => {
    const dataDir = makeDataDirWithActivity();
    const store = makeStore();
    seedStore(store, systemNowMs());
    // Deps WITH clock populated — exactly what buildRpcDispatchDeps now wires
    // (ObservabilityApiDeps.clock = boot.clock). The handler must assemble a
    // real report, not throw on `deps.clock!`.
    const handlers = bindFleetHealthHandlers(
      makeDeps({ obsStore: store, dataDir, clock: createFakeClock(systemNowMs()) }),
    );
    const r = (await handlers["obs.fleet.health"]!({
      sinceHours: 24,
      _trustLevel: "admin",
    })) as FleetHealthReport;
    expect(r.schemaVersion).toBe(1);
    expect(r.windowHours).toBe(24);
    expect(r.sessions.total).toBe(2);
  });

  it("throws when deps.clock is UNWIRED (proves the buildRpcDispatchDeps clock wiring is load-bearing)", async () => {
    const dataDir = makeDataDirWithActivity();
    // Deps WITHOUT a clock — the pre-wiring failure mode. The handler's
    // `deps.clock!` assertion dereferences undefined -> throws. This is the exact
    // regression the buildRpcDispatchDeps `clock: c.clock` line prevents.
    const handlers = bindFleetHealthHandlers(
      makeDeps({ obsStore: makeStore(), dataDir /* clock intentionally omitted */ }),
    );
    await expect(
      handlers["obs.fleet.health"]!({ sinceHours: 24, _trustLevel: "admin" }),
    ).rejects.toThrow();
  });
});
