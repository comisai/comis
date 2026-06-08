// SPDX-License-Identifier: Apache-2.0
/**
 * `readSessionIndexWindow` tests — the A3 multi-day session-index aggregate.
 *
 * A REAL on-disk-layout test (AGENTS §2.10): the §2.10 rule exists because a
 * fixture-only test ("inject a clean array of records") proves the LOGIC but
 * NOT the path resolution / day-windowing / soft-fail — two production-breaking
 * `obs.explain` reader bugs shipped under fixture-only coverage. So this test
 * WRITES actual `<tmpDataDir>/logs/session-index.<date>.jsonl` files for ≥2
 * distinct day-keys, each with real JSONL lines built from the SessionIndexEvent
 * shape, and drives the REAL `readSessionIndexWindow(tmpDataDir, sinceMs)` — no
 * injected reader, no fixture array.
 *
 * The tmp dataDir is always under `os.tmpdir()` (NEVER the real `~/.comis` —
 * the Phase-155 no-prod-datadir hygiene; here the test writes the JSONL files
 * directly rather than via `appendSessionIndexEntry`, so the tmp dir is the
 * isolation, not the write-guard).
 *
 * Cases pinned:
 *   1. ACTIVE AGENTS/CHANNELS across two day-files (distinct agentId / channel).
 *   2. EXIT-REASON DISTRIBUTION histogram from session_ended rows.
 *   3. TURN/TOKEN TOTALS summed from session_ended (authoritative session totals).
 *   4. SYNTHETIC EXCLUSION — a REAL filter: default excludes a `synthetic:true`
 *      row; `{includeSynthetic:true}` includes it (proves not a no-op).
 *   5. SOFT-FAIL — a window day-key with no file → `daysMissing`, no throw; a
 *      malformed line is skipped while adjacent valid lines still aggregate.
 *   6. WINDOWING — a row in a day-file OLDER than the window's earliest day-key
 *      is not read.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { systemDateFrom, systemNowMs } from "@comis/core";
import { readSessionIndexWindow } from "./fleet-session-index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for a given epoch ms — mirrors the reader's day-key derivation. */
function dayKeyForMs(ms: number): string {
  return systemDateFrom(ms).toISOString().slice(0, 10);
}

/** Build a session_started JSONL object. */
function startedRow(
  overrides: {
    agentId: string;
    channelType: string;
    channelId: string;
    sessionId?: string;
    synthetic?: boolean;
  },
): Record<string, unknown> {
  return {
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    ts: new Date(systemNowMs()).toISOString(),
    event: "session_started",
    sessionId: overrides.sessionId ?? `sess-${overrides.agentId}`,
    sessionKey: overrides.sessionId ?? `sess-${overrides.agentId}`,
    channelType: overrides.channelType,
    channelId: overrides.channelId,
    agentId: overrides.agentId,
    traceIds: ["trace-1"],
    ...(overrides.synthetic === true ? { synthetic: true } : {}),
  };
}

/** Build a session_ended JSONL object. */
function endedRow(
  overrides: {
    exitReason: string;
    turnCount: number;
    totalTokens: number;
    sessionId?: string;
    synthetic?: boolean;
  },
): Record<string, unknown> {
  return {
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    ts: new Date(systemNowMs()).toISOString(),
    event: "session_ended",
    sessionId: overrides.sessionId ?? "sess-x",
    exitReason: overrides.exitReason,
    turnCount: overrides.turnCount,
    totalTokens: overrides.totalTokens,
    ...(overrides.synthetic === true ? { synthetic: true } : {}),
  };
}

/**
 * Create a fresh tmp dataDir and write `<tmp>/logs/session-index.<dayKey>.jsonl`
 * for each supplied (dayKey → rows) entry. Each row is JSON.stringify'd one per
 * line (real JSONL). Returns the tmp dataDir absolute path.
 */
function makeDataDirWithDayFiles(
  byDay: Array<{ dayKey: string; lines: string[] }>,
): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-session-index-"));
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  for (const { dayKey, lines } of byDay) {
    const file = path.join(logsDir, `session-index.${dayKey}.jsonl`);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  }
  return dataDir;
}

describe("readSessionIndexWindow", () => {
  it("lists distinct active agents and channels from session_started rows across two day-files", () => {
    const today = dayKeyForMs(systemNowMs());
    const yesterday = dayKeyForMs(systemNowMs() - DAY_MS);
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: yesterday,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-a", channelType: "telegram", channelId: "111" }),
          ),
        ],
      },
      {
        dayKey: today,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-b", channelType: "discord", channelId: "222" }),
          ),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs() - DAY_MS);

    // Distinct agents from BOTH day-files, sorted for determinism.
    expect(result.activeAgents).toEqual(["agent-a", "agent-b"]);
    // Distinct "channelType:channelId" from BOTH day-files, sorted.
    expect(result.activeChannels).toEqual(["discord:222", "telegram:111"]);
    // Two day-files in the window were opened and read.
    expect(result.daysRead).toBe(2);
    expect(result.daysMissing).toBe(0);
  });

  it("builds an exit-reason histogram from session_ended rows", () => {
    const today = dayKeyForMs(systemNowMs());
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 1, totalTokens: 10, sessionId: "s1" })),
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 1, totalTokens: 20, sessionId: "s2" })),
          JSON.stringify(endedRow({ exitReason: "error", turnCount: 1, totalTokens: 30, sessionId: "s3" })),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs());

    expect(result.exitReasons).toEqual({ success: 2, error: 1 });
  });

  it("sums turn and token totals from the authoritative session_ended rows", () => {
    const today = dayKeyForMs(systemNowMs());
    const yesterday = dayKeyForMs(systemNowMs() - DAY_MS);
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: yesterday,
        lines: [
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 3, totalTokens: 100, sessionId: "s1" })),
        ],
      },
      {
        dayKey: today,
        lines: [
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 4, totalTokens: 250, sessionId: "s2" })),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs() - DAY_MS);

    expect(result.turnTotal).toBe(7);
    expect(result.tokenTotal).toBe(350);
  });

  it("excludes a synthetic:true row by default but includes it under includeSynthetic (a REAL filter, not a no-op)", () => {
    const today = dayKeyForMs(systemNowMs());
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-real", channelType: "telegram", channelId: "111" }),
          ),
          // A synthetic session: a started + an ended row, both stamped synthetic.
          JSON.stringify(
            startedRow({
              agentId: "agent-synthetic",
              channelType: "discord",
              channelId: "999",
              synthetic: true,
            }),
          ),
          JSON.stringify(
            endedRow({ exitReason: "harness", turnCount: 99, totalTokens: 9999, sessionId: "syn", synthetic: true }),
          ),
        ],
      },
    ]);

    // Default: synthetic excluded — only the real agent/channel, no harness totals.
    const excluded = readSessionIndexWindow(dataDir, systemNowMs());
    expect(excluded.activeAgents).toEqual(["agent-real"]);
    expect(excluded.activeChannels).toEqual(["telegram:111"]);
    expect(excluded.exitReasons).toEqual({});
    expect(excluded.turnTotal).toBe(0);
    expect(excluded.tokenTotal).toBe(0);

    // Opt-in: synthetic included — proves the filter is not a no-op. nowMs is
    // the explicit window upper bound (the 3rd positional arg post-WR-01).
    const included = readSessionIndexWindow(dataDir, systemNowMs(), systemNowMs(), { includeSynthetic: true });
    expect(included.activeAgents).toEqual(["agent-real", "agent-synthetic"]);
    expect(included.activeChannels).toEqual(["discord:999", "telegram:111"]);
    expect(included.exitReasons).toEqual({ harness: 1 });
    expect(included.turnTotal).toBe(99);
    expect(included.tokenTotal).toBe(9999);
  });

  it("treats a string 'true' synthetic field as NON-synthetic and still aggregates the row (strict === true)", () => {
    // Untrusted JSONL: only a real boolean true excludes — a string must not be
    // truthy-coerced into a spurious exclusion of a real session.
    const today = dayKeyForMs(systemNowMs());
    const row = startedRow({ agentId: "agent-real", channelType: "telegram", channelId: "111" });
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [JSON.stringify({ ...row, synthetic: "true" })],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs());
    expect(result.activeAgents).toEqual(["agent-real"]);
  });

  it("soft-fails a window day-key with no file (counts daysMissing, never throws)", () => {
    // Window spans yesterday..today but only today's file exists.
    const today = dayKeyForMs(systemNowMs());
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-a", channelType: "telegram", channelId: "111" }),
          ),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs() - DAY_MS);

    expect(result.activeAgents).toEqual(["agent-a"]);
    expect(result.daysRead).toBe(1); // today
    expect(result.daysMissing).toBe(1); // yesterday's file is absent
  });

  it("skips a malformed JSONL line and still aggregates the valid lines around it", () => {
    const today = dayKeyForMs(systemNowMs());
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [
          "{ this is not valid json",
          JSON.stringify(
            startedRow({ agentId: "agent-a", channelType: "telegram", channelId: "111" }),
          ),
          "}}}also broken",
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 2, totalTokens: 50, sessionId: "s1" })),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs());

    expect(result.activeAgents).toEqual(["agent-a"]);
    expect(result.exitReasons).toEqual({ success: 1 });
    expect(result.turnTotal).toBe(2);
    expect(result.tokenTotal).toBe(50);
    expect(result.daysRead).toBe(1);
  });

  it("does not read a day-file OLDER than the window's earliest day-key (windowing)", () => {
    const today = dayKeyForMs(systemNowMs());
    const twoDaysAgo = dayKeyForMs(systemNowMs() - 2 * DAY_MS);
    const dataDir = makeDataDirWithDayFiles([
      {
        // OLDER than the window (sinceMs is today) — must NOT be opened.
        dayKey: twoDaysAgo,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-old", channelType: "telegram", channelId: "111" }),
          ),
        ],
      },
      {
        dayKey: today,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-today", channelType: "discord", channelId: "222" }),
          ),
        ],
      },
    ]);

    // Window starts today → only today's day-key is iterated.
    const result = readSessionIndexWindow(dataDir, systemNowMs());

    expect(result.activeAgents).toEqual(["agent-today"]);
    expect(result.activeAgents).not.toContain("agent-old");
    expect(result.daysRead).toBe(1);
    expect(result.daysMissing).toBe(0);
  });

  it("uses the INJECTED nowMs as the window upper bound, not real Date.now() (WR-01 determinism seam)", () => {
    // WR-01: the day-key window upper bound must be the injected `nowMs`, so a
    // single clock instant flows through the whole fleet assembly. We key the
    // day-file to a FIXED historical instant and pass that same instant as
    // `nowMs`; the reader must resolve the window to that historical day and
    // read the file. Pre-fix the reader called its own systemNowMs() (real
    // today) → it iterated real-today's day-key and missed the historical file
    // (daysRead 0). This FAILS on the pre-patch signature/code.
    const fixedNow = Date.UTC(2020, 0, 2, 9, 0, 0); // 2020-01-02T09:00:00Z
    const fixedDayKey = dayKeyForMs(fixedNow); // "2020-01-02"
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: fixedDayKey,
        lines: [
          JSON.stringify(startedRow({ agentId: "agent-fixed", channelType: "telegram", channelId: "111" })),
          JSON.stringify(endedRow({ exitReason: "success", turnCount: 2, totalTokens: 42, sessionId: "f1" })),
        ],
      },
    ]);

    // sinceMs = the fixed day's start; nowMs = the fixed instant. The window is
    // a single historical day-key, resolved entirely from the injected clock.
    const result = readSessionIndexWindow(dataDir, fixedNow - DAY_MS, fixedNow);

    expect(result.activeAgents).toEqual(["agent-fixed"]);
    expect(result.turnTotal).toBe(2);
    expect(result.tokenTotal).toBe(42);
    expect(result.daysRead).toBe(1);
  });

  it("returns a zeroed summary with no throw when the logs directory is entirely absent (soft-fail)", () => {
    const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-session-index-empty-"));
    const result = readSessionIndexWindow(emptyDataDir, systemNowMs());

    expect(result.activeAgents).toEqual([]);
    expect(result.activeChannels).toEqual([]);
    expect(result.exitReasons).toEqual({});
    expect(result.turnTotal).toBe(0);
    expect(result.tokenTotal).toBe(0);
    expect(result.daysRead).toBe(0);
    expect(result.daysMissing).toBe(1); // today's day-key in the window, no file
  });

  it("clamps an over-long window to the most-recent MAX_DAYS day-keys (bounded work)", () => {
    // sinceMs 400 days back would naively open 401 day-files; the reader clamps
    // to MAX_DAYS. Only today's file exists; the assertion is that it does not
    // throw / hang and still reads today's row, with daysMissing bounded.
    const today = dayKeyForMs(systemNowMs());
    const dataDir = makeDataDirWithDayFiles([
      {
        dayKey: today,
        lines: [
          JSON.stringify(
            startedRow({ agentId: "agent-a", channelType: "telegram", channelId: "111" }),
          ),
        ],
      },
    ]);

    const result = readSessionIndexWindow(dataDir, systemNowMs() - 400 * DAY_MS);

    expect(result.activeAgents).toEqual(["agent-a"]);
    expect(result.daysRead).toBe(1);
    // The window is clamped, so daysMissing is bounded by MAX_DAYS, not 400.
    expect(result.daysMissing).toBeLessThanOrEqual(90);
  });
});
