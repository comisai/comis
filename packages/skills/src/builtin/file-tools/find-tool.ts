// SPDX-License-Identifier: Apache-2.0
/**
 * Native find tool: file discovery via glob pattern matching with mtime sort,
 * .gitignore respect, hidden file toggle, and path security.
 *
 * Replaces pi-mono createFindTool + wrapWithSafePath + wrapFindWithMtimeSort
 * wrapper chain with a single self-contained factory.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { safePath, PathTraversalError } from "@comis/core";
import { type LazyPaths, resolvePaths } from "../file/safe-path-wrapper.js";
import { readStringParam, readNumberParam, readBooleanParam } from "../platform/tool-helpers.js";
import ignore from "ignore";

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

const FindParams = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.test.ts')",
    }),
    path: Type.Optional(
      Type.String({
        description: "Directory to search in. Defaults to workspace root.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum number of results to return. Default: 1000. Pass 0 for unlimited.",
        default: 1000,
      }),
    ),
    include_hidden: Type.Optional(
      Type.Boolean({
        description: "Include hidden files and directories (dotfiles). Default: false.",
        default: false,
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

/**
 * Load .gitignore from the search base directory and create an ignore filter.
 * Always adds ".git" to the ignore list. Silently returns a filter that only
 * ignores .git when no .gitignore file exists.
 */
async function loadGitignore(searchBase: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  ig.add(".git");

  try {
    const content = await fsp.readFile(
      nodePath.join(searchBase, ".gitignore"),
      "utf-8",
    );
    ig.add(content);
  } catch {
    // No .gitignore file -- only .git is filtered
  }

  return ig;
}

/**
 * Convert a glob pattern to a RegExp that treats dotfiles as normal files.
 * Unlike POSIX glob semantics where `*` does not match leading dots,
 * this regex allows `*` and `**` to match dot-prefixed names.
 *
 * Supports: `*`, `**`, `?`, `{a,b}` brace expansion.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // **/ matches zero or more directories
          regex += "(?:.+/)?";
          i += 3;
          continue;
        }
        // ** at end or before non-slash matches everything
        regex += ".*";
        i += 2;
        continue;
      }
      // * matches anything except /
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === "{") {
      regex += "(?:";
      i++;
    } else if (c === "}") {
      regex += ")";
      i++;
    } else if (c === ",") {
      regex += "|";
      i++;
    } else if (".+^$|()[]\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}

/**
 * Collect file paths matching a glob pattern from the search base.
 *
 * When includeHidden is false, uses fs.glob which naturally skips dotfiles.
 * When includeHidden is true, uses readdir to get all entries including hidden,
 * then filters with a regex-based glob matcher that allows dotfiles.
 */
async function collectFiles(
  pattern: string,
  searchBase: string,
  includeHidden: boolean,
): Promise<string[]> {
  const results: string[] = [];

  if (!includeHidden) {
    // fs.glob naturally excludes dotfiles; exclude node_modules and .git
    for await (const entry of fsp.glob(pattern, {
      cwd: searchBase,
      exclude: (name: string) => name === "node_modules" || name === ".git",
    })) {
      results.push(entry);
    }
  } else {
    // readdir gets ALL entries including hidden; then filter by glob pattern
    // using a regex that allows dotfiles (unlike POSIX * which skips them)
    const re = globToRegex(pattern);
    const allEntries = await fsp.readdir(searchBase, { recursive: true });
    for (const entry of allEntries) {
      // Skip node_modules and .git directories
      if (
        entry.startsWith("node_modules") ||
        entry.includes("/node_modules/") ||
        entry === ".git" ||
        entry.startsWith(".git/") ||
        entry.includes("/.git/")
      ) {
        continue;
      }

      // Check if entry is a file (not directory)
      try {
        const fullPath = nodePath.resolve(searchBase, entry);
        const stat = await fsp.stat(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        continue; // Skip entries that can't be stat'd
      }

      // Match against glob pattern using dot-aware regex
      if (re.test(entry)) {
        results.push(entry);
      }
    }
  }

  return results;
}

/**
 * Stat each file path relative to searchBase, collecting mtime for sorting.
 * Silently skips files that can't be stat'd (may have disappeared).
 */
async function statFiles(
  filePaths: string[],
  searchBase: string,
): Promise<Array<{ relativePath: string; mtimeMs: number }>> {
  const entries: Array<{ relativePath: string; mtimeMs: number }> = [];

  const statPromises = filePaths.map(async (fp) => {
    try {
      const absolutePath = nodePath.resolve(searchBase, fp);
      const stat = await fsp.stat(absolutePath);
      entries.push({ relativePath: fp, mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between collect and stat -- skip
    }
  });

  await Promise.all(statPromises);

  return entries;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the native find tool.
 *
 * Searches for files by glob pattern with mtime sorting, .gitignore respect,
 * hidden file toggle, path security via safePath chain, and configurable
 * result limits.
 *
 * @param workspacePath - Workspace root directory
 * @param logger - Optional logger for debug output
 * @param readOnlyPaths - Additional read-only path roots
 * @param sharedPaths - Shared path roots (lazy or static)
 * @returns AgentTool instance for find operations
 */
export function createComisFindTool(
  workspacePath: string,
  logger?: ToolLogger,
  readOnlyPaths?: string[],
  sharedPaths?: LazyPaths,
): AgentTool<typeof FindParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "ALWAYS use this tool for file discovery. Do NOT use exec with find/fd/locate commands.",
    "Results are sorted by modification time (most recent first) with a default limit of 1000.",
  ] };
  return {
    ...ext,
    name: "find",
    label: "Find Files",
    description:
      "Find files by glob pattern. Results sorted by modification time (most recent first). " +
      "Respects .gitignore. Default limit: 1000 results. Use path to narrow search scope. " +
      "For searching file contents, use grep instead.",
    parameters: FindParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // 1. Extract params
        const pattern = readStringParam(params, "pattern", true)!;
        const filePath = readStringParam(params, "path", false);
        const limit = readNumberParam(params, "limit", false) ?? 1000;
        const includeHidden =
          readBooleanParam(params, "include_hidden", false) ?? false;

        // 2. Resolve search path
        let searchBase: string;
        if (filePath) {
          searchBase = resolveSearchPath(
            workspacePath,
            filePath,
            readOnlyPaths,
            sharedPaths,
          );
        } else {
          searchBase = workspacePath;
        }

        logger?.debug?.("find: searching", pattern, "in", searchBase);

        // 3. Load .gitignore from search base
        const ig = await loadGitignore(searchBase);

        // 4. Execute glob/readdir
        const rawFiles = await collectFiles(pattern, searchBase, includeHidden);

        // 5. Filter through .gitignore
        const filtered = rawFiles.filter((f) => !ig.ignores(f));

        // 6. Stat for mtime
        const withMtime = await statFiles(filtered, searchBase);

        // 7. Sort by mtime descending
        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // 8. Apply limit
        const totalFound = withMtime.length;
        const effectiveLimit = limit === 0 ? totalFound : limit;
        const truncated = totalFound > effectiveLimit;
        const results = truncated
          ? withMtime.slice(0, effectiveLimit)
          : withMtime;

        // 9. Format output
        if (results.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No files found matching pattern" },
            ],
            details: { totalFound: 0, truncated: false },
          };
        }

        const lines = results.map((f) => f.relativePath);
        if (truncated) {
          lines.push(
            `[Results limited to ${effectiveLimit} files. Total matching: ${totalFound}. Use a more specific pattern or increase limit.]`,
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { totalFound, truncated },
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: true },
        };
      }
    },
  };
}
