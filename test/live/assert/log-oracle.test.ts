// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the universal log-oracle.
 *
 * All tests use fake in-memory NDJSON strings — no real daemon, no real files.
 * COMIS_LIVE is not required.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { runLogOracle } from "./log-oracle.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface FakeEntry {
  level?: string;
  levelValue?: number;
  msg?: string;
  time?: string;
  hint?: string;
  errorKind?: string;
  durationMs?: number;
  traceId?: string;
  traceSchema?: string;
  event?: string;
  totalTokens?: number;
  stuckSubAgentRuns?: number;
  deadLetterQueueSize?: number;
  promptTimeoutsLast5m?: number;
  degradedProviders?: string[];
  [key: string]: unknown;
}

function makeFakeLog(entries: FakeEntry[]): string {
  return entries
    .map((e) =>
      JSON.stringify({
        level: e.level ?? "info",
        levelValue: e.levelValue ?? 30,
        msg: e.msg ?? "test message",
        time: e.time ?? new Date().toISOString(),
        ...e,
      }),
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLogOracle — check 2+3: ERROR with hint+errorKind passes", () => {
  it("resolves when ERROR has both hint and errorKind", async () => {
    const log = makeFakeLog([
      {
        level: "error",
        levelValue: 50,
        msg: "some error occurred",
        hint: "retry the operation",
        errorKind: "transient",
      },
    ]);
    await expect(runLogOracle(log)).resolves.toBeUndefined();
  });
});

describe("runLogOracle — check 3: ERROR missing hint throws", () => {
  it("throws when ERROR entry is missing hint", async () => {
    const log = makeFakeLog([
      {
        level: "error",
        levelValue: 50,
        msg: "missing hint error",
        errorKind: "permanent",
        // no hint field
      },
    ]);
    await expect(runLogOracle(log)).rejects.toThrow();
  });
});

describe("runLogOracle — check 3: FATAL missing errorKind throws", () => {
  it("throws when FATAL entry is missing errorKind", async () => {
    const log = makeFakeLog([
      {
        level: "fatal",
        levelValue: 60,
        msg: "fatal with no errorKind",
        hint: "restart the service",
        // no errorKind field
      },
    ]);
    await expect(runLogOracle(log)).rejects.toThrow();
  });
});

describe("runLogOracle — check 2: expectedErrors subtracts from check 2", () => {
  it("resolves when ERROR msg matches expectedErrors list", async () => {
    const log = makeFakeLog([
      {
        level: "error",
        levelValue: 50,
        msg: "known error",
        // missing hint+errorKind — but it's expected so check 2 subtracts it
        // Note: check 3 still runs on non-subtracted errors, but this one is
        // subtracted before check 3 sees it
      },
    ]);
    await expect(
      runLogOracle(log, { expectedErrors: ["known error"] }),
    ).resolves.toBeUndefined();
  });
});

describe("runLogOracle — check 1: invalid traceSchema line throws", () => {
  it("throws when a comis-cache-trace line is not valid JSON schema", async () => {
    // Build a log where a line with traceSchema but invalid cache-trace shape
    const badCacheTrace = JSON.stringify({
      level: "info",
      levelValue: 30,
      msg: "cache event",
      time: new Date().toISOString(),
      traceSchema: "comis-cache-trace",
      // missing required fields like stage, seq, agentId, etc.
      badField: true,
    });
    await expect(runLogOracle(badCacheTrace)).rejects.toThrow();
  });
});

describe("runLogOracle — check 6: secret in log throws", () => {
  it("throws when a log line contains an API key pattern", async () => {
    const log = makeFakeLog([
      {
        level: "debug",
        msg: "provider config",
        apiKey: "sk-abc12345678901234567890",
      },
    ]);
    await expect(runLogOracle(log)).rejects.toThrow();
  });
});

describe("runLogOracle — check 8: stuckSubAgentRuns:1 throws", () => {
  it("throws when health line has stuckSubAgentRuns > 0", async () => {
    const log = makeFakeLog([
      {
        level: "info",
        msg: "Daemon health",
        stuckSubAgentRuns: 1,
        deadLetterQueueSize: 0,
        promptTimeoutsLast5m: 0,
      },
    ]);
    await expect(runLogOracle(log)).rejects.toThrow();
  });
});

describe("runLogOracle — check 8: healthy health line passes", () => {
  it("resolves when health line has all zeros", async () => {
    const log = makeFakeLog([
      {
        level: "info",
        msg: "Daemon health",
        stuckSubAgentRuns: 0,
        deadLetterQueueSize: 0,
        promptTimeoutsLast5m: 0,
      },
    ]);
    await expect(runLogOracle(log)).resolves.toBeUndefined();
  });
});

describe("runLogOracle — empty log passes", () => {
  it("resolves on empty log string with no violations", async () => {
    await expect(runLogOracle("")).resolves.toBeUndefined();
  });
});
