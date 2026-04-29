// SPDX-License-Identifier: Apache-2.0
/**
 * Tool Parallelism: Read-only classifier and mutation serializer.
 *
 * The SDK's "parallel" tool execution mode runs ALL tools concurrently.
 * This is correct for read-only tools but unsafe for mutating tools
 * (exec, write, edit, etc.) which may have ordering dependencies or
 * filesystem conflicts.
 *
 * The mutation serializer wraps mutating tool execute() methods with a
 * shared async mutex so they run one at a time, even when the SDK fires
 * them concurrently in parallel mode. Read-only tools pass through
 * without serialization.
 *
 * @module
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getToolMetadata } from "@comis/core";

// ---------------------------------------------------------------------------
// Read-only tool classification
// ---------------------------------------------------------------------------

/**
 * Set of tool names that are safe to run concurrently.
 * These tools only read state and never modify filesystem, database,
 * or external services.
 */
export const READ_ONLY_TOOLS = new Set([
  // File system reads
  "read",
  "grep",
  "find",
  "ls",

  // Web reads
  "web_search",
  "web_fetch",
  "browser",

  // Memory/session reads
  "memory_search",
  "memory_get",
  "session_search",

  // Session reads
  "sessions_list",
  "session_status",
  "sessions_history",
  // Context reads
  "ctx_search",
  "ctx_inspect",
  "ctx_expand",
  "ctx_recall",

  // Media analysis (read-only inference)
  "image_analyze",
  "describe_video",
  "extract_document",
  "transcribe_audio",

  // Platform reads
  "obs_query",
  "models_manage",

  // Discovery
  "discover_tools",

  // NOTE: "process" is intentionally EXCLUDED — its kill action is mutating (SIGTERM/SIGKILL).
]);

/** Minimal logger interface for parallelism warnings. */
interface ParallelismLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Determine whether a tool is read-only (safe for concurrent execution).
 *
 * Three-tier fallback chain:
 *   1. Explicit metadata declaration (getToolMetadata registry)
 *   2. MCP heuristic (mcp__-prefixed tools manage their own state)
 *   3. Legacy READ_ONLY_TOOLS set (backward compat)
 *
 * Unknown tools default to false (mutating) as a safety measure.
 */
export function isReadOnlyTool(name: string, logger?: ParallelismLogger): boolean {
  // Priority 1: explicit metadata declaration
  const meta = getToolMetadata(name);
  if (meta?.isReadOnly !== undefined) return meta.isReadOnly;

  // Priority 2: MCP heuristic (MCP servers manage their own state)
  if (name.startsWith("mcp__")) return true;

  // Priority 3: legacy hardcoded set (backward compat)
  const legacyResult = READ_ONLY_TOOLS.has(name);
  if (logger && legacyResult) {
    logger.warn(
      { toolName: name, hint: "Register isReadOnly metadata for this tool", errorKind: "config" },
      "isReadOnlyTool() fell back to legacy READ_ONLY_TOOLS set",
    );
  }
  return legacyResult;
}

/**
 * Determine whether a tool is safe for concurrent execution.
 *
 * Unlike isReadOnlyTool(), this considers tools that mutate state but
 * target independent resources (e.g., message sends to different channels).
 * Falls back to isReadOnly when isConcurrencySafe metadata is unset.
 */
export function isConcurrencySafe(name: string, logger?: ParallelismLogger): boolean {
  const meta = getToolMetadata(name);
  if (meta?.isConcurrencySafe !== undefined) return meta.isConcurrencySafe;
  // Default: same as isReadOnly
  return isReadOnlyTool(name, logger);
}

// ---------------------------------------------------------------------------
// Async mutex
// ---------------------------------------------------------------------------

/**
 * Minimal async mutex — no external dependencies.
 * Each call to run() queues behind the previous, ensuring serial execution.
 */
function createAsyncMutex() {
  let current = Promise.resolve();
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = current;
      current = next;
      await prev;
      try {
        return await fn();
      } finally {
        release!();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mutation serializer
// ---------------------------------------------------------------------------

/**
 * Create a mutation serializer that wraps mutating tool execute() methods
 * with a shared async mutex.
 *
 * Returns a function that accepts a ToolDefinition array and returns a new
 * array where:
 * - Read-only tools are passed through unchanged (same execute reference).
 * - Mutating tools have their execute() wrapped to serialize through the mutex.
 *
 * Each call to createMutationSerializer() creates an independent mutex,
 * so different executor sessions do not block each other.
 */
export function createMutationSerializer(): (
  tools: ToolDefinition[],
) => ToolDefinition[] {
  const mutex = createAsyncMutex();

  return (tools: ToolDefinition[]): ToolDefinition[] =>
    tools.map((tool) => {
      if (isConcurrencySafe(tool.name)) {
        return tool;
      }

      // Wrap mutating tool's execute with the shared mutex
      const originalExecute = tool.execute.bind(tool);
      return {
        ...tool,
        execute(
          ...args: Parameters<ToolDefinition["execute"]>
        ): ReturnType<ToolDefinition["execute"]> {
          return mutex.run(() => originalExecute(...args));
        },
      } as ToolDefinition;
    });
}
