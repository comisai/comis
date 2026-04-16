/**
 * Tool schema safety: provider-specific normalization and description pruning
 * for tool JSON schemas.
 *
 * Combines schema normalization (stripping unsupported keywords per provider)
 * with schema pruning (removing optional parameter descriptions to save tokens).
 *
 * @module
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";

// --- Schema normalization (formerly schema-normalizer.ts) ---

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Known LLM provider names. Accepts any string for forward-compatibility. */
export type ProviderName = "anthropic" | "openai" | "google" | "openrouter" | string;

/** Result of normalizing a single schema. */
export interface NormalizedSchema {
  schema: Record<string, unknown>;
  strippedKeywords: string[];
}

// ---------------------------------------------------------------------------
// Provider keyword maps
// ---------------------------------------------------------------------------

/**
 * Map of provider -> set of unsupported JSON Schema keywords to strip.
 * OpenAI is not listed because it supports the standard keywords.
 * OpenRouter passes through to the underlying provider.
 */
export const PROVIDER_UNSUPPORTED_KEYWORDS: Record<string, Set<string>> = {
  anthropic: new Set([
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "patternProperties",
    "additionalItems",
  ]),
  google: new Set([
    "additionalProperties",
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]),
};

// ---------------------------------------------------------------------------
// Schema walking (normalization)
// ---------------------------------------------------------------------------

/** Keys that contain nested schema objects to recurse into. */
const NESTED_SCHEMA_KEYS = new Set([
  "properties",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
]);

/**
 * Deep-walk a schema node and strip unsupported keywords.
 * Mutates the clone in-place and collects stripped keyword names.
 */
function walkAndStrip(
  node: Record<string, unknown>,
  unsupported: Set<string>,
  stripped: Set<string>,
): void {
  // Strip unsupported keywords at this level
  for (const key of Object.keys(node)) {
    if (unsupported.has(key)) {
      stripped.add(key);
      delete node[key];
    }
  }

  // Recurse into nested schema structures
  for (const key of NESTED_SCHEMA_KEYS) {
    const value = node[key];
    if (value === undefined || value === null) continue;

    // Skip $ref -- don't walk into references
    if (key === "$ref") continue;

    if (key === "properties" && typeof value === "object" && !Array.isArray(value)) {
      // properties: { propName: schemaObject, ... }
      for (const propSchema of Object.values(value as Record<string, unknown>)) {
        if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
          walkAndStrip(propSchema as Record<string, unknown>, unsupported, stripped);
        }
      }
    } else if (Array.isArray(value)) {
      // allOf, anyOf, oneOf: array of schema objects
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          walkAndStrip(item as Record<string, unknown>, unsupported, stripped);
        }
      }
    } else if (typeof value === "object") {
      // items, not, if, then, else, additionalProperties: single schema object
      walkAndStrip(value as Record<string, unknown>, unsupported, stripped);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API (normalization)
// ---------------------------------------------------------------------------

/**
 * Deep-clone a JSON Schema and strip unsupported keywords for the given provider.
 *
 * If the provider has no entry in PROVIDER_UNSUPPORTED_KEYWORDS, returns the
 * schema unchanged (still cloned to prevent mutation).
 *
 * @param schema - The JSON Schema to normalize
 * @param provider - Target LLM provider name
 * @returns Normalized schema with list of stripped keywords
 */
export function normalizeToolSchema(
  schema: Record<string, unknown>,
  provider: ProviderName,
): NormalizedSchema {
  const cloned = structuredClone(schema);
  const unsupported = PROVIDER_UNSUPPORTED_KEYWORDS[provider];

  if (!unsupported || unsupported.size === 0) {
    return { schema: cloned, strippedKeywords: [] };
  }

  const stripped = new Set<string>();
  walkAndStrip(cloned, unsupported, stripped);

  return { schema: cloned, strippedKeywords: [...stripped].sort() };
}

/**
 * Normalize all tool definition schemas for a provider.
 *
 * @deprecated Use `normalizeToolSchemasForProvider()` from `provider/tool-schema/normalize.ts` instead.
 * This function only applies Layer 1 (keyword stripping). The new pipeline applies all 4 layers
 * (keyword stripping, Gemini cleaning, xAI stripping, OpenAI type forcing).
 *
 * @param tools - Array of tool definitions with optional inputSchema
 * @param provider - Target LLM provider name
 * @returns Normalized tool definitions with per-tool stripped keyword lists
 */
export function normalizeToolSchemas(
  tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>,
  provider: ProviderName,
): Array<{ name: string; inputSchema?: Record<string, unknown>; strippedKeywords: string[] }> {
  return tools.map((tool) => {
    if (!tool.inputSchema) {
      return { name: tool.name, inputSchema: undefined, strippedKeywords: [] };
    }

    const { schema, strippedKeywords } = normalizeToolSchema(tool.inputSchema, provider);
    return { name: tool.name, inputSchema: schema, strippedKeywords };
  });
}

// --- Schema pruning (formerly schema-pruning.ts) ---

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of pruning descriptions from a single schema. */
export interface PruneResult {
  schema: Record<string, unknown>;
  removedCount: number;
}

/** Result of pruning descriptions from an array of tool definitions. */
export interface PruneToolsResult {
  tools: ToolDefinition[];
  totalRemoved: number;
  estimatedTokensSaved: number;
}

// ---------------------------------------------------------------------------
// Schema walking (pruning)
// ---------------------------------------------------------------------------

/**
 * Walk a schema node and strip descriptions from optional parameters.
 * Mutates the clone in-place. Returns the count of removed descriptions
 * and the total character length of removed description strings.
 */
function walkAndPrune(
  node: Record<string, unknown>,
  requiredSet: Set<string>,
): { removed: number; charsRemoved: number } {
  let removed = 0;
  let charsRemoved = 0;

  const properties = node.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties || typeof properties !== "object") {
    return { removed, charsRemoved };
  }

  for (const [propName, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== "object") continue;

    if (!requiredSet.has(propName) && "description" in propSchema) {
      const desc = propSchema.description;
      if (typeof desc === "string") {
        charsRemoved += desc.length;
      }
      delete propSchema.description;
      removed++;
    }

    // Recurse into nested object properties
    if (
      propSchema.type === "object" &&
      propSchema.properties &&
      typeof propSchema.properties === "object"
    ) {
      const innerRequired = Array.isArray(propSchema.required)
        ? new Set(propSchema.required as string[])
        : new Set<string>();
      const inner = walkAndPrune(
        propSchema as Record<string, unknown>,
        innerRequired,
      );
      removed += inner.removed;
      charsRemoved += inner.charsRemoved;
    }
  }

  return { removed, charsRemoved };
}

// ---------------------------------------------------------------------------
// Public API (pruning)
// ---------------------------------------------------------------------------

/**
 * Deep-clone a JSON Schema and strip descriptions from optional parameters.
 *
 * Required parameters (listed in the schema's `required` array) retain
 * their descriptions unconditionally. Parameters not in `required` have
 * their `description` field removed.
 *
 * CRITICAL: Uses structuredClone to avoid mutating shared TypeBox TSchema
 * objects that may be referenced across sessions.
 *
 * @param schema - The JSON Schema to prune
 * @returns Pruned schema with removal count
 */
export function pruneSchemaDescriptions(
  schema: Record<string, unknown>,
): PruneResult {
  const cloned = structuredClone(schema);
  const requiredSet = Array.isArray(cloned.required)
    ? new Set(cloned.required as string[])
    : new Set<string>();

  const { removed } = walkAndPrune(cloned, requiredSet);

  return { schema: cloned, removedCount: removed };
}

/**
 * Prune optional parameter descriptions from an array of tool definitions.
 *
 * Tools whose name is in `excludeNames` are passed through unmodified
 * (default: browser tool excluded since it needs full descriptions).
 *
 * @param tools - Array of tool definitions to prune
 * @param excludeNames - Tool names to skip (default: `new Set(["browser"])`)
 * @returns Pruned tools with total removal count and estimated token savings
 */
export function pruneToolSchemas(
  tools: ToolDefinition[],
  excludeNames: Set<string> = new Set(["browser"]),
): PruneToolsResult {
  let totalRemoved = 0;
  let totalCharsRemoved = 0;

  const prunedTools = tools.map((tool) => {
    if (excludeNames.has(tool.name)) {
      return tool;
    }

    const schema = tool.parameters as Record<string, unknown>;
    const cloned = structuredClone(schema);
    const requiredSet = Array.isArray(cloned.required)
      ? new Set(cloned.required as string[])
      : new Set<string>();

    const { removed, charsRemoved } = walkAndPrune(cloned, requiredSet);
    totalRemoved += removed;
    totalCharsRemoved += charsRemoved;

    return { ...tool, parameters: cloned } as ToolDefinition;
  });

  const estimatedTokensSaved = Math.ceil(
    totalCharsRemoved / CHARS_PER_TOKEN_RATIO,
  );

  return {
    tools: prunedTools,
    totalRemoved,
    estimatedTokensSaved,
  };
}
