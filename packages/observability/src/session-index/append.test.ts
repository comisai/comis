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

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const tmpDirs: string[] = [];

beforeEach(() => {
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
    await new Promise((r) => setImmediate(r));

    const expectedPath = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const lines = fs.readFileSync(expectedPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("session_started");
    expect(parsed.sessionId).toBe("t1:c1:u1");
  });

  it("creates a new file session-index.<nextDay>.jsonl when writing past midnight UTC", async () => {
    // Use fake timers for this test to control the UTC date
    vi.useFakeTimers();
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

    vi.useRealTimers();

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

    await new Promise((r) => setImmediate(r));

    const filePath = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
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

    await new Promise((r) => setImmediate(r));

    const filePath = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim());

    expect(typeof parsed.inputTokens).toBe("number");
    expect(typeof parsed.outputTokens).toBe("number");
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.outputTokens).toBe(50);
  });

  it("produces a file with mode 0o600 after first write (QueuedFileWriter O_NOFOLLOW + fchmod)", async () => {
    const event = makeSessionStarted();
    appendSessionIndexEntry(tmpDir, event);

    await new Promise((r) => setImmediate(r));

    const filePath = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
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

    await new Promise((r) => setImmediate(r));

    const filePath = path.join(tmpDir, "logs", "session-index.2026-05-25.jsonl");
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");

    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toMatch(isoPattern);
    }
  });
});
