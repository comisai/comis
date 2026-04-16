/**
 * Per-provider tool schema normalization pipeline.
 *
 * 5-layer architecture applied sequentially per tool:
 *   0. Universal anyOf/const-to-enum normalization (all providers)
 *   1. Provider keyword stripping (reuses existing schema-normalizer.ts)
 *   2. Gemini-specific deep cleaning ($ref, $defs, $schema, if/then/else, etc.)
 *   3. xAI constraint stripping (minLength, maxLength, minimum, maximum, etc.)
 *   4. OpenAI top-level type: "object" forcing (universal)
 *
 * Entry point: `normalizeToolSchemasForProvider(tools, ctx)` accepts
 * `ToolDefinition[]` and returns normalized `ToolDefinition[]` (new objects,
 * no mutation).
 *
 * @module
 */

import type { ModelCompatConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  normalizeToolSchema as stripProviderKeywords,
  PROVIDER_UNSUPPORTED_KEYWORDS,
} from "../../safety/tool-schema-safety.js";
import { resolveProviderCapabilities } from "../capabilities.js";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import { stripXaiUnsupportedKeywords } from "./clean-for-xai.js";
import { normalizeAnyOfToEnum } from "./normalize-enums.js";

// ---------------------------------------------------------------------------
// Module-level logger (set once during bootstrap)
// ---------------------------------------------------------------------------

let logger: ComisLogger | undefined;

/**
 * Set the module-level logger. Called once during daemon bootstrap,
 * same pattern as `setSanitizeLogger()` in sanitize-pipeline.ts.
 */
export function setToolNormalizationLogger(l: ComisLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context for tool schema normalization. */
export interface ToolNormalizationContext {
  provider: string;
  modelId: string;
  compat?: ModelCompatConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add `type: "object"` to a single schema's top level if missing.
 * Returns the schema unchanged if it already has a type or is not an object.
 */
function ensureTopLevelObjectSingle(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  const node = schema as Record<string, unknown>;
  if (node.type === undefined) {
    return { ...node, type: "object" };
  }
  return schema;
}

/**
 * Apply Layer 4 (top-level type forcing) to all tools.
 * Used on the early-return path when no provider-specific cleaning is needed.
 */
function ensureTopLevelObject(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") return tool;
    const schema = ensureTopLevelObjectSingle(tool.parameters);
    if (schema === tool.parameters) return tool;
    return { ...tool, parameters: schema } as ToolDefinition;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Normalize tool schemas for a specific provider.
 *
 * Applies up to 5 layers based on provider family and compat config:
 *   - Layer 0: Convert anyOf/const patterns to enum arrays (all providers)
 *   - Layer 1: Strip provider-specific unsupported keywords (anthropic, google)
 *   - Layer 2: Gemini deep cleaning (google family only)
 *   - Layer 3: xAI constraint stripping (toolSchemaProfile === "xai")
 *   - Layer 4: Force top-level `type: "object"` (all providers)
 *
 * Returns new ToolDefinition objects -- never mutates the input.
 */
export function normalizeToolSchemasForProvider(
  tools: ToolDefinition[],
  ctx: ToolNormalizationContext,
): ToolDefinition[] {
  // Layer 0 (universal): Convert anyOf/const patterns to enum arrays
  tools = tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") return tool;
    const normalized = normalizeAnyOfToEnum(tool.parameters);
    if (normalized === tool.parameters) return tool;
    return { ...tool, parameters: normalized } as ToolDefinition;
  });

  const caps = resolveProviderCapabilities(ctx.provider);
  const isGemini = caps.providerFamily === "google";
  const isXai = ctx.compat?.toolSchemaProfile === "xai";
  const providerLower = ctx.provider.toLowerCase();

  // Determine keyword stripping: exact match first, then Gemini family fallback
  const exactSet = PROVIDER_UNSUPPORTED_KEYWORDS[providerLower];
  const hasKeywordStripping = exactSet
    ? exactSet
    : (isGemini ? PROVIDER_UNSUPPORTED_KEYWORDS["google"] : undefined);
  const keywordStripProvider = exactSet
    ? providerLower
    : (isGemini ? "google" : providerLower);

  // Early return: if no provider-specific cleaning needed, just apply Layer 4
  if (!isGemini && !isXai && !hasKeywordStripping) {
    return ensureTopLevelObject(tools);
  }

  return tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") return tool;
    let schema: unknown = tool.parameters;

    // Layer 1: Provider keyword stripping
    if (hasKeywordStripping) {
      const result = stripProviderKeywords(
        schema as Record<string, unknown>,
        keywordStripProvider,
      );
      schema = result.schema;
      if (result.strippedKeywords.length > 0) {
        logger?.debug(
          {
            toolName: tool.name,
            provider: ctx.provider,
            stripped: result.strippedKeywords,
          },
          "Tool schema keywords stripped for provider compatibility",
        );
      }
    }

    // Layer 2: Gemini-specific deep cleaning
    if (isGemini) schema = cleanSchemaForGemini(schema);

    // Layer 3: xAI constraint stripping
    if (isXai) schema = stripXaiUnsupportedKeywords(schema);

    // Layer 4: OpenAI top-level type forcing
    schema = ensureTopLevelObjectSingle(schema);

    return { ...tool, parameters: schema } as ToolDefinition;
  });
}
