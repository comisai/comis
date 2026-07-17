// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for appendSessionIndexEntry — the append-only session index writer.
 *
 * Invariants verified:
 *
 *   1. Writes one JSONL line to <dataDir>/logs/session-index.YYYY-MM-DD.jsonl
 *   2. Date-roll: a simulated day boundary creates a new file
 *   3. Schema discipline: traceSchema + schemaVersion on every record
 *   4. turn_completed carries BOTH inputTokens AND outputTokens
 *   5. File mode is 0o600 (O_NOFOLLOW + fchmod via QueuedFileWriter)
 *   6. Return value is "queued" on success
 *   7. ts field is ISO 8601
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionStartedEvent, TurnCompletedEvent, SessionEndedEvent } from "./types.js";
import { appendSessionIndexEntry } from "./append.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSessionStarted(): SessionStartedEvent {
  return {
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    event: "session_started",
    ts: new Date().toISOString(),
    sessionId: "t1:c1:u1",
    sessionKey: "t1:c1:u1",
    channelType: "telegram",
    channelId: "test-channel",
    agentId: "test-agent",
    traceIds: ["exec-001"],
  };
}

function makeTurnCompleted(): TurnCompletedEvent {
  return {
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    event: "turn_completed",
    ts: new Date().toISOString(),
    sessionId: "t1:c1:u1",
    messageId: "inbound-message-1",
    traceId: "exec-001",
    durationMs: 1234,
    inputTokens: 100,
    outputTokens: 50,
    lastError: null,
  };
}

function makeSessionEnded(): SessionEndedEvent {
  return {
    traceSchema: "comis-session-index",
    schemaVersion: 1,
    event: "session_ended",
    ts: new Date().toISOString(),
    sessionId: "t1:c1:u1",
    exitReason: "destroyed",
    turnCount: 1,
    totalTokens: 150,
  };
}

/**
 * The session-index filename is keyed by the current UTC date — `append.ts`
 * derives it as `new Date().toISOString().slice(0, 10)`. Tests that assert on
 * the written file must compute the expected day the same way, otherwise they
 * pass only on the single hardcoded calendar day they were written on.
 */
function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const tmpDirs: string[] = [];

beforeEach(() => {
  // Pin the clock so the date-rolled file path (session-index.2026-05-25.jsonl)
  // is deterministic regardless of the wall-clock date the suite runs on. The
  // writer derives the filename from systemNowMs(); without this the hardcoded
  // dates only matched on the real 2026-05-25 and the suite broke on every
  // later day. The date-roll test overrides setSystemTime to cross UTC midnight.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-25T12:00:00Z"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidx-"));
  tmpDirs.push(tmpDir);
});

afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("appendSessionIndexEntry — JSONL write", () => {
  it("writes one JSONL line to <dataDir>/logs/session-index.YYYY-MM-DD.jsonl for session_started", async () => {
    const event = makeSessionStarted();
    appendSessionIndexEntry(tmpDir, event);

    // Await async flush via microtask
    await vi.runAllTimersAsync();

    const expectedPath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const lines = fs.readFileSync(expectedPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("session_started");
    expect(parsed.sessionId).toBe("t1:c1:u1");
  });

  it("creates a new file session-index.<nextDay>.jsonl when writing past midnight UTC", async () => {
    // beforeEach already installed fake timers; set the pre-midnight time.
    vi.setSystemTime(new Date("2026-05-25T23:59:00Z"));

    const event1 = makeSessionStarted();
    appendSessionIndexEntry(tmpDir, event1);

    // Advance clock past midnight UTC
    vi.setSystemTime(new Date("2026-05-26T00:00:01Z"));

    const event2 = makeTurnCompleted();
    appendSessionIndexEntry(tmpDir, event2);

    // Drain the queued promise chain — runAllTimersAsync advances fake timers
    // and flushes microtasks so the QueuedFileWriter's async append completes.
    await vi.runAllTimersAsync();

    const day1File = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
    const day2File = path.join(tmpDir, "logs", "session-index.2026-05-26.jsonl");

    expect(fs.existsSync(day1File)).toBe(true);
    expect(fs.existsSync(day2File)).toBe(true);
  });

  it("writes records with traceSchema: 'comis-session-index' and schemaVersion: 1", async () => {
    const events = [makeSessionStarted(), makeTurnCompleted(), makeSessionEnded()];

    for (const ev of events) {
      appendSessionIndexEntry(tmpDir, ev);
    }

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.traceSchema).toBe("comis-session-index");
      expect(parsed.schemaVersion).toBe(1);
    }
  });

  it("turn_completed payload carries BOTH inputTokens and outputTokens as numbers", async () => {
    const event = makeTurnCompleted();
    appendSessionIndexEntry(tmpDir, event);

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim());

    expect(typeof parsed.inputTokens).toBe("number");
    expect(typeof parsed.outputTokens).toBe("number");
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.outputTokens).toBe(50);
  });

  it("produces a file with mode 0o600 after first write (QueuedFileWriter O_NOFOLLOW + fchmod)", async () => {
    const event = makeSessionStarted();
    appendSessionIndexEntry(tmpDir, event);

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns 'queued' on success", () => {
    const event = makeSessionStarted();
    const result = appendSessionIndexEntry(tmpDir, event);
    expect(result).toBe("queued");
  });

  it("writes records with ts in ISO 8601 format", async () => {
    const events = [makeSessionStarted(), makeTurnCompleted(), makeSessionEnded()];

    for (const ev of events) {
      appendSessionIndexEntry(tmpDir, ev);
    }

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");

    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toMatch(isoPattern);
    }
  });
});

// ---------------------------------------------------------------------------
// synthetic?/source? optional fields — round-trip
// ---------------------------------------------------------------------------

describe("appendSessionIndexEntry — synthetic/source provenance", () => {
  it("round-trips an explicit source:'test' + synthetic:true through the JSONL", async () => {
    // source and synthetic are optional readonly provenance fields on
    // SessionIndexEventBase; this literal sets both explicitly to prove they
    // survive the JSONL write and read back intact.
    const rec: SessionStartedEvent = {
      ...makeSessionStarted(),
      source: "test",
      synthetic: true,
    };
    appendSessionIndexEntry(tmpDir, rec);

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    expect(parsed.source).toBe("test");
    expect(parsed.synthetic).toBe(true);
  });

  it("leaves source/synthetic undefined when absent on the production (non-test) path", async () => {
    // A production-shaped row carries NEITHER field — readers treat absence as
    // synthetic !== true (the obs.* default-include case). To exercise the
    // production branch from inside vitest (which auto-sets VITEST=true +
    // NODE_ENV=test), both flags are stubbed to non-test values so the
    // test-process stamp does NOT fire. (Under VITEST the writer always stamps
    // source:"test" — covered by the write-guard suite below.)
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    appendSessionIndexEntry(tmpDir, makeSessionStarted());

    await vi.runAllTimersAsync();

    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    expect(parsed.source).toBeUndefined();
    expect(parsed.synthetic).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("accepts the closed source union: 'runtime' | 'test' | 'bench' (type-level)", () => {
    // Type-level assertion: the closed union holds. A value outside it would
    // fail tsc (verified at build time, not runtime).
    const sources: ReadonlyArray<NonNullable<SessionStartedEvent["source"]>> = [
      "runtime",
      "test",
      "bench",
    ];
    expect(sources).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// VITEST + real-~/.comis throw-guard — stops a test run polluting production telemetry
// ---------------------------------------------------------------------------

describe("appendSessionIndexEntry — test-process write-guard", () => {
  it("throws when VITEST=true and dataDir is under the real ~/.comis", () => {
    vi.stubEnv("VITEST", "true");
    const realHome = path.join(os.homedir(), ".comis");
    expect(() => appendSessionIndexEntry(realHome, makeSessionStarted())).toThrow(
      /must not write under the real.*\.comis/,
    );
    vi.unstubAllEnvs();
  });

  it("throws when VITEST=true and dataDir is a subdir of the real ~/.comis", () => {
    vi.stubEnv("VITEST", "true");
    const underHome = path.join(os.homedir(), ".comis", "nested");
    expect(() => appendSessionIndexEntry(underHome, makeSessionStarted())).toThrow(
      /must not write under the real.*\.comis/,
    );
    vi.unstubAllEnvs();
  });

  it("does NOT throw when VITEST=true and dataDir is a tmp dir (correct test usage)", () => {
    vi.stubEnv("VITEST", "true");
    expect(() => appendSessionIndexEntry(tmpDir, makeSessionStarted())).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("stamps source:'test' and synthetic:true on a record written under VITEST in a tmp dir", async () => {
    vi.stubEnv("VITEST", "true");
    appendSessionIndexEntry(tmpDir, makeSessionStarted());
    await vi.runAllTimersAsync();
    const filePath = path.join(tmpDir, "logs", `session-index.${todayUtcDay()}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    expect(parsed.source).toBe("test");
    expect(parsed.synthetic).toBe(true);
    vi.unstubAllEnvs();
  });
});
