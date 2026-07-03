// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isReadOnlyTool,
  isConcurrencySafe,
  createMutationSerializer,
  createOrderPreservingResultBuffer,
} from "./tool-parallelism.js";
import { registerToolMetadata } from "@comis/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal ToolDefinition stub for testing.
 * The execute mock resolves after `delayMs` to enable concurrency timing tests.
 */
function makeTool(
  name: string,
  delayMs = 0,
): ToolDefinition {
  const executeFn = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              content: [{ type: "text", text: `${name}-result` }],
              isError: false,
            }),
          delayMs,
        ),
      ),
  );
  return {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: {
      type: "object" as const,
      properties: {},
    },
    execute: executeFn,
  } as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// isReadOnlyTool classification
//
// Production tool descriptors are seeded via `registerAllToolMetadata()` in
// `@comis/skills/bridge/tool-metadata-registry.ts` at daemon boot. For this
// co-located unit test the metadata is registered explicitly so the
// descriptor-driven classifier path (Priority 1) returns the expected verdict
// without any legacy fallback.
// ---------------------------------------------------------------------------

const READ_ONLY_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "browser",
  "memory_search",
  "memory_get",
  "session_search",
  "sessions_list",
  "session_status",
  "sessions_history",
  "ctx_search",
  "ctx_inspect",
  "ctx_expand",
  "ctx_recall",
  "image_analyze",
  "describe_video",
  "extract_document",
  "transcribe_audio",
  "obs_query",
  "models_manage",
  "discover_tools",
] as const;

const MUTATING_TOOL_NAMES = [
  "exec",
  "process",
  "edit",
  "write",
  "apply_patch",
  "memory_store",
  "memory_manage",
  "sessions_manage",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "pipeline",
  "cron",
  "gateway",
  "heartbeat_manage",
  "channels_manage",
  "tokens_manage",
  "skills_manage",
  "mcp_manage",
  "agents_manage",
  "tts_synthesize",
  "whatsapp_action",
  "discord_action",
  "telegram_action",
  "slack_action",
] as const;

for (const name of READ_ONLY_TOOL_NAMES) {
  registerToolMetadata(name, { isReadOnly: true });
}
for (const name of MUTATING_TOOL_NAMES) {
  registerToolMetadata(name, { isReadOnly: false });
}
// `message` is mutating-but-concurrency-safe — registered here so the test's
// "mutating tool" expectation holds without depending on the larger registry.
registerToolMetadata("message", { isReadOnly: false, isConcurrencySafe: true });

describe("isReadOnlyTool", () => {
  it.each(READ_ONLY_TOOL_NAMES)("returns true for read-only tool: %s", (name) => {
    expect(isReadOnlyTool(name)).toBe(true);
  });

  it.each([...MUTATING_TOOL_NAMES, "message"])("returns false for mutating tool: %s", (name) => {
    expect(isReadOnlyTool(name)).toBe(false);
  });

  it("returns true for MCP tools (names starting with mcp__)", () => {
    expect(isReadOnlyTool("mcp__github__list_repos")).toBe(true);
    expect(isReadOnlyTool("mcp__slack__get_messages")).toBe(true);
    expect(isReadOnlyTool("mcp__custom_server__any_tool")).toBe(true);
  });

  it("returns false for unknown tools (safe default: treat as mutating)", () => {
    expect(isReadOnlyTool("unknown_tool")).toBe(false);
    expect(isReadOnlyTool("some_new_tool")).toBe(false);
    expect(isReadOnlyTool("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createMutationSerializer
// ---------------------------------------------------------------------------

describe("createMutationSerializer", () => {
  it("returns a function that accepts ToolDefinition[] and returns ToolDefinition[]", () => {
    const serialize = createMutationSerializer();
    const tools = [makeTool("read"), makeTool("exec")];
    const result = serialize(tools);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  it("read-only tools have their execute() unchanged (same reference)", () => {
    const serialize = createMutationSerializer();
    const readTool = makeTool("read");
    const originalExecute = readTool.execute;
    const [wrapped] = serialize([readTool]);
    expect(wrapped.execute).toBe(originalExecute);
  });

  it("mutating tools have their execute() wrapped (different reference)", () => {
    const serialize = createMutationSerializer();
    const execTool = makeTool("exec");
    const originalExecute = execTool.execute;
    const [wrapped] = serialize([execTool]);
    expect(wrapped.execute).not.toBe(originalExecute);
  });

  it("preserves all other ToolDefinition properties", () => {
    const serialize = createMutationSerializer();
    const tool = makeTool("exec");
    const [wrapped] = serialize([tool]);
    expect(wrapped.name).toBe(tool.name);
    expect(wrapped.label).toBe(tool.label);
    expect(wrapped.description).toBe(tool.description);
    expect(wrapped.parameters).toBe(tool.parameters);
  });

  it("wrapper passes through toolCallId, params, signal, onUpdate to original execute()", async () => {
    const serialize = createMutationSerializer();
    const tool = makeTool("exec");
    const [wrapped] = serialize([tool]);

    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const ctx = {} as any;

    await wrapped.execute("call-1", { input: "test" }, signal, onUpdate, ctx);

    expect(tool.execute).toHaveBeenCalledWith(
      "call-1",
      { input: "test" },
      signal,
      onUpdate,
      ctx,
    );
  });

  it("serializes concurrent mutating tool calls (second waits for first)", async () => {
    const serialize = createMutationSerializer();
    const completionOrder: string[] = [];

    const slowTool = makeTool("exec", 50);
    const fastTool = makeTool("write", 0);

    // Override execute to track completion order
    const origSlowExecute = slowTool.execute;
    slowTool.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      const result = await (origSlowExecute as any)(...args);
      completionOrder.push("slow");
      return result;
    }) as any;

    const origFastExecute = fastTool.execute;
    fastTool.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      const result = await (origFastExecute as any)(...args);
      completionOrder.push("fast");
      return result;
    }) as any;

    const [wrappedSlow, wrappedFast] = serialize([slowTool, fastTool]);

    // Fire both concurrently
    const p1 = wrappedSlow.execute("call-1", {}, undefined, undefined, {} as any);
    const p2 = wrappedFast.execute("call-2", {}, undefined, undefined, {} as any);

    await Promise.all([p1, p2]);

    // Even though fast takes 0ms, it waits for slow because both are mutating
    expect(completionOrder).toEqual(["slow", "fast"]);
  });

  it("read-only and mutating tools execute concurrently without waiting", async () => {
    const serialize = createMutationSerializer();
    const startTimes: Record<string, number> = {};

    const readTool = makeTool("read", 50);
    const mutateTool = makeTool("exec", 50);

    // Override to track start times
    const origReadExecute = readTool.execute;
    readTool.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      startTimes["read"] = Date.now();
      return (origReadExecute as any)(...args);
    }) as any;

    const origMutateExecute = mutateTool.execute;
    mutateTool.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      startTimes["exec"] = Date.now();
      return (origMutateExecute as any)(...args);
    }) as any;

    const [wrappedRead, wrappedMutate] = serialize([readTool, mutateTool]);

    // Fire both concurrently
    const p1 = wrappedRead.execute("call-1", {}, undefined, undefined, {} as any);
    const p2 = wrappedMutate.execute("call-2", {}, undefined, undefined, {} as any);

    await Promise.all([p1, p2]);

    // Both should start at approximately the same time (within 10ms)
    const diff = Math.abs(startTimes["read"]! - startTimes["exec"]!);
    expect(diff).toBeLessThan(20);
  });

  it("two read-only tools execute concurrently without waiting", async () => {
    const serialize = createMutationSerializer();
    const startTimes: Record<string, number> = {};

    const tool1 = makeTool("read", 50);
    const tool2 = makeTool("grep", 50);

    const origExecute1 = tool1.execute;
    tool1.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      startTimes["read"] = Date.now();
      return (origExecute1 as any)(...args);
    }) as any;

    const origExecute2 = tool2.execute;
    tool2.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      startTimes["grep"] = Date.now();
      return (origExecute2 as any)(...args);
    }) as any;

    const [wrapped1, wrapped2] = serialize([tool1, tool2]);

    const p1 = wrapped1.execute("call-1", {}, undefined, undefined, {} as any);
    const p2 = wrapped2.execute("call-2", {}, undefined, undefined, {} as any);

    await Promise.all([p1, p2]);

    const diff = Math.abs(startTimes["read"]! - startTimes["grep"]!);
    expect(diff).toBeLessThan(20);
  });

  it("re-throws if original execute() throws, releasing the mutex", async () => {
    const serialize = createMutationSerializer();
    const tool = makeTool("exec");
    tool.execute = vi.fn().mockRejectedValue(new Error("boom")) as any;

    const [wrapped] = serialize([tool]);

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, {} as any),
    ).rejects.toThrow("boom");

    // Mutex should be released -- next mutating call should work
    const tool2 = makeTool("write");
    const [wrapped2] = serialize([tool2]);
    // Use a fresh serializer's tool since it has its own mutex, so use same serializer
    // Re-serialize to get the second tool under same mutex
    const [, wrapped2b] = createMutationSerializer()([tool, tool2]);
    // Actually, let's test with the same serializer: tool still fails, but a new call succeeds
    tool.execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "recovered" }],
      isError: false,
    }) as any;

    // Re-wrap with same serializer
    const [wrappedRecovered] = serialize([tool]);
    const result = await wrappedRecovered.execute(
      "call-2",
      {},
      undefined,
      undefined,
      {} as any,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "recovered" }],
      isError: false,
    });
  });

  it("each createMutationSerializer() call creates an independent mutex", async () => {
    const serialize1 = createMutationSerializer();
    const serialize2 = createMutationSerializer();

    const completionOrder: string[] = [];

    const tool1 = makeTool("exec", 50);
    const tool2 = makeTool("write", 0);

    const origExecute1 = tool1.execute;
    tool1.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      const result = await (origExecute1 as any)(...args);
      completionOrder.push("tool1");
      return result;
    }) as any;

    const origExecute2 = tool2.execute;
    tool2.execute = vi.fn().mockImplementation(async (...args: any[]) => {
      const result = await (origExecute2 as any)(...args);
      completionOrder.push("tool2");
      return result;
    }) as any;

    // Wrap under DIFFERENT serializers
    const [wrapped1] = serialize1([tool1]);
    const [wrapped2] = serialize2([tool2]);

    // Fire both -- they should NOT wait on each other (independent mutexes)
    const p1 = wrapped1.execute("call-1", {}, undefined, undefined, {} as any);
    const p2 = wrapped2.execute("call-2", {}, undefined, undefined, {} as any);

    await Promise.all([p1, p2]);

    // tool2 (0ms) should complete before tool1 (50ms) since independent mutexes
    expect(completionOrder).toEqual(["tool2", "tool1"]);
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyTool fallback chain
// ---------------------------------------------------------------------------

describe("isReadOnlyTool fallback chain", () => {
  it("priority 1: returns metadata isReadOnly when registered as true", () => {
    registerToolMetadata("par_test_meta_ro", { isReadOnly: true });
    expect(isReadOnlyTool("par_test_meta_ro")).toBe(true);
  });

  it("priority 1: returns metadata isReadOnly when registered as false", () => {
    registerToolMetadata("par_test_meta_mut", { isReadOnly: false });
    expect(isReadOnlyTool("par_test_meta_mut")).toBe(false);
  });

  it("priority 1: metadata overrides MCP heuristic", () => {
    registerToolMetadata("mcp__par_test__write_tool", { isReadOnly: false });
    expect(isReadOnlyTool("mcp__par_test__write_tool")).toBe(false);
  });

  it("priority 2: MCP heuristic returns true when no metadata", () => {
    expect(isReadOnlyTool("mcp__par_test_unregistered__tool")).toBe(true);
  });

  it("unknown tool with no metadata returns false (safe default)", () => {
    expect(isReadOnlyTool("par_test_no_metadata_tool")).toBe(false);
  });

  it("returns false for unknown tool with no metadata", () => {
    expect(isReadOnlyTool("par_test_unknown_xyz")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Order-preserving, cache-stable result buffer
//
// The SDK runs read-only tools concurrently (parallel mode) so their executes
// resolve in COMPLETION order, which is nondeterministic. If concurrent
// results were placed into the message array in completion order, the cached
// prompt prefix would change turn-over-turn and bust the prompt cache
// (a cost DoS). The order-preserving buffer indexes each result by its
// TOOL-CALL position and flushes in that source order regardless of arrival
// order — so the assembled result array is deterministic (cache-stable).
// ---------------------------------------------------------------------------

describe("createOrderPreservingResultBuffer — concurrent reads land in tool-call order (cache-stable)", () => {
  it("flushes results in tool-call order even when completions arrive out of order [#3,#1,#2] → [#1,#2,#3]", () => {
    const buffer = createOrderPreservingResultBuffer<string>(3);
    // Tool-calls issued in order [#1, #2, #3]; completions arrive [#3, #1, #2].
    buffer.record(2, "read#3-result");
    buffer.record(0, "read#1-result");
    buffer.record(1, "read#2-result");
    expect(buffer.flush()).toEqual([
      "read#1-result",
      "read#2-result",
      "read#3-result",
    ]);
  });

  it("flushes in tool-call order when completions arrive in order too (identity case)", () => {
    const buffer = createOrderPreservingResultBuffer<string>(3);
    buffer.record(0, "a");
    buffer.record(1, "b");
    buffer.record(2, "c");
    expect(buffer.flush()).toEqual(["a", "b", "c"]);
  });

  it("is cache-stable: the same tool-call set yields a byte-identical ordered array across runs", () => {
    // Two independent runs of the SAME tool-call set with DIFFERENT completion
    // interleavings must produce the identical ordered result array — the
    // nondeterministic interleave never leaks into the cached prefix.
    const runA = createOrderPreservingResultBuffer<string>(3);
    runA.record(1, "y");
    runA.record(2, "z");
    runA.record(0, "x");

    const runB = createOrderPreservingResultBuffer<string>(3);
    runB.record(2, "z");
    runB.record(0, "x");
    runB.record(1, "y");

    expect(JSON.stringify(runA.flush())).toBe(JSON.stringify(runB.flush()));
    expect(runA.flush()).toEqual(["x", "y", "z"]);
  });

  it("reports completeness so the consumer flushes only when every tool-call has resolved", () => {
    const buffer = createOrderPreservingResultBuffer<string>(2);
    expect(buffer.isComplete()).toBe(false);
    buffer.record(1, "second");
    expect(buffer.isComplete()).toBe(false);
    buffer.record(0, "first");
    expect(buffer.isComplete()).toBe(true);
    expect(buffer.flush()).toEqual(["first", "second"]);
  });

  it("a zero-call turn is trivially complete and flushes an empty array", () => {
    const buffer = createOrderPreservingResultBuffer<string>(0);
    expect(buffer.isComplete()).toBe(true);
    expect(buffer.flush()).toEqual([]);
  });

  it("rejects an out-of-range index (a result with no matching tool-call slot)", () => {
    const buffer = createOrderPreservingResultBuffer<string>(2);
    expect(() => buffer.record(2, "overflow")).toThrow(/index/i);
    expect(() => buffer.record(-1, "underflow")).toThrow(/index/i);
  });

  it("flush before all results have arrived throws rather than emit a hole (no torn prefix)", () => {
    const buffer = createOrderPreservingResultBuffer<string>(3);
    buffer.record(0, "only-one");
    expect(() => buffer.flush()).toThrow(/incomplete|complete/i);
  });

  it("a late duplicate for an already-recorded slot is rejected (no silent overwrite)", () => {
    const buffer = createOrderPreservingResultBuffer<string>(2);
    buffer.record(0, "first");
    expect(() => buffer.record(0, "again")).toThrow(/already|duplicate/i);
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyTool optional logger
//
// The classifier has no warn-on-legacy-fallback path; the `logger` parameter
// remains for forward-compatibility with future descriptor-level diagnostics.
// These tests pin the no-op behavior so a future addition does not silently
// change call semantics.
// ---------------------------------------------------------------------------

describe("isReadOnlyTool optional logger", () => {
  it("does not warn when metadata is present", () => {
    registerToolMetadata("par_test_no_warn", { isReadOnly: true });
    const logger = { warn: vi.fn() };
    isReadOnlyTool("par_test_no_warn", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when no logger provided", () => {
    expect(() => isReadOnlyTool("par_test_no_logger")).not.toThrow();
  });

  it("does not warn for MCP tools", () => {
    const logger = { warn: vi.fn() };
    isReadOnlyTool("mcp__par_test_no_warn__tool", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn for unknown tools with no metadata", () => {
    const logger = { warn: vi.fn() };
    isReadOnlyTool("par_test_not_legacy", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isConcurrencySafe
// ---------------------------------------------------------------------------

describe("isConcurrencySafe", () => {
  it("returns explicit isConcurrencySafe when set to true", () => {
    registerToolMetadata("par_test_cs_true", { isReadOnly: false, isConcurrencySafe: true });
    expect(isConcurrencySafe("par_test_cs_true")).toBe(true);
  });

  it("returns explicit isConcurrencySafe when set to false", () => {
    registerToolMetadata("par_test_cs_false", { isReadOnly: true, isConcurrencySafe: false });
    expect(isConcurrencySafe("par_test_cs_false")).toBe(false);
  });

  it("defaults to isReadOnly true when isConcurrencySafe unset", () => {
    registerToolMetadata("par_test_cs_default_ro", { isReadOnly: true });
    expect(isConcurrencySafe("par_test_cs_default_ro")).toBe(true);
  });

  it("defaults to isReadOnly false when isConcurrencySafe unset", () => {
    registerToolMetadata("par_test_cs_default_mut", { isReadOnly: false });
    expect(isConcurrencySafe("par_test_cs_default_mut")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutation serializer uses isConcurrencySafe
// ---------------------------------------------------------------------------

describe("createMutationSerializer with isConcurrencySafe", () => {
  // Register metadata for serializer tests
  registerToolMetadata("message", { isReadOnly: false, isConcurrencySafe: true });
  registerToolMetadata("read", { isReadOnly: true });
  registerToolMetadata("exec", { isReadOnly: false });

  it("concurrency-safe mutating tool (message) has execute unchanged (not wrapped)", () => {
    const serialize = createMutationSerializer();
    const messageTool = makeTool("message");
    const originalExecute = messageTool.execute;
    const [wrapped] = serialize([messageTool]);
    expect(wrapped.execute).toBe(originalExecute);
  });

  it("mutating non-concurrent tool (exec) has execute wrapped", () => {
    const serialize = createMutationSerializer();
    const execTool = makeTool("exec");
    const originalExecute = execTool.execute;
    const [wrapped] = serialize([execTool]);
    expect(wrapped.execute).not.toBe(originalExecute);
  });

  it("read-only tool (read) has execute unchanged", () => {
    const serialize = createMutationSerializer();
    const readTool = makeTool("read");
    const originalExecute = readTool.execute;
    const [wrapped] = serialize([readTool]);
    expect(wrapped.execute).toBe(originalExecute);
  });
});
