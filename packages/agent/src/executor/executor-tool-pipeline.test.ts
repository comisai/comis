// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for executor-tool-pipeline.
 *
 * executor-tool-pipeline.ts is a per-execute() pipeline that prepares a
 * `ToolDefinition[]` for the agent SDK: HTML-entity-decoded xAI/Grok
 * arguments, JIT-guide wrapping, small-model schema pruning, schema
 * snapshot stability across turns, provider-family normalization, and
 * mutation serializer wrapping. Each helper is a pure function on
 * `{ tools, ... } -> ToolDefinition[]`, so the tests construct minimal
 * stand-ins (no SDK init) and assert on the returned shape.
 *
 * Use-case design: every `it("...")` description names a use case ≥20
 * chars ending in a recognizable shape ("returns X when Y",
 * "rejects Z when W", "<noun phrase>" describing observable behavior).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatSessionKey } from "@comis/core";
import {
  decodeHtmlEntitiesInParams,
  applyJitGuideWrapping,
  applySchemasPruning,
  applySchemaSnapshot,
  applyProviderNormalization,
  applyMutationSerializer,
} from "./executor-tool-pipeline.js";
import * as pipelineModule from "./executor-tool-pipeline.js";
import {
  deleteToolSchemaSnapshots,
  clearSessionToolSchemaSnapshotHash,
  setSessionStateClock,
} from "./executor-session-state.js";
import { clearSessionState } from "./session-snapshot-cleanup.js";
import {
  handleToolSchemaUnsupported,
  resetToolSchemaStripGateForTest,
} from "./prompt-runner/tool-schema-unsupported-handler.js";
import type {
  BridgeSnapshot,
  InvokeRetry,
  RetryState,
} from "./prompt-runner/silent-failure-handlers.js";
import type { RunPromptParams } from "./prompt-runner/prompt-runner-types.js";
import { hostileMcpTool } from "../provider/tool-schema/gbnf-hostile-fixtures.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Module-level clock for executor-session-state's bounded session map.
setSessionStateClock({ now: () => Date.now(), nowDate: () => new Date() });

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal cast helper — `ToolDefinition` has a TypeBox `parameters` type
 * with generic parameter constraints. Test fixtures use plain objects;
 * the cast is local to this file.
 */
function makeTool(partial: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: partial.name,
    label: partial.label ?? partial.name,
    description: partial.description ?? "",
    parameters: partial.parameters ?? ({ type: "object", properties: {} } as unknown as ToolDefinition["parameters"]),
    execute: partial.execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], isError: false, details: undefined })),
    ...partial,
  } as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// decodeHtmlEntitiesInParams
// ---------------------------------------------------------------------------

describe("decodeHtmlEntitiesInParams — xAI/Grok HTML-entity decoding for tool call arguments", () => {
  it("decodes &amp; to & in a top-level string value without touching siblings", () => {
    const input = { url: "https://example.com/path?a=1&amp;b=2", count: 42 };
    const result = decodeHtmlEntitiesInParams(input);
    expect(result.url).toBe("https://example.com/path?a=1&b=2");
    expect(result.count).toBe(42);
  });

  it("recursively decodes &lt; &gt; &quot; in a deeply nested object value", () => {
    const input = {
      outer: {
        inner: {
          query: "select &quot;name&quot; where x &lt; 10 and x &gt; 0",
        },
      },
    };
    const result = decodeHtmlEntitiesInParams(input);
    const inner = (result.outer as { inner: { query: string } }).inner;
    expect(inner.query).toBe('select "name" where x < 10 and x > 0');
  });

  it("preserves non-string primitive values (numbers, booleans, null) without transformation", () => {
    const input = {
      count: 7,
      enabled: true,
      missing: null,
      ratio: 0.5,
    };
    const result = decodeHtmlEntitiesInParams(input);
    expect(result).toEqual({ count: 7, enabled: true, missing: null, ratio: 0.5 });
  });

  it("decodes entities inside arrays of strings and arrays of nested objects", () => {
    const input = {
      tags: ["a &amp; b", "c &lt; d"],
      records: [{ name: "x &amp; y" }, { name: "p &quot;q&quot;" }],
    };
    const result = decodeHtmlEntitiesInParams(input);
    expect(result.tags).toEqual(["a & b", "c < d"]);
    expect(result.records).toEqual([{ name: "x & y" }, { name: 'p "q"' }]);
  });

  it("returns a new object rather than mutating the caller's params in place", () => {
    const input = { value: "x &amp; y" };
    const result = decodeHtmlEntitiesInParams(input);
    expect(result).not.toBe(input);
    expect(input.value).toBe("x &amp; y");
    expect(result.value).toBe("x & y");
  });

  it("preserves non-string array elements (numbers, null) inside a mixed-type array", () => {
    const input = { mixed: ["a &amp; b", 7, null, "c"] };
    const result = decodeHtmlEntitiesInParams(input);
    expect(result.mixed).toEqual(["a & b", 7, null, "c"]);
  });
});

// ---------------------------------------------------------------------------
// applyJitGuideWrapping
// ---------------------------------------------------------------------------

describe("applyJitGuideWrapping — JIT guide injection wrapper around tool execute()", () => {
  it("returns the same number of tools after wrapping (no tools added or dropped)", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "a" }), makeTool({ name: "b" }), makeTool({ name: "c" })];
    const delivered = new Set<string>();
    const result = applyJitGuideWrapping({ tools, deliveredGuides: delivered, logger });
    expect(result.length).toBe(tools.length);
  });

  it("preserves the name and description of each input tool through wrapping", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "alpha", description: "first" }), makeTool({ name: "beta", description: "second" })];
    const result = applyJitGuideWrapping({ tools, deliveredGuides: new Set(), logger });
    expect(result.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(result.map((t) => t.description)).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// applySchemasPruning
// ---------------------------------------------------------------------------

describe("applySchemasPruning — nano-class schema pruning gated on capabilityClass (Phase 151: behavior-neutral)", () => {
  it("passes tools through unchanged for 'small' capabilityClass models without invoking pruning", () => {
    // Phase 151 behavior-neutral: only "nano" triggers pruning; "small" (qwen3.6 27B/256K) is NOT pruned.
    const logger = createMockLogger();
    const tools = [makeTool({ name: "a", description: "do a" }), makeTool({ name: "b", description: "do b" })];
    const result = applySchemasPruning({ tools, capabilityClass: "small", logger });
    expect(result).toEqual(tools);
    expect((logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(0);
  });

  it("passes tools through unchanged for 'frontier' capabilityClass models without invoking pruning", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "a" })];
    const result = applySchemasPruning({ tools, capabilityClass: "frontier", logger });
    expect(result).toEqual(tools);
  });

  it("passes tools through unchanged for 'mid' capabilityClass models without invoking pruning", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "a", description: "do a" }), makeTool({ name: "b", description: "do b" })];
    const result = applySchemasPruning({ tools, capabilityClass: "mid", logger });
    expect(result).toEqual(tools);
    expect((logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(0);
  });

  it("emits an INFO log when pruning is invoked for a 'nano' capabilityClass model", () => {
    const logger = createMockLogger();
    // Build a tool with a long description so pruning has something to remove.
    const tools = [makeTool({ name: "search", description: "lorem ipsum ".repeat(50) })];
    applySchemasPruning({ tools, capabilityClass: "nano", logger });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ toolCount: expect.any(Number) }),
      "Schema descriptions pruned for nano-class model",
    );
  });
});

// ---------------------------------------------------------------------------
// applySchemaSnapshot
// ---------------------------------------------------------------------------

describe("applySchemaSnapshot — first-turn capture and subsequent-turn reuse of tool shapes", () => {
  const SESSION = "test-snapshot-session-1";

  function clear(): void {
    deleteToolSchemaSnapshots(SESSION);
    clearSessionToolSchemaSnapshotHash(SESSION);
  }

  it("captures tool shapes on the first call and returns the original tools unmodified", () => {
    clear();
    const tools = [makeTool({ name: "search", description: "initial" })];
    const result = applySchemaSnapshot({ tools, sessionKey: SESSION, deferredNames: [] });
    expect(result.map((t) => t.name)).toEqual(["search"]);
    expect(result[0].description).toBe("initial");
  });

  it("returns snapshot-stable description and parameters even when the live tool description changes between turns", () => {
    clear();
    // Turn 1: snapshot.
    applySchemaSnapshot({
      tools: [makeTool({ name: "search", description: "initial" })],
      sessionKey: SESSION,
      deferredNames: [],
    });
    // Turn 2: live tool description differs; snapshot must win.
    const turn2 = applySchemaSnapshot({
      tools: [makeTool({ name: "search", description: "MUTATED-LIVE-DESCRIPTION" })],
      sessionKey: SESSION,
      deferredNames: [],
    });
    expect(turn2[0].description).toBe("initial");
  });

  it("invalidates the snapshot when tool composition changes between turns (new tool added)", () => {
    clear();
    // Turn 1: snapshot with one tool.
    applySchemaSnapshot({
      tools: [makeTool({ name: "alpha", description: "first" })],
      sessionKey: SESSION,
      deferredNames: [],
    });
    // Turn 2: tool composition expanded — snapshot must invalidate and re-snapshot.
    const turn2 = applySchemaSnapshot({
      tools: [
        makeTool({ name: "alpha", description: "first-new" }),
        makeTool({ name: "beta", description: "second-new" }),
      ],
      sessionKey: SESSION,
      deferredNames: [],
    });
    // Both tools present; new descriptions used (snapshot was invalidated and recaptured).
    expect(turn2.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    expect(turn2.find((t) => t.name === "alpha")?.description).toBe("first-new");
  });
});

// ---------------------------------------------------------------------------
// applyProviderNormalization
// ---------------------------------------------------------------------------

describe("applyProviderNormalization — provider-specific tool normalization and xAI argument decoding", () => {
  it("filters Comis web_search tool out when the model has native web search (xAI nativeWebSearchTool)", () => {
    const tools = [makeTool({ name: "web_search" }), makeTool({ name: "calculator" })];
    const result = applyProviderNormalization({
      tools,
      provider: "xai",
      modelId: "grok-beta",
      compat: { nativeWebSearchTool: true },
    });
    expect(result.find((t) => t.name === "web_search")).toBeUndefined();
    expect(result.find((t) => t.name === "calculator")).toBeDefined();
  });

  it("attaches a prepareArguments hook when compat.toolCallArgumentsEncoding is html-entities", () => {
    const tools = [makeTool({ name: "calculator" })];
    const result = applyProviderNormalization({
      tools,
      provider: "xai",
      modelId: "grok-beta",
      compat: { toolCallArgumentsEncoding: "html-entities" },
    });
    expect(typeof result[0].prepareArguments).toBe("function");
    const decoded = result[0].prepareArguments!({ url: "a &amp; b" });
    expect((decoded as { url: string }).url).toBe("a & b");
  });

  it("attaches a universal prepareArguments hook even without provider compat flags (F-3 coercion)", () => {
    const tools = [makeTool({ name: "calculator" })];
    const result = applyProviderNormalization({
      tools,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    });
    expect(result.map((t) => t.name)).toEqual(["calculator"]);
    // Every tool now carries the F-3 stringified-JSON coercer; it is an identity
    // no-op when nothing needs coercing (empty-properties schema here).
    expect(typeof result[0].prepareArguments).toBe("function");
    expect(result[0].prepareArguments!({ a: "1" })).toEqual({ a: "1" });
  });

  it("coerces a stringified array field to an array via prepareArguments (F-3, live 2026-06-12)", () => {
    const tools = [
      makeTool({
        name: "memory_manage",
        parameters: {
          type: "object",
          properties: { action: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
        } as unknown as ToolDefinition["parameters"],
      }),
    ];
    const result = applyProviderNormalization({
      tools,
      provider: "ollama",
      modelId: "qwen3.6:35b",
    });
    const prepared = result[0].prepareArguments!({ action: "delete", ids: '["abc-123"]' });
    expect(prepared).toEqual({ action: "delete", ids: ["abc-123"] });
  });

  it("does NOT coerce a JSON-array-shaped string when the field is declared a string (F-3 safety)", () => {
    const tools = [
      makeTool({
        name: "file_write",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        } as unknown as ToolDefinition["parameters"],
      }),
    ];
    const result = applyProviderNormalization({ tools, provider: "ollama", modelId: "qwen3.6:35b" });
    const prepared = result[0].prepareArguments!({ path: "a.json", content: "[1,2,3]" });
    expect(prepared).toEqual({ path: "a.json", content: "[1,2,3]" });
  });

  it("composes xAI html-entity decode THEN F-3 coercion in prepareArguments", () => {
    const tools = [
      makeTool({
        name: "tool",
        parameters: {
          type: "object",
          properties: { note: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
        } as unknown as ToolDefinition["parameters"],
      }),
    ];
    const result = applyProviderNormalization({
      tools,
      provider: "xai",
      modelId: "grok-beta",
      compat: { toolCallArgumentsEncoding: "html-entities" },
    });
    const prepared = result[0].prepareArguments!({ note: "a &amp; b", ids: '["x"]' });
    expect(prepared).toEqual({ note: "a & b", ids: ["x"] });
  });
});

// ---------------------------------------------------------------------------
// applyMutationSerializer
// ---------------------------------------------------------------------------

describe("applyMutationSerializer — mutation serializer wrapping for parallel-mode tool dispatch", () => {
  it("emits a DEBUG log with the count of mutating (non-concurrency-safe) tools", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "alpha" }), makeTool({ name: "beta" })];
    applyMutationSerializer(tools, logger);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ mutatingToolCount: expect.any(Number) }),
      "Mutation serializer applied to tool pipeline",
    );
  });

  it("returns one wrapped tool per input tool (no tools added or dropped)", () => {
    const logger = createMockLogger();
    const tools = [makeTool({ name: "alpha" }), makeTool({ name: "beta" }), makeTool({ name: "gamma" })];
    const result = applyMutationSerializer(tools, logger);
    expect(result.length).toBe(tools.length);
  });
});

// ---------------------------------------------------------------------------
// CR-02 (175-REVIEW): reactive strip must persist across turns; the
// once-per-session gate must clear on session reset.
//
// The per-turn assembly order is snapshot → normalize: applySchemaSnapshot
// rebuilds parameters from the pre-strip deep-copy snapshot every turn, and
// on gbnf-profile providers cleanSchemaForGbnf constructs brand-new parameter
// objects each turn — so the handler's in-place strip (correct for the
// in-flight retry) NEVER reaches the objects the next turn sends. Pre-fix:
// turn N heals, turn N+1 re-sends the rejected pattern/format, the provider
// 400s deterministically, and the closed once-gate declares terminal failure
// — the session is permanently bricked after one heal.
// ---------------------------------------------------------------------------

describe("CR-02: reactive strip persistence across turns + session-reset gate clearing", () => {
  beforeEach(() => {
    resetToolSchemaStripGateForTest();
  });

  /** Fresh hostile live toolset, as the per-turn assembly receives it. */
  function makeHostileLiveTools(): ToolDefinition[] {
    return [
      makeTool({
        name: hostileMcpTool.name,
        description: hostileMcpTool.description,
        parameters: structuredClone(hostileMcpTool.parameters) as ToolDefinition["parameters"],
      }),
    ];
  }

  /**
   * One assembly turn in the production order (executor-tool-assembly.ts):
   * snapshot → provider normalization → persisted reactive strip. The strip
   * step is bound tolerantly via the namespace so this file still loads on
   * the pre-patch module (the RED state, where the export does not exist and
   * a turn is snapshot → normalize only).
   */
  function runAssemblyTurn(tools: ToolDefinition[], snapshotKey: string): ToolDefinition[] {
    let out = applySchemaSnapshot({ tools, sessionKey: snapshotKey, deferredNames: [] });
    out = applyProviderNormalization({
      tools: out,
      provider: "my-ollama",
      modelId: "qwen3.6:35b",
      compat: { toolSchemaProfile: "gbnf" },
    });
    const reapply = (
      pipelineModule as unknown as {
        applyPersistedReactiveStrip?: (p: { tools: ToolDefinition[]; sessionKey: string }) => ToolDefinition[];
      }
    ).applyPersistedReactiveStrip;
    return reapply ? reapply({ tools: out, sessionKey: snapshotKey }) : out;
  }

  /** Drive the REAL strip-retry handler against this turn's wire toolset. */
  async function fireGrammar400(
    sessionKey: { tenantId: string; userId: string; channelId: string },
    wireTools: ToolDefinition[],
    invokeRetry: InvokeRetry,
  ): Promise<RetryState> {
    const retryState: RetryState = { promptSucceeded: false, promptError: undefined };
    const params = {
      session: { getLastAssistantText: vi.fn(() => "recovered visible text"), messages: [] },
      sessionKey,
      agentId: "agent-1",
      bridge: { getResult: vi.fn(() => ({ llmCalls: 1, textEmitted: true })) },
      mergedCustomTools: wireTools,
      resolvedModel: { id: "qwen3.6:35b", provider: "my-ollama" },
      config: { provider: "my-ollama", model: "qwen3.6:35b" },
      deps: {
        logger: createMockLogger(),
        eventBus: { emit: vi.fn() },
        clock: { now: () => 1234 },
        timers: {
          setTimeout: (fn: () => void) => {
            fn();
            return { cancelled: false, cancel: () => {}, unref: () => {} };
          },
        },
      },
    } as unknown as RunPromptParams;
    const bridgeSnapshot = {
      llmCalls: 1,
      finishReason: "error",
      textEmitted: false,
      lastLlmErrorMessage: "JSON schema conversion failed:\nUnrecognized schema: ...",
    } as BridgeSnapshot;
    await handleToolSchemaUnsupported(params, "msg", undefined, bridgeSnapshot, retryState, invokeRetry);
    return retryState;
  }

  it("turn N+1 after a healed turn N sends STRIPPED wire schemas — the heal survives the snapshot→normalize rebuild", async () => {
    const sessionKey = { tenantId: "t1", userId: "u1", channelId: "cr02-multiturn" };
    const snapshotKey = formatSessionKey(sessionKey);

    // Turn N: assemble, grammar-400, strip-retry heals (invokeRetry succeeds).
    const wireTurn1 = runAssemblyTurn(makeHostileLiveTools(), snapshotKey);
    const invokeRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    const state = await fireGrammar400(sessionKey, wireTurn1, invokeRetry);
    expect(state.promptSucceeded).toBe(true);
    // The in-flight strip reached THIS turn's wire objects (pre-fix true too).
    expect(JSON.stringify(wireTurn1.map((t) => t.parameters))).not.toContain('"pattern"');

    // Turn N+1: per-turn assembly rebuilds from the pre-strip snapshot (live
    // tools are re-supplied each turn) — the strip must still be in effect.
    const wireTurn2 = runAssemblyTurn(makeHostileLiveTools(), snapshotKey);
    const serialized = JSON.stringify(wireTurn2.map((t) => t.parameters));
    expect(serialized).not.toContain('"pattern"');
    expect(serialized).not.toContain('"format"');
  });

  it("session reset clears the once-gate: a reset session gets its one strip-retry again instead of instant terminal failure", async () => {
    const sessionKey = { tenantId: "t1", userId: "u1", channelId: "cr02-reset" };
    const snapshotKey = formatSessionKey(sessionKey);

    // Turn N: the session consumes its one strip-retry.
    const wireTurn1 = runAssemblyTurn(makeHostileLiveTools(), snapshotKey);
    const firstRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    await fireGrammar400(sessionKey, wireTurn1, firstRetry);
    expect(firstRetry).toHaveBeenCalledTimes(1);

    // Operator resets the conversation: ALL executor session state for the
    // key is dropped through the single authoritative cleanup path.
    clearSessionState(snapshotKey);

    // Fresh session (same key after reset): its first grammar-400 must get a
    // strip-retry — pre-fix the process-lifetime gate stayed closed and the
    // reset session terminal-failed with zero repair attempts.
    const wireAfterReset = runAssemblyTurn(makeHostileLiveTools(), snapshotKey);
    const secondRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    const state = await fireGrammar400(sessionKey, wireAfterReset, secondRetry);
    expect(secondRetry).toHaveBeenCalledTimes(1);
    expect(state.promptSucceeded).toBe(true);
  });

  it("wiring: executor-tool-assembly applies the persisted reactive strip AFTER provider normalization (source pin)", () => {
    // Source-grep wiring pin (retry-loop.test.ts precedent): the unit turns
    // above prove the mechanism; this proves assembleTools actually calls it
    // in the load-bearing order (after normalization rebuilds objects).
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "executor-tool-assembly.ts"), "utf-8");
    expect(source).toMatch(/applyPersistedReactiveStrip\(/);
    expect(source.indexOf("applyPersistedReactiveStrip(")).toBeGreaterThan(
      source.indexOf("applyProviderNormalization("),
    );
  });
});
