// SPDX-License-Identifier: Apache-2.0
/**
 * `IncidentSourceReader` + `makeRealReader` tests — the four bounded source
 * readers behind one DI seam (the fixture-injection seam).
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
 *                              limit:1000}) then SESSION-SCOPED filter by row.sessionKey
 *                              (F2 fallback). The multi-session case is pinned:
 *                              the MATCHING row is returned, NOT the most-recent;
 *                              and a target behind 200 newer rows is still found
 *                              (the query window is 1000 rows wide).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeTrajectoryPointerFileBestEffort } from "@comis/observability";
import { makeRealReader } from "./obs-explain-readers.js";
import type { IncidentSourceReader } from "./obs-explain-readers.js";

// The 678 fixture's canonical key; sessionId is the trailing colon segment.
const SESSION_KEY = "default:agent:default:678314278:678314278:peer:678314278";
const SESSION_ID = "678314278";

// The REAL production on-disk layout for SESSION_KEY (verified against live
// ~/.comis): sessions live under <dataDir>/workspace/sessions/<tenant>/<channel>/
// keyed by the encoded SessionKey filename (sessionKeyToPath), NOT under a flat
// <dataDir>/sessions/<sessionId>.* path. tenant="default", channel="678314278",
// file="678314278~peer~678314278.jsonl" (userId[~peer~peerId].jsonl).
const REAL_TENANT = "default";
const REAL_CHANNEL = "678314278";
const REAL_SESSION_FILE = "678314278~peer~678314278.jsonl";

/**
 * Build the REAL production session directory for SESSION_KEY under a temp
 * dataDir and return the absolute `.jsonl` sessionFile path. Mirrors what the
 * pi-agent session manager + trajectory recorder write on disk:
 *   <dataDir>/workspace/sessions/<tenant>/<channel>/<file>.jsonl   (session JSONL)
 */
function makeRealSessionDir(dataDir: string): string {
  const dir = path.join(dataDir, "workspace", "sessions", REAL_TENANT, REAL_CHANNEL);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, REAL_SESSION_FILE);
  // The session JSONL itself (message log) — empty is fine; the readers target
  // its trajectory/metadata siblings.
  fs.writeFileSync(sessionFile, "", "utf-8");
  writeTrajectoryPointerFileBestEffort({
    sessionFile,
    sessionId: SESSION_KEY,
    runtimeFile: `${sessionFile}.trajectory.jsonl`,
  });
  return sessionFile;
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-readers-"));
}

/**
 * Write the trajectory JSONL for SESSION_KEY at its REAL co-located path
 * (`<sessionFile>.trajectory.jsonl`). No pointer file → the reader resolves via
 * the co-located fallback (exercises the production resolution end-to-end).
 */
function writeRealTrajectory(dataDir: string, lines: string[]): void {
  const sessionFile = makeRealSessionDir(dataDir);
  fs.writeFileSync(`${sessionFile}.trajectory.jsonl`, lines.join("\n") + "\n", "utf-8");
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
    writeRealTrajectory(dataDir, [logLine, eventLine]);

    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);

    // BOTH shapes come back — the log line is NOT dropped for lacking traceSchema.
    expect(records.length).toBe(2);
    expect(records.some((r) => r.msg === "Tool execution failed")).toBe(true);
    expect(records.some((r) => r.traceSchema === "comis-trajectory")).toBe(true);
  });

  it("soft-fails to [] when the session trajectory file is absent", async () => {
    const dataDir = tmpDataDir(); // no workspace/sessions tree written
    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);
    expect(records).toEqual([]);
  });

  it("skips malformed JSONL lines and blank lines without throwing", async () => {
    const dataDir = tmpDataDir();
    writeRealTrajectory(dataDir, [
      "{ not json",
      "   ", // blank/whitespace-only line — skipped
      JSON.stringify({ toolName: "web_fetch", msg: "Tool execution failed" }),
    ]);
    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);
    expect(records.length).toBe(1);
  });

  it("soft-fails to [] when the sessionKey is not a parseable formatted key", async () => {
    // The reader resolves the path via parseFormattedSessionKey + sessionKeyToPath
    // (the authoritative mapper), which needs ≥3 colon-delimited fields. A bare
    // token has no tenant/user/channel → unparseable → [] (no throw).
    const dataDir = tmpDataDir();
    const reader = makeRealReader(dataDir);
    expect(await reader.readSessionRecords("barekey")).toEqual([]);
  });
});

describe("makeRealReader REAL production layout (workspace/sessions + pointer)", () => {
  // Regression net for the centerpiece bug: makeRealReader resolved a flat
  // <dataDir>/sessions/<sessionId>.* path that DOES NOT EXIST in production.
  // The real layout is <dataDir>/workspace/sessions/<tenant>/<channel>/<file>,
  // with the trajectory located via the <file>.trajectory-path.json pointer.
  // These tests build that exact layout and FAIL on the pre-fix code (which
  // reads nothing → empty report, endReason=unknown, 0 failures/offloads).

  it("readSessionRecords resolves the trajectory via the .trajectory-path.json pointer (failure + offload events surface)", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = makeRealSessionDir(dataDir);

    // A real degraded turn: a classified tool failure + an offloaded result.
    const failureEvent = JSON.stringify({
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "tool.result",
      seq: 1,
      sessionId: SESSION_KEY,
      data: { toolName: "web_fetch", success: false, classifiedFailureBy: "executor" },
    });
    const offloadEvent = JSON.stringify({
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      type: "tool.result_offloaded",
      seq: 2,
      sessionId: SESSION_KEY,
      data: { toolName: "web_fetch", diskPathRel: "tool-results/call_abc.json" },
    });
    // The trajectory lives at a runtimeFile that the POINTER names (the
    // co-located <sessionFile>.trajectory.jsonl path here, matching prod).
    const runtimeFile = `${sessionFile}.trajectory.jsonl`;
    fs.writeFileSync(runtimeFile, [failureEvent, offloadEvent].join("\n") + "\n", "utf-8");
    // The canonical pointer the recorder writes alongside the session JSONL.
    fs.writeFileSync(
      `${sessionFile}.trajectory-path.json`,
      JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        sessionId: SESSION_KEY,
        runtimeFile,
      }),
      "utf-8",
    );

    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(SESSION_KEY);

    expect(records.length).toBe(2);
    expect(records.some((r) => (r.data as Record<string, unknown>)?.classifiedFailureBy === "executor")).toBe(true);
    expect(records.some((r) => r.type === "tool.result_offloaded")).toBe(true);
  });

  it("readSessionMetadata reads the <file>_session-metadata.json companion next to the session JSONL (sessionEnd rollup)", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = makeRealSessionDir(dataDir);
    // Metadata companion = sessionFile with `.jsonl` → `_session-metadata.json`
    // (comis-session-manager.ts:392), NOT <dataDir>/sessions/<id>_session-metadata.json.
    const metadataFile = sessionFile.replace(/\.jsonl$/, "_session-metadata.json");
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        traceId: "trace-1",
        sessionEnd: {
          type: "session_end",
          endReason: "completed_with_tool_errors",
          degraded: true,
          costUsd: 1.320669,
          breakerTripCount: 0,
        },
      }),
      "utf-8",
    );

    const reader = makeRealReader(dataDir);
    const meta = await reader.readSessionMetadata(SESSION_KEY);
    expect(meta).not.toBeNull();
    expect((meta!.sessionEnd as Record<string, unknown>).endReason).toBe("completed_with_tool_errors");
    expect((meta!.sessionEnd as Record<string, unknown>).degraded).toBe(true);
  });

  it("soft-fails to []/null when the workspace session dir is absent (no throw)", async () => {
    const dataDir = tmpDataDir(); // no workspace/sessions tree written
    const reader = makeRealReader(dataDir);
    expect(await reader.readSessionRecords(SESSION_KEY)).toEqual([]);
    expect(await reader.readSessionMetadata(SESSION_KEY)).toBeNull();
  });
});

describe("makeRealReader webhook (multi-colon userId) resolution via the pointer sessionId", () => {
  // A webhook session is created with SessionKey
  //   {tenantId:"default", userId:"hook:devtask:wh1", channelId:"webhook"}
  // → formatSessionKey ⇒ "default:hook:devtask:wh1:webhook" and sessionKeyToPath
  // ⇒ default/webhook/hook@3adevtask@3awh1.jsonl (channel=dir, encoded userId=file).
  // But parseFormattedSessionKey GREEDILY joins the multi-segment span into
  // channelId ({userId:"hook", channelId:"devtask:wh1:webhook"}) — the inverse of
  // the writer's intent — because a colon-bearing userId is genuinely ambiguous in
  // the "tenant:user:channel" string. So resolveSessionFile computes a path that
  // does not exist and the readers return nothing — a false "nothing happened" for
  // a session that SUCCEEDED (the exact DAG-async webhook diagnostic lens).
  //
  // The fix: when the fast-path artifacts are absent, resolveSessionFile falls back
  // to the AUTHORITATIVE on-disk record — the <file>.jsonl.trajectory-path.json
  // pointer whose `sessionId` carries the verbatim formatted key. These tests build
  // that exact layout and FAIL on the pre-fix code (mis-parsed path → []/null).
  const WH_KEY = "default:hook:devtask:wh1:webhook";
  const WH_TENANT = "default";
  const WH_CHANNEL = "webhook";
  // sessionKeyToPath encoding of userId "hook:devtask:wh1" (":" → "@3a").
  const WH_FILE = "hook@3adevtask@3awh1.jsonl";

  function makeWebhookSessionDir(dataDir: string): string {
    const dir = path.join(dataDir, "workspace", "sessions", WH_TENANT, WH_CHANNEL);
    fs.mkdirSync(dir, { recursive: true });
    const sessionFile = path.join(dir, WH_FILE);
    fs.writeFileSync(sessionFile, "", "utf-8"); // the session JSONL (message log).
    return sessionFile;
  }

  function writePointer(sessionFile: string, sessionId: string): void {
    fs.writeFileSync(
      `${sessionFile}.trajectory-path.json`,
      JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        sessionId,
        runtimeFile: `${sessionFile}.trajectory.jsonl`,
      }),
      "utf-8",
    );
  }

  it("readSessionMetadata resolves the webhook rollup via the pointer's sessionId (RED pre-fix: parse mis-splits the colon-bearing userId → null)", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = makeWebhookSessionDir(dataDir);
    writePointer(sessionFile, WH_KEY);
    fs.writeFileSync(
      sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
      JSON.stringify({
        sessionEnd: {
          type: "session_end",
          endReason: "success",
          degraded: false,
          costUsd: 0.8444,
          totalTokens: 495290,
        },
      }),
      "utf-8",
    );

    const reader = makeRealReader(dataDir);
    const meta = await reader.readSessionMetadata(WH_KEY);
    expect(meta).not.toBeNull();
    expect((meta!.sessionEnd as Record<string, unknown>).endReason).toBe("success");
    expect((meta!.sessionEnd as Record<string, unknown>).totalTokens).toBe(495290);
  });

  it("readSessionRecords resolves the webhook trajectory via the pointer (RED pre-fix: [])", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = makeWebhookSessionDir(dataDir);
    writePointer(sessionFile, WH_KEY);
    fs.writeFileSync(
      `${sessionFile}.trajectory.jsonl`,
      JSON.stringify({ traceSchema: "comis-trajectory", type: "model.completed", seq: 1, data: {} }) + "\n",
      "utf-8",
    );

    const reader = makeRealReader(dataDir);
    const records = await reader.readSessionRecords(WH_KEY);
    expect(records.length).toBe(1);
    expect(records[0]!.type).toBe("model.completed");
  });

  it("matches the pointer's sessionId EXACTLY — a different webhook key gets no cross-session bleed (null)", async () => {
    const dataDir = tmpDataDir();
    const sessionFile = makeWebhookSessionDir(dataDir); // pointer sessionId = WH_KEY
    writePointer(sessionFile, WH_KEY);
    fs.writeFileSync(
      sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
      JSON.stringify({ sessionEnd: { type: "session_end", endReason: "success" } }),
      "utf-8",
    );
    const reader = makeRealReader(dataDir);
    // A DIFFERENT, non-existent webhook key: its fast path misses AND no pointer's
    // sessionId equals it → null (no bleed from the present, unrelated session).
    expect(await reader.readSessionMetadata("default:hook:devtask:OTHER:webhook")).toBeNull();
  });

  it("does not regress the clean telegram fast path (fallback only fires on a fast-path miss)", async () => {
    // The canonical telegram SESSION_KEY round-trips cleanly: its fast-path
    // artifacts exist, so resolveSessionFile must NOT consult the pointer fallback
    // (and must return the telegram rollup, not the webhook one even if both live
    // under the same tenant).
    const dataDir = tmpDataDir();
    // Webhook session present under the same tenant (a decoy for the fallback).
    const whFile = makeWebhookSessionDir(dataDir);
    writePointer(whFile, WH_KEY);
    fs.writeFileSync(
      whFile.replace(/\.jsonl$/, "_session-metadata.json"),
      JSON.stringify({ sessionEnd: { endReason: "webhook-decoy" } }),
      "utf-8",
    );
    // The real telegram layout for SESSION_KEY.
    fs.writeFileSync(
      realMetadataPath(dataDir),
      JSON.stringify({ sessionEnd: { type: "session_end", endReason: "completed", degraded: false } }),
      "utf-8",
    );
    const reader = makeRealReader(dataDir);
    const meta = await reader.readSessionMetadata(SESSION_KEY);
    expect(meta).not.toBeNull();
    expect((meta!.sessionEnd as Record<string, unknown>).endReason).toBe("completed");
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

/** Absolute `_session-metadata.json` companion path for the real SESSION_KEY layout. */
function realMetadataPath(dataDir: string): string {
  const sessionFile = makeRealSessionDir(dataDir);
  return sessionFile.replace(/\.jsonl$/, "_session-metadata.json");
}

describe("makeRealReader.readSessionMetadata", () => {
  it("reads the <file>_session-metadata.json companion with sessionEnd fields", async () => {
    const dataDir = tmpDataDir();
    fs.writeFileSync(
      realMetadataPath(dataDir),
      JSON.stringify({
        sessionId: SESSION_ID,
        executionCostUsd: 1.320669,
        sessionEnd: { type: "session_end", endReason: "completed_with_tool_errors", degraded: true, costUsd: 1.320669 },
      }),
      "utf-8",
    );
    const reader = makeRealReader(dataDir);
    const meta = await reader.readSessionMetadata(SESSION_KEY);
    expect(meta).not.toBeNull();
    expect(meta!.executionCostUsd).toBeCloseTo(1.320669, 4);
    expect((meta!.sessionEnd as Record<string, unknown>).degraded).toBe(true);
  });

  it("returns null when the metadata companion is absent", async () => {
    const dataDir = tmpDataDir();
    const reader = makeRealReader(dataDir);
    expect(await reader.readSessionMetadata(SESSION_KEY)).toBeNull();
  });

  it("returns null when the metadata companion is corrupt JSON (soft-fail)", async () => {
    const dataDir = tmpDataDir();
    fs.writeFileSync(realMetadataPath(dataDir), "{ corrupt json not closed", "utf-8");
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
    // Queried a WINDOW (limit:1000), not limit:1.
    expect(queryDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ category: "session_summary", limit: 1000 }),
    );
  });

  it("finds the target row even when many newer session_summary rows precede it (wide recency window)", async () => {
    // A busy daemon writes many session_summary rows AFTER the target session
    // ends. queryDiagnostics orders timestamp DESC, so the target sits deep in
    // the result. The reader queries a WINDOW then filters by sessionKey — the
    // window must be large enough that a realistically-old target is still
    // inside it (with a window of 50, a target behind 50+ newer rows would be
    // silently missed: the F2 rollup returns null and the report loses every
    // field only F2 can supply). This pins a target at depth 200.
    const dataDir = tmpDataDir();
    const newerCount = 200;
    const rows = [
      ...Array.from({ length: newerCount }, (_, i) => ({
        category: "session_summary",
        timestamp: 100_000 - i, // newest-first; all NEWER than the target
        severity: "info",
        message: `newer ${i}`,
        sessionKey: `default:newer-${i}:newer-${i}:peer:newer-${i}`,
      })),
      {
        category: "session_summary",
        timestamp: 1, // oldest → last in the DESC result
        severity: "info",
        message: "our older session",
        sessionKey: SESSION_KEY,
      },
    ];
    // Honor the query limit the reader passes (the real store applies LIMIT in
    // SQL), so the test fails if the reader's window is smaller than the target
    // depth.
    const queryDiagnostics = vi.fn((params: { limit?: number }) =>
      rows.slice(0, params.limit ?? rows.length),
    );
    const obsStore = { queryDiagnostics } as unknown as Parameters<typeof makeRealReader>[1];

    const reader = makeRealReader(dataDir, obsStore);
    const rollup = await reader.readDiagnosticsRollup(SESSION_KEY);

    expect(rollup).not.toBeNull();
    expect(rollup!.sessionKey).toBe(SESSION_KEY);
    expect(rollup!.message).toBe("our older session");
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

describe("makeRealReader default data dir", () => {
  it("falls back to ~/.comis when an empty dataDir is passed (soft-fail to [])", async () => {
    // Empty dataDir → defaultDataDir() (~/.comis); a synthetic key has no file
    // there → [] without throwing. Exercises the default-dir branch.
    const reader = makeRealReader("");
    const records = await reader.readSessionRecords(
      "default:synthetic-no-such-session:x:peer:synthetic-no-such-session",
    );
    expect(records).toEqual([]);
  });
});

describe("makeRealReader path containment", () => {
  it("a traversal-bearing sessionKey cannot escape <workspaceDir>/sessions (sessionKeyToPath safePath guard)", async () => {
    const dataDir = tmpDataDir();
    // Plant a file OUTSIDE the workspace sessions tree that a naive join might reach.
    const outside = path.join(dataDir, "..", "escape-target.trajectory.jsonl");
    fs.writeFileSync(outside, JSON.stringify({ secret: "leaked" }) + "\n", "utf-8");

    const reader: IncidentSourceReader = makeRealReader(dataDir);
    // A traversal-bearing key: sessionKeyToPath runs every field through safePath
    // (and `..` survives encodeComponent only as a filename fragment, never a
    // path segment), so the read stays inside <workspaceDir>/sessions and finds
    // nothing → [] (no leak, no throw).
    const records = await reader.readSessionRecords("default:..:..:peer:..");
    expect(records).toEqual([]);
    fs.rmSync(outside, { force: true });
  });
});

// ---------------------------------------------------------------------------
// rankCandidateSessionKeys — the "did you mean …?" ranker for a 0-record miss
// (a lossy/partial key like `telegram:<chatId>` → the real formatted key).
// ---------------------------------------------------------------------------
describe("rankCandidateSessionKeys", () => {
  const REAL = [
    "default:678314278:678314278:peer:678314278",
    "default:111:111:peer:111",
    "default:heartbeat-agent1:system:cron:x",
  ];

  it("surfaces the formatted key from a natural `channel:chatId` request (the live friction)", async () => {
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    const out = rankCandidateSessionKeys("telegram:678314278", REAL);
    expect(out[0]).toBe("default:678314278:678314278:peer:678314278");
  });

  it("surfaces the formatted key from the TILDE-form `<user>~peer~<peer>` request (the trajectory-filename + drive.mjs friction)", async () => {
    // `drive.mjs` and the ground-truth read-order surface the tilde-form
    // (`678314278~peer~678314278`) as the session's name — an operator naturally
    // pastes THAT into `comis explain`. Splitting only on ':' left it one
    // no-overlap blob → [] → the misleading bare session_not_found. It must
    // tokenize on '~' and match the real colon-form key.
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    const out = rankCandidateSessionKeys("678314278~peer~678314278", REAL);
    expect(out[0]).toBe("default:678314278:678314278:peer:678314278");
  });

  it("ranks a MORE-matching key above a less-matching one (segment overlap count)", async () => {
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    // Requesting two segments that both appear in the 678 key ranks it first.
    const out = rankCandidateSessionKeys("678314278:peer", REAL);
    expect(out[0]).toBe("default:678314278:678314278:peer:678314278");
  });

  it("returns [] when nothing shares a segment (no false suggestions)", async () => {
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    expect(rankCandidateSessionKeys("telegram:999999", REAL)).toEqual([]);
  });

  it("returns [] for an empty / separators-only request", async () => {
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    expect(rankCandidateSessionKeys("", REAL)).toEqual([]);
    expect(rankCandidateSessionKeys(":::", REAL)).toEqual([]);
    expect(rankCandidateSessionKeys("~/~", REAL)).toEqual([]);
  });

  it("dedupes + caps to the limit", async () => {
    const { rankCandidateSessionKeys } = await import("./obs-explain-readers.js");
    const many = Array.from({ length: 20 }, (_, i) => `default:678314278:${i}:peer:${i}`);
    const out = rankCandidateSessionKeys("678314278", [...many, ...many], 5);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5); // no duplicates
  });
});
