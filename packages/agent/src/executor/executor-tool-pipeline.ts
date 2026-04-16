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

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ComisLogger } from "@comis/infra";
import {
  getToolSchemaSnapshots,
  setToolSchemaSnapshots,
  getToolSchemaSnapshotHash,
  setToolSchemaSnapshotHash,
  deleteToolSchemaSnapshots,
  computeToolCompositionHash,
} from "./executor-session-state.js";
import { createJitGuideWrapper } from "./jit-guide-injector.js";
import { pruneToolSchemas } from "../safety/tool-schema-safety.js";
import { normalizeToolSchemasForProvider } from "../provider/tool-schema/normalize.js";
import { createMutationSerializer, isConcurrencySafe } from "./tool-parallelism.js";

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
  modelTier: "small" | "medium" | "large";
  logger: ComisLogger;
}

/** Apply schema pruning for small models. Returns processed tools. */
export function applySchemasPruning(params: SchemaPruneParams): ToolDefinition[] {
  if (params.modelTier !== "small") return params.tools;

  const pruneResult = pruneToolSchemas(params.tools);
  // INFO log for schema pruning (promoted, per-execution boundary event)
  params.logger.info(
    {
      removedCount: pruneResult.totalRemoved,
      tokensSaved: pruneResult.estimatedTokensSaved,
      toolCount: pruneResult.tools.length,
    },
    "Schema descriptions pruned for small model",
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
  compat?: { supportsTools?: boolean; toolSchemaProfile?: "default" | "xai"; toolCallArgumentsEncoding?: "json" | "html-entities"; nativeWebSearchTool?: boolean };
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
  });

  // Decode HTML entities in xAI tool call arguments via prepareArguments hook.
  // Runs BEFORE TypeBox schema validation in the SDK agent loop (agent-loop.js:300-301),
  // which is the correct interception point for argument normalization.
  if (params.compat?.toolCallArgumentsEncoding === "html-entities") {
    tools = tools.map((tool) => ({
      ...tool,
      prepareArguments: (args: unknown) =>
        decodeHtmlEntitiesInParams(args as Record<string, unknown>),
    }));
  }

  return tools;
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
