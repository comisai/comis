// SPDX-License-Identifier: Apache-2.0
/**
 * Test fixture module — hostile MCP-shaped tool schemas synthesized from live
 * failures: ollama#10164, llama.cpp#19716/#17574/#22314. Imported by test
 * suites only; no runtime consumer.
 *
 * Deliberately NOT exported from any barrel/index.ts — test suites import it
 * via relative path (clean-for-gbnf, normalize, and executor retry tests share
 * this single fixture set so the hostile constructs stay in one place).
 *
 * @module
 */

/**
 * Minimal structural tool shape (name/description/parameters) — compatible
 * with the SDK `ToolDefinition` fields the schema cleaners read. Inert data:
 * no `execute`, no runtime behavior.
 */
export interface HostileMcpTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * One tool covering all four proactive gbnf transform classes plus the
 * reactive strip targets (`pattern`/`format` — which the PROACTIVE gbnf
 * profile must NOT touch):
 *
 * - `due`      — unanchored `pattern` with PCRE `\d` shorthand + `format`
 *                (llama.cpp #22314 grammar-parse class; survives the proactive profile)
 * - `assignee` — nullable `anyOf` + node-level description (Ollama Go-side
 *                strictness; collapse target)
 * - `retries`  — `["integer", "null"]` type array (ollama#10164 family)
 * - `metadata` — free-form object (no `properties`, no `additionalProperties`)
 * - `note`     — bare node, description only (llama.cpp #19716
 *                "Unrecognized schema" top-killer)
 * - `mode`     — nullable `oneOf` with an enum branch (ollama#13967 class)
 */
export const hostileMcpTool: HostileMcpTool = {
  name: "schedule_task",
  description: "MCP-shaped hostile fixture",
  parameters: {
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
  },
};

/**
 * Nested hostility — a nullable union inside `items` of an array property AND
 * inside an `allOf` entry's nested property. Proves the cleaner recurses
 * through `properties`/`items`/`allOf`, not just top-level property nodes.
 */
export const nestedHostilityTool: HostileMcpTool = {
  name: "nested_hostility",
  description: "Nullable unions nested inside items and allOf entries",
  parameters: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "null" }], description: "tag" },
      },
      combo: {
        allOf: [
          {
            type: "object",
            properties: {
              deep: { oneOf: [{ type: "number" }, { type: "null" }] },
            },
          },
        ],
      },
    },
    required: [],
  },
};

/**
 * Fully well-formed control tool — must pass through the gbnf profile
 * deep-equal unchanged with zero transforms reported. Note `minimum`/`maximum`
 * are present on purpose: gbnf is a structural rewrite, NOT a keyword strip.
 */
export const wellFormedTool: HostileMcpTool = {
  name: "well_formed",
  description: "Fully well-formed control tool (pass-through)",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
      days: { type: "integer", minimum: 1, maximum: 14 },
    },
    required: ["city"],
  },
};

/**
 * The shared hostile toolset: one all-transforms tool, one nested-hostility
 * tool (recursion proof), one well-formed tool (pass-through proof).
 */
export const hostileMcpToolset: readonly HostileMcpTool[] = [
  hostileMcpTool,
  nestedHostilityTool,
  wellFormedTool,
];
