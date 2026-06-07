// SPDX-License-Identifier: Apache-2.0
/**
 * `IncidentSourceReader` + `makeRealReader` tests — the four bounded source
 * readers behind one DI seam (the X3 fixture-injection seam).
 *
 * Production reads real files; tests inject fixture records. The four readers:
 *   1. readSessionRecords    — <dataDir>/sessions/<sessionId>.trajectory.jsonl
 *                              returns ALL parsed lines (log AND event shapes —
 *                              NO traceSchema envelope filtering, unlike the
 *                              production bundle reader).
 *   2. readCacheTraceRecords — <dataDir>/logs/cache-trace.jsonl, session-filtered.
 *   3. readSessionMetadata   — <sessionId>_session-metadata.json companion (F1
 *                              PRIMARY rollup source).
 *   4. readDiagnosticsRollup — obsStore.queryDiagnostics({category:"session_summary",
 *                              limit:50}) then SESSION-SCOPED filter by row.sessionKey
 *                              (F2 fallback). The multi-session case is RED-pinned:
 *                              the MATCHING row is returned, NOT the most-recent.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeRealReader } from "./obs-explain-readers.js";
import type { IncidentSourceReader } from "./obs-explain-readers.js";

// The 678 fixture's canonical key; sessionId is the trailing colon segment.
const SESSION_KEY = "default:678314278:678314278:peer:678314278";
const SESSION_ID = "678314278";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-readers-"));
}

function writeSessionsFile(dataDir: string, name: string, lines: string[]): void {
  const sessionsDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, name), lines.join("\n") + "\n", "utf-8");
}

function writeLogsFile(dataDir: string, name: string, lines: string[]): void {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, name), lines.join("\n") + "\n", "utf-8");
}

describe("makeRealReader.readSessionRecords", () => {
  it("returns BOTH a raw log line and a structured event (no traceSchema filtering)", async () => {
    const dataDir = tmpDataDir();
    const logLine = JSON.stringify({
      level: 40,
      toolName: "web_fetch",
      msg: "Tool execution failed",
    });
    const eventLine = JSON.stringify({
      traceSchema: "comis-trajectory",
      type: "tool.result",
      seq: 1,
      data: { toolName: "web_fetch", success: false },
    });
    writeSessionsFile(dataDir, `${SESSION_ID}.trajectory.jsonl`, [logLine, eventLine]);

    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);

    // BOTH shapes come back — the log line is NOT dropped for lacking traceSchema.
    expect(records.length).toBe(2);
    expect(records.some((r) => r.msg === "Tool execution failed")).toBe(true);
    expect(records.some((r) => r.traceSchema === "comis-trajectory")).toBe(true);
  });

  it("soft-fails to [] when the session trajectory file is absent", async () => {
    const dataDir = tmpDataDir(); // no sessions/ written
    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);
    expect(records).toEqual([]);
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const dataDir = tmpDataDir();
    writeSessionsFile(dataDir, `${SESSION_ID}.trajectory.jsonl`, [
      "{ not json",
      JSON.stringify({ toolName: "web_fetch", msg: "Tool execution failed" }),
    ]);
    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);
    expect(records.length).toBe(1);
  });
});

describe("makeRealReader.readCacheTraceRecords", () => {
  it("reads the session's cache-trace lines and soft-fails to [] when absent", async () => {
    const dataDir = tmpDataDir();
    // Absent file → [].
    const reader1 = makeRealReader(dataDir);
    expect(await reader1.readCacheTraceRecords(SESSION_KEY)).toEqual([]);

    // Present file → the session's lines, filtered by sessionKey.
    writeLogsFile(dataDir, "cache-trace.jsonl", [
      JSON.stringify({ sessionKey: SESSION_KEY, event: "cache_hit", toolName: "web_fetch" }),
      JSON.stringify({ sessionKey: "default:other:other:peer:other", event: "cache_hit" }),
    ]);
    const reader2 = makeRealReader(dataDir);
    const rows = await reader2.readCacheTraceRecords(SESSION_KEY);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sessionKey).toBe(SESSION_KEY);
  });
});

describe("makeRealReader.readSessionMetadata", () => {
  it("reads the <sessionId>_session-metadata.json companion with sessionEnd fields", async () => {
    const dataDir = tmpDataDir();
    const sessionsDir = path.join(dataDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${SESSION_ID}_session-metadata.json`),
      JSON.stringify({
        sessionId: SESSION_ID,
        sessionCostUsd: 1.320669,
        sessionEnd: { type: "session_end", endReason: "completed_with_tool_errors", degraded: true, costUsd: 1.320669 },
      }),
      "utf-8",
    );
    const reader = makeRealReader(dataDir);
    const meta = await reader.readSessionMetadata(SESSION_KEY);
    expect(meta).not.toBeNull();
    expect(meta!.sessionCostUsd).toBeCloseTo(1.320669, 4);
    expect((meta!.sessionEnd as Record<string, unknown>).degraded).toBe(true);
  });

  it("returns null when the metadata companion is absent", async () => {
    const dataDir = tmpDataDir();
    const reader = makeRealReader(dataDir);
    expect(await reader.readSessionMetadata(SESSION_KEY)).toBeNull();
  });
});

describe("makeRealReader.readDiagnosticsRollup (session-scoped)", () => {
  it("returns the row whose sessionKey MATCHES — NOT the most-recent (multi-session RED-pin)", async () => {
    const dataDir = tmpDataDir();
    // Two session_summary rows for DIFFERENT sessions. queryDiagnostics returns
    // them newest-first (the OTHER session's row is most-recent). The reader
    // must filter by sessionKey and return OUR row, not the newest one.
    const otherRow = {
      category: "session_summary",
      timestamp: 2000,
      severity: "info",
      message: "other session",
      sessionKey: "default:other:other:peer:other",
    };
    const ourRow = {
      category: "session_summary",
      timestamp: 1000,
      severity: "info",
      message: "our session",
      sessionKey: SESSION_KEY,
    };
    const queryDiagnostics = vi.fn().mockReturnValue([otherRow, ourRow]);
    const obsStore = { queryDiagnostics } as unknown as Parameters<typeof makeRealReader>[1];

    const reader = makeRealReader(dataDir, obsStore);
    const rollup = await reader.readDiagnosticsRollup(SESSION_KEY);

    expect(rollup).not.toBeNull();
    expect(rollup!.sessionKey).toBe(SESSION_KEY);
    expect(rollup!.message).toBe("our session");
    // Queried a WINDOW (limit:50), not limit:1.
    expect(queryDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ category: "session_summary", limit: 50 }),
    );
  });

  it("returns null when no row matches the session", async () => {
    const dataDir = tmpDataDir();
    const queryDiagnostics = vi.fn().mockReturnValue([
      { category: "session_summary", timestamp: 1, severity: "info", message: "x", sessionKey: "default:other:other:peer:other" },
    ]);
    const obsStore = { queryDiagnostics } as unknown as Parameters<typeof makeRealReader>[1];
    const reader = makeRealReader(dataDir, obsStore);
    expect(await reader.readDiagnosticsRollup(SESSION_KEY)).toBeNull();
  });

  it("returns null when obsStore is undefined (F1 metadata is the primary source)", async () => {
    const dataDir = tmpDataDir();
    const reader = makeRealReader(dataDir);
    expect(await reader.readDiagnosticsRollup(SESSION_KEY)).toBeNull();
  });
});

describe("makeRealReader path containment", () => {
  it("a traversal sessionId cannot escape <dataDir>/sessions (safePath guard)", async () => {
    const dataDir = tmpDataDir();
    // Plant a file OUTSIDE the dataDir that a naive join would reach.
    const outside = path.join(dataDir, "..", "escape-target.trajectory.jsonl");
    fs.writeFileSync(outside, JSON.stringify({ secret: "leaked" }) + "\n", "utf-8");

    const reader: IncidentSourceReader = makeRealReader(dataDir);
    // A traversal key whose trailing segment is "..". safePath collapses it so
    // the read stays inside <dataDir>/sessions and finds nothing → [].
    const records = await reader.readSessionRecords("default:x:x:peer:..");
    expect(records).toEqual([]);
    fs.rmSync(outside, { force: true });
  });
});
