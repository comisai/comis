/**
 * Native ls tool: directory listing with alphabetical sort, type indicators,
 * dotfile inclusion, and path security.
 *
 * Replaces pi-mono createLsTool + wrapWithSafePath wrapper chain with a
 * single self-contained factory.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fsp from "node:fs/promises";
import { safePath, PathTraversalError } from "@comis/core";
import { type LazyPaths, resolvePaths } from "../file/safe-path-wrapper.js";
import { readStringParam, readNumberParam } from "../platform/tool-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface (skills does not import @comis/infra). */
interface ToolLogger {
  debug?(msg: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const LsParams = Type.Object(
  {
    path: Type.String({
      description: "Directory to list (relative to workspace or absolute)",
    }),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum number of entries to return. Default: 500.",
        default: 500,
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a search path through the workspace -> readOnlyPaths -> sharedPaths
 * fallback chain. Returns the resolved absolute path.
 *
 * Throws Error with [path_traversal] prefix when the path cannot be resolved
 * through any allowed root.
 */
function resolveSearchPath(
  workspacePath: string,
  filePath: string,
  readOnlyPaths: string[] | undefined,
  sharedPaths: LazyPaths | undefined,
): string {
  // Try workspace first
  try {
    return safePath(workspacePath, filePath);
  } catch (error) {
    if (!(error instanceof PathTraversalError)) throw error;
  }

  // Try readOnlyPaths
  if (readOnlyPaths) {
    for (const roPath of readOnlyPaths) {
      try {
        return safePath(roPath, filePath);
      } catch (error) {
        if (!(error instanceof PathTraversalError)) throw error;
      }
    }
  }

  // Try sharedPaths (lazily resolved)
  const resolved = resolvePaths(sharedPaths);
  for (const sp of resolved) {
    try {
      return safePath(sp, filePath);
    } catch (error) {
      if (!(error instanceof PathTraversalError)) throw error;
    }
  }

  throw new Error(`[path_traversal] Path outside workspace bounds: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the native ls tool.
 *
 * Lists directory contents alphabetically with type indicators (trailing /
 * for directories), dotfile inclusion, configurable limit with truncation
 * notice, and path security via safePath chain.
 *
 * @param workspacePath - Workspace root directory
 * @param logger - Optional logger for debug output
 * @param readOnlyPaths - Additional read-only path roots
 * @param sharedPaths - Shared path roots (lazy or static)
 * @returns AgentTool instance for ls operations
 */
export function createComisLsTool(
  workspacePath: string,
  logger?: ToolLogger,
  readOnlyPaths?: string[],
  sharedPaths?: LazyPaths,
): AgentTool<typeof LsParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "Use this for directory contents. For recursive file search, use the find tool instead.",
    "Includes dotfiles by default. Directories shown with trailing /.",
  ] };
  return {
    ...ext,
    name: "ls",
    label: "List Directory",
    description:
      "List directory contents alphabetically, including dotfiles. Returns entry names with " +
      "trailing '/' for directories. Default limit: 500 entries.",
    parameters: LsParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // 1. Extract params
        const filePath = readStringParam(params, "path", true)!;
        const limit = readNumberParam(params, "limit", false) ?? 500;

        // 2. Resolve path through safePath chain
        const absolutePath = resolveSearchPath(workspacePath, filePath, readOnlyPaths, sharedPaths);

        logger?.debug?.("ls: listing", absolutePath);

        // 3. Verify path exists and is a directory
        let stat;
        try {
          stat = await fsp.stat(absolutePath);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            return {
              content: [{ type: "text" as const, text: `Directory not found: ${filePath}` }],
              details: { error: true },
            };
          }
          throw e;
        }
        if (!stat.isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `Not a directory: ${filePath}. Use the read tool for files.` }],
            details: { error: true },
          };
        }

        // 4. Read directory with type information
        const entries = await fsp.readdir(absolutePath, { withFileTypes: true });

        // 5. Sort alphabetically (case-insensitive)
        entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

        // 6. Apply limit
        const totalEntries = entries.length;
        const truncated = totalEntries > limit;
        const limited = truncated ? entries.slice(0, limit) : entries;

        // 7. Format output
        if (limited.length === 0) {
          return {
            content: [{ type: "text" as const, text: "(empty directory)" }],
            details: { totalEntries: 0, truncated: false },
          };
        }

        const lines = limited.map((entry) => {
          if (entry.isDirectory()) return entry.name + "/";
          return entry.name;
        });

        if (truncated) {
          lines.push(`[${totalEntries - limit} more entries not shown. Total: ${totalEntries}]`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { totalEntries, truncated },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: true },
        };
      }
    },
  };
}
