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
 * The ONE clock read (`sinceHours -> sinceMs`) is an injected fakeClock — NO
 * Date.now()/new Date() (the globals gate). The fakeClock is pinned to the REAL
 * `systemNowMs()` so the A1/I-track window (fakeClock-derived `sinceMs`) and the
 * A3 day-keys (the reader's own `systemNowMs()`) agree on "the last N hours".
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
import { systemDateFrom, systemNowMs } from "@comis/core";
import type { FleetHealthReport } from "@comis/core";
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

  it("is DETERMINISTIC: same data + same fakeClock -> byte-identical reports", async () => {
    const now = systemNowMs();
    const store = makeStore();
    seedStore(store, now);
    const dataDir = makeDataDirWithActivity();

    const a = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);
    const b = await assembleFleetHealthReport({ obsStore: store, dataDir, clock: createFakeClock(now) }, 24);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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
