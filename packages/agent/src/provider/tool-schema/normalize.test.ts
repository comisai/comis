// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeToolSchemasForProvider,
  setToolNormalizationLogger,
} from "./normalize.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ComisLogger } from "@comis/infra";

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

  describe("Debug logging", () => {
    it("calls logger.debug when keywords are stripped", () => {
      const debugFn = vi.fn();
      const mockLogger = {
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

      expect(debugFn).toHaveBeenCalledOnce();
      const logArg = debugFn.mock.calls[0][0] as Record<string, unknown>;
      expect(logArg.toolName).toBe("logged_tool");
      expect(logArg.provider).toBe("anthropic");
      expect(logArg.stripped).toEqual(expect.arrayContaining(["format", "minLength"]));
    });

    it("does not call logger.debug when no keywords are stripped", () => {
      const debugFn = vi.fn();
      const mockLogger = {
        debug: debugFn,
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

      expect(debugFn).not.toHaveBeenCalled();
    });
  });
});
