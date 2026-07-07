// SPDX-License-Identifier: Apache-2.0
/**
 * Real-layout tests for the OFFLINE obs
 * assemblers — `comis explain --offline` / `comis fleet --offline` and the
 * automatic unreachable-gateway fallback both ride these.
 *
 * Per AGENTS.md §2.10 the layout IS the contract: the explain test builds the
 * PRODUCTION nested tree (`workspace/sessions/<tenant>/<channel>/<file>.jsonl`
 * + the co-located `.trajectory-path.json` pointer + `_session-metadata.json`)
 * under a temp dir — NEVER `~/.comis` — and drives the real reader stack
 * end-to-end with no daemon and no memory.db. It doubles as a cross-feature
 * E2E: the trajectory carries a `context.budget` record,
 * so the report must surface `contextBudget`, the numbers-backed
 * `context_exhausted` verdict naming the cap knob, and the
 * signals-derived agentId/channel — all from disk alone.
 *
 * `path.join` is test-only here (the no-path.join rule scopes to non-test src);
 * the SUT resolves paths via the production helpers.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safePath } from "@comis/core";
import { writeTrajectoryPointerFileBestEffort } from "@comis/observability";
// Test-only @comis/memory imports (the L11 cli→memory production rule excludes
// `.test.ts`): seed a REAL memory.db with the obs schema so the offline audit
// read exercises the same store `openObsStoreIfPresent` opens.
import {
  openSqliteDatabase,
  initSchema as initMemorySchema,
  createObservabilityStore,
} from "@comis/memory";
import type { AuditEventRow } from "@comis/memory";
import {
  assembleIncidentReportOffline,
  assembleFleetHealthReportOffline,
  resolveOfflineDataDir,
  resolveSessionFileOffline,
  readAuditSummaryOffline,
  suggestWorstSessionOffline,
} from "./offline-obs.js";

// Regression guard: if `comis explain --offline` / `comis fleet --offline`
// resolved the data dir from `os.homedir()` ALONE, ignoring `COMIS_DATA_DIR`,
// then running the CLI as a different user than the daemon (e.g. the daemon as
// `comis` but the CLI as `root`) would read an EMPTY `<root-home>/.comis` and
// report `endReason=unknown, $0, 0 turns` for a session that SUCCEEDED — the
// exact false "nothing happened" the obs lens exists to prevent. The daemon +
// the wizard (04-oauth-helpers) both honor `COMIS_DATA_DIR`; the offline obs
// reader must match.
describe("resolveOfflineDataDir", () => {
  const prev = process.env.COMIS_DATA_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.COMIS_DATA_DIR;
    else process.env.COMIS_DATA_DIR = prev;
  });
  it("honors COMIS_DATA_DIR when set (matches the daemon + wizard data-dir resolution)", () => {
    process.env.COMIS_DATA_DIR = "/srv/custom-comis-data";
    expect(resolveOfflineDataDir()).toBe("/srv/custom-comis-data");
  });
  it("falls back to <homedir>/.comis when COMIS_DATA_DIR is unset", () => {
    delete process.env.COMIS_DATA_DIR;
    expect(resolveOfflineDataDir()).toBe(safePath(os.homedir(), ".comis"));
  });
});

// A production-shaped session key — maps to tenant "default", channel
// "678314278", file "678314278~peer~678314278.jsonl" (verified against the
// production ~/.comis layout).
const SESSION_KEY = "default:678314278:678314278:peer:678314278";

const tmpDirs: string[] = [];

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-obs-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build the production nested session layout and return the session file path. */
function buildLiveShapedSession(dataDir: string): string {
  const sessionDir = path.join(dataDir, "workspace", "sessions", "default", "678314278");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "678314278~peer~678314278.jsonl");
  fs.writeFileSync(sessionFile, "", "utf-8");

  const records = [
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.started",
      seq: 1,
      agentId: "default",
      sessionId: SESSION_KEY,
      data: { channelType: "telegram", channelId: "678314278" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "tool.result",
      seq: 2,
      agentId: "default",
      data: { toolName: "ctx_search", toolCallId: "call_wezdp01b", success: true },
    },
    // The terminal budget equation — the exhausted fit check.
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "context.budget",
      seq: 3,
      agentId: "default",
      data: {
        windowTokens: 32_000,
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
        systemTokens: 25_694,
        freshTailTokens: 5_272,
        budgetedHistoryTokens: 0,
        keptCount: 0,
        assembledInputTokens: 31_572,
        outputHeadroom: 768,
        verdict: "exhausted",
      },
    },
  ];
  const runtimeFile = `${sessionFile}.trajectory.jsonl`;
  fs.writeFileSync(runtimeFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

  writeTrajectoryPointerFileBestEffort({
    sessionFile,
    sessionId: SESSION_KEY,
    runtimeFile,
  });

  const metadataFile = sessionFile.replace(/\.jsonl$/, "_session-metadata.json");
  fs.writeFileSync(
    metadataFile,
    JSON.stringify({
      traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e",
      sessionEnd: {
        type: "session_end",
        endReason: "context_exhausted",
        degraded: true,
        costUsd: 0,
        totalTokens: 51_145,
        toolStats: { ctx_search: { ok: 1, failed: 0 } },
      },
    }),
    "utf-8",
  );
  return sessionFile;
}

/** An audit row for the offline-store seed — content-free (kind + ts drive the aggregate). */
function makeAuditRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    tenantId: "tenant-a",
    agentId: "agent-a",
    ts: 1_700_000_000_000,
    kind: "secret_access",
    classification: null,
    action: null,
    actor: null,
    outcome: "success",
    severity: "info",
    traceId: "trace-a",
    refs: null,
    ...overrides,
  };
}

/**
 * Seed a REAL `memory.db` under `dataDir` with the obs schema and the given
 * audit rows — the same store `openObsStoreIfPresent` opens on the read path.
 */
function seedAuditDb(dataDir: string, rows: AuditEventRow[]): void {
  const dbPath = path.join(dataDir, "memory.db");
  const db = openSqliteDatabase({
    dbPath,
    initSchema: (d) => {
      initMemorySchema(d, 1536);
    },
  });
  const store = createObservabilityStore(db);
  for (const row of rows) store.insertAuditEvent(row);
  db.close();
}

/**
 * Write a session rollup (metadata + pointer, no daemon) for `sessionKey` under
 * a temp dataDir with the given `degraded`/`costUsd` — the shape
 * `suggestWorstSessionOffline` ranks. The pointer's `sessionId` carries the
 * verbatim key (the only authoritative key record the scan reads).
 */
function writeSessionRollup(
  dataDir: string,
  opts: {
    tenant: string;
    channel: string;
    file: string;
    sessionKey: string;
    degraded: boolean;
    costUsd: number;
  },
): void {
  const dir = path.join(dataDir, "workspace", "sessions", opts.tenant, opts.channel);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, `${opts.file}.jsonl`);
  fs.writeFileSync(sessionFile, "", "utf-8");
  const runtimeFile = `${sessionFile}.trajectory.jsonl`;
  fs.writeFileSync(runtimeFile, "", "utf-8");
  writeTrajectoryPointerFileBestEffort({ sessionFile, sessionId: opts.sessionKey, runtimeFile });
  fs.writeFileSync(
    sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
    JSON.stringify({
      traceId: `trace-${opts.file}`,
      sessionEnd: { type: "session_end", degraded: opts.degraded, costUsd: opts.costUsd },
    }),
    "utf-8",
  );
}

describe("assembleIncidentReportOffline — real nested layout, no daemon, no memory.db", () => {
  // Generous timeout: the FIRST offline call lazy-loads the whole @comis/daemon
  // graph (a deliberate trade — CLI startup stays light; the offline
  // path pays once). Under vitest's transform that load can take ~10s cold.
  it("assembles the numbers-backed context_exhausted post-mortem from disk alone", { timeout: 120_000 }, async () => {
    const dataDir = tmpDataDir();
    buildLiveShapedSession(dataDir);

    const report = await assembleIncidentReportOffline(dataDir, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    // Identity: agentId from the record envelopes; channel from session.started.
    expect(report.sessionKey).toBe(SESSION_KEY);
    expect(report.agentId).toBe("default");
    expect(report.channel).toEqual({ type: "telegram", id: "678314278" });

    // Outcome from the metadata rollup.
    expect(report.outcome.endReason).toBe("context_exhausted");
    expect(report.outcome.degraded).toBe(true);

    // The budget equation rode the trajectory onto the report.
    expect(report.contextBudget?.verdict).toBe("exhausted");
    expect(report.contextBudget?.assembledInputTokens).toBe(31_572);
    expect(report.contextBudget?.windowCapSource).toBe("effectiveContextCapSmall");

    // The verdict is numbers-backed and names the exact knob.
    expect(report.likelyRootCause?.code).toBe("context_exhausted");
    expect(report.likelyRootCause?.detail).toContain("31572");
    expect(report.likelyRootCause?.detail).toContain("131072");
    expect(report.likelyRootCause?.suggestedNextSteps.join(" | ")).toContain(
      "contextEngine.budget.effectiveContextCapSmall",
    );

    // One ctx_search call counts exactly once.
    expect(report.toolStats.ctx_search).toEqual({ ok: 1, failed: 0 });

    // Coverage honesty: the trajectory was actually read.
    expect(report.coverage?.trajectory.found).toBe(true);
    expect(report.coverage?.trajectory.records).toBeGreaterThan(0);
  });
});

describe("assembleFleetHealthReportOffline — memory.db present but missing obs tables", () => {
  it("degrades to file-only sources when the db lacks the obs schema (post-reset live state)", { timeout: 120_000 }, async () => {
    const dataDir = tmpDataDir();
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    // An empty SQLite db — exactly what an operator reset can leave behind.
    fs.writeFileSync(path.join(dataDir, "memory.db"), "", "utf-8");

    const report = await assembleFleetHealthReportOffline(dataDir, 24);

    expect(report.windowHours).toBe(24);
    expect(report.coverage?.sessionSummary.found).toBe(false);
  });
});

describe("assembleFleetHealthReportOffline — local day files, no daemon, no memory.db", () => {
  it("returns an honest report with coverage gaps when memory.db is absent", { timeout: 120_000 }, async () => {
    const dataDir = tmpDataDir();
    const logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    // Today's session-index day file (the fleet activity source reads real day-keys).
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      {
        traceSchema: "comis-session-index",
        schemaVersion: 1,
        event: "session_started",
        ts: new Date().toISOString(),
        sessionId: SESSION_KEY,
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        channelId: "678314278",
        agentId: "default",
        traceIds: ["t-1"],
      },
      {
        traceSchema: "comis-session-index",
        schemaVersion: 1,
        event: "session_ended",
        ts: new Date().toISOString(),
        sessionId: SESSION_KEY,
        exitReason: "success",
        turnCount: 2,
        totalTokens: 100,
      },
    ];
    fs.writeFileSync(
      path.join(logsDir, `session-index.${today}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8",
    );

    const report = await assembleFleetHealthReportOffline(dataDir, 24);

    expect(report.windowHours).toBe(24);
    // Activity came from the local day file.
    expect(report.activity.activeAgents).toContain("default");
    // The session-summary store (memory.db) is absent — coverage says so
    // honestly instead of masquerading as a clean zero-session fleet.
    expect(report.coverage?.sessionSummary.found).toBe(false);
  });
});

describe("resolveSessionFileOffline — real nested layout via the daemon pointer seam", () => {
  // Generous timeout: the first daemon-seam call lazy-loads the whole
  // @comis/daemon graph (~10s cold under vitest's transform), like the
  // assembler seam above.
  it("resolves a formatted sessionKey to its REAL workspace .jsonl through the daemon seam", { timeout: 120_000 }, async () => {
    const dataDir = tmpDataDir();
    const sessionFile = buildLiveShapedSession(dataDir);

    const resolved = await resolveSessionFileOffline(dataDir, SESSION_KEY);

    // The pointer discipline lands the REAL workspace file — never a fabricated
    // flat <dataDir>/sessions/<id> guess.
    expect(resolved).toBe(sessionFile);
    expect(resolved!.startsWith(path.join(dataDir, "workspace", "sessions"))).toBe(true);
  });

  it("returns undefined for a sessionKey with no on-disk artifacts", { timeout: 120_000 }, async () => {
    const dataDir = tmpDataDir(); // no workspace/sessions tree written
    expect(await resolveSessionFileOffline(dataDir, SESSION_KEY)).toBeUndefined();
  });
});

describe("readAuditSummaryOffline — window-scoped {total, byKind} from the offline store", () => {
  const NOW_MS = 1_700_000_000_000;
  const HOURS = 24;
  const WINDOW_MS = HOURS * 3_600_000;

  it("counts ALL in-window rows by kind with no traceId narrowing", () => {
    const dataDir = tmpDataDir();
    // Three distinct traceIds in-window: the window read must count all of them
    // (unlike the per-session IncidentReport.audit, which narrows to one traceId).
    seedAuditDb(dataDir, [
      makeAuditRow({ id: "a", kind: "secret_access", ts: NOW_MS - 1_000, traceId: "t-1" }),
      makeAuditRow({ id: "b", kind: "secret_access", ts: NOW_MS - 2_000, traceId: "t-2" }),
      makeAuditRow({ id: "c", kind: "injection_detected", ts: NOW_MS - 3_000, traceId: "t-3" }),
      // Out of window (ts < now - 24h) — excluded from the count.
      makeAuditRow({ id: "old", kind: "command_blocked", ts: NOW_MS - WINDOW_MS - 10_000 }),
    ]);

    const summary = readAuditSummaryOffline(dataDir, HOURS, NOW_MS);

    expect(summary).toEqual({
      schemaVersion: 1,
      total: 3,
      byKind: { secret_access: 2, injection_detected: 1 },
    });
  });

  it("returns undefined when memory.db is absent (→ the caller emits a manifest warning)", () => {
    const dataDir = tmpDataDir(); // no memory.db
    expect(readAuditSummaryOffline(dataDir, HOURS, NOW_MS)).toBeUndefined();
  });

  it("flags capped when the window read hits the store row ceiling", () => {
    const dataDir = tmpDataDir();
    const rows: AuditEventRow[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push(makeAuditRow({ id: `evt-${i}`, kind: "secret_access", ts: NOW_MS - i }));
    }
    seedAuditDb(dataDir, rows);

    const summary = readAuditSummaryOffline(dataDir, HOURS, NOW_MS);

    expect(summary?.total).toBe(1000);
    expect(summary?.capped).toBe(true);
  });
});

describe("suggestWorstSessionOffline — CLI-side worst-session ranking over readable rollups", () => {
  it("returns the degraded session's key over a clean one (degraded ranks first)", () => {
    const dataDir = tmpDataDir();
    // The CLEAN session carries the HIGHER cost — it must NOT win over the
    // degraded one (degraded-first dominates the cost tiebreak).
    writeSessionRollup(dataDir, {
      tenant: "default",
      channel: "222",
      file: "222~peer~222",
      sessionKey: "default:222:222:peer:222",
      degraded: false,
      costUsd: 2.0,
    });
    writeSessionRollup(dataDir, {
      tenant: "default",
      channel: "111",
      file: "111~peer~111",
      sessionKey: "default:111:111:peer:111",
      degraded: true,
      costUsd: 0.5,
    });

    expect(suggestWorstSessionOffline(dataDir)).toBe("default:111:111:peer:111");
  });

  it("breaks ties among degraded sessions by costUsd (highest first)", () => {
    const dataDir = tmpDataDir();
    writeSessionRollup(dataDir, {
      tenant: "default",
      channel: "aaa",
      file: "aaa~peer~aaa",
      sessionKey: "default:aaa:aaa:peer:aaa",
      degraded: true,
      costUsd: 0.25,
    });
    writeSessionRollup(dataDir, {
      tenant: "default",
      channel: "bbb",
      file: "bbb~peer~bbb",
      sessionKey: "default:bbb:bbb:peer:bbb",
      degraded: true,
      costUsd: 3.75,
    });

    expect(suggestWorstSessionOffline(dataDir)).toBe("default:bbb:bbb:peer:bbb");
  });

  it("returns undefined over an empty/absent sessions tree", () => {
    const dataDir = tmpDataDir();
    expect(suggestWorstSessionOffline(dataDir)).toBeUndefined();
  });
});
