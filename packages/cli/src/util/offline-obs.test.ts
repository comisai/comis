// SPDX-License-Identifier: Apache-2.0
/**
 * W14 (obs-llm-troubleshooting): real-layout tests for the OFFLINE obs
 * assemblers — `comis explain --offline` / `comis fleet --offline` and the
 * automatic unreachable-gateway fallback both ride these.
 *
 * Per AGENTS.md §2.10 the layout IS the contract: the explain test builds the
 * PRODUCTION nested tree (`workspace/sessions/<tenant>/<channel>/<file>.jsonl`
 * + the co-located `.trajectory-path.json` pointer + `_session-metadata.json`)
 * under a temp dir — NEVER `~/.comis` — and drives the real reader stack
 * end-to-end with no daemon and no memory.db. It doubles as the cross-feature
 * E2E for this change-set: the trajectory carries a `context.budget` record
 * (W2), so the report must surface `contextBudget` (W3), the numbers-backed
 * `context_exhausted` verdict naming the cap knob (W3), and the
 * signals-derived agentId/channel (W8) — all from disk alone.
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
import {
  assembleIncidentReportOffline,
  assembleFleetHealthReportOffline,
  resolveOfflineDataDir,
} from "./offline-obs.js";

// OBS-OFFLINE-DATADIR (webhook-claude-cli-tdd-20260630-rerun): `comis explain --offline` /
// `comis fleet --offline` resolved the data dir from `os.homedir()` ALONE, ignoring
// `COMIS_DATA_DIR`. Running the CLI as a different user than the daemon (the live-test rig runs
// the daemon as `comis` but invokes the CLI as `root`) then read an EMPTY `<root-home>/.comis`
// and reported `endReason=unknown, $0, 0 turns` for a session that SUCCEEDED — the exact false
// "nothing happened" the obs lens exists to prevent. The daemon + the wizard (04-oauth-helpers)
// both honor `COMIS_DATA_DIR`; the offline obs reader must match.
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

// The live incident's session key — maps to tenant "default", channel
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
    // W2: the terminal budget equation — the exhausted fit check.
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

describe("assembleIncidentReportOffline — real nested layout, no daemon, no memory.db", () => {
  // Generous timeout: the FIRST offline call lazy-loads the whole @comis/daemon
  // graph (the deliberate W14 trade — CLI startup stays light; the offline
  // path pays once). Under vitest's transform that load can take ~10s cold.
  it("assembles the numbers-backed context_exhausted post-mortem from disk alone", { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir();
    buildLiveShapedSession(dataDir);

    const report = await assembleIncidentReportOffline(dataDir, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    // Identity (W8): agentId from the record envelopes; channel from session.started.
    expect(report.sessionKey).toBe(SESSION_KEY);
    expect(report.agentId).toBe("default");
    expect(report.channel).toEqual({ type: "telegram", id: "678314278" });

    // Outcome from the metadata rollup.
    expect(report.outcome.endReason).toBe("context_exhausted");
    expect(report.outcome.degraded).toBe(true);

    // W3: the budget equation rode the trajectory onto the report.
    expect(report.contextBudget?.verdict).toBe("exhausted");
    expect(report.contextBudget?.assembledInputTokens).toBe(31_572);
    expect(report.contextBudget?.windowCapSource).toBe("effectiveContextCapSmall");

    // W3: the verdict is numbers-backed and names the exact knob.
    expect(report.likelyRootCause?.code).toBe("context_exhausted");
    expect(report.likelyRootCause?.detail).toContain("31572");
    expect(report.likelyRootCause?.detail).toContain("131072");
    expect(report.likelyRootCause?.suggestedNextSteps.join(" | ")).toContain(
      "contextEngine.budget.effectiveContextCapSmall",
    );

    // W8: one ctx_search call counts exactly once.
    expect(report.toolStats.ctx_search).toEqual({ ok: 1, failed: 0 });

    // Coverage honesty: the trajectory was actually read.
    expect(report.coverage?.trajectory.found).toBe(true);
    expect(report.coverage?.trajectory.records).toBeGreaterThan(0);
  });
});

describe("assembleFleetHealthReportOffline — memory.db present but missing obs tables", () => {
  it("degrades to file-only sources when the db lacks the obs schema (post-reset live state)", { timeout: 30_000 }, async () => {
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
  it("returns an honest report with coverage gaps when memory.db is absent", { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir();
    const logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    // Today's session-index day file (the A3 activity source reads real day-keys).
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
    // A3 activity came from the local day file.
    expect(report.activity.activeAgents).toContain("default");
    // The session-summary store (memory.db) is absent — coverage says so
    // honestly instead of masquerading as a clean zero-session fleet.
    expect(report.coverage?.sessionSummary.found).toBe(false);
  });
});
