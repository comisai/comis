// SPDX-License-Identifier: Apache-2.0
/**
 * `buildCacheTraceWrapper` behavior tests (Plan 46-01 Task 7).
 *
 * Three cases:
 *   - wrapper_emits_stream_context_before_delegating_to_next
 *   - wrapper_passes_through_next_yielded_events
 *   - wrapper_with_includeMessages_false_omits_messages_field
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

import type { StreamFn } from "@earendil-works/pi-agent-core";

import { createCacheTrace, type CacheTrace } from "./runtime.js";
import { buildCacheTraceWrapper } from "./stream-fn-wrapper.js";
import type { CacheTraceEvent } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-cache-trace-wrapper-"));
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

function makeTrace(opts: { includeMessages: boolean; filePath: string }): CacheTrace {
  const trace = createCacheTrace({
    enabled: true,
    filePath: opts.filePath,
    includeMessages: opts.includeMessages,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-1",
    sessionId: "sid-1",
  });
  if (trace === null) throw new Error("makeTrace returned null");
  return trace;
}

// Minimal stub model + context. The wrapper does NOT call into the real
// pi-ai stack — it just reads `model.provider`, `model.id`, and
// `context.messages` / `context.systemPrompt`.
function fakeModel(): unknown {
  return { provider: "anthropic", id: "claude-3-opus" };
}

function fakeContext(opts?: { systemPrompt?: string }): unknown {
  return {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
    systemPrompt: opts?.systemPrompt ?? "you are an assistant",
  };
}

describe("buildCacheTraceWrapper", () => {
  it("wrapper_emits_stream_context_before_delegating_to_next", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const callOrder: string[] = [];
    const next: StreamFn = ((model: unknown, context: unknown, _options?: unknown) => {
      callOrder.push("next");
      void model;
      void context;
      return {} as ReturnType<StreamFn>;
    }) as StreamFn;

    const wrapped = wrap(next);
    // The wrapper records BEFORE delegating; assert by checking that
    // by the time `next` returns the file has at least one record.
    wrapped(fakeModel() as Parameters<StreamFn>[0], fakeContext() as Parameters<StreamFn>[1]);

    await trace.flush();

    expect(callOrder).toEqual(["next"]);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.stage).toBe("stream:context");
    expect(lines[0]!.provider).toBe("anthropic");
    expect(lines[0]!.modelId).toBe("claude-3-opus");
  });

  it("wrapper_passes_through_next_yielded_events (return value unchanged)", () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const sentinel = { _sentinel: "next-return-value" };
    const next: StreamFn = ((..._args: unknown[]) =>
      sentinel as unknown as ReturnType<StreamFn>) as StreamFn;

    const wrapped = wrap(next);
    const result = wrapped(
      fakeModel() as Parameters<StreamFn>[0],
      fakeContext() as Parameters<StreamFn>[1],
    );
    expect(result).toBe(sentinel);
  });

  it("wrapper_with_includeMessages_false_omits_messages_field but keeps fingerprints + digest", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: false, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) =>
      ({}) as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(
      fakeModel() as Parameters<StreamFn>[0],
      fakeContext() as Parameters<StreamFn>[1],
    );

    await trace.flush();
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    const ev = lines[0]!;
    expect(ev.messages).toBeUndefined();
    expect(Array.isArray(ev.messageFingerprints)).toBe(true);
    expect(ev.messageFingerprints!.length).toBe(2);
    expect(ev.messagesDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.systemDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
