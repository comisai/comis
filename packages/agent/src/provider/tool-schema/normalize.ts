// SPDX-License-Identifier: Apache-2.0
/**
 * Per-provider tool schema normalization pipeline.
 *
 * Layered architecture applied sequentially per tool:
 *   0.   Universal anyOf/const-to-enum normalization (all providers)
 *   1.   Provider keyword stripping (reuses existing schema-normalizer.ts)
 *   2.   Gemini-specific deep cleaning ($ref, $defs, $schema, if/then/else, etc.)
 *   3.   xAI constraint stripping (minLength, maxLength, minimum, maximum, etc.)
 *   3.5. GBNF structural transforms for llama.cpp-family local providers
 *        (gated on compat.toolSchemaProfile === "gbnf"; removal/relaxation only)
 *   4.   OpenAI top-level type: "object" forcing (universal)
 *
 * Entry point: `normalizeToolSchemasForProvider(tools, ctx)` accepts
 * `ToolDefinition[]` and returns normalized `ToolDefinition[]` (new objects,
 * no mutation).
 *
 * @module
 */

import type { ModelCompatConfig } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  normalizeToolSchema as stripProviderKeywords,
  PROVIDER_UNSUPPORTED_KEYWORDS,
} from "../../safety/tool-schema-safety.js";
import { resolveProviderCapabilities } from "../capabilities.js";
import {
  cleanSchemaForGbnf,
  MAX_GBNF_WALK_DEPTH,
  type GbnfTransformKeyword,
} from "./clean-for-gbnf.js";
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

/**
 * Once-per-boot-per-provider INFO latch (GBNF-03). A boot-time SNAPSHOT
 * summary, not a recurring event: the daemon process IS the boot, so a
 * module-level latch gives once-per-boot semantics with zero new wiring
 * (the logger is latched at boot via setToolNormalizationLogger, wired in
 * setup-agents-registry.ts). Counts + names only — never schema bodies
 * (I7). Per-turn detail stays at trace.
 */
const gbnfSummaryLoggedForProvider = new Set<string>();

/**
 * Test-only reset for the module-level gbnf boot-summary latch — without it,
 * test order breaks (same rationale as the logger reset in the test suite's
 * beforeEach).
 */
export function resetGbnfBootSummaryForTest(): void {
  gbnfSummaryLoggedForProvider.clear();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context for tool schema normalization. */
export interface ToolNormalizationContext {
  provider: string;
  modelId: string;
  compat?: ModelCompatConfig;
  /**
   * AUTHOR-03 (best-effort, Phase 174-05): when true, the raw pipeline tool
   * schema receives the GBNF Layer 3.5 structural transform to harden the raw
   * escape hatch on GBNF-eligible (local/default-family) providers EVEN WHEN
   * they are not pinned to the explicit `compat.toolSchemaProfile === "gbnf"`
   * profile. Default/absent = false = unchanged behavior (the transform is
   * driven solely by the gbnf profile). Removal/relaxation only — never widens
   * field VALUE validation (the daemon driver Zod is the single source of
   * truth). Gated D-08-strict: it never engages GBNF on a cloud-family provider
   * (anthropic/google/xai) by name. Threaded from
   * `config.orchestration.authoring.gbnfConstrain` at the call site.
   */
  gbnfConstrain?: boolean;
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
 * Applies up to 6 layers based on provider family and compat config:
 *   - Layer 0: Convert anyOf/const patterns to enum arrays (all providers)
 *   - Layer 1: Strip provider-specific unsupported keywords (anthropic, google)
 *   - Layer 2: Gemini deep cleaning (google family only)
 *   - Layer 3: xAI constraint stripping (toolSchemaProfile === "xai")
 *   - Layer 3.5: GBNF structural transforms (toolSchemaProfile === "gbnf" --
 *     llama.cpp-family local providers; removal/relaxation only)
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
  // GBNF gate derives SOLELY from the explicit compat profile — never from
  // the provider name or baseUrl (D-08). The gbnfConstrain authoring gate
  // arrives SEPARATELY in ctx.gbnfConstrain (threaded from
  // config.orchestration.authoring.gbnfConstrain at the executor call site,
  // CR-01); this pipeline only honors what arrives in ctx.
  const isGbnf = ctx.compat?.toolSchemaProfile === "gbnf";
  const providerLower = ctx.provider.toLowerCase();

  // Determine keyword stripping: exact match first, then Gemini family fallback
  const exactSet = PROVIDER_UNSUPPORTED_KEYWORDS[providerLower];
  const hasKeywordStripping = exactSet
    ? exactSet
    : (isGemini ? PROVIDER_UNSUPPORTED_KEYWORDS["google"] : undefined);
  const keywordStripProvider = exactSet
    ? providerLower
    : (isGemini ? "google" : providerLower);

  // AUTHOR-03 (174-05): the gbnfConstrain authoring gate. GBNF-eligible providers
  // are the local/default family — EXACTLY the set the early-return below treats
  // as "no cleaning needed" (no keyword set, not gemini, not xai). When the
  // operator flips `config.orchestration.authoring.gbnfConstrain` on, Layer 3.5
  // engages for these providers to harden the raw pipeline escape hatch even
  // when they are not pinned to the explicit gbnf profile. Gated D-08-strict:
  // gbnfEligible EXCLUDES cloud families (anthropic/google/xai), so the flag
  // never infers GBNF from a cloud provider name. `applyGbnf` (NOT `isGbnf`)
  // drives every Layer 3.5 site below.
  const gbnfEligible = !isGemini && !isXai && !hasKeywordStripping;
  const applyGbnf = isGbnf || ((ctx.gbnfConstrain ?? false) && gbnfEligible);

  // Early return: if no provider-specific cleaning needed, just apply Layer 4.
  // `!applyGbnf` is load-bearing: local providers (no keyword set, not gemini,
  // not xai) are EXACTLY the providers the gbnf layer exists for — without it
  // they short-circuit here and silently skip Layer 3.5. FLAGS-OFF
  // (gbnfConstrain falsy) ⇒ applyGbnf === isGbnf ⇒ this condition is unchanged.
  if (!isGemini && !isXai && !applyGbnf && !hasKeywordStripping) {
    return ensureTopLevelObject(tools);
  }

  // (tool name, transform keywords) pairs collected during the Layer 3.5
  // map pass — consumed by the once-per-boot INFO summary below.
  const gbnfTransformedTools: Array<{
    name: string;
    keywords: GbnfTransformKeyword[];
  }> = [];

  const normalized = tools.map((tool) => {
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
        // Fix B (log-review): demoted debug → trace. Fires per tool per
        // request — dominated debug-mode logs at one-per-tool-per-turn
        // cadence (~30 lines/turn on agents with 30+ tools registered).
        // The stripped-keyword set is deterministic per (provider, tool)
        // pair; if an operator needs the detail, trace recovers it.
        logger?.trace(
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

    // Layer 3.5: GBNF structural transforms for llama.cpp-family local
    // providers (removal/relaxation only — pattern/format deliberately
    // survive; reactive stripping on grammar-400 lives in the executor,
    // GBNF-02). `applyGbnf` = the gbnf profile OR the gbnfConstrain authoring
    // gate on a gbnf-eligible provider (174-05); FLAGS-OFF ⇒ === isGbnf.
    if (applyGbnf) {
      // CR-01 (175-REVIEW): force the Layer-4 top-level object contract
      // BEFORE the gbnf transforms. T4 (missing-type injection) fires on
      // typeless nodes and infers "string" for a bare/description-only TOP
      // LEVEL (`parameters: {}` — a real no-arg-tool shape from sloppy MCP
      // servers); Layer 4 below then no-ops because a type is present,
      // shipping a top-level {"type":"string"} arguments payload only on
      // gbnf providers. Pre-forcing is idempotent ({} → {type:"object"} →
      // T3 adds properties:{}) and byte-stable on re-runs.
      schema = ensureTopLevelObjectSingle(schema);
      const gbnfResult = cleanSchemaForGbnf(schema);
      schema = gbnfResult.schema;
      if (gbnfResult.depthLimited) {
        // WR-03 fail-safe surfaced: subtrees beyond the walk's depth cap
        // passed through un-transformed (never a crash). Content-free per
        // I7 — tool name + cap only, no schema bodies.
        logger?.warn(
          {
            toolName: tool.name,
            provider: ctx.provider,
            maxWalkDepth: MAX_GBNF_WALK_DEPTH,
            hint: "Tool schema exceeds the gbnf transform depth cap; subtrees beyond the cap passed through un-transformed — inspect the MCP server emitting this tool",
            errorKind: "validation" as const,
          },
          "GBNF transform depth cap reached; deep subtrees passed through un-walked",
        );
      }
      if (gbnfResult.transformedKeywords.length > 0) {
        // Mirror the keyword-strip trace shape above: per-tool, trace level
        // (deterministic per (provider, tool) pair — trace recovers the
        // detail without dominating debug-mode logs).
        logger?.trace(
          {
            toolName: tool.name,
            provider: ctx.provider,
            transformed: gbnfResult.transformedKeywords,
          },
          "Tool schema structurally transformed for GBNF compatibility",
        );
        gbnfTransformedTools.push({
          name: tool.name,
          keywords: gbnfResult.transformedKeywords,
        });
      }
    }

    // Layer 4: OpenAI top-level type forcing
    schema = ensureTopLevelObjectSingle(schema);

    return { ...tool, parameters: schema } as ToolDefinition;
  });

  // Once-per-boot INFO summary (GBNF-03): the FIRST transforming call per
  // provider emits one content-free summary line (counts + names + the
  // closed transform vocabulary, never schema bodies — I7); subsequent
  // calls stay at the per-tool trace above.
  if (
    applyGbnf &&
    gbnfTransformedTools.length > 0 &&
    !gbnfSummaryLoggedForProvider.has(ctx.provider)
  ) {
    gbnfSummaryLoggedForProvider.add(ctx.provider);
    const keywords = [
      ...new Set(gbnfTransformedTools.flatMap((entry) => entry.keywords)),
    ];
    logger?.info(
      {
        provider: ctx.provider,
        toolCount: gbnfTransformedTools.length,
        transformedTools: gbnfTransformedTools.map((entry) => entry.name),
        keywords,
      },
      "GBNF tool-schema transforms applied for local provider",
    );
  }

  return normalized;
}
