// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the context-trace asserter.
 *
 * All tests are fixture-driven — no daemon, no network, no COMIS_LIVE required.
 * Tests exercise all 7 exported functions from context-trace.ts.
 *
 * Covers:
 *   - readContextStreamShape: NDJSON parsing for stream:context lines
 *   - assertA1TailVerbatim: totalCount > 0
 *   - assertA2PairIntact: pairedToolResultCount === toolResultCount === toolUseCount
 *   - assertA3NoPairSplit: every toolUseId has a matching toolResultId (unless idsTruncated)
 *   - assertO1MetricsNonZero: context:dag_compacted or context:evicted event with positive counts
 *   - assertP1HonestPresentation: context:dag_compacted with totalSummariesCreated > 0
 *   - assertP2UncertaintyClauses: any context:dag_compacted event present
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import {
  readContextStreamShape,
  assertA1TailVerbatim,
  assertA2PairIntact,
  assertA3NoPairSplit,
  assertO1MetricsNonZero,
  assertP1HonestPresentation,
  assertP2UncertaintyClauses,
  type ContextStreamShape,
} from "./context-trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid ContextStreamShape for asserter tests.
 */
function makeShape(overrides?: Partial<ContextStreamShape>): ContextStreamShape {
  return {
    totalCount: 5,
    blockKindCounts: { text: 5 },
    hasToolResult: false,
    toolUseIds: [],
    toolResultIds: [],
    toolUseCount: 0,
    toolResultCount: 0,
    pairedToolResultCount: 0,
    idsTruncated: false,
    ...overrides,
  };
}

/**
 * Build a minimal stream:context NDJSON line carrying an assembledShape.
 */
function makeContextNdjsonLine(assembledShape: ContextStreamShape): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "stream:context",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 0,
    agentId: "agent-1",
    sessionId: "session-1",
    traceId: "trace-1",
    assembledShape,
  });
}

/**
 * Build a model:after NDJSON line (no assembledShape).
 */
function makeModelAfterNdjsonLine(): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: "model:after",
    ts: "2026-06-06T00:00:00.000Z",
    seq: 1,
    agentId: "agent-1",
    sessionId: "session-1",
    traceId: "trace-1",
    messagesDigest: "abc123",
    systemDigest: "def456",
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 1024,
  });
}

/**
 * Build a context:dag_compacted event.
 */
function makeDagCompactedEvent(
  payload?: Partial<{
    leafSummariesCreated: number;
    condensedSummariesCreated: number;
    maxDepthReached: number;
    totalSummariesCreated: number;
    durationMs: number;
  }>,
): { name: string; payload: unknown } {
  return {
    name: "context:dag_compacted",
    payload: {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "key-1",
      leafSummariesCreated: 0,
      condensedSummariesCreated: 0,
      maxDepthReached: 0,
      totalSummariesCreated: 0,
      durationMs: 100,
      timestamp: Date.now(),
      ...payload,
    },
  };
}

/**
 * Build a context:evicted event.
 */
function makeEvictedEvent(evictedCount: number): { name: string; payload: unknown } {
  return {
    name: "context:evicted",
    payload: {
      agentId: "agent-1",
      sessionKey: "key-1",
      evictedCount,
      evictedChars: 1000,
      categories: { tool_result: evictedCount },
      timestamp: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// readContextStreamShape
// ---------------------------------------------------------------------------

describe("readContextStreamShape — NDJSON with one stream:context line", () => {
  it("returns shape with correct totalCount when stream:context line is present", () => {
    const shape = makeShape({ totalCount: 7 });
    const lines = [makeContextNdjsonLine(shape), makeModelAfterNdjsonLine()].join("\n");

    const result = readContextStreamShape(lines);

    expect(result).not.toBeNull();
    expect(result?.totalCount).toBe(7);
  });
});

describe("readContextStreamShape — NDJSON with only model:after lines", () => {
  it("returns null when no stream:context lines are present", () => {
    const lines = [makeModelAfterNdjsonLine(), makeModelAfterNdjsonLine()].join("\n");

    const result = readContextStreamShape(lines);

    expect(result).toBeNull();
  });
});

describe("readContextStreamShape — returns last stream:context shape when multiple present", () => {
  it("returns the last shape when multiple stream:context lines are present", () => {
    const shape1 = makeShape({ totalCount: 3 });
    const shape2 = makeShape({ totalCount: 9 });
    const lines = [
      makeContextNdjsonLine(shape1),
      makeModelAfterNdjsonLine(),
      makeContextNdjsonLine(shape2),
    ].join("\n");

    const result = readContextStreamShape(lines);

    expect(result?.totalCount).toBe(9);
  });
});

describe("readContextStreamShape — malformed JSON lines are silently skipped", () => {
  it("returns null when all lines are malformed JSON", () => {
    const lines = "not json at all\nalso not json\n{incomplete";

    const result = readContextStreamShape(lines);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertA1TailVerbatim
// ---------------------------------------------------------------------------

describe("assertA1TailVerbatim — totalCount 0 throws", () => {
  it("throws when totalCount is 0", () => {
    const shape = makeShape({ totalCount: 0 });

    expect(() => assertA1TailVerbatim(shape)).toThrow();
  });
});

describe("assertA1TailVerbatim — totalCount 5 does not throw", () => {
  it("does not throw when totalCount is 5", () => {
    const shape = makeShape({ totalCount: 5 });

    expect(() => assertA1TailVerbatim(shape)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertA2PairIntact
// ---------------------------------------------------------------------------

describe("assertA2PairIntact — pair intact (pairedToolResultCount === toolResultCount === toolUseCount)", () => {
  it("does not throw when all counts match (paired=1, result=1, use=1)", () => {
    const shape = makeShape({
      toolUseCount: 1,
      toolResultCount: 1,
      pairedToolResultCount: 1,
    });

    expect(() => assertA2PairIntact(shape)).not.toThrow();
  });
});

describe("assertA2PairIntact — orphan tool_result throws", () => {
  it("throws when pairedToolResultCount !== toolResultCount (orphan)", () => {
    const shape = makeShape({
      toolUseCount: 1,
      toolResultCount: 1,
      pairedToolResultCount: 0,
    });

    expect(() => assertA2PairIntact(shape)).toThrow();
  });
});

describe("assertA2PairIntact — mismatched use/result counts throws", () => {
  it("throws when toolUseCount !== toolResultCount", () => {
    const shape = makeShape({
      toolUseCount: 2,
      toolResultCount: 1,
      pairedToolResultCount: 1,
    });

    expect(() => assertA2PairIntact(shape)).toThrow();
  });
});

describe("assertA2PairIntact — no tool calls does not throw", () => {
  it("does not throw when there are no tool calls (all counts 0)", () => {
    const shape = makeShape({
      toolUseCount: 0,
      toolResultCount: 0,
      pairedToolResultCount: 0,
    });

    expect(() => assertA2PairIntact(shape)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertA3NoPairSplit
// ---------------------------------------------------------------------------

describe("assertA3NoPairSplit — idsTruncated=false, matching ids does not throw", () => {
  it("does not throw when toolUseIds=[u1] and toolResultIds=[u1] (idsTruncated=false)", () => {
    const shape = makeShape({
      toolUseIds: ["u1"],
      toolResultIds: ["u1"],
      idsTruncated: false,
    });

    expect(() => assertA3NoPairSplit(shape)).not.toThrow();
  });
});

describe("assertA3NoPairSplit — idsTruncated=false, missing result throws", () => {
  it("throws when toolUseIds=[u1] and toolResultIds=[] (idsTruncated=false)", () => {
    const shape = makeShape({
      toolUseIds: ["u1"],
      toolResultIds: [],
      idsTruncated: false,
    });

    expect(() => assertA3NoPairSplit(shape)).toThrow();
  });
});

describe("assertA3NoPairSplit — idsTruncated=true skips check, emits console.warn", () => {
  it("does not throw when idsTruncated=true (skips; emits warn)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shape = makeShape({
      toolUseIds: ["u1"],
      toolResultIds: [],
      idsTruncated: true,
    });

    expect(() => assertA3NoPairSplit(shape)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("idsTruncated=true"));

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// assertO1MetricsNonZero
// ---------------------------------------------------------------------------

describe("assertO1MetricsNonZero — dag_compacted with leafSummariesCreated=2 does not throw", () => {
  it("does not throw when dag_compacted event has leafSummariesCreated=2", () => {
    const events = [makeDagCompactedEvent({ leafSummariesCreated: 2 })];

    expect(() => assertO1MetricsNonZero(events)).not.toThrow();
  });
});

describe("assertO1MetricsNonZero — evicted event with evictedCount=3 does not throw", () => {
  it("does not throw when context:evicted has evictedCount=3", () => {
    const events = [makeEvictedEvent(3)];

    expect(() => assertO1MetricsNonZero(events)).not.toThrow();
  });
});

describe("assertO1MetricsNonZero — empty events array throws", () => {
  it("throws when events array is empty", () => {
    expect(() => assertO1MetricsNonZero([])).toThrow();
  });
});

describe("assertO1MetricsNonZero — dag_compacted with leafSummariesCreated=0 and no evicted throws", () => {
  it("throws when dag_compacted.leafSummariesCreated=0 and no evicted event", () => {
    const events = [makeDagCompactedEvent({ leafSummariesCreated: 0 })];

    expect(() => assertO1MetricsNonZero(events)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertP1HonestPresentation
// ---------------------------------------------------------------------------

describe("assertP1HonestPresentation — dag_compacted with totalSummariesCreated=1 does not throw", () => {
  it("does not throw when dag_compacted event has totalSummariesCreated=1", () => {
    const events = [makeDagCompactedEvent({ totalSummariesCreated: 1 })];

    expect(() => assertP1HonestPresentation(events)).not.toThrow();
  });
});

describe("assertP1HonestPresentation — empty events array throws", () => {
  it("throws when events array is empty", () => {
    expect(() => assertP1HonestPresentation([])).toThrow();
  });
});

describe("assertP1HonestPresentation — dag_compacted with totalSummariesCreated=0 throws", () => {
  it("throws when dag_compacted.totalSummariesCreated=0 (no summaries presented)", () => {
    const events = [makeDagCompactedEvent({ totalSummariesCreated: 0 })];

    expect(() => assertP1HonestPresentation(events)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertP2UncertaintyClauses
// ---------------------------------------------------------------------------

describe("assertP2UncertaintyClauses — dag_compacted event present does not throw", () => {
  it("does not throw when a context:dag_compacted event is present", () => {
    const events = [makeDagCompactedEvent()];

    expect(() => assertP2UncertaintyClauses(events)).not.toThrow();
  });
});

describe("assertP2UncertaintyClauses — empty events array throws", () => {
  it("throws when events array is empty (dag mode not active)", () => {
    expect(() => assertP2UncertaintyClauses([])).toThrow();
  });
});

describe("assertP2UncertaintyClauses — events with no dag_compacted throws", () => {
  it("throws when events contain only non-dag_compacted events", () => {
    const events = [makeEvictedEvent(1)];

    expect(() => assertP2UncertaintyClauses(events)).toThrow();
  });
});
