// SPDX-License-Identifier: Apache-2.0
/**
 * GOLDEN real-layout end-to-end regression test for the `obs.explain` pipeline.
 *
 * The AGENTS.md §2.10 "filesystem-layout resolvers need a real-layout test" rule
 * made into an ENFORCED gate. The existing `obs-explain-readers.test.ts` covers
 * each reader IN ISOLATION; this file drives the WHOLE pipeline
 * (`assembleIncidentReportFromSources(makeRealReader(tmpDataDir), …)`) against a
 * session built ON DISK with the REAL path-construction + writer helpers — the
 * integration the per-reader test does NOT cover.
 *
 * Why a real on-disk layout (NOT a hand-authored fixture): a frozen fixture is
 * EXACTLY what let two production-breaking reader bugs slip past review —
 * both would FAIL this test:
 *   - the flat-path bug — `makeRealReader` resolved a flat `<dataDir>/sessions/<id>.*`
 *     path that does not exist in production (the real layout is
 *     `<dataDir>/workspace/sessions/<tenant>/<channel>/<file>` resolved via the
 *     co-located `.trajectory-path.json` pointer) → an EMPTY IncidentReport for
 *     EVERY real session. Gated here by the NON-EMPTY assertions.
 *   - the field-name bug — the signals normalizer read `data.diskPath` where the
 *     writer emits `data.diskPathRel` → `"<offloaded>"` drill-down pointers.
 *     Gated here by `offloads[0].pointer === "tool-results/call_abc.json"` (NOT
 *     "<offloaded>") — the assertion goes RED if a `data.diskPath` read is
 *     reintroduced.
 *
 * The layout is built via the REAL helpers — `parseFormattedSessionKey`
 * (@comis/core), `sessionKeyToPath` (@comis/agent), and the production
 * `writeTrajectoryPointerFileBestEffort` (@comis/observability) — under a
 * `fs.mkdtemp` temp dir in `os.tmpdir()` (NEVER `~/.comis`). `path.join`
 * is used in this TEST file only — the no-path.join ESLint rule scopes to
 * non-test `src/**`; the SUT still resolves via `safePath`.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { sessionKeyToPath } from "@comis/agent";
import { systemDateFrom, systemNowMs } from "@comis/core";
import { createObservabilityStore, initSchema } from "@comis/memory";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  writeTrajectoryPointerFileBestEffort,
} from "@comis/observability";
import { makeRealReader } from "./obs-explain-readers.js";
import { assembleIncidentReportFromSources } from "./obs-explain.js";
import { taskEventToRow } from "../../observability/obs-scheduler-rows.js";

// The canonical formatted session key (the same one obs-explain-readers.test.ts
// pins). sessionKeyToPath maps it to tenant="default", channel="678314278",
// file="678314278~peer~678314278.jsonl".
const SESSION_KEY = "default:agent:default:678314278:678314278:peer:678314278";
const NAMED_AGENT_SESSION_KEY = "default:agent:worker:678314278:678314278:peer:678314278";
const TASK_ROOT_RUN_ID = "root-task-check-244cd6a3-0a81-48b1-a4f1-2e24375a6b35";
const TASK_CORRELATION_ID = "256bb57a-b6c3-46ba-88d3-459c7be29dfe";
const TASK_SESSION_KEY = "default:agent:default:scheduler-task-check-default:scheduler:task-check:attempt-task-a:peer:scheduler-task-check-default";
const GRAPH_ID = "5ea53a58-f0fc-4683-b6e6-53b1d828e602";
const GRAPH_TRACE_ID = "5a6c1d74-da1c-4d09-93c3-33862a076b9b";

// Every temp dir created — torn down in afterEach so no temp tree leaks.
const tmpDirs: string[] = [];

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-golden-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Resolve the REAL session `.jsonl` file path the SAME way `makeRealReader` does
 * (via `parseFormattedSessionKey` + `sessionKeyToPath` under
 * `<dataDir>/workspace/sessions`), create its parent dir, and write the (empty)
 * session JSONL message log. Returns the absolute session file path. NEVER
 * hand-builds the path — the real helper IS the contract under test.
 */
function buildRealSessionFile(dataDir: string): string {
  const sessionsBase = path.join(dataDir, "workspace", "sessions");
  const sessionFile = sessionKeyToPath({
    tenantId: "default",
    agentId: "default",
    userId: "678314278",
    channelId: "678314278",
    peerId: "678314278",
  }, sessionsBase);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  // The session JSONL itself (message log) — empty is fine; the readers target
  // its trajectory/metadata siblings.
  fs.writeFileSync(sessionFile, "", "utf-8");
  return sessionFile;
}

function buildNamedAgentSessionFile(workspaceDir: string): string {
  const sessionFile = sessionKeyToPath({
    tenantId: "default",
    agentId: "worker",
    userId: "678314278",
    channelId: "678314278",
    peerId: "678314278",
  }, path.join(workspaceDir, "sessions"));
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  return sessionFile;
}

/** The two REAL event-shape trajectory records (failure + offload). */
function trajectoryLines(): string {
  const failure = JSON.stringify({
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    type: "tool.result",
    seq: 1,
    data: {
      toolName: "web_fetch",
      success: false,
      classifiedFailureBy: "executor",
      errorKind: "dependency",
    },
  });
  // The offload's `data.diskPathRel` is the load-bearing field — the writer
  // emits diskPathRel (translate-payload.ts), never diskPath; reading diskPath
  // is the field-name regression this golden test gates.
  const offload = JSON.stringify({
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    type: "tool.result_offloaded",
    seq: 2,
    data: {
      toolName: "web_fetch",
      diskPathRel: "tool-results/call_abc.json",
      originalChars: 51_200,
    },
  });
  return [failure, offload].join("\n") + "\n";
}

function multiExecutionTrajectoryLines(): string {
  return [
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.started",
      seq: 1,
      traceId: "trace-healthy",
      data: { channelType: "telegram", channelId: "678314278" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "prompt.submitted",
      seq: 2,
      traceId: "trace-failed",
      data: { inboundKind: "message" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.summary",
      seq: 3,
      traceId: "trace-failed",
      data: {
        degraded: true,
        turnCount: 0,
        costUsd: 0,
        toolStats: {},
        breakerTripCount: 0,
        topErrorKinds: { config: 1 },
        source: "runtime",
        endReason: "error",
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "subagent.budget_exceeded",
      seq: 4,
      traceId: SESSION_KEY,
      data: {
        nodeId: "failed-turn-node",
        capSource: "node",
        tokenBudget: 1_500,
        tokensUsed: 0,
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "prompt.submitted",
      seq: 5,
      traceId: "trace-healthy",
      data: { inboundKind: "message" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "model.completed",
      seq: 6,
      traceId: "trace-healthy",
      data: {
        inputTokens: 100,
        outputTokens: 20,
        stopReason: "stop",
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "delivery.dispatched",
      seq: 7,
      traceId: "trace-healthy",
      data: { status: "success" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.summary",
      seq: 8,
      traceId: "trace-healthy",
      data: {
        degraded: false,
        turnCount: 1,
        costUsd: 0.01,
        toolStats: {},
        breakerTripCount: 0,
        topErrorKinds: {},
        source: "runtime",
        endReason: "success",
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function taskTrajectoryLines(): string {
  return [
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "context.budget",
      seq: 1,
      traceId: TASK_CORRELATION_ID,
      data: {
        windowTokens: 32_000,
        rawContextWindowTokens: 32_000,
        windowCapSource: "none",
        systemTokens: 1_000,
        freshTailTokens: 200,
        budgetedHistoryTokens: 0,
        keptCount: 0,
        assembledInputTokens: 1_200,
        outputHeadroom: 768,
        verdict: "fits",
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "capability.audited",
      seq: 2,
      traceId: TASK_CORRELATION_ID,
      agentId: "default",
      data: {
        leaseId: "lease-task-a",
        rootRunId: TASK_ROOT_RUN_ID,
        capability: "orch:read",
        tool: "task_check",
        decision: "allow",
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "model.completed",
      seq: 3,
      traceId: TASK_CORRELATION_ID,
      data: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
      },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.summary",
      seq: 4,
      traceId: TASK_CORRELATION_ID,
      data: { costUsd: 0.015, turnCount: 1, degraded: false },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "learning.outcome_observed",
      seq: 5,
      traceId: TASK_CORRELATION_ID,
      data: {
        trajectoryId: "task-trajectory-a",
        outcome: "unknown",
        source: "pipeline",
        confidence: 0,
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function writeTaskSessionIndex(dataDir: string): void {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const dayKey = systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(logsDir, `session-index.${dayKey}.jsonl`),
    JSON.stringify({
      traceSchema: "comis-session-index",
      schemaVersion: 1,
      event: "turn_completed",
      traceId: TASK_CORRELATION_ID,
      sessionKey: TASK_SESSION_KEY,
    }) + "\n",
    "utf-8",
  );
}

function graphTrajectoryLines(): string {
  return [
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.started",
      seq: 1,
      traceId: GRAPH_TRACE_ID,
      data: { channelType: "telegram", channelId: "678314278" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "prompt.submitted",
      seq: 2,
      traceId: GRAPH_TRACE_ID,
      data: { inboundKind: "message" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "model.completed",
      seq: 3,
      traceId: GRAPH_TRACE_ID,
      data: { inputTokens: 100, outputTokens: 20, stopReason: "stop" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "delivery.dispatched",
      seq: 4,
      traceId: GRAPH_TRACE_ID,
      data: { status: "success" },
    },
    {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "session.summary",
      seq: 5,
      traceId: GRAPH_TRACE_ID,
      data: {
        degraded: false,
        turnCount: 1,
        costUsd: 0.01,
        toolStats: {},
        breakerTripCount: 0,
        topErrorKinds: {},
        source: "runtime",
        endReason: "success",
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function writeGraphSessionIndex(dataDir: string): void {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const dayKey = systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(logsDir, `session-index.${dayKey}.jsonl`),
    JSON.stringify({
      traceSchema: "comis-session-index",
      schemaVersion: 1,
      event: "turn_completed",
      traceId: GRAPH_TRACE_ID,
      sessionKey: SESSION_KEY,
    }) + "\n",
    "utf-8",
  );
}

function writeGraphRunMetadata(dataDir: string): void {
  const graphDir = path.join(dataDir, "graph-runs", GRAPH_ID);
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(
    path.join(graphDir, "_run-metadata.json"),
    JSON.stringify({
      graphId: GRAPH_ID,
      graphName: "PRIVATE GRAPH LABEL",
      startedAt: "2026-07-30T06:20:44.795Z",
      completedAt: "2026-07-30T06:22:27.305Z",
      durationMs: 102_510,
      status: "completed",
      traceId: GRAPH_TRACE_ID,
      nodesTotal: 2,
      nodesSucceeded: 2,
      nodesFailed: 0,
      nodesSkipped: 0,
      nodesRetried: 1,
      totalCostUsd: 0.25,
      totalTokens: 12_000,
      nodes: {
        weather: {
          status: "completed",
          durationMs: 29_576,
          subAgentRunId: "run-weather",
          cacheReadTokens: 2_000,
          cacheWriteTokens: 0,
          cacheEffectiveness: 1,
          attemptsUsed: 2,
          output: "PRIVATE NODE OUTPUT",
        },
        decision: {
          status: "completed",
          durationMs: 2_915,
          subAgentRunId: "run-decision",
          cacheReadTokens: null,
          cacheWriteTokens: null,
          cacheEffectiveness: null,
          attemptsUsed: 1,
        },
      },
    }),
    "utf-8",
  );
}

/**
 * Write the REAL `_session-metadata.json` companion next to the session JSONL
 * (the `.jsonl` → `_session-metadata.json` rename comis-session-manager.ts
 * performs), carrying a degraded sessionEnd rollup.
 */
function writeRealMetadata(sessionFile: string): void {
  const metadataFile = sessionFile.replace(/\.jsonl$/, "_session-metadata.json");
  fs.writeFileSync(
    metadataFile,
    JSON.stringify({
      traceId: "trace-1",
      channel: { type: "telegram", id: "678314278" },
      sessionEnd: {
        type: "session_end",
        endReason: "completed_with_tool_errors",
        degraded: true,
        costUsd: 1.32,
      },
    }),
    "utf-8",
  );
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("obs.explain golden real-layout end-to-end (real writers + makeRealReader)", () => {
  it("assembles a NON-EMPTY IncidentReport with resolved offload pointers from a real on-disk session", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = buildRealSessionFile(dataDir);

    // The trajectory lives at the runtimeFile the POINTER names — the co-located
    // <sessionFile>.trajectory.jsonl path, matching production.
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, trajectoryLines(), "utf-8");

    // Write the REAL pointer via the PRODUCTION writer (NOT a hand-built
    // JSON.stringify) — exercises BOTH pointer resolution AND the diskPathRel
    // offload format end-to-end.
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: SESSION_KEY,
      runtimeFile,
    });
    // The writer is best-effort — guard against a silent no-op.
    expect(fs.existsSync(resolveTrajectoryPointerFilePath(sessionFile))).toBe(true);

    writeRealMetadata(sessionFile);

    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir),
      dataDir,
      { sessionKey: SESSION_KEY, depth: "summary" },
    );

    // NON-EMPTY: flat-path resolution would yield a confident-looking empty
    // report (endReason=unknown, 0 failures/offloads). The metadata companion
    // resolving proves the workspace/sessions tree was read.
    expect(report.outcome.endReason).toBe("completed_with_tool_errors");
    expect(report.outcome.degraded).toBe(true);
    expect(report.toolStats.web_fetch).toBeDefined();
    expect(report.toolStats.web_fetch!.failed).toBeGreaterThanOrEqual(1);
    expect(report.failures.length).toBeGreaterThanOrEqual(1);
    expect(report.offloads.length).toBe(1);

    // POINTER RESOLVES: a data.diskPath read would yield "<offloaded>" — the
    // EXACT field-name regression this assertion forbids.
    expect(report.offloads[0]!.pointer).toBe("tool-results/call_abc.json");
    expect(report.offloads[0]!.pointer).not.toBe("<offloaded>");
  });

  it("assembles named-agent sessions from their configured workspace", async () => {
    const dataDir = tmpDataDir();
    const workspaceDir = path.join(dataDir, "custom-worker-workspace");
    const sessionFile = buildNamedAgentSessionFile(workspaceDir);
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, trajectoryLines(), "utf-8");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: NAMED_AGENT_SESSION_KEY,
      runtimeFile,
    });
    writeRealMetadata(sessionFile);
    const reader = makeRealReader(
      dataDir,
      undefined,
      new Map([["worker", workspaceDir]]),
    );

    const report = await assembleIncidentReportFromSources(
      reader,
      dataDir,
      { sessionKey: NAMED_AGENT_SESSION_KEY, depth: "summary" },
    );

    expect(reader.resolveSessionFilePath?.(NAMED_AGENT_SESSION_KEY)).toBe(sessionFile);
    expect(report.outcome.endReason).toBe("completed_with_tool_errors");
    expect(report.toolStats.web_fetch?.failed).toBeGreaterThanOrEqual(1);
    expect(report.offloads[0]?.pointer).toBe("tool-results/call_abc.json");
  });

  it("resolves a failed trace from durable diagnostics and isolates its execution", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = buildRealSessionFile(dataDir);
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, multiExecutionTrajectoryLines(), "utf-8");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: SESSION_KEY,
      runtimeFile,
    });
    writeRealMetadata(sessionFile);

    const db = new Database(":memory:");
    initSchema(db, 1_536);
    const store = createObservabilityStore(db);
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "session_summary",
      severity: "error",
      agentId: "default",
      sessionKey: SESSION_KEY,
      message: "session:summary",
      details: JSON.stringify({
        degraded: true,
        turnCount: 0,
        costUsd: 0,
        toolStats: {},
        breakerTripCount: 0,
        topErrorKinds: { config: 1 },
        source: "runtime",
        endReason: "error",
      }),
      traceId: "trace-failed",
    });

    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir, store),
      dataDir,
      { traceId: "trace-failed", depth: "summary" },
    );

    expect(report.sessionKey).toBe(SESSION_KEY);
    expect(report.traceId).toBe("trace-failed");
    expect(report.outcome).toEqual({
      endReason: "error",
      degraded: true,
      severity: "failed",
    });
    expect(report.cost.costUsd).toBe(0);
    expect(report.summary).toContain("endReason=error");
    expect(report.likelyRootCause?.code).toBe("node_budget_exceeded");
    expect(report.nodeBudgetBreaches).toEqual([
      expect.objectContaining({
        nodeId: "failed-turn-node",
        tokenBudget: 1_500,
        tokensUsed: 0,
      }),
    ]);
    db.close();
  });

  it("resolves a task-check root to its real origin session and folds durable delivery evidence", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = buildRealSessionFile(dataDir);
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, trajectoryLines(), "utf-8");
    writeTrajectoryPointerFileBestEffort({ sessionFile, sessionId: SESSION_KEY, runtimeFile });
    writeRealMetadata(sessionFile);
    writeTaskSessionIndex(dataDir);

    // Ephemeral task-check sessions intentionally have no transcript/pointer.
    // Their trajectory writer therefore uses the sanctioned workspace-dir
    // fallback: <dataDir>/workspace/<safe-session-id>.trajectory.jsonl.
    const taskTrajectoryFile = resolveTrajectoryFilePath({
      sessionId: TASK_SESSION_KEY,
      workspaceDir: path.join(dataDir, "workspace"),
    });
    fs.writeFileSync(taskTrajectoryFile, taskTrajectoryLines(), "utf-8");
    expect(taskTrajectoryFile.startsWith(path.join(dataDir, "workspace"))).toBe(true);
    expect(taskTrajectoryFile.includes(`${path.sep}sessions${path.sep}`)).toBe(false);

    const db = new Database(":memory:");
    initSchema(db, 1_536);
    const store = createObservabilityStore(db);
    store.insertDiagnostic(taskEventToRow("scheduler:task_check_started", {
      agentId: "default",
      sessionKey: SESSION_KEY,
      attemptId: "attempt-task-a",
      rootRunId: TASK_ROOT_RUN_ID,
      correlationId: TASK_CORRELATION_ID,
      taskIds: ["task-a"],
      sourceExecutionIds: ["execution-a"],
      originTraceIds: ["trace-1"],
      durationMs: 3,
      timestamp: 3_000,
    }));
    const terminalRow = taskEventToRow("scheduler:task_check_terminal", {
      agentId: "default",
      sessionKey: SESSION_KEY,
      attemptId: "attempt-task-a",
      rootRunId: TASK_ROOT_RUN_ID,
      correlationId: TASK_CORRELATION_ID,
      taskIds: ["task-a"],
      sourceExecutionIds: ["execution-a"],
      originTraceIds: ["trace-1"],
      outcome: "delivered",
      recovery: "live",
      deliveredChunks: 1,
      failedChunks: 0,
      ambiguousChunks: 0,
      durationMs: 21,
      timestamp: 3_021,
    });
    terminalRow.details = JSON.stringify({
      ...JSON.parse(terminalRow.details ?? "{}") as Record<string, unknown>,
      taskText: "PRIVATE TASK BODY MUST NOT SURFACE",
    });
    store.insertDiagnostic(terminalRow);

    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir, store),
      dataDir,
      { rootRunId: TASK_ROOT_RUN_ID, depth: "summary" },
    );

    expect(report.sessionKey).toBe(SESSION_KEY);
    expect(report.outcome).toEqual({
      endReason: "success",
      degraded: false,
      severity: "ok",
    });
    expect(report.summary).toBe("0 tool failures across 1 turns; endReason=success");
    expect(report.likelyRootCause).toBeNull();
    expect(report.cost).toMatchObject({ costUsd: 0.015, totalTokens: 1_300 });
    expect(report.channel).toEqual({ type: "telegram", id: "678314278" });
    expect((report as unknown as Record<string, unknown>).taskCheck).toEqual({
      rootRunId: TASK_ROOT_RUN_ID,
      attemptId: "attempt-task-a",
      correlationId: TASK_CORRELATION_ID,
      lifecycle: "terminal",
      outcome: "delivered",
      recovery: "live",
      deliveredChunks: 1,
      failedChunks: 0,
      ambiguousChunks: 0,
    });
    expect(report.contextBudget).toMatchObject({ verdict: "fits", assembledInputTokens: 1_200 });
    expect(report.spawnTree).toEqual([
      expect.objectContaining({
        leaseId: "lease-task-a",
        rootRunId: TASK_ROOT_RUN_ID,
        toolsInvoked: ["task_check"],
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE TASK BODY MUST NOT SURFACE");
    db.close();
  });

  it("resolves a graph identifier through terminal metadata and the real nested session layout", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = buildRealSessionFile(dataDir);
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, graphTrajectoryLines(), "utf-8");
    writeTrajectoryPointerFileBestEffort({
      sessionFile,
      sessionId: SESSION_KEY,
      runtimeFile,
    });
    writeRealMetadata(sessionFile);
    writeGraphSessionIndex(dataDir);
    writeGraphRunMetadata(dataDir);

    const report = await assembleIncidentReportFromSources(
      makeRealReader(dataDir),
      dataDir,
      {
        graphId: GRAPH_ID,
        depth: "full",
      } as unknown as Parameters<typeof assembleIncidentReportFromSources>[2],
    );
    const graph = (report as unknown as {
      graph?: {
        graphId: string;
        status: string;
        traceId?: string;
        nodes: Array<Record<string, unknown>>;
      };
    }).graph;

    expect(report.sessionKey).toBe(SESSION_KEY);
    expect(report.traceId).toBe(GRAPH_TRACE_ID);
    expect(report.outcome.endReason).toBe("success");
    expect(graph).toMatchObject({
      graphId: GRAPH_ID,
      status: "completed",
      traceId: GRAPH_TRACE_ID,
    });
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        nodeId: "weather",
        status: "completed",
        attemptsUsed: 2,
      }),
      expect.objectContaining({
        nodeId: "decision",
        status: "completed",
        attemptsUsed: 1,
      }),
    ]);
    expect(JSON.stringify(graph)).not.toContain("PRIVATE");
  });

});
