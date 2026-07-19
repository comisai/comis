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
import { sessionKeyToPath } from "@comis/agent";
import {
  resolveTrajectoryPointerFilePath,
  writeTrajectoryPointerFileBestEffort,
} from "@comis/observability";
import { makeRealReader } from "./obs-explain-readers.js";
import { assembleIncidentReportFromSources } from "./obs-explain.js";

// The canonical formatted session key (the same one obs-explain-readers.test.ts
// pins). sessionKeyToPath maps it to tenant="default", channel="678314278",
// file="678314278~peer~678314278.jsonl".
const SESSION_KEY = "default:agent:default:678314278:678314278:peer:678314278";

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

});
