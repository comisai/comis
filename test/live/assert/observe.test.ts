// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for observe.ts matchers.
 *
 * All tests use in-memory fake log lines and fake RPC responses — no real
 * daemon or provider is required. Tests exercise every rung of the §7.5
 * assertion ladder (rungs 1–5 + rung-7 discouragement).
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  expectCompletion,
  expectCacheHit,
  expectNoErrorWithoutHint,
  expectBillingTokens,
  expectEvent,
  expectNoSecretLeak,
  expectHealthStable,
  rawTextEquality,
} from "./observe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Join an array of NDJSON-compatible strings into a newline-delimited block.
 */
function makeFakeLogs(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Build a single fake cache-trace NDJSON line.
 */
function makeCacheTrace(tokens: number): string {
  return JSON.stringify({
    traceSchema: "comis-cache-trace",
    stage: "model:after",
    seq: 1,
    agentId: "a1",
    sessionId: "s1",
    traceId: "t1",
    provider: "anthropic",
    modelId: "claude-3-haiku-20240307",
    messagesDigest: "abc123",
    systemDigest: "def456",
    cacheReadInputTokens: tokens,
    cacheCreationInputTokens: 0,
  });
}

// ---------------------------------------------------------------------------
// expectCompletion
// ---------------------------------------------------------------------------

describe("expectCompletion", () => {
  it("resolves when a completion log entry with matching agentId and durationMs is present", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "info",
        msg: "completion",
        agentId: "a1",
        durationMs: 123,
        time: new Date().toISOString(),
        levelValue: 30,
      }),
    ]);
    await expect(
      expectCompletion({ agentId: "a1", hasDurationMs: true }, logs),
    ).resolves.toBeUndefined();
  });

  it("throws when durationMs is missing from the completion entry", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "info",
        msg: "completion",
        agentId: "a1",
        time: new Date().toISOString(),
        levelValue: 30,
      }),
    ]);
    await expect(
      expectCompletion({ agentId: "a1", hasDurationMs: true }, logs),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectCacheHit
// ---------------------------------------------------------------------------

describe("expectCacheHit", () => {
  it("resolves when cacheReadInputTokens meets the minimum threshold", async () => {
    const lines = makeFakeLogs([makeCacheTrace(500)]);
    await expect(
      expectCacheHit({ minReadTokens: 100 }, lines),
    ).resolves.toBeUndefined();
  });

  it("throws when cacheReadInputTokens is below the minimum threshold", async () => {
    const lines = makeFakeLogs([makeCacheTrace(50)]);
    await expect(
      expectCacheHit({ minReadTokens: 100 }, lines),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectNoErrorWithoutHint
// ---------------------------------------------------------------------------

describe("expectNoErrorWithoutHint", () => {
  it("resolves when every error entry carries both hint and errorKind", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "error",
        msg: "fail",
        hint: "network timeout",
        errorKind: "network",
        time: new Date().toISOString(),
        levelValue: 50,
      }),
    ]);
    await expect(expectNoErrorWithoutHint(logs)).resolves.toBeUndefined();
  });

  it("throws when an error entry is missing hint and errorKind", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "error",
        msg: "fail",
        time: new Date().toISOString(),
        levelValue: 50,
      }),
    ]);
    await expect(expectNoErrorWithoutHint(logs)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectBillingTokens
// ---------------------------------------------------------------------------

describe("expectBillingTokens", () => {
  it("resolves when totalTokens meets the minimum", async () => {
    const billing = { totalTokens: 500, totalCost: 0.01, callCount: 1, totalCacheSaved: 0 };
    await expect(
      expectBillingTokens({ minTokens: 100 }, billing),
    ).resolves.toBeUndefined();
  });

  it("throws when totalTokens is below the minimum", async () => {
    const billing = { totalTokens: 50, totalCost: 0.0, callCount: 1, totalCacheSaved: 0 };
    await expect(
      expectBillingTokens({ minTokens: 100 }, billing),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectEvent
// ---------------------------------------------------------------------------

describe("expectEvent", () => {
  it("resolves when the event with matching name and payload subset is present", async () => {
    const events = [
      { name: "tool:executed", payload: { toolName: "web_search", durationMs: 42 } },
    ];
    await expect(
      expectEvent("tool:executed", { toolName: "web_search" }, events),
    ).resolves.toBeUndefined();
  });

  it("throws when the expected event is not in the events array", async () => {
    const events = [
      { name: "model:inference_completed", payload: { durationMs: 100 } },
    ];
    await expect(
      expectEvent("tool:executed", { toolName: "web_search" }, events),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectNoSecretLeak
// ---------------------------------------------------------------------------

describe("expectNoSecretLeak", () => {
  it("resolves when log lines contain no secret-shaped patterns", async () => {
    const lines = [
      JSON.stringify({ level: "info", msg: "hello world", time: new Date().toISOString(), levelValue: 30 }),
      JSON.stringify({ level: "debug", msg: "context assembled", time: new Date().toISOString(), levelValue: 20 }),
    ];
    await expect(expectNoSecretLeak(lines)).resolves.toBeUndefined();
  });

  it("throws when a log line contains a Bearer token (secret-shaped pattern)", async () => {
    const lines = [
      JSON.stringify({
        level: "info",
        msg: "Bearer sk-abc12345678901234567890",
        time: new Date().toISOString(),
        levelValue: 30,
      }),
    ];
    await expect(expectNoSecretLeak(lines)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectHealthStable
// ---------------------------------------------------------------------------

describe("expectHealthStable", () => {
  it("resolves when health line shows all stable indicators at zero", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "info",
        msg: "Daemon health",
        stuckSubAgentRuns: 0,
        deadLetterQueueSize: 0,
        promptTimeoutsLast5m: 0,
        degradedProviders: [],
        time: new Date().toISOString(),
        levelValue: 30,
      }),
    ]);
    await expect(expectHealthStable({}, logs)).resolves.toBeUndefined();
  });

  it("throws when stuckSubAgentRuns is non-zero", async () => {
    const logs = makeFakeLogs([
      JSON.stringify({
        level: "info",
        msg: "Daemon health",
        stuckSubAgentRuns: 1,
        deadLetterQueueSize: 0,
        promptTimeoutsLast5m: 0,
        degradedProviders: [],
        time: new Date().toISOString(),
        levelValue: 30,
      }),
    ]);
    await expect(expectHealthStable({}, logs)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rawTextEquality
// ---------------------------------------------------------------------------

describe("rawTextEquality", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a console.warn containing 'rung-7' or 'raw text' when called", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rawTextEquality("some text", "some text");
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(typeof warnArg).toBe("string");
    expect(warnArg.toLowerCase()).toMatch(/rung-7|raw text/);
  });

  it("does not throw — rawTextEquality is a no-op discouragement helper", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => rawTextEquality("abc", "xyz")).not.toThrow();
  });
});
