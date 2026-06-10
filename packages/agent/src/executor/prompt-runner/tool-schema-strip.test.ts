// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the reactive 2-keyword schema strip (GBNF-02 repair
 * half) plus the A5 propagation decider at the REAL SDK boundary.
 *
 * The strip module is the repair payload of `handleToolSchemaUnsupported`:
 * when a grammar-400 classifies as `tool_schema_unsupported`, the handler
 * strips `pattern`/`format` from the session-held tool schemas IN PLACE and
 * retries exactly once per session. These tests pin:
 *
 *   1. the pure deep walk (`stripSchemaKeywordsDeep`) — removal at every
 *      nesting depth, purity, dedup'd keyword reporting;
 *   2. the in-place application (`applyReactiveSchemaStripInPlace`) —
 *      OBJECT IDENTITY of both the tool entry AND its `parameters` object
 *      (the propagation mechanism — see the A5 decider below);
 *   3. the A5 decider — a REAL `AgentSession` (no fakes) proving the
 *      mutation is visible through the SDK's own registry accessor
 *      `session.getToolDefinition()` AND on the agent-state wire surface.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { hostileMcpTool, wellFormedTool } from "../../provider/tool-schema/gbnf-hostile-fixtures.js";
// Pre-patch this import crashes the suite (module missing) — the intended
// wholesale RED for a brand-new test file with no pre-existing tests.
import {
  REACTIVE_STRIP_KEYWORDS,
  stripSchemaKeywordsDeep,
  applyReactiveSchemaStripInPlace,
} from "./tool-schema-strip.js";

/** Deep-cloned hostile tool so the shared fixture module stays pristine. */
function makeHostileToolClone(): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name: hostileMcpTool.name,
    description: hostileMcpTool.description,
    parameters: structuredClone(hostileMcpTool.parameters) as Record<string, unknown>,
  };
}

describe("REACTIVE_STRIP_KEYWORDS", () => {
  it("is exactly the two-keyword {pattern, format} subset (deliberately narrower than XAI_REJECTED)", () => {
    expect([...REACTIVE_STRIP_KEYWORDS].sort()).toEqual(["format", "pattern"]);
  });
});

describe("stripSchemaKeywordsDeep", () => {
  it("removes pattern and format at the top level and reports both keyword names", () => {
    const input = { type: "string", pattern: "\\d+", format: "date", description: "d" };
    const { schema, stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    expect(schema).toEqual({ type: "string", description: "d" });
    expect(stripped).toEqual(["pattern", "format"]);
  });

  it("removes the keywords inside nested properties at every depth", () => {
    const input = {
      type: "object",
      properties: {
        due: { type: "string", pattern: "\\d{4}", format: "date" },
        nested: {
          type: "object",
          properties: { deep: { type: "string", format: "uri" } },
        },
      },
    };
    const { schema, stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    const out = JSON.stringify(schema);
    expect(out).not.toContain('"pattern"');
    expect(out).not.toContain('"format"');
    expect(stripped).toEqual(["pattern", "format"]);
  });

  it("removes the keywords inside items as a single schema and items as an array of schemas", () => {
    const single = { type: "array", items: { type: "string", pattern: "^x$" } };
    const tuple = { type: "array", items: [{ type: "string", format: "uuid" }, { type: "number" }] };
    expect(JSON.stringify(stripSchemaKeywordsDeep(single, REACTIVE_STRIP_KEYWORDS).schema)).not.toContain('"pattern"');
    const tupleOut = stripSchemaKeywordsDeep(tuple, REACTIVE_STRIP_KEYWORDS);
    expect(JSON.stringify(tupleOut.schema)).not.toContain('"format"');
    expect((tupleOut.schema as { items: unknown[] }).items).toHaveLength(2);
  });

  it("removes the keywords inside anyOf, oneOf, and allOf entries", () => {
    const input = {
      anyOf: [{ type: "string", pattern: "a" }],
      oneOf: [{ type: "string", format: "email" }],
      allOf: [{ type: "object", properties: { p: { type: "string", pattern: "b" } } }],
    };
    const { schema, stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    const out = JSON.stringify(schema);
    expect(out).not.toContain('"pattern"');
    expect(out).not.toContain('"format"');
    expect(stripped).toEqual(["pattern", "format"]);
  });

  it("removes the keywords inside additionalProperties when it is a schema object", () => {
    const input = {
      type: "object",
      additionalProperties: { type: "string", pattern: "^v_", format: "hostname" },
    };
    const { schema } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    const out = JSON.stringify(schema);
    expect(out).not.toContain('"pattern"');
    expect(out).not.toContain('"format"');
    // additionalProperties survives as a schema — only the keywords are removed.
    expect((schema as Record<string, unknown>).additionalProperties).toEqual({ type: "string" });
  });

  it("reports each removed keyword name exactly once (deduplicated across depths)", () => {
    const input = {
      type: "object",
      properties: {
        a: { type: "string", pattern: "1", format: "date" },
        b: { type: "string", pattern: "2", format: "time" },
      },
    };
    const { stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    expect(stripped).toEqual(["pattern", "format"]);
  });

  it("is pure: the input schema deep-equals its pre-call snapshot after the walk", () => {
    const input = structuredClone(hostileMcpTool.parameters);
    const snapshot = JSON.stringify(input);
    stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns stripped: [] and a deep-equal schema for an untouched well-formed input", () => {
    const input = structuredClone(wellFormedTool.parameters);
    const { schema, stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    expect(stripped).toEqual([]);
    expect(schema).toEqual(input);
  });

  it("does NOT strip a property literally NAMED pattern or format (keyword vs property-name guard)", () => {
    const input = {
      type: "object",
      properties: {
        pattern: { type: "string", description: "a property that happens to be called pattern" },
        format: { type: "string" },
      },
    };
    const { schema, stripped } = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);
    expect(stripped).toEqual([]);
    expect(schema).toEqual(input);
  });

  it("passes through non-object inputs unchanged (null, undefined, string, array)", () => {
    expect(stripSchemaKeywordsDeep(null, REACTIVE_STRIP_KEYWORDS)).toEqual({ schema: null, stripped: [], depthLimited: false });
    expect(stripSchemaKeywordsDeep(undefined, REACTIVE_STRIP_KEYWORDS).schema).toBeUndefined();
    expect(stripSchemaKeywordsDeep("x", REACTIVE_STRIP_KEYWORDS)).toEqual({ schema: "x", stripped: [], depthLimited: false });
  });

  // WR-03 (175-REVIEW): the strip walk shares the un-capped-recursion flaw —
  // a hostile MCP schema deep enough to overflow it would crash the repair
  // path the schema rejection itself triggered.
  describe("WR-03: depth-limited recursion (attacker-controlled MCP schemas)", () => {
    function makeDeepPropertiesChain(
      depth: number,
      leaf: Record<string, unknown>,
    ): Record<string, unknown> {
      let node: Record<string, unknown> = leaf;
      for (let i = 0; i < depth; i++) {
        node = { type: "object", properties: { child: node } };
      }
      return node;
    }

    it("survives a 6000-level properties chain without a stack overflow (a depth JSON.parse survives)", () => {
      const deep = makeDeepPropertiesChain(6000, { type: "string", pattern: "^x$" });
      expect(() => stripSchemaKeywordsDeep(deep, REACTIVE_STRIP_KEYWORDS)).not.toThrow();
    });

    it("fails SAFE at the cap: shallow pattern/format still stripped, deep tail passes through, depthLimited reports the cut", () => {
      const input = {
        type: "object",
        properties: {
          due: { type: "string", pattern: "\\d{4}", format: "date" },
          tail: makeDeepPropertiesChain(6000, { type: "string", pattern: "^x$" }),
        },
      };

      const result = stripSchemaKeywordsDeep(input, REACTIVE_STRIP_KEYWORDS);

      const props = (result.schema as { properties: Record<string, Record<string, unknown>> }).properties;
      expect(props.due).toEqual({ type: "string" });
      expect(result.stripped).toEqual(["pattern", "format"]);
      expect(
        (result as unknown as { depthLimited?: boolean }).depthLimited,
      ).toBe(true);
    });
  });
});

describe("applyReactiveSchemaStripInPlace", () => {
  it("preserves OBJECT IDENTITY of the tool entry AND its parameters object while removing the keywords (the in-place pin)", () => {
    const hostile = makeHostileToolClone();
    const tools = [hostile];
    const toolBefore = tools[0];
    const parametersBefore = tools[0].parameters;
    expect(JSON.stringify(parametersBefore)).toContain('"pattern"');

    const result = applyReactiveSchemaStripInPlace(tools);

    // Same tool object — replacing the array entry would silently not
    // propagate to the session registry (RESEARCH Pitfall 6 / the v2.20
    // rigged-test class).
    expect(tools[0]).toBe(toolBefore);
    // Same parameters object — this is the LOAD-BEARING identity: the SDK's
    // wrapped AgentTools capture `definition.parameters` by reference at
    // session creation (tool-definition-wrapper.js), so only content-level
    // mutation of the SAME object reaches the wire. A write-back of a new
    // schema object would update the registry but orphan the wrapped tools.
    expect(tools[0].parameters).toBe(parametersBefore);
    const out = JSON.stringify(tools[0].parameters);
    expect(out).not.toContain('"pattern"');
    expect(out).not.toContain('"format"');
    expect(result.strippedToolNames).toEqual(["schedule_task"]);
    expect(result.strippedKeywords).toEqual(["pattern", "format"]);
  });

  it("returns only the tools that actually changed and leaves a clean tool's parameters untouched", () => {
    const hostile = makeHostileToolClone();
    const clean = {
      name: wellFormedTool.name,
      description: wellFormedTool.description,
      parameters: structuredClone(wellFormedTool.parameters) as Record<string, unknown>,
    };
    const cleanParamsBefore = clean.parameters;
    const cleanSnapshot = JSON.stringify(clean.parameters);

    const result = applyReactiveSchemaStripInPlace([hostile, clean]);

    expect(result.strippedToolNames).toEqual(["schedule_task"]);
    expect(clean.parameters).toBe(cleanParamsBefore);
    expect(JSON.stringify(clean.parameters)).toBe(cleanSnapshot);
  });

  it("reports empty results when no tool carries pattern or format anywhere", () => {
    const clean = {
      name: wellFormedTool.name,
      description: wellFormedTool.description,
      parameters: structuredClone(wellFormedTool.parameters) as Record<string, unknown>,
    };
    const result = applyReactiveSchemaStripInPlace([clean]);
    expect(result.strippedToolNames).toEqual([]);
    expect(result.strippedKeywords).toEqual([]);
  });

  it("skips tools without an object parameters value instead of throwing", () => {
    const result = applyReactiveSchemaStripInPlace([
      { name: "no_params" },
      { name: "string_params", parameters: "not-a-schema" },
    ]);
    expect(result.strippedToolNames).toEqual([]);
    expect(result.strippedKeywords).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A5 propagation decider — REAL SDK boundary (RESEARCH Open Questions Q2,
// RESOLVED). THE (a-lite)-vs-(b) decider; this is the test a fake cannot
// satisfy.
//
// FALLBACK TRIGGER (do NOT weaken these assertions): if this decider FAILS
// on the real SDK (clone-at-creation — getToolDefinition or the agent-state
// wire surface returns stale schema content after the in-place strip), or if
// `createAgentSession` proves un-constructible in a unit context (heavyweight
// runtime deps), the decider is NOT proven. In that case Plan 175-05 Task 3
// implements design-blessed option (b) next-turn constraint memory instead
// (handler classifies + WARNs + sets the session flag + ends THIS turn as
// honest classified failure; the next turn's per-turn assembly applies the
// strip), and the handler tests' same-turn-retry expectations are adapted to
// the (b) contract in the same commit. Never ship (a-lite) on faked evidence.
//
// Composition this decider relies on: pi-ai converts `parameters:
// tool.parameters` VERBATIM per request at request-build time
// (openai-completions.js:819, verified 0.78.1; design-verified 0.79.1) from
// the agent-state tools — so a mutation visible on BOTH the SDK registry
// (`getToolDefinition`) and the agent-state wire surface (`session.state.tools`)
// is wire-visible on the retry request.
// ---------------------------------------------------------------------------
describe("A5 propagation decider — REAL SDK boundary (RESEARCH Open Questions Q2, RESOLVED)", () => {
  let scratchDir: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(resolve(tmpdir(), "comis-a5-decider-"));
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("in-place strip on the SAME customTools object is visible through session.getToolDefinition AND the agent-state wire surface of a REAL AgentSession", async () => {
    // The exact ToolDefinition shape production passes: pi-executor.ts:580
    // calls createAgentSession({ customTools: mergedCustomTools, tools:
    // mergedCustomTools.map(t => t.name) }) and later mutates those SAME
    // objects in place (the tool.execute mutation at pi-executor.ts:1517-1526).
    const hostileTool = {
      name: hostileMcpTool.name,
      label: "Schedule Task (hostile fixture)",
      description: hostileMcpTool.description,
      parameters: structuredClone(hostileMcpTool.parameters),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    } as unknown as ToolDefinition;

    // Minimal REAL session: in-memory managers (no disk persistence), a
    // scratch agentDir (no reads from the operator's ~/.pi), no model entry
    // (construction does not require auth or network — it is session
    // construction, not prompting).
    const authStorage = AuthStorage.inMemory();
    const { session } = await createAgentSession({
      cwd: scratchDir,
      agentDir: scratchDir,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      sessionManager: SessionManager.inMemory(scratchDir),
      settingsManager: SettingsManager.inMemory(),
      tools: [hostileMcpTool.name],
      customTools: [hostileTool],
    });

    try {
      // NEGATIVE CONTROL FIRST: the accessor reads real schema content (not a
      // stub) — pattern/format are present before any strip.
      const registryBefore = JSON.stringify(session.getToolDefinition(hostileMcpTool.name)?.parameters);
      expect(registryBefore).toContain('"pattern"');
      expect(registryBefore).toContain('"format"');

      // Wire-surface negative control: the wrapped AgentTool the agent holds
      // (what pi-ai converts per request) carries the same schema content.
      const wireToolsBefore = (session.state as { tools: Array<{ name: string; parameters?: unknown }> }).tools;
      const wireBefore = wireToolsBefore.find((t) => t.name === hostileMcpTool.name);
      expect(wireBefore, "customTools entry must be ACTIVE on the agent state").toBeDefined();
      expect(JSON.stringify(wireBefore?.parameters)).toContain('"pattern"');

      // The strip — mutating the SAME object the session was created with
      // (exactly what production does via params.mergedCustomTools).
      const result = applyReactiveSchemaStripInPlace([hostileTool as unknown as { name: string; parameters?: unknown }]);
      expect(result.strippedToolNames).toEqual([hostileMcpTool.name]);

      // DECIDER ASSERTION at the SDK's OWN registry boundary: the SDK holds
      // the same object and reads its LIVE parameters, not a creation-time
      // clone.
      const registryAfter = JSON.stringify(session.getToolDefinition(hostileMcpTool.name)?.parameters);
      expect(registryAfter).not.toContain('"pattern"');
      expect(registryAfter).not.toContain('"format"');

      // DECIDER ASSERTION at the wire surface: the wrapped AgentTool the
      // agent sends to pi-ai reads the same live parameters object.
      const wireToolsAfter = (session.state as { tools: Array<{ name: string; parameters?: unknown }> }).tools;
      const wireAfter = wireToolsAfter.find((t) => t.name === hostileMcpTool.name);
      const wireAfterJson = JSON.stringify(wireAfter?.parameters);
      expect(wireAfterJson).not.toContain('"pattern"');
      expect(wireAfterJson).not.toContain('"format"');

      // Structure survives: only the 2 keywords were removed.
      const after = session.getToolDefinition(hostileMcpTool.name)?.parameters as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(after.properties)).toEqual(
        Object.keys(hostileMcpTool.parameters.properties as Record<string, unknown>),
      );
    } finally {
      session.dispose();
    }
  });
});
