// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace EventBus bridge behavior tests.
 *
 * Two cases:
 *   - subscribes_and_unsubscribes_cleanly (no listener leaks)
 *   - attaches_token_counts_to_next_session_after_emit (the round-trip
 *     from bus → setLatestTokenUsage → recordStage("session:after"))
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TypedEventBus } from "@comis/core";

import { createCacheTrace, type CacheTrace } from "./runtime.js";
import { attachCacheTraceToEventBus } from "./event-bus-bridge.js";
import type { CacheTraceEvent } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-cache-trace-bus-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): CacheTraceEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l)) as CacheTraceEvent[];
}

function makeTrace(filePath: string): CacheTrace {
  const trace = createCacheTrace({
    enabled: true,
    filePath,
    includeMessages: true,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-1",
    sessionId: "sid-1",
  });
  if (trace === null) throw new Error("makeTrace: createCacheTrace returned null");
  return trace;
}

describe("attachCacheTraceToEventBus", () => {
  it("subscribes_and_unsubscribes_cleanly across multiple cycles", () => {
    const bus = new TypedEventBus();
    const trace = makeTrace(join(tmpDir, "trace.jsonl"));

    // Baseline: no listeners.
    expect(bus.listenerCount("observability:token_usage")).toBe(0);

    // Subscribe twice, unsubscribe twice — confirm listener count
    // returns to zero each cycle (no orphan handlers).
    const unsub1 = attachCacheTraceToEventBus(trace, bus);
    expect(bus.listenerCount("observability:token_usage")).toBe(1);

    const unsub2 = attachCacheTraceToEventBus(trace, bus);
    expect(bus.listenerCount("observability:token_usage")).toBe(2);

    unsub1();
    expect(bus.listenerCount("observability:token_usage")).toBe(1);

    unsub2();
    expect(bus.listenerCount("observability:token_usage")).toBe(0);
  });

  it("attaches_token_counts_to_next_session_after_emit via bus → setLatestTokenUsage → recordStage", async () => {
    const bus = new TypedEventBus();
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace(filePath);

    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    // Synthesize a token_usage event. The bridge's handler narrows the
    // payload — we pass the canonical shape from
    // packages/core/src/event-bus/events-agent.ts.
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "channel-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-3-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      latencyMs: 250,
      cacheReadTokens: 9999,
      cacheWriteTokens: 42,
      sessionKey: "sid-1",
      savedVsUncached: 0,
      cacheEligible: true,
    });

    trace.recordStage("session:after", {});
    await trace.flushAndClose();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.stage).toBe("session:after");
    expect(lines[0]!.cacheReadInputTokens).toBe(9999);
    expect(lines[0]!.cacheCreationInputTokens).toBe(42);

    unsubscribe();
  });
});
