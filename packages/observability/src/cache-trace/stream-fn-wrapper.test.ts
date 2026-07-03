// SPDX-License-Identifier: Apache-2.0
/**
 * `buildCacheTraceWrapper` behavior tests.
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
  it("wrapper_emits_stream_context_pre_call_and_model_after_post_call", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const callOrder: string[] = [];
    const next: StreamFn = ((model: unknown, context: unknown, _options?: unknown) => {
      callOrder.push("next");
      void model;
      void context;
      // Test stub: return-value carries a `usage` block directly so the
      // wrapper's "no .result() function" fallback projects the tokens
      // onto model:after.
      return { usage: { cacheRead: 1234, cacheWrite: 56 } } as unknown as ReturnType<StreamFn>;
    }) as StreamFn;

    const wrapped = wrap(next);
    wrapped(fakeModel() as Parameters<StreamFn>[0], fakeContext() as Parameters<StreamFn>[1]);

    await trace.flush();

    expect(callOrder).toEqual(["next"]);
    const lines = readLines(filePath);
    // Wrapper emits 3 stages — model:before, stream:context, model:after.
    expect(lines).toHaveLength(3);
    expect(lines[0]!.stage).toBe("model:before");
    expect(lines[1]!.stage).toBe("stream:context");
    expect(lines[1]!.provider).toBe("anthropic");
    expect(lines[1]!.modelId).toBe("claude-3-opus");
    expect(lines[2]!.stage).toBe("model:after");
    // Ordering preserved by monotonic seq.
    expect(lines[0]!.seq).toBeLessThan(lines[1]!.seq);
    expect(lines[1]!.seq).toBeLessThan(lines[2]!.seq);
  });

  it("wrapper_model_after_carries_cache_tokens_from_streamfn_return_value_usage_block", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) =>
      ({ usage: { cacheRead: 7777, cacheWrite: 22 } }) as unknown as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(fakeModel() as Parameters<StreamFn>[0], fakeContext() as Parameters<StreamFn>[1]);

    await trace.flush();
    const lines = readLines(filePath);
    const postCall = lines.find((l) => l.stage === "model:after");
    expect(postCall).toBeDefined();
    expect(postCall!.cacheReadInputTokens).toBe(7777);
    expect(postCall!.cacheCreationInputTokens).toBe(22);
  });

  it("wrapper_model_after_accepts_anthropic_named_fields_directly", async () => {
    // Provider variant: usage carries Anthropic-style names directly.
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) =>
      ({
        usage: { cacheReadInputTokens: 111, cacheCreationInputTokens: 9 },
      }) as unknown as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(fakeModel() as Parameters<StreamFn>[0], fakeContext() as Parameters<StreamFn>[1]);

    await trace.flush();
    const lines = readLines(filePath);
    const postCall = lines.find((l) => l.stage === "model:after");
    expect(postCall!.cacheReadInputTokens).toBe(111);
    expect(postCall!.cacheCreationInputTokens).toBe(9);
  });

  it("wrapper_model_after_still_emits_when_usage_block_is_absent", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) =>
      ({}) as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(fakeModel() as Parameters<StreamFn>[0], fakeContext() as Parameters<StreamFn>[1]);

    await trace.flush();
    const lines = readLines(filePath);
    const postCall = lines.find((l) => l.stage === "model:after");
    expect(postCall).toBeDefined();
    // Token fields omitted when usage is absent — model:after still emits.
    expect(postCall!.cacheReadInputTokens).toBeUndefined();
    expect(postCall!.cacheCreationInputTokens).toBeUndefined();
  });

  it("wrapper_passes_through_next_return_value_unchanged", () => {
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
    // The wrapper returns the original return value (the executor
    // iterates the stream itself).
    expect(result).toBe(sentinel);
  });

  it("wrapper_emits_model_after_with_error_when_next_throws_synchronously", () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) => {
      throw new Error("synchronous-throw-from-streamfn");
    }) as StreamFn;
    const wrapped = wrap(next);
    expect(() =>
      wrapped(
        fakeModel() as Parameters<StreamFn>[0],
        fakeContext() as Parameters<StreamFn>[1],
      ),
    ).toThrow("synchronous-throw-from-streamfn");
  });

  it("wrapper_emits_assembledShape_with_toolResult_pairing_even_when_includeMessages_false", async () => {
    // The stream:context payload must carry a SMALL assembled-array
    // shape descriptor (counts/flags + tool_use<->tool_result id pairing)
    // that survives even when includeMessages is OFF — so a test can assert
    // tool_use<->tool_result pairing WITHOUT shipping the full messages array.
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: false, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    // Context whose messages include a tool_use block on an assistant
    // message and a top-level toolResult message keyed to the same call id.
    const toolContext: unknown = {
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read", input: {} }] },
        { role: "toolResult", toolCallId: "tu_1", content: [{ type: "text", text: "ok" }] },
      ],
      systemPrompt: "you are an assistant",
    };

    const next: StreamFn = ((..._args: unknown[]) =>
      ({}) as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(fakeModel() as Parameters<StreamFn>[0], toolContext as Parameters<StreamFn>[1]);

    await trace.flush();
    const lines = readLines(filePath);
    const preCall = lines.find((l) => l.stage === "stream:context");
    expect(preCall).toBeDefined();
    // The full messages array stays absent (includeMessages off) — unchanged.
    expect(preCall!.messages).toBeUndefined();
    // The small shape descriptor is present even with includeMessages off.
    const shape = preCall!.assembledShape;
    expect(shape).toBeDefined();
    expect(shape!.hasToolResult).toBe(true);
    expect(shape!.toolUseIds).toContain("tu_1");
    expect(shape!.toolResultIds).toContain("tu_1");
    // Pairing invariant: every toolResultId has a matching toolUseId (no orphan).
    for (const rid of shape!.toolResultIds) {
      expect(shape!.toolUseIds).toContain(rid);
    }
    // totalCount reflects the assembled array length.
    expect(shape!.totalCount).toBe(3);
    // The count fields mirror the small case (no truncation here). Read
    // via a raw record so this asserts on what landed on disk regardless of the
    // typed schema shape.
    const rawSmall = readLines(filePath).find(
      (l) => l.stage === "stream:context",
    ) as unknown as { assembledShape: Record<string, unknown> };
    expect(rawSmall.assembledShape.toolUseCount).toBe(1);
    expect(rawSmall.assembledShape.toolResultCount).toBe(1);
    expect(rawSmall.assembledShape.pairedToolResultCount).toBe(1);
    expect(rawSmall.assembledShape.idsTruncated).toBe(false);
  });

  it("wrapper_assembledShape_keeps_pairing_counts_above_the_64_item_array_cap", async () => {
    // On a large tool fan-out (>64 tool_use / tool_result ids), the
    // sampled `toolUseIds` / `toolResultIds` arrays must NOT trip the 64-item
    // payload limiter (which would replace them with an opaque
    // `{ __bounded__: … }` sentinel and silently defeat the pairing/orphan
    // check). The descriptor self-bounds the arrays AND carries integer count
    // fields that survive the bound — so the gate asserts on counts, not on a
    // possibly-truncated array.
    const PAIRS = 80; // > PAYLOAD_BOUNDS.maxArrayLength (64)
    const messages: unknown[] = [
      { role: "user", content: [{ type: "text", text: "big fan-out" }] },
    ];
    for (let i = 0; i < PAIRS; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `tu_${i}`, name: "read", input: {} }],
      });
      messages.push({
        role: "toolResult",
        toolCallId: `tu_${i}`,
        content: [{ type: "text", text: "ok" }],
      });
    }

    const filePath = join(tmpDir, "fanout.jsonl");
    const trace = makeTrace({ includeMessages: false, filePath });
    const next: StreamFn = ((..._args: unknown[]) =>
      ({}) as ReturnType<StreamFn>) as StreamFn;
    buildCacheTraceWrapper(trace)(next)(
      fakeModel() as Parameters<StreamFn>[0],
      { messages, systemPrompt: "sys" } as Parameters<StreamFn>[1],
    );
    await trace.flush();

    // Read the RAW recorded line (post-sanitization, exactly what landed on
    // disk) so we can prove the arrays were NOT sentinel-replaced.
    const raw = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.stage === "stream:context");
    expect(raw).toBeDefined();
    const shape = raw!.assembledShape as Record<string, unknown>;

    // Arrays survive as real string arrays (sampled), never a bounded sentinel.
    expect(Array.isArray(shape.toolUseIds)).toBe(true);
    expect(Array.isArray(shape.toolResultIds)).toBe(true);
    expect((shape.toolUseIds as string[]).length).toBeLessThanOrEqual(64);

    // The pairing signal survives via integer counts at any turn size.
    expect(shape.toolUseCount).toBe(PAIRS);
    expect(shape.toolResultCount).toBe(PAIRS);
    expect(shape.pairedToolResultCount).toBe(PAIRS);
    expect(shape.idsTruncated).toBe(true);
    expect(shape.hasToolResult).toBe(true);
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
    // Two records: stream:context + model:after.
    const preCall = lines.find((l) => l.stage === "stream:context");
    expect(preCall).toBeDefined();
    expect(preCall!.messages).toBeUndefined();
    expect(Array.isArray(preCall!.messageFingerprints)).toBe(true);
    expect(preCall!.messageFingerprints!.length).toBe(2);
    expect(preCall!.messagesDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preCall!.systemDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildCacheTraceWrapper emits model:before stage", () => {
  it("wrapper_emits_model_before_stage_with_provider_and_modelid", async () => {
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace({ includeMessages: true, filePath });
    const wrap = buildCacheTraceWrapper(trace);

    const next: StreamFn = ((..._args: unknown[]) =>
      ({ usage: { cacheRead: 0, cacheWrite: 0 } }) as unknown as ReturnType<StreamFn>) as StreamFn;
    const wrapped = wrap(next);
    wrapped(
      fakeModel() as Parameters<StreamFn>[0],
      fakeContext() as Parameters<StreamFn>[1],
    );

    await trace.flush();
    const lines = readLines(filePath);

    const stages = lines.map((l) => l.stage);
    expect(stages).toContain("model:before");

    // model:before must precede stream:context (and stream:context must
    // precede model:after) — verified via the monotonic seq counter.
    const modelBefore = lines.find((l) => l.stage === "model:before");
    const streamContext = lines.find((l) => l.stage === "stream:context");
    const modelAfter = lines.find((l) => l.stage === "model:after");
    expect(modelBefore).toBeDefined();
    expect(streamContext).toBeDefined();
    expect(modelAfter).toBeDefined();
    expect(modelBefore!.seq).toBeLessThan(streamContext!.seq);
    expect(streamContext!.seq).toBeLessThan(modelAfter!.seq);

    // Payload carries provider + modelId from the model arg.
    expect(modelBefore!.provider).toBe("anthropic");
    expect(modelBefore!.modelId).toBe("claude-3-opus");
    // Digests propagate from preCallPayload (the same digests carried by
    // stream:context).
    expect(modelBefore!.messagesDigest).toBe(streamContext!.messagesDigest);
    expect(modelBefore!.systemDigest).toBe(streamContext!.systemDigest);
  });
});
