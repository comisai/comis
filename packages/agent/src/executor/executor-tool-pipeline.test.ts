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

import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  decodeHtmlEntitiesInParams,
  applyJitGuideWrapping,
  applySchemasPruning,
  applySchemaSnapshot,
  applyProviderNormalization,
  applyMutationSerializer,
} from "./executor-tool-pipeline.js";
import {
  deleteToolSchemaSnapshots,
  clearSessionToolSchemaSnapshotHash,
  setSessionStateClock,
} from "./executor-session-state.js";
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

  it("leaves tools unchanged when no provider-specific compat flags apply", () => {
    const tools = [makeTool({ name: "calculator" })];
    const result = applyProviderNormalization({
      tools,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    });
    expect(result.map((t) => t.name)).toEqual(["calculator"]);
    expect(result[0].prepareArguments).toBeUndefined();
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
