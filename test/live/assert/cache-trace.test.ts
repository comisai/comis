// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A fixture-driven unit tests for cache-trace.ts asserters.
 *
 * All tests use in-memory fixture lines — no real daemon, no network,
 * no COMIS_LIVE dependency.  Tests exercise every exported function
 * and validate the model:after-only accumulation guard (session:after
 * double-count prevention).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  readCacheTraceForTurn,
  expectCacheWrite,
  expectNoCacheWrite,
  expectCacheRead,
  expectDigestChange,
  type CacheTraceSummary,
} from "./cache-trace.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a cache-trace NDJSON line representing a model:after write event.
 * cacheCreationInputTokens=n, cacheReadInputTokens=0, stage="model:after"
 */
function makeCacheWrite(n: number): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "model:after",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 1,
    agentId: "a1",
    sessionId: "s1",
    traceId: "t1",
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    messagesDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    systemDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cacheCreationInputTokens: n,
    cacheReadInputTokens: 0,
  });
}

/**
 * Build a cache-trace NDJSON line representing a model:after read event.
 * cacheReadInputTokens=n, cacheCreationInputTokens=0, stage="model:after"
 */
function makeCacheRead(n: number): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "model:after",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 2,
    agentId: "a1",
    sessionId: "s1",
    traceId: "t1",
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    messagesDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    systemDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cacheReadInputTokens: n,
    cacheCreationInputTokens: 0,
  });
}

/**
 * Build a cache-trace NDJSON line with flexible field overrides.
 * Defaults to stage="model:after" so callers only need to supply deltas.
 */
function makeCacheTraceLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "model:after",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 1,
    agentId: "a1",
    sessionId: "s1",
    traceId: "t1",
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    messagesDigest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    systemDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  });
}

/**
 * Build a session:after line (session-aggregate, must NOT be summed).
 */
function makeCacheSessionAfter(n: number): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "session:after",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 99,
    agentId: "a1",
    sessionId: "s1",
    traceId: "t1",
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    cacheCreationInputTokens: n,
    cacheReadInputTokens: 0,
  });
}

// ---------------------------------------------------------------------------
// expectCacheWrite
// ---------------------------------------------------------------------------

describe("expectCacheWrite", () => {
  it("resolves when cacheCreationInputTokens > 0 in a model:after line", async () => {
    const lines = makeCacheWrite(500);
    await expect(
      expectCacheWrite({ minCreationTokens: 1 }, lines),
    ).resolves.toBeUndefined();
  });

  it("resolves when cacheCreationInputTokens meets an explicit minimum", async () => {
    const lines = makeCacheWrite(500);
    await expect(
      expectCacheWrite({ minCreationTokens: 500 }, lines),
    ).resolves.toBeUndefined();
  });

  it("throws when cacheCreationInputTokens is 0 and minCreationTokens=1", async () => {
    const lines = makeCacheWrite(0);
    await expect(
      expectCacheWrite({ minCreationTokens: 1 }, lines),
    ).rejects.toThrow(/cacheCreationInputTokens/);
  });

  it("throws when cacheCreationInputTokens falls below the explicit minimum", async () => {
    const lines = makeCacheWrite(200);
    await expect(
      expectCacheWrite({ minCreationTokens: 500 }, lines),
    ).rejects.toThrow();
  });

  it("defaults to minCreationTokens=1 when opts is empty", async () => {
    const lines = makeCacheWrite(1);
    await expect(
      expectCacheWrite({}, lines),
    ).resolves.toBeUndefined();
  });

  it("defaults to minCreationTokens=1 and throws when tokens are 0", async () => {
    const lines = makeCacheWrite(0);
    await expect(
      expectCacheWrite({}, lines),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectNoCacheWrite
// ---------------------------------------------------------------------------

describe("expectNoCacheWrite", () => {
  it("resolves when there are no cache-trace lines (empty file)", async () => {
    await expect(expectNoCacheWrite("")).resolves.toBeUndefined();
  });

  it("resolves when all model:after lines have cacheCreationInputTokens=0", async () => {
    const lines = makeCacheRead(300); // read-only line, creation=0
    await expect(expectNoCacheWrite(lines)).resolves.toBeUndefined();
  });

  it("resolves when cacheCreationInputTokens is 0 across multiple lines", async () => {
    const line1 = makeCacheWrite(0);
    const line2 = makeCacheRead(150);
    await expect(expectNoCacheWrite([line1, line2].join("\n"))).resolves.toBeUndefined();
  });

  it("throws when any model:after line has cacheCreationInputTokens > 0", async () => {
    const lines = makeCacheWrite(500);
    await expect(expectNoCacheWrite(lines)).rejects.toThrow(/cacheCreationInputTokens=0/);
  });

  it("throws with actual token count in the message", async () => {
    const lines = makeCacheWrite(1);
    await expect(expectNoCacheWrite(lines)).rejects.toThrow(/found 1/);
  });
});

// ---------------------------------------------------------------------------
// expectCacheRead
// ---------------------------------------------------------------------------

describe("expectCacheRead", () => {
  it("resolves when cacheReadInputTokens meets minReadTokens", async () => {
    const lines = makeCacheRead(300);
    await expect(
      expectCacheRead({ minReadTokens: 1 }, lines),
    ).resolves.toBeUndefined();
  });

  it("resolves when cacheReadInputTokens exactly equals minReadTokens", async () => {
    const lines = makeCacheRead(300);
    await expect(
      expectCacheRead({ minReadTokens: 300 }, lines),
    ).resolves.toBeUndefined();
  });

  it("throws when cacheReadInputTokens is 0", async () => {
    const lines = makeCacheRead(0);
    await expect(
      expectCacheRead({ minReadTokens: 1 }, lines),
    ).rejects.toThrow(/cacheReadInputTokens/);
  });

  it("throws when cacheReadInputTokens is below minReadTokens", async () => {
    const lines = makeCacheRead(10);
    await expect(
      expectCacheRead({ minReadTokens: 100 }, lines),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectDigestChange
// ---------------------------------------------------------------------------

describe("expectDigestChange", () => {
  it("resolves when messagesDigest changes between before and after", () => {
    const before: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa",
      lastSystemDigest: "dddd",
    };
    const after: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "zzzz",
      lastSystemDigest: "dddd",
    };
    expect(() => expectDigestChange(before, after)).not.toThrow();
  });

  it("resolves when systemDigest changes between before and after", () => {
    const before: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa",
      lastSystemDigest: "dddd",
    };
    const after: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa",
      lastSystemDigest: "yyyy",
    };
    expect(() => expectDigestChange(before, after)).not.toThrow();
  });

  it("throws when both digests are identical between before and after", () => {
    const before: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa",
      lastSystemDigest: "dddd",
    };
    const after: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa",
      lastSystemDigest: "dddd",
    };
    expect(() => expectDigestChange(before, after)).toThrow(/digest/i);
  });

  it("throws when both digests are undefined — same undefined state", () => {
    const before: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 0,
      lastMessagesDigest: undefined,
      lastSystemDigest: undefined,
    };
    const after: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 0,
      lastMessagesDigest: undefined,
      lastSystemDigest: undefined,
    };
    expect(() => expectDigestChange(before, after)).toThrow(/digest/i);
  });

  it("throws when 'after' has traceCount=0 — turn failed before emitting cache-trace", () => {
    // before has a real digest; after has traceCount=0 (undefined digest).
    // Without the guard, before.lastMessagesDigest !== undefined evaluates to
    // 'changed' and the function would NOT throw — masking a broken turn.
    const before: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 1,
      lastMessagesDigest: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
      lastSystemDigest: "dddd1111eeee2222ffff3333aaaa4444bbbb5555cccc6666dddd1111eeee2222",
    };
    const after: CacheTraceSummary = {
      totalCreationTokens: 0,
      totalReadTokens: 0,
      traceCount: 0,        // turn produced no qualifying trace lines
      lastMessagesDigest: undefined,
      lastSystemDigest: undefined,
    };
    expect(() => expectDigestChange(before, after)).toThrow(/traceCount=0/);
  });
});

// ---------------------------------------------------------------------------
// readCacheTraceForTurn
// ---------------------------------------------------------------------------

describe("readCacheTraceForTurn", () => {
  it("returns all-zeros summary for empty string without throwing", () => {
    const summary = readCacheTraceForTurn("");
    expect(summary.totalCreationTokens).toBe(0);
    expect(summary.totalReadTokens).toBe(0);
    expect(summary.traceCount).toBe(0);
    expect(summary.lastMessagesDigest).toBeUndefined();
    expect(summary.lastSystemDigest).toBeUndefined();
  });

  it("accumulates totalCreationTokens across two model:after lines", () => {
    const line1 = makeCacheTraceLine({ cacheCreationInputTokens: 200, seq: 1 });
    const line2 = makeCacheTraceLine({ cacheCreationInputTokens: 300, seq: 2 });
    const summary = readCacheTraceForTurn([line1, line2].join("\n"));
    expect(summary.totalCreationTokens).toBe(500);
    expect(summary.traceCount).toBe(2);
  });

  it("accumulates totalReadTokens across two model:after lines", () => {
    const line1 = makeCacheTraceLine({ cacheReadInputTokens: 100, seq: 1 });
    const line2 = makeCacheTraceLine({ cacheReadInputTokens: 150, seq: 2 });
    const summary = readCacheTraceForTurn([line1, line2].join("\n"));
    expect(summary.totalReadTokens).toBe(250);
  });

  it("filters by traceId — excludes lines with a different traceId", () => {
    const t1line = makeCacheTraceLine({ traceId: "t1", cacheCreationInputTokens: 200 });
    const t2line = makeCacheTraceLine({ traceId: "t2", cacheCreationInputTokens: 999 });
    const summary = readCacheTraceForTurn([t1line, t2line].join("\n"), { traceId: "t1" });
    expect(summary.totalCreationTokens).toBe(200);
    expect(summary.traceCount).toBe(1);
  });

  it("filters by sessionId — excludes lines with a different sessionId", () => {
    const s1line = makeCacheTraceLine({ sessionId: "s1", cacheCreationInputTokens: 100 });
    const s2line = makeCacheTraceLine({ sessionId: "s2", cacheCreationInputTokens: 999 });
    const summary = readCacheTraceForTurn([s1line, s2line].join("\n"), { sessionId: "s1" });
    expect(summary.totalCreationTokens).toBe(100);
    expect(summary.traceCount).toBe(1);
  });

  it("skips non-cache-trace lines (no traceSchema field) silently", () => {
    const nonCacheLine = JSON.stringify({ msg: "some pino log line", level: "info" });
    const cacheLine = makeCacheTraceLine({ cacheCreationInputTokens: 100 });
    const summary = readCacheTraceForTurn([nonCacheLine, cacheLine].join("\n"));
    expect(summary.traceCount).toBe(1);
    expect(summary.totalCreationTokens).toBe(100);
  });

  it("skips malformed JSON lines silently without throwing", () => {
    const badLine = "NOT_VALID_JSON{{{{";
    const goodLine = makeCacheTraceLine({ cacheCreationInputTokens: 50 });
    const summary = readCacheTraceForTurn([badLine, goodLine].join("\n"));
    expect(summary.traceCount).toBe(1);
    expect(summary.totalCreationTokens).toBe(50);
  });

  it("captures lastMessagesDigest and lastSystemDigest from the last qualifying line", () => {
    const line1 = makeCacheTraceLine({
      seq: 1,
      messagesDigest: "digest-first",
      systemDigest: "sys-first",
    });
    const line2 = makeCacheTraceLine({
      seq: 2,
      messagesDigest: "digest-last",
      systemDigest: "sys-last",
    });
    const summary = readCacheTraceForTurn([line1, line2].join("\n"));
    expect(summary.lastMessagesDigest).toBe("digest-last");
    expect(summary.lastSystemDigest).toBe("sys-last");
  });

  // Double-count guard: session:after lines must NOT be summed
  it("does NOT count tokens from session:after lines (double-count guard)", () => {
    const sessionAfterLine = makeCacheSessionAfter(500);
    const summary = readCacheTraceForTurn(sessionAfterLine);
    expect(summary.totalCreationTokens).toBe(0);
    expect(summary.traceCount).toBe(0);
  });

  it("does NOT count session:after tokens even when mixed with model:after lines", () => {
    const modelAfterLine = makeCacheTraceLine({ cacheCreationInputTokens: 100 });
    const sessionAfterLine = makeCacheSessionAfter(500);
    const summary = readCacheTraceForTurn([modelAfterLine, sessionAfterLine].join("\n"));
    // Only the model:after line should be counted
    expect(summary.totalCreationTokens).toBe(100);
    expect(summary.traceCount).toBe(1);
  });

  it("skips lines that fail Zod safe-parse (wrong stage value)", () => {
    // A line with an invalid stage should be treated like malformed input
    const badStageLine = JSON.stringify({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "unknown:stage",
      ts: "2026-06-06T00:00:00.000Z",
      seq: 1,
      agentId: "a1",
      sessionId: "s1",
      traceId: "t1",
      cacheCreationInputTokens: 999,
    });
    const goodLine = makeCacheTraceLine({ cacheCreationInputTokens: 50 });
    const summary = readCacheTraceForTurn([badStageLine, goodLine].join("\n"));
    expect(summary.traceCount).toBe(1);
    expect(summary.totalCreationTokens).toBe(50);
  });

  it("handles whitespace-only lines gracefully", () => {
    const lines = ["  ", "\t", makeCacheTraceLine({ cacheCreationInputTokens: 77 })].join("\n");
    const summary = readCacheTraceForTurn(lines);
    expect(summary.traceCount).toBe(1);
    expect(summary.totalCreationTokens).toBe(77);
  });
});
