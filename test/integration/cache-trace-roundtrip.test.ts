// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace end-to-end JSONL roundtrip integration.
 *
 * Tests the full write-side cache-trace pipeline without spinning up a
 * full agent turn:
 *
 *   1. `createCacheTrace(...)` constructs a recorder.
 *   2. `attachCacheTraceToEventBus(...)` wires the bridge to a
 *      TypedEventBus.
 *   3. `buildCacheTraceWrapper(...)` produces a StreamFn wrapper.
 *   4. An emit of `observability:token_usage` followed by
 *      `recordStage("session:after", ...)` produces a JSONL event with
 *      `cacheReadInputTokens` + `cacheCreationInputTokens` populated.
 *   5. The wrapper records a `stream:context` event before delegating
 *      to the next stream link, with full 64-char digests.
 *
 * Per CLAUDE.md "Vitest aliases @comis/* → dist/" — must run `pnpm build`
 * before `pnpm test:integration`. The bare-package imports below resolve
 * to `packages/observability/dist/index.js`.
 *
 * @module
 */
import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
} from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TypedEventBus } from "@comis/core";
import {
  createCacheTrace,
  attachCacheTraceToEventBus,
  buildCacheTraceWrapper,
  type CacheTrace,
  type CacheTraceEvent,
} from "@comis/observability";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-cache-trace-rt-"));
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

describe("cache-trace v1 JSONL emission", () => {
  it("agent turn with diagnostics.cacheTrace.enabled writes schema-versioned JSONL with messagesDigest + systemDigest + session:after token counts", async () => {
    const traceFile = join(tmpDir, "cache-trace.jsonl");

    // Step 1: construct the recorder.
    const trace: CacheTrace | null = createCacheTrace({
      enabled: true,
      filePath: traceFile,
      includeMessages: false,
      includePrompt: true,
      includeSystem: true,
      agentId: "agent-int",
      sessionId: "sid-int",
      provider: "anthropic",
      modelId: "claude-3-opus",
    });
    expect(trace).not.toBeNull();

    // Step 2: wire the bridge to a real TypedEventBus.
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace!, bus);

    // Step 3: build the wrapper + simulate the stream chain by calling
    // the wrapped StreamFn with a fake `next`. This produces the
    // `stream:context` event with sha256 digests.
    const fakeStreamFn = ((..._args: unknown[]) => ({} as unknown)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const wrapped = buildCacheTraceWrapper(trace!)(fakeStreamFn);
    wrapped(
      { provider: "anthropic", id: "claude-3-opus" } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
        systemPrompt: "you are an assistant",
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Step 4: synthesize a token_usage event — the bridge captures
    // cacheReadTokens + cacheWriteTokens and stashes them.
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-int",
      agentId: "agent-int",
      channelId: "channel-int",
      executionId: "exec-int",
      provider: "anthropic",
      model: "claude-3-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 250,
      cacheReadTokens: 1234,
      cacheWriteTokens: 42,
      sessionKey: "sid-int",
      savedVsUncached: 0,
      cacheEligible: true,
    });

    // Step 5: emit session:after — the recorder reads + attaches the
    // stashed token counts.
    trace!.recordStage("session:after", {});

    // Flush and close.
    await trace!.flushAndClose();
    unsubscribe();

    // Read back and assert.
    const events = readLines(traceFile);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Schema-v1 envelope on every event.
    for (const ev of events) {
      expect(ev.traceSchema).toBe("comis-cache-trace");
      expect(ev.schemaVersion).toBe(1);
      expect(ev.agentId).toBe("agent-int");
      expect(ev.sessionId).toBe("sid-int");
    }

    // The stream:context event carries digests + omits raw messages.
    const ctx = events.find((ev) => ev.stage === "stream:context");
    expect(ctx).toBeDefined();
    expect(ctx!.messagesDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx!.systemDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx!.messages).toBeUndefined(); // includeMessages: false
    expect(Array.isArray(ctx!.messageFingerprints)).toBe(true);
    expect(ctx!.messageFingerprints!.length).toBe(2);

    // The session:after event carries the bus-attributed tokens.
    const after = events.find((ev) => ev.stage === "session:after");
    expect(after).toBeDefined();
    expect(after!.cacheReadInputTokens).toBe(1234);
    expect(after!.cacheCreationInputTokens).toBe(42);
  });

  it("digest_stable_across_runs: two cache-trace runs with identical messages emit identical messagesDigest values", async () => {
    function runOnce(filePath: string): CacheTraceEvent {
      const t = createCacheTrace({
        enabled: true,
        filePath,
        includeMessages: false,
        includePrompt: true,
        includeSystem: true,
        agentId: "agent-int",
        sessionId: "sid-stable",
      });
      expect(t).not.toBeNull();
      const fake = ((..._a: unknown[]) => ({} as unknown)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const wrapped = buildCacheTraceWrapper(t!)(fake);
      wrapped(
        { provider: "anthropic", id: "claude-3-opus" } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {
          messages: [
            { role: "user", content: "stable" },
            { role: "assistant", content: "echo" },
          ],
          systemPrompt: "consistent system",
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      );
      return t!;
      // Returning the recorder so the caller can flush.
    }

    const path1 = join(tmpDir, "run1.jsonl");
    const path2 = join(tmpDir, "run2.jsonl");
    const t1 = runOnce(path1) as unknown as CacheTrace;
    await t1.flushAndClose();
    const t2 = runOnce(path2) as unknown as CacheTrace;
    await t2.flushAndClose();

    const ev1 = readLines(path1).find((e) => e.stage === "stream:context");
    const ev2 = readLines(path2).find((e) => e.stage === "stream:context");
    expect(ev1).toBeDefined();
    expect(ev2).toBeDefined();
    expect(ev1!.messagesDigest).toBe(ev2!.messagesDigest);
    expect(ev1!.systemDigest).toBe(ev2!.systemDigest);
  });
});
