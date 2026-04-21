// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  normalizeToolSchema,
  normalizeToolSchemas,
  PROVIDER_UNSUPPORTED_KEYWORDS,
  pruneSchemaDescriptions,
  pruneToolSchemas,
} from "./tool-schema-safety.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

describe("tool-schema-safety", () => {
  // ---------------------------------------------------------------------------
  // Schema normalization (formerly schema-normalizer.test.ts)
  // ---------------------------------------------------------------------------

  describe("schema normalization", () => {
    describe("PROVIDER_UNSUPPORTED_KEYWORDS", () => {
      it("has entries for anthropic and google", () => {
        expect(PROVIDER_UNSUPPORTED_KEYWORDS.anthropic.size).toBeGreaterThan(0);
        expect(PROVIDER_UNSUPPORTED_KEYWORDS.google.size).toBeGreaterThan(0);
      });

      it("openrouter has no entry (passthrough handled by normalizeToolSchema fallback)", () => {
        expect(PROVIDER_UNSUPPORTED_KEYWORDS.openrouter).toBeUndefined();
      });
    });

    describe("normalizeToolSchema", () => {
      it("strips unsupported keywords for anthropic", () => {
        const schema = {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
          },
          required: ["name"],
        };
        const result = normalizeToolSchema(schema, "anthropic");

        expect(result.schema.properties).toBeDefined();
        const nameSchema = (result.schema.properties as Record<string, Record<string, unknown>>).name;
        expect(nameSchema.type).toBe("string");
        expect(nameSchema.minLength).toBeUndefined();
        expect(nameSchema.maxLength).toBeUndefined();
        expect(nameSchema.pattern).toBeUndefined();
        expect(result.strippedKeywords).toContain("minLength");
        expect(result.strippedKeywords).toContain("maxLength");
        expect(result.strippedKeywords).toContain("pattern");
      });

      it("strips unsupported keywords for google", () => {
        const schema = {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "integer", minimum: 0, maximum: 100 },
          },
        };
        const result = normalizeToolSchema(schema, "google");

        expect(result.schema.additionalProperties).toBeUndefined();
        const countSchema = (result.schema.properties as Record<string, Record<string, unknown>>).count;
        expect(countSchema.minimum).toBeUndefined();
        expect(countSchema.maximum).toBeUndefined();
        expect(result.strippedKeywords).toContain("additionalProperties");
        expect(result.strippedKeywords).toContain("minimum");
        expect(result.strippedKeywords).toContain("maximum");
      });

      it("passes through unchanged for openrouter", () => {
        const schema = {
          type: "object",
          properties: { name: { type: "string", minLength: 1 } },
        };
        const result = normalizeToolSchema(schema, "openrouter");

        expect(result.strippedKeywords).toEqual([]);
        const nameSchema = (result.schema.properties as Record<string, Record<string, unknown>>).name;
        expect(nameSchema.minLength).toBe(1);
      });

      it("passes through unchanged for unknown providers", () => {
        const schema = {
          type: "object",
          properties: { x: { type: "number", minimum: 0 } },
        };
        const result = normalizeToolSchema(schema, "some-unknown-provider");

        expect(result.strippedKeywords).toEqual([]);
        const xSchema = (result.schema.properties as Record<string, Record<string, unknown>>).x;
        expect(xSchema.minimum).toBe(0);
      });

      it("does not mutate the original schema", () => {
        const schema = {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
          },
        };
        const originalStr = JSON.stringify(schema);
        normalizeToolSchema(schema, "anthropic");
        expect(JSON.stringify(schema)).toBe(originalStr);
      });

      it("handles deeply nested properties", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                nested: {
                  type: "object",
                  properties: {
                    value: { type: "string", pattern: "^[a-z]+$", format: "email" },
                  },
                },
              },
            },
          },
        };
        const result = normalizeToolSchema(schema, "anthropic");

        const deepValue = (
          (
            (result.schema.properties as Record<string, Record<string, unknown>>).config
              .properties as Record<string, Record<string, unknown>>
          ).nested.properties as Record<string, Record<string, unknown>>
        ).value;
        expect(deepValue.pattern).toBeUndefined();
        expect(deepValue.format).toBeUndefined();
        expect(deepValue.type).toBe("string");
        expect(result.strippedKeywords).toContain("pattern");
        expect(result.strippedKeywords).toContain("format");
      });

      it("handles allOf/anyOf/oneOf arrays", () => {
        const schema = {
          type: "object",
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "number", minimum: 0 },
          ],
        };
        const result = normalizeToolSchema(schema, "anthropic");

        const anyOf = result.schema.anyOf as Array<Record<string, unknown>>;
        expect(anyOf[0].minLength).toBeUndefined();
        expect(anyOf[1].minimum).toBeUndefined();
      });

      it("handles items schema (array items)", () => {
        const schema = {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 50 },
          minItems: 1,
          maxItems: 10,
        };
        const result = normalizeToolSchema(schema, "anthropic");

        expect((result.schema.items as Record<string, unknown>).minLength).toBeUndefined();
        expect((result.schema.items as Record<string, unknown>).maxLength).toBeUndefined();
        expect(result.schema.minItems).toBeUndefined();
        expect(result.schema.maxItems).toBeUndefined();
      });

      it("returns sorted strippedKeywords", () => {
        const schema = {
          type: "object",
          properties: {
            a: { type: "string", pattern: "x", minLength: 1, format: "uri" },
          },
        };
        const result = normalizeToolSchema(schema, "anthropic");
        const sorted = [...result.strippedKeywords].sort();
        expect(result.strippedKeywords).toEqual(sorted);
      });
    });

    describe("normalizeToolSchemas", () => {
      it("normalizes all tools in array", () => {
        const tools = [
          { name: "tool_a", inputSchema: { type: "object", properties: { x: { type: "string", minLength: 1 } } } },
          { name: "tool_b", inputSchema: { type: "object", properties: { y: { type: "number", minimum: 0 } } } },
        ];
        const result = normalizeToolSchemas(tools, "anthropic");

        expect(result).toHaveLength(2);
        expect(result[0].name).toBe("tool_a");
        expect(result[0].strippedKeywords).toContain("minLength");
        expect(result[1].name).toBe("tool_b");
        expect(result[1].strippedKeywords).toContain("minimum");
      });

      it("handles tools without inputSchema", () => {
        const tools = [{ name: "simple_tool" }];
        const result = normalizeToolSchemas(tools, "anthropic");

        expect(result[0].inputSchema).toBeUndefined();
        expect(result[0].strippedKeywords).toEqual([]);
      });

      it("preserves tool names", () => {
        const tools = [
          { name: "my_tool", inputSchema: { type: "object" } },
        ];
        const result = normalizeToolSchemas(tools, "anthropic");
        expect(result[0].name).toBe("my_tool");
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Schema pruning (formerly schema-pruning.test.ts)
  // ---------------------------------------------------------------------------

  describe("schema pruning", () => {
    /** Create a minimal ToolDefinition stub for testing. */
    function stubTool(
      name: string,
      schema: Record<string, unknown>,
    ): ToolDefinition {
      return {
        name,
        label: name,
        description: `Tool ${name}`,
        parameters: schema,
        execute: async () => ({ resultForAssistant: "" }),
      } as unknown as ToolDefinition;
    }

    describe("pruneSchemaDescriptions", () => {
      it("strips optional parameter descriptions", () => {
        const schema = {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            limit: { type: "number", description: "Max results to return" },
            offset: { type: "number", description: "Starting offset" },
            format: { type: "string", description: "Output format" },
            filter: { type: "string", description: "Filter expression" },
            verbose: { type: "boolean", description: "Enable verbose output" },
            timeout: { type: "number", description: "Timeout in ms" },
          },
          required: ["query", "limit", "offset"],
        };

        const result = pruneSchemaDescriptions(schema);

        // Required params retain descriptions
        const props = result.schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        expect(props.query.description).toBe("The search query");
        expect(props.limit.description).toBe("Max results to return");
        expect(props.offset.description).toBe("Starting offset");

        // Optional params have descriptions removed
        expect(props.format.description).toBeUndefined();
        expect(props.filter.description).toBeUndefined();
        expect(props.verbose.description).toBeUndefined();
        expect(props.timeout.description).toBeUndefined();

        expect(result.removedCount).toBe(4);
      });

      it("preserves required parameter descriptions unconditionally", () => {
        const schema = {
          type: "object",
          properties: {
            name: { type: "string", description: "User name" },
            email: { type: "string", description: "User email" },
            age: { type: "number", description: "User age" },
          },
          required: ["name", "email", "age"],
        };

        const result = pruneSchemaDescriptions(schema);

        const props = result.schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        expect(props.name.description).toBe("User name");
        expect(props.email.description).toBe("User email");
        expect(props.age.description).toBe("User age");

        expect(result.removedCount).toBe(0);
      });

      it("handles schema with no required array", () => {
        const schema = {
          type: "object",
          properties: {
            alpha: { type: "string", description: "Alpha param" },
            beta: { type: "number", description: "Beta param" },
          },
          // No required field -- all are optional by JSON Schema spec
        };

        const result = pruneSchemaDescriptions(schema);

        const props = result.schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        expect(props.alpha.description).toBeUndefined();
        expect(props.beta.description).toBeUndefined();

        expect(result.removedCount).toBe(2);
      });

      it("recurses into nested object properties", () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              description: "Configuration object",
              properties: {
                host: { type: "string", description: "Server host" },
                port: { type: "number", description: "Server port" },
                tls: { type: "boolean", description: "Enable TLS" },
              },
              required: ["host"],
            },
          },
          required: ["config"],
        };

        const result = pruneSchemaDescriptions(schema);

        const props = result.schema.properties as Record<string, Record<string, unknown>>;
        // Outer required param "config" retains its own description
        expect(props.config.description).toBe("Configuration object");

        // Inner properties: host is required, port and tls are optional
        const innerProps = (props.config as Record<string, unknown>)
          .properties as Record<string, Record<string, unknown>>;
        expect(innerProps.host.description).toBe("Server host");
        expect(innerProps.port.description).toBeUndefined();
        expect(innerProps.tls.description).toBeUndefined();

        expect(result.removedCount).toBe(2);
      });

      it("returns deep clone, does not mutate original", () => {
        const schema = {
          type: "object",
          properties: {
            name: { type: "string", description: "The name" },
            tag: { type: "string", description: "Optional tag" },
          },
          required: ["name"],
        };

        const originalJson = JSON.stringify(schema);
        pruneSchemaDescriptions(schema);

        // Original must be completely unchanged
        expect(JSON.stringify(schema)).toBe(originalJson);
      });

      it("handles empty properties object", () => {
        const schema = {
          type: "object",
          properties: {},
        };

        const result = pruneSchemaDescriptions(schema);

        expect(result.removedCount).toBe(0);
        expect(result.schema.properties).toEqual({});
      });
    });

    describe("pruneToolSchemas", () => {
      it("excludes browser tool by default", () => {
        const browserSchema = {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to navigate to" },
            action: { type: "string", description: "Browser action" },
          },
          required: ["url"],
        };
        const otherSchema = {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results" },
          },
          required: ["query"],
        };

        const tools = [
          stubTool("search", otherSchema),
          stubTool("browser", browserSchema),
          stubTool("fetch", otherSchema),
        ];

        const result = pruneToolSchemas(tools);

        // Browser tool should be unmodified
        const browserTool = result.tools.find((t) => t.name === "browser")!;
        const browserProps = (
          browserTool.parameters as Record<string, unknown>
        ).properties as Record<string, Record<string, unknown>>;
        expect(browserProps.action.description).toBe("Browser action");

        // Other tools should have optional descriptions pruned
        const searchTool = result.tools.find((t) => t.name === "search")!;
        const searchProps = (
          searchTool.parameters as Record<string, unknown>
        ).properties as Record<string, Record<string, unknown>>;
        expect(searchProps.query.description).toBe("Search query");
        expect(searchProps.limit.description).toBeUndefined();

        // totalRemoved: 2 tools x 1 optional each = 2
        expect(result.totalRemoved).toBe(2);
      });

      it("calculates estimatedTokensSaved", () => {
        // Create tool with known description lengths
        // "Max results" = 11 chars, "Output format" = 13 chars
        // Total chars removed = 11 + 13 = 24
        // estimatedTokensSaved = Math.ceil(24 / 4) = 6
        const schema = {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results" },
            format: { type: "string", description: "Output format" },
          },
          required: ["query"],
        };

        const tools = [stubTool("search", schema)];
        const result = pruneToolSchemas(tools);

        expect(result.totalRemoved).toBe(2);
        // "Max results" (11) + "Output format" (13) = 24 chars / 3.5 = 7 tokens
        expect(result.estimatedTokensSaved).toBe(Math.ceil(24 / 3.5));
      });

      it("respects custom excludeNames", () => {
        const schema = {
          type: "object",
          properties: {
            input: { type: "string", description: "Input data" },
            verbose: { type: "boolean", description: "Verbose mode" },
          },
          required: ["input"],
        };

        const tools = [
          stubTool("browser", schema),
          stubTool("special", schema),
          stubTool("normal", schema),
        ];

        // Exclude "special" instead of browser
        const result = pruneToolSchemas(tools, new Set(["special"]));

        // Browser is NOT excluded (custom set overrides default)
        const browserTool = result.tools.find((t) => t.name === "browser")!;
        const browserProps = (
          browserTool.parameters as Record<string, unknown>
        ).properties as Record<string, Record<string, unknown>>;
        expect(browserProps.verbose.description).toBeUndefined();

        // Special IS excluded
        const specialTool = result.tools.find((t) => t.name === "special")!;
        const specialProps = (
          specialTool.parameters as Record<string, unknown>
        ).properties as Record<string, Record<string, unknown>>;
        expect(specialProps.verbose.description).toBe("Verbose mode");

        expect(result.totalRemoved).toBe(2); // browser + normal, 1 each
      });
    });
  });
});
