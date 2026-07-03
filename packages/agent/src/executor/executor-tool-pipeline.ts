// SPDX-License-Identifier: Apache-2.0
/**
 * Tool pipeline processing for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate tool deferral wiring,
 * schema snapshot comparison, JIT guide wrapping, schema pruning,
 * provider-specific normalization, mutation serializer setup, and xAI HTML
 * entity decoding into a focused module.
 *
 * Consumers:
 * - pi-executor.ts: calls pipeline functions during tool assembly in execute()
 *
 * @module
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComisLogger } from "@comis/core";
import {
  getToolSchemaSnapshots,
  setToolSchemaSnapshots,
  getToolSchemaSnapshotHash,
  setToolSchemaSnapshotHash,
  deleteToolSchemaSnapshots,
  computeToolCompositionHash,
  isReactiveSchemaStripArmed,
} from "./executor-session-state.js";
import { createJitGuideWrapper } from "./jit-guide-injector.js";
import { pruneToolSchemas } from "../safety/tool-schema-safety.js";
import { normalizeToolSchemasForProvider } from "../provider/tool-schema/normalize.js";
import {
  stripSchemaKeywordsDeep,
  REACTIVE_STRIP_KEYWORDS,
} from "./prompt-runner/tool-schema-strip.js";
import { createMutationSerializer, isConcurrencySafe } from "./tool-parallelism.js";
import { coerceStringifiedStructuredFields } from "./tool-arg-coercion.js";

// ---------------------------------------------------------------------------
// HTML entity decoding for xAI/Grok tool call arguments
// ---------------------------------------------------------------------------

/**
 * Recursively decode HTML entities in all string values of a params object.
 * Used for xAI/Grok which HTML-encodes tool call argument strings.
 * Only decodes the 4 standard XML entities: &amp; &lt; &gt; &quot;
 */
export function decodeHtmlEntitiesInParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      result[key] = value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = decodeHtmlEntitiesInParams(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) =>
        typeof v === "string"
          ? v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          : (v !== null && typeof v === "object" && !Array.isArray(v))
            ? decodeHtmlEntitiesInParams(v as Record<string, unknown>)
            : v,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool pipeline: JIT guides, pruning, schema snapshot, normalization
// ---------------------------------------------------------------------------

/** Parameters for JIT guide wrapping. */
export interface JitGuideParams {
  tools: ToolDefinition[];
  deliveredGuides: Set<string>;
  logger: ComisLogger;
}

/** Apply JIT guide wrapping to tools. */
export function applyJitGuideWrapping(params: JitGuideParams): ToolDefinition[] {
  return createJitGuideWrapper(params.tools, params.deliveredGuides, params.logger);
}

/** Parameters for schema pruning. */
export interface SchemaPruneParams {
  tools: ToolDefinition[];
  capabilityClass: import("./model-profile.js").CapabilityClass;
  logger: ComisLogger;
}

/** Apply schema pruning for nano-class models (only the "nano" capability class is pruned). */
export function applySchemasPruning(params: SchemaPruneParams): ToolDefinition[] {
  if (params.capabilityClass !== "nano") return params.tools;

  const pruneResult = pruneToolSchemas(params.tools);
  // INFO log for schema pruning (promoted, per-execution boundary event)
  params.logger.info(
    {
      removedCount: pruneResult.totalRemoved,
      tokensSaved: pruneResult.estimatedTokensSaved,
      toolCount: pruneResult.tools.length,
    },
    "Schema descriptions pruned for nano-class model",
  );
  return pruneResult.tools;
}

// ---------------------------------------------------------------------------
// Schema snapshot management
// ---------------------------------------------------------------------------

/** Parameters for applying tool schema snapshot. */
export interface SchemaSnapshotParams {
  tools: ToolDefinition[];
  sessionKey: string;
  deferredNames: string[];
}

/**
 * Apply tool schema snapshot: on first turn, snapshot tool shapes; on
 * subsequent turns, rebuild tools from snapshot shapes + live execute().
 *
 * Returns the stable tool set with snapshotted schemas.
 */
export function applySchemaSnapshot(params: SchemaSnapshotParams): ToolDefinition[] {
  const { tools, sessionKey, deferredNames } = params;

  // Hash-based invalidation -- when tool composition changes (discovery
  // or re-deferral), invalidate the snapshot so it is recreated with the new set.
  const currentHash = computeToolCompositionHash(tools.map(t => t.name));
  const snapshotHash = getToolSchemaSnapshotHash(sessionKey);

  if (snapshotHash && snapshotHash !== currentHash) {
    // Tool composition changed (discovery or re-deferral) -- invalidate snapshot
    deleteToolSchemaSnapshots(sessionKey);
  }

  let snapshotShapes = getToolSchemaSnapshots(sessionKey);

  if (!snapshotShapes) {
    // First turn (or invalidated): capture tool shapes after deferral + pruning
    snapshotShapes = tools.map(t => ({
      name: t.name,
      label: t.label ?? t.name,
      description: t.description ?? "",
      parameters: t.parameters ? JSON.parse(JSON.stringify(t.parameters)) : undefined,
    }));
    setToolSchemaSnapshots(sessionKey, snapshotShapes);
    setToolSchemaSnapshotHash(sessionKey, currentHash);
    return tools;
  }

  // Subsequent turns: rebuild tools from snapshotted shapes + live execute()
  const liveToolMap = new Map(tools.map(t => [t.name, t]));
  const stableTools: ToolDefinition[] = [];

  for (const shape of snapshotShapes) {
    const liveTool = liveToolMap.get(shape.name);
    if (liveTool) {
      // Use snapshotted shape with live execute()
      stableTools.push({
        ...liveTool,
        description: shape.description,
        parameters: shape.parameters,
      } as typeof liveTool);
    } else {
      // Tool disappeared (MCP disconnect) or deferred. Keep shape with stub execute().
      // If tool is in the deferred set, return discover_tools hint instead
      // of generic "temporarily unavailable" message.
      stableTools.push({
        name: shape.name,
        label: shape.label,
        description: shape.description,
        parameters: shape.parameters,
        execute: async () => {
          if (deferredNames.includes(shape.name)) {
            return {
              content: [{ type: "text" as const, text: `Tool "${shape.name}" is deferred. Call discover_tools with query "select:${shape.name}" to fetch the schema first.` }],
              isError: true,
              details: undefined,
            };
          }
          return {
            content: [{ type: "text" as const, text: `Tool "${shape.name}" is temporarily unavailable (MCP server disconnected). Try again later or use an alternative approach.` }],
            isError: true,
            details: undefined,
          };
        },
      } as unknown as ToolDefinition);
    }
  }

  // Append any NEW tools that appeared after snapshot (e.g., MCP reconnect with new tools)
  for (const tool of tools) {
    if (!snapshotShapes.some(s => s.name === tool.name)) {
      stableTools.push(tool);
      snapshotShapes.push({
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ? JSON.parse(JSON.stringify(tool.parameters)) : undefined,
      });
    }
  }

  return stableTools;
}

// ---------------------------------------------------------------------------
// Provider-specific normalization
// ---------------------------------------------------------------------------

/** Parameters for provider normalization. */
export interface ProviderNormalizeParams {
  tools: ToolDefinition[];
  provider: string;
  modelId: string;
  compat?: { supportsTools?: boolean; toolSchemaProfile?: "default" | "xai" | "gbnf"; toolCallArgumentsEncoding?: "json" | "html-entities"; nativeWebSearchTool?: boolean };
  /**
   * The value of
   * `config.orchestration.authoring.gbnfConstrain`, threaded from the
   * assembly call site. When true, the Layer 3.5 GBNF transform engages for
   * gbnf-ELIGIBLE (local/default-family) providers even when they are not
   * pinned to the explicit `compat.toolSchemaProfile === "gbnf"` profile.
   * Default/absent = false = unchanged behavior (FLAGS-OFF byte-identical).
   */
  gbnfConstrain?: boolean;
}

/**
 * Apply provider-specific tool normalization: web search filtering,
 * schema normalization, xAI HTML entity decoding, and mutation serializer.
 *
 * Returns the fully processed tool set ready for session creation.
 */
export function applyProviderNormalization(params: ProviderNormalizeParams): ToolDefinition[] {
  let tools = params.tools;

  // Filter out Comis web_search when provider has native web search (e.g., xAI webSearch)
  if (params.compat?.nativeWebSearchTool) {
    tools = tools.filter((t) => t.name !== "web_search");
  }

  // Per-provider tool schema normalization (after snapshot, before session creation)
  tools = normalizeToolSchemasForProvider(tools, {
    provider: params.provider,
    modelId: params.modelId,
    compat: params.compat,
    // Forward the authoring gate so the Layer 3.5 GBNF
    // transform actually engages on gbnf-eligible providers when the operator
    // flips it on. Absent ⇒ undefined ⇒ FLAGS-OFF byte-identical.
    gbnfConstrain: params.gbnfConstrain,
  });

  // prepareArguments runs BEFORE TypeBox schema validation in the SDK agent loop
  // (agent-loop.js prepareToolCall → validateToolArguments) — the correct interception
  // point for argument normalization. We compose two normalizations into it:
  //   1. xAI/Grok HTML-entity decode (provider-gated), then
  //   2. per-field stringified-JSON coercion (universal): a small model emits
  //      e.g. memory_manage {ids:"[\"uuid\"]"} — the SDK validator coerces stringified
  //      primitives but NOT arrays/objects, so the call was rejected and the model
  //      fabricated a result. Coerce array/object fields back to structured values,
  //      schema-awarely (never string-typed fields). Applied to ALL tools so every
  //      capability class benefits; identity no-op when nothing needs coercing.
  const decodeHtmlEntities = params.compat?.toolCallArgumentsEncoding === "html-entities";
  tools = tools.map((tool) => {
    const schema = tool.parameters as { properties?: Record<string, unknown> } | undefined;
    return {
      ...tool,
      prepareArguments: (args: unknown) => {
        let next = (args ?? {}) as Record<string, unknown>;
        if (decodeHtmlEntities) next = decodeHtmlEntitiesInParams(next);
        next = coerceStringifiedStructuredFields(next, schema).args;
        return next;
      },
    };
  });

  return tools;
}

// ---------------------------------------------------------------------------
// Persisted reactive schema strip
// ---------------------------------------------------------------------------

/** Parameters for the persisted reactive strip. */
export interface PersistedReactiveStripParams {
  tools: ToolDefinition[];
  /** FORMATTED session key — the same key the schema snapshot uses. */
  sessionKey: string;
}

/**
 * Re-apply the session's reactive pattern/format strip AFTER provider
 * normalization. The strip-retry handler
 * (tool-schema-unsupported-handler.ts) mutates THIS turn's wire objects for
 * the in-flight retry, but every subsequent turn rebuilds `parameters` from
 * the pre-strip schema snapshot — and gbnf normalization constructs
 * brand-new parameter objects each turn — so without this step the
 * unstripped `pattern`/`format` go back on the wire, the provider 400s
 * again deterministically, and the closed once-gate declares terminal
 * failure: one heal would permanently brick the session.
 *
 * Pure: returns new tool objects when something is stripped (never mutates
 * the snapshot-held parameters). Identity no-op when the session never
 * armed the strip — the common path costs one bounded-map lookup.
 */
export function applyPersistedReactiveStrip(params: PersistedReactiveStripParams): ToolDefinition[] {
  if (!isReactiveSchemaStripArmed(params.sessionKey)) return params.tools;

  return params.tools.map((tool) => {
    const p = tool.parameters;
    if (p === null || p === undefined || typeof p !== "object" || Array.isArray(p)) return tool;
    const { schema, stripped } = stripSchemaKeywordsDeep(p, REACTIVE_STRIP_KEYWORDS);
    if (stripped.length === 0) return tool;
    return { ...tool, parameters: schema } as ToolDefinition;
  });
}

/**
 * Apply mutation serializer to tool execute() methods.
 * SDK runs in default "parallel" mode -- read-only tools execute concurrently,
 * mutating tools serialize via the mutex to prevent ordering bugs.
 */
export function applyMutationSerializer(tools: ToolDefinition[], logger: ComisLogger): ToolDefinition[] {
  const serializeTools = createMutationSerializer();
  const result = serializeTools(tools);
  logger.debug(
    { mutatingToolCount: result.filter(t => !isConcurrencySafe(t.name)).length },
    "Mutation serializer applied to tool pipeline",
  );
  return result;
}
