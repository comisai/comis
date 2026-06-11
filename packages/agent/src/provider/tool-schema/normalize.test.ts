// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeToolSchemasForProvider,
  setToolNormalizationLogger,
  type ToolNormalizationContext,
} from "./normalize.js";
import * as normalizeModule from "./normalize.js";
import {
  hostileMcpTool,
  hostileMcpToolset,
  wellFormedTool,
  type HostileMcpTool,
} from "./gbnf-hostile-fixtures.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComisLogger } from "@comis/core";

/**
 * Reset the module-level gbnf boot-summary latch between tests (mirrors the
 * logger reset in the top-level beforeEach — without it, test order breaks).
 * Bound tolerantly via the namespace so the file still loads on the pre-patch
 * module where the export does not exist yet (the RED state).
 */
function resetGbnfBootSummary(): void {
  (
    normalizeModule as unknown as { resetGbnfBootSummaryForTest?: () => void }
  ).resetGbnfBootSummaryForTest?.();
}

/** Create a minimal ToolDefinition stub for testing. */
function makeTool(
  name: string,
  parameters?: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: parameters ?? { type: "object" },
    execute: async () => ({ resultForAssistant: "ok" }),
  } as unknown as ToolDefinition;
}

/**
 * The hostile fixtures are inert data (name/description/parameters, no
 * execute) — cast to the SDK shape the pipeline reads (per the Plan-01
 * fixture contract: consumers cast where a full ToolDefinition is required).
 */
function asToolDefs(tools: readonly HostileMcpTool[]): ToolDefinition[] {
  return tools as unknown as ToolDefinition[];
}

describe("normalizeToolSchemasForProvider", () => {
  beforeEach(() => {
    // Reset logger between tests
    setToolNormalizationLogger(undefined as unknown as ComisLogger);
  });

  describe("Google provider (Layer 1 + Layer 2 + Layer 4)", () => {
    it("strips Google PROVIDER_UNSUPPORTED_KEYWORDS (Layer 1) and Gemini keywords (Layer 2)", () => {
      const tool = makeTool("test_tool", {
        type: "object",
        additionalProperties: false,       // Layer 1 (google) + Layer 2 (gemini)
        $ref: "#/$defs/Foo",               // Layer 2 only
        $defs: { Foo: { type: "string" } }, // Layer 2 only
        properties: {
          value: {
            type: "string",
            format: "email",    // Layer 1 (google keyword)
            minLength: 1,       // Layer 1 (google keyword)
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "google",
        modelId: "gemini-2.0-flash",
      });

      expect(result).toHaveLength(1);
      const schema = result[0].parameters as Record<string, unknown>;

      // Layer 1: google keywords stripped
      expect(schema.additionalProperties).toBeUndefined();
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.value.format).toBeUndefined();
      expect(props.value.minLength).toBeUndefined();

      // Layer 2: Gemini-specific keywords stripped
      expect(schema.$ref).toBeUndefined();
      expect(schema.$defs).toBeUndefined();

      // Layer 4: type preserved
      expect(schema.type).toBe("object");
    });
  });

  describe("Google-vertex provider (same as google via providerFamily)", () => {
    it("applies same cleaning as google", () => {
      const tool = makeTool("vertex_tool", {
        type: "object",
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
        properties: {
          x: { type: "number", minimum: 0 },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "google-vertex",
        modelId: "gemini-pro",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      expect(schema.additionalProperties).toBeUndefined();
      expect(schema.$schema).toBeUndefined();
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.x.minimum).toBeUndefined();
    });
  });

  describe("xAI provider (Layer 1 + Layer 3 + Layer 4)", () => {
    it("strips xAI keywords (Layer 3), no Gemini stripping", () => {
      const tool = makeTool("xai_tool", {
        type: "object",
        additionalProperties: false,  // NOT stripped by xAI (Layer 3)
        properties: {
          name: {
            type: "string",
            minLength: 1,     // Layer 3: xAI constraint
            maxLength: 100,   // Layer 3: xAI constraint
            format: "email",  // Layer 3: xAI constraint
          },
          count: {
            type: "integer",
            minimum: 0,       // Layer 3: xAI constraint
            maximum: 1000,    // Layer 3: xAI constraint
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "xai",
        modelId: "grok-2",
        compat: { toolSchemaProfile: "xai" },
      });

      const schema = result[0].parameters as Record<string, unknown>;

      // additionalProperties NOT stripped (not a Gemini provider, and not in xAI rejected list)
      expect(schema.additionalProperties).toBe(false);

      const props = schema.properties as Record<string, Record<string, unknown>>;
      // Layer 3: xAI constraints stripped
      expect(props.name.minLength).toBeUndefined();
      expect(props.name.maxLength).toBeUndefined();
      expect(props.name.format).toBeUndefined();
      expect(props.count.minimum).toBeUndefined();
      expect(props.count.maximum).toBeUndefined();

      // Preserved
      expect(props.name.type).toBe("string");
      expect(props.count.type).toBe("integer");
    });
  });

  describe("Anthropic provider (Layer 1 + Layer 4 only)", () => {
    it("strips Anthropic PROVIDER_UNSUPPORTED_KEYWORDS, no Layer 2/3", () => {
      const tool = makeTool("anthropic_tool", {
        type: "object",
        additionalProperties: false,  // NOT stripped for anthropic
        properties: {
          name: {
            type: "string",
            minLength: 1,    // Layer 1: anthropic keyword
            pattern: "^[a-z]+$",  // Layer 1: anthropic keyword
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      // additionalProperties preserved (not in anthropic set)
      expect(schema.additionalProperties).toBe(false);

      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.name.minLength).toBeUndefined();
      expect(props.name.pattern).toBeUndefined();
      expect(props.name.type).toBe("string");
    });
  });

  describe("OpenAI provider (Layer 4 only)", () => {
    it("only applies Layer 4 (type: object forcing)", () => {
      const tool = makeTool("openai_tool", {
        // intentionally no type at top level
        properties: {
          name: {
            type: "string",
            minLength: 1,
            pattern: "^[a-z]+$",
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "openai",
        modelId: "gpt-4o",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      // Layer 4: type forced to "object"
      expect(schema.type).toBe("object");

      // No keyword stripping (OpenAI not in PROVIDER_UNSUPPORTED_KEYWORDS)
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.name.minLength).toBe(1);
      expect(props.name.pattern).toBe("^[a-z]+$");
    });
  });

  describe("Unknown provider (Layer 4 only)", () => {
    it("only applies Layer 4", () => {
      const tool = makeTool("unknown_tool", {
        properties: {
          x: { type: "number", minimum: 0 },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "some-new-provider",
        modelId: "some-model",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      expect(schema.type).toBe("object");
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.x.minimum).toBe(0);
    });
  });

  describe("Layer 4: top-level type: object forcing", () => {
    it("adds type: object when missing from root", () => {
      const tool = makeTool("no_type", {
        properties: { x: { type: "string" } },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "openai",
        modelId: "gpt-4",
      });

      expect((result[0].parameters as Record<string, unknown>).type).toBe("object");
    });

    it("preserves type: object when already present", () => {
      const tool = makeTool("has_type", {
        type: "object",
        properties: { x: { type: "string" } },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "openai",
        modelId: "gpt-4",
      });

      expect((result[0].parameters as Record<string, unknown>).type).toBe("object");
    });
  });

  describe("Layer 0: anyOf/const to enum normalization", () => {
    it("normalizes anyOf/const to enum on early-return path (anthropic)", () => {
      const tool = makeTool("enum_tool", {
        type: "object",
        properties: {
          action: {
            anyOf: [
              { const: "start", type: "string" },
              { const: "stop", type: "string" },
              { const: "restart", type: "string" },
            ],
          },
          name: { type: "string" },
        },
      });

      // Anthropic has keyword stripping but is NOT gemini/xai, so
      // this exercises Layer 0 + Layer 1 + Layer 4
      const result = normalizeToolSchemasForProvider([tool], {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.action).toEqual({
        type: "string",
        enum: ["start", "stop", "restart"],
      });
      expect(props.name).toEqual({ type: "string" });
    });

    it("normalizes anyOf/const to enum on early-return path (openai - Layer 4 only)", () => {
      const tool = makeTool("openai_enum", {
        type: "object",
        properties: {
          mode: {
            anyOf: [
              { const: "fast", type: "string" },
              { const: "slow", type: "string" },
            ],
          },
        },
      });

      // OpenAI hits the early-return path (no keyword stripping, not gemini, not xai)
      const result = normalizeToolSchemasForProvider([tool], {
        provider: "openai",
        modelId: "gpt-4o",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.mode).toEqual({
        type: "string",
        enum: ["fast", "slow"],
      });
    });

    it("normalizes anyOf/const to enum for google (full pipeline)", () => {
      const tool = makeTool("gemini_enum", {
        type: "object",
        properties: {
          priority: {
            description: "Task priority",
            anyOf: [
              { const: "low", type: "string" },
              { const: "high", type: "string" },
            ],
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "google",
        modelId: "gemini-2.0-flash",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.priority).toEqual({
        type: "string",
        enum: ["low", "high"],
        description: "Task priority",
      });
    });

    it("preserves non-const anyOf patterns through full pipeline", () => {
      const tool = makeTool("mixed_union", {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
      });

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "openai",
        modelId: "gpt-4o",
      });

      const schema = result[0].parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      // Should NOT be converted to enum -- mixed types preserved
      expect(props.value.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
      expect(props.value.enum).toBeUndefined();
    });
  });

  describe("Edge cases", () => {
    it("tools without parameters pass through unchanged", () => {
      const tool = {
        name: "no_params",
        label: "no_params",
        description: "No params tool",
        execute: async () => ({ resultForAssistant: "ok" }),
      } as unknown as ToolDefinition;

      const result = normalizeToolSchemasForProvider([tool], {
        provider: "google",
        modelId: "gemini-2.0-flash",
      });

      expect(result[0].name).toBe("no_params");
      expect(result[0].parameters).toBeUndefined();
    });

    it("input tools array not mutated", () => {
      const tool = makeTool("immutable_test", {
        type: "object",
        additionalProperties: false,
        properties: {
          x: { type: "string", format: "email" },
        },
      });
      const tools = [tool];
      const originalParams = JSON.stringify(tool.parameters);

      normalizeToolSchemasForProvider(tools, {
        provider: "google",
        modelId: "gemini-2.0-flash",
      });

      // Original tool parameters should not be mutated
      expect(JSON.stringify(tools[0].parameters)).toBe(originalParams);
    });

    it("empty tools array returns empty array", () => {
      const result = normalizeToolSchemasForProvider([], {
        provider: "google",
        modelId: "gemini-2.0-flash",
      });

      expect(result).toEqual([]);
    });
  });

  describe("Trace logging — log-review demotion", () => {
    // Previously this log was debug-level, firing per-tool-per-request and
    // dominating debug logs. It's now trace-level — recoverable when
    // an operator needs it, silent during routine debug-mode operation.

    it("calls logger.trace (NOT .debug) when keywords are stripped", () => {
      const debugFn = vi.fn();
      const traceFn = vi.fn();
      const mockLogger = {
        trace: traceFn,
        debug: debugFn,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ComisLogger;
      setToolNormalizationLogger(mockLogger);

      const tool = makeTool("logged_tool", {
        type: "object",
        properties: {
          x: { type: "string", format: "email", minLength: 1 },
        },
      });

      normalizeToolSchemasForProvider([tool], {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      expect(traceFn).toHaveBeenCalledOnce();
      // Critical: the keywords-stripped emit MUST NOT pollute debug-mode logs.
      expect(debugFn).not.toHaveBeenCalled();
      const logArg = traceFn.mock.calls[0][0] as Record<string, unknown>;
      expect(logArg.toolName).toBe("logged_tool");
      expect(logArg.provider).toBe("anthropic");
      expect(logArg.stripped).toEqual(expect.arrayContaining(["format", "minLength"]));
    });

    it("does not call logger.trace when no keywords are stripped", () => {
      const traceFn = vi.fn();
      const mockLogger = {
        trace: traceFn,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ComisLogger;
      setToolNormalizationLogger(mockLogger);

      const tool = makeTool("clean_tool", {
        type: "object",
        properties: {
          x: { type: "string" },
        },
      });

      normalizeToolSchemasForProvider([tool], {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      expect(traceFn).not.toHaveBeenCalled();
    });
  });

  describe("GBNF profile (Layer 3.5) — local providers", () => {
    // These tests drive the FULL public pipeline (never the transform fn in
    // isolation — that is clean-for-gbnf.test.ts's job). They pin the GATE:
    // the early-return at the no-provider-cleaning branch must learn the gbnf
    // profile or local providers silently skip the layer (RESEARCH Pitfall 3).
    const gbnfCtx: ToolNormalizationContext = {
      provider: "my-ollama",
      modelId: "qwen3.6:35b",
      compat: { toolSchemaProfile: "gbnf" },
    };

    it("applies all four gbnf transforms through the public pipeline for a gbnf-profile provider", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        gbnfCtx,
      );

      expect(result[0].parameters).toEqual({
        type: "object",
        properties: {
          // pattern/format survive — the proactive profile never strips them
          due: { type: "string", pattern: "\\d{4}-\\d{2}-\\d{2}", format: "date" },
          // nullable anyOf collapsed to the non-null branch + guarded hint
          assignee: { type: "string", description: "who (nullable)" },
          // ["integer","null"] type array collapsed to the scalar type
          retries: { type: "integer", description: "(nullable)" },
          // free-form object gains an explicit empty properties map
          metadata: { type: "object", properties: {} },
          // bare description-only node gains an inferred type
          note: { description: "Value for add/replace/test operations", type: "string" },
          // nullable oneOf collapsed, enum branch preserved
          mode: { type: "string", enum: ["a", "b"], description: "(nullable)" },
        },
        required: ["due"],
      });
    });

    it("preserves pattern and format under the proactive gbnf profile (reactive strip is GBNF-02)", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        gbnfCtx,
      );

      const schema = result[0].parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.due.pattern).toBe("\\d{4}-\\d{2}-\\d{2}");
      expect(props.due.format).toBe("date");
    });

    it("re-running the pipeline on its own output is byte-identical (pipeline-level idempotency)", () => {
      const first = normalizeToolSchemasForProvider(
        asToolDefs(hostileMcpToolset),
        gbnfCtx,
      );
      const second = normalizeToolSchemasForProvider(first, gbnfCtx);

      // Byte-identity (not just deep-equality) pins key-order stability too —
      // schema snapshots/caches can re-feed normalized schemas through the
      // pipeline, so twice MUST equal once at the pipeline level (L0/L4
      // interplay included).
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it("does not mutate the input toolset: deep-equals its pre-call JSON snapshot", () => {
      const inputTools = asToolDefs(hostileMcpToolset);
      const snapshot = JSON.stringify(inputTools);

      normalizeToolSchemasForProvider(inputTools, gbnfCtx);

      expect(JSON.stringify(inputTools)).toBe(snapshot);
    });

    it("forces top-level type object when a gbnf-profile schema lacks one (Layer 4 still applies)", () => {
      const tool = makeTool("gbnf_missing_top_type", {
        properties: { x: { type: "string" } },
      });

      const result = normalizeToolSchemasForProvider([tool], gbnfCtx);

      expect((result[0].parameters as Record<string, unknown>).type).toBe("object");
    });

    // CR-01 (175-REVIEW): Layer 3.5 runs BEFORE Layer 4, and T4 infers
    // "string" for a typeless top level with no properties/required/
    // additionalProperties/items — `parameters: {}` (a real no-arg-tool shape
    // from sloppy MCP servers) and `parameters: {description}` became
    // top-level {"type":"string"}, making llama.cpp compile the whole
    // arguments payload as a JSON string. Layer 4 then no-ops because a type
    // is present. Every other provider path produces type "object" for the
    // same input — these pins force the gbnf path onto the same contract.
    it("CR-01: a bare no-arg top-level schema ({}) becomes type object under the gbnf profile — never type string", () => {
      const tool = makeTool("noarg_bare", {});

      const result = normalizeToolSchemasForProvider([tool], gbnfCtx);

      expect(result[0].parameters).toEqual({ type: "object", properties: {} });
    });

    it("CR-01: a description-only top-level schema becomes type object under the gbnf profile, matching the no-compat path's contract", () => {
      const descOnly = { description: "No-arg tool from a sloppy MCP server" };
      const gbnfResult = normalizeToolSchemasForProvider(
        [makeTool("noarg_desc_only", { ...descOnly })],
        gbnfCtx,
      );
      const noCompatResult = normalizeToolSchemasForProvider(
        [makeTool("noarg_desc_only", { ...descOnly })],
        { provider: "my-ollama", modelId: "qwen3.6:35b" },
      );

      const gbnfParams = gbnfResult[0].parameters as Record<string, unknown>;
      expect(gbnfParams.type).toBe("object");
      // The no-compat path (early-return L0+L4) yields type "object" for the
      // same input — the gbnf profile must agree on the top-level contract.
      expect((noCompatResult[0].parameters as Record<string, unknown>).type).toBe("object");
      expect(gbnfParams.description).toBe(descOnly.description);
    });

    it("CR-01: typeless top-level normalization stays idempotent under the gbnf profile (twice = once, byte-identical)", () => {
      const tools = [
        makeTool("noarg_bare", {}),
        makeTool("noarg_desc_only", { description: "No-arg tool" }),
      ];

      const first = normalizeToolSchemasForProvider(tools, gbnfCtx);
      const second = normalizeToolSchemasForProvider(first, gbnfCtx);

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
  });

  describe("I3 — non-local providers byte-identical (expected literals)", () => {
    // Expected literals derived by running the PRE-PATCH pipeline (base
    // efd87538, before the gbnf layer existed) once per provider on
    // hostileMcpTool and inlining the output verbatim. NEVER compare the
    // pipeline to itself in these assertions — self-comparison pins can't
    // fail (RESEARCH Pitfall 7). These four pins must pass pre- AND
    // post-patch: the gbnf layer must not perturb any non-gbnf provider.

    it("anthropic: hostile fixture normalizes to the pinned pre-phase literal (keyword strip + L0 + L4)", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      );

      expect(result[0].parameters).toEqual({
        type: "object",
        properties: {
          // anthropic PROVIDER_UNSUPPORTED_KEYWORDS strips pattern + format
          due: { type: "string" },
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], description: "who" },
          retries: { type: ["integer", "null"] },
          metadata: { type: "object" },
          note: { description: "Value for add/replace/test operations" },
          mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        },
        required: ["due"],
      });
    });

    it("openai: hostile fixture normalizes to the pinned pre-phase literal (L0 + L4 only)", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        { provider: "openai", modelId: "gpt-4o" },
      );

      expect(result[0].parameters).toEqual({
        type: "object",
        properties: {
          due: { type: "string", pattern: "\\d{4}-\\d{2}-\\d{2}", format: "date" },
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], description: "who" },
          retries: { type: ["integer", "null"] },
          metadata: { type: "object" },
          note: { description: "Value for add/replace/test operations" },
          mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        },
        required: ["due"],
      });
    });

    it("google: hostile fixture normalizes to the pinned pre-phase literal (gemini cleaning + keyword strip + L0 + L4)", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        { provider: "google", modelId: "gemini-2.0-flash" },
      );

      // Coincides with the anthropic literal for THIS fixture: the google
      // keyword set also strips pattern/format, and the gemini deep-clean has
      // nothing to remove here (no $ref/$defs/additionalProperties present).
      expect(result[0].parameters).toEqual({
        type: "object",
        properties: {
          due: { type: "string" },
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], description: "who" },
          retries: { type: ["integer", "null"] },
          metadata: { type: "object" },
          note: { description: "Value for add/replace/test operations" },
          mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        },
        required: ["due"],
      });
    });

    it("my-ollama without gbnf compat: pinned L0+L4-only literal proves no name sniffing (D-08)", () => {
      const result = normalizeToolSchemasForProvider(
        asToolDefs([hostileMcpTool]),
        { provider: "my-ollama", modelId: "qwen3.6:35b" },
      );

      // No compat → the gbnf layer must NEVER apply, regardless of the
      // ollama-ish provider name: the gate derives solely from
      // compat.toolSchemaProfile (D-08: no baseUrl/name sniffing).
      expect(result[0].parameters).toEqual({
        type: "object",
        properties: {
          due: { type: "string", pattern: "\\d{4}-\\d{2}-\\d{2}", format: "date" },
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], description: "who" },
          retries: { type: ["integer", "null"] },
          metadata: { type: "object" },
          note: { description: "Value for add/replace/test operations" },
          mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        },
        required: ["due"],
      });
    });
  });

  describe("GBNF once-per-boot INFO summary (GBNF-03)", () => {
    beforeEach(() => {
      // The latch is module-level state — reset it alongside the logger
      // (top-level beforeEach) so each test starts from a fresh boot.
      resetGbnfBootSummary();
    });

    function makeMockLogger(): {
      logger: ComisLogger;
      infoFn: ReturnType<typeof vi.fn>;
      traceFn: ReturnType<typeof vi.fn>;
    } {
      const infoFn = vi.fn();
      const traceFn = vi.fn();
      const logger = {
        trace: traceFn,
        debug: vi.fn(),
        info: infoFn,
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ComisLogger;
      return { logger, infoFn, traceFn };
    }

    const gbnfCtxFor = (provider: string): ToolNormalizationContext => ({
      provider,
      modelId: "qwen3.6:35b",
      compat: { toolSchemaProfile: "gbnf" },
    });

    it("emits exactly one INFO summary {provider, toolCount, transformedTools, keywords} on the first transforming call", () => {
      const { logger, infoFn } = makeMockLogger();
      setToolNormalizationLogger(logger);

      normalizeToolSchemasForProvider(
        asToolDefs(hostileMcpToolset),
        gbnfCtxFor("my-ollama"),
      );

      expect(infoFn).toHaveBeenCalledOnce();
      const [logArg, message] = infoFn.mock.calls[0] as [
        Record<string, unknown>,
        string,
      ];
      expect(message).toBe("GBNF tool-schema transforms applied for local provider");
      // EXACTLY these four fields — nothing else rides on the summary line.
      expect(Object.keys(logArg).sort()).toEqual([
        "keywords",
        "provider",
        "toolCount",
        "transformedTools",
      ]);
      expect(logArg.provider).toBe("my-ollama");
      // schedule_task + nested_hostility transformed; well_formed untouched.
      expect(logArg.toolCount).toBe(2);
      expect(logArg.transformedTools).toEqual(["schedule_task", "nested_hostility"]);
      // Deduplicated union of the closed 4-token transform vocabulary.
      expect(logArg.keywords).toEqual([
        "nullable_union",
        "type_array",
        "free_form_object",
        "missing_type",
      ]);
    });

    it("emits no second INFO for the same provider (per-boot latch) while per-tool trace still fires", () => {
      const { logger, infoFn, traceFn } = makeMockLogger();
      setToolNormalizationLogger(logger);
      const ctx = gbnfCtxFor("my-ollama");

      normalizeToolSchemasForProvider(asToolDefs(hostileMcpToolset), ctx);
      normalizeToolSchemasForProvider(asToolDefs(hostileMcpToolset), ctx);

      // Latched: exactly ONE info across both calls.
      expect(infoFn).toHaveBeenCalledOnce();
      // Per-tool detail keeps firing at trace on every call (2 transformed
      // tools x 2 calls).
      expect(traceFn).toHaveBeenCalledTimes(4);
    });

    it("emits its own single INFO per provider: the latch is keyed per provider, not global", () => {
      const { logger, infoFn } = makeMockLogger();
      setToolNormalizationLogger(logger);

      normalizeToolSchemasForProvider(
        asToolDefs(hostileMcpToolset),
        gbnfCtxFor("my-ollama"),
      );
      normalizeToolSchemasForProvider(
        asToolDefs(hostileMcpToolset),
        gbnfCtxFor("my-lmstudio"),
      );

      expect(infoFn).toHaveBeenCalledTimes(2);
      const providers = infoFn.mock.calls.map(
        (call) => (call[0] as Record<string, unknown>).provider,
      );
      expect(providers).toEqual(["my-ollama", "my-lmstudio"]);
    });

    it("keeps the INFO content-free: no schema-structure substrings leak into the log fields (I7)", () => {
      const { logger, infoFn } = makeMockLogger();
      setToolNormalizationLogger(logger);

      normalizeToolSchemasForProvider(
        asToolDefs(hostileMcpToolset),
        gbnfCtxFor("my-ollama"),
      );

      expect(infoFn).toHaveBeenCalledOnce();
      // Schema bodies and schema keywords-as-structure must never leak —
      // only the 4-token transform vocabulary + registry tool names.
      const serialized = JSON.stringify(infoFn.mock.calls[0][0]);
      expect(serialized).not.toContain("properties");
      expect(serialized).not.toContain("anyOf");
      expect(serialized).not.toContain("pattern");
    });

    it("emits no INFO when the gbnf profile applies zero transforms (well-formed toolset)", () => {
      const { logger, infoFn } = makeMockLogger();
      setToolNormalizationLogger(logger);

      normalizeToolSchemasForProvider(
        asToolDefs([wellFormedTool]),
        gbnfCtxFor("my-ollama"),
      );

      expect(infoFn).not.toHaveBeenCalled();
    });
  });
});
