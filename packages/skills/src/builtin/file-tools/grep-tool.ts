/**
 * Native grep tool: file content search via ripgrep subprocess with 3 output
 * modes, path validation, and correct exit code handling.
 *
 * Replaces pi-mono createGrepTool + wrapGrepWithOutputMode wrapper stack with
 * a single self-contained factory. Follows the read-tool.ts pattern.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safePath, PathTraversalError } from "@comis/core";
import { type LazyPaths, resolvePaths } from "../file/safe-path-wrapper.js";
import { readStringParam, readNumberParam, readBooleanParam } from "../platform/tool-helpers.js";
import { truncateLine, GREP_MAX_LINE_WIDTH } from "../truncate.js";
import { ensureTool } from "../tool-provisioner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface (skills does not import @comis/infra). */
interface ToolLogger {
  debug?(msg: string, ...args: unknown[]): void;
}

/** The three supported output modes for grep results. */
type OutputMode = "content" | "files_with_matches" | "count";

/** Valid output mode values for parameter validation. */
const OUTPUT_MODES: readonly OutputMode[] = ["content", "files_with_matches", "count"] as const;

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const GrepParams = Type.Object(
  {
    pattern: Type.String({ description: "Regex pattern to search for (ripgrep syntax). Escape special chars: \\\\. \\\\[ \\\\( etc. Use literal param for plain text." }),
    path: Type.Optional(
      Type.String({
        description:
          "File or directory to search in (defaults to workspace root)",
      }),
    ),
    output_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("content"),
          Type.Literal("files_with_matches"),
          Type.Literal("count"),
        ],
        {
          description:
            "Output format: content (default), files_with_matches, or count",
        },
      ),
    ),
    glob: Type.Optional(Type.String({
      description: "Glob pattern to filter files (e.g., '*.js', '**/*.tsx'). Maps to rg --glob.",
    })),
    type: Type.Optional(Type.String({
      description: "File type to search (e.g., 'js', 'py', 'rust', 'go'). More efficient than glob for standard types.",
    })),
    "-A": Type.Optional(Type.Integer({
      description: "Lines to show after each match (requires output_mode: 'content')",
    })),
    "-B": Type.Optional(Type.Integer({
      description: "Lines to show before each match (requires output_mode: 'content')",
    })),
    "-C": Type.Optional(Type.Integer({
      description: "Lines to show before AND after each match (alias for context)",
    })),
    "-n": Type.Optional(Type.Boolean({
      description: "Show line numbers (default: true for content mode)",
    })),
    "-i": Type.Optional(Type.Boolean({
      description: "Case-insensitive search",
    })),
    multiline: Type.Optional(Type.Boolean({
      description: "Enable multiline mode where . matches newlines and patterns can span lines. Default: false.",
    })),
    literal: Type.Optional(
      Type.Boolean({
        description:
          "Treat pattern as a literal string, not regex. " +
          "Use when searching for text with special characters like [, (, {, ., *, etc. Default: false.",
      }),
    ),
    head_limit: Type.Optional(Type.Integer({
      description: "Limit output to first N lines/entries. Defaults to 250. Pass 0 for unlimited.",
    })),
    offset: Type.Optional(Type.Integer({
      description: "Skip first N lines/entries before applying head_limit. Defaults to 0.",
    })),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Promisified execFile
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Lazy-initialized ripgrep path promise (prevents concurrent downloads). */
let rgPathPromise: Promise<string | undefined> | undefined;

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
 * Build ripgrep command-line arguments from pattern and output mode.
 *
 * @param pattern - Regex pattern to search for
 * @param outputMode - Output format mode
 * @returns Array of rg arguments
 */
function buildRipgrepArgs(
  pattern: string,
  outputMode: OutputMode,
  options: {
    glob?: string;
    type?: string;
    caseInsensitive?: boolean;
    multiline?: boolean;
    literal?: boolean;
    afterContext?: number;
    beforeContext?: number;
    context?: number;
    headLimit?: number;
    offset?: number;
  } = {},
): string[] {
  const args = [
    "--color", "never",       // No ANSI codes in output
    "--with-filename",        // Always include filenames (even single file)
  ];

  // VCS directory exclusion (always applied, before user globs so user can override)
  const VCS_EXCLUDES = ["!.git", "!.svn", "!.hg", "!.bzr", "!.jj", "!.sl"];
  for (const exclude of VCS_EXCLUDES) {
    args.push("--glob", exclude);
  }

  // Mode-specific flags
  if (outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (outputMode === "count") {
    args.push("--count");
  } else {
    // content mode: include line numbers
    args.push("--line-number");
  }

  // Pattern (use -e to avoid pattern being confused with flags)
  args.push("-e", pattern);

  // Phase 9: filtering
  if (options.glob) args.push("--glob", options.glob);
  if (options.type) args.push("--type", options.type);

  // Phase 9: case-insensitive
  if (options.caseInsensitive) args.push("-i");

  // Literal mode (fixed-strings)
  if (options.literal) {
    args.push("--fixed-strings");
  }

  // Phase 9: multiline
  if (options.multiline) args.push("-U", "--multiline-dotall");

  // Phase 9: context lines (content mode only -- ignored for other modes)
  if (outputMode === "content") {
    if (options.afterContext !== undefined) args.push("-A", String(options.afterContext));
    if (options.beforeContext !== undefined) args.push("-B", String(options.beforeContext));
    if (options.context !== undefined) args.push("-C", String(options.context));
  }

  // Phase 9: per-file match limit for pagination efficiency (content mode only)
  if (outputMode === "content") {
    const headLimit = options.headLimit ?? 250;
    const offset = options.offset ?? 0;
    if (headLimit > 0) {
      const perFileCap = Math.max(headLimit + offset, 500);
      args.push("-m", String(perFileCap));
    }
  }

  return args;
}

/**
 * Execute ripgrep subprocess and handle exit codes.
 *
 * Exit code 0: matches found (stdout contains results).
 * Exit code 1: no matches found (not an error).
 * ENOENT: rg binary not installed.
 * Other exit codes: actual errors (bad regex, permission denied, etc.).
 *
 * @param args - ripgrep command-line arguments
 * @param cwd - Working directory for the search
 * @param signal - Optional abort signal
 * @returns stdout and exit code
 */
async function execRipgrep(
  rgBinary: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(rgBinary, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      signal,
    });
    return { stdout, exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { code?: string | number; stdout?: string; stderr?: string };

    // rg exit code 1 = no matches (not an error)
    if (execError.code === 1) {
      return { stdout: "", exitCode: 1 };
    }

    // rg binary not found (should be rare since ensureTool resolves path first)
    if (execError.code === "ENOENT") {
      throw new Error(
        "[grep_not_found] ripgrep (rg) is not available and auto-download was attempted. " +
        "Install with: brew install ripgrep / apt install ripgrep",
        { cause: error },
      );
    }

    // All other errors (exit code 2 = bad regex, permission denied, etc.)
    throw new Error(
      `[grep_error] ripgrep failed: ${execError.stderr ?? String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Format rg --count output: parse file:count lines, sort descending, format
 * as "file: N match(es)".
 *
 * @param stdout - Raw rg --count output
 * @returns Formatted count output
 */
function formatCountOutput(stdout: string): string {
  if (!stdout.trim()) return "";

  const entries = stdout.trim().split("\n").map((line) => {
    // rg --count format: "file:count"
    const lastColon = line.lastIndexOf(":");
    const filePath = line.substring(0, lastColon);
    const count = parseInt(line.substring(lastColon + 1), 10);
    return { filePath, count };
  });

  // Sort by count descending
  entries.sort((a, b) => b.count - a.count);

  return entries
    .map(({ filePath, count }) =>
      `${filePath}: ${count} ${count === 1 ? "match" : "matches"}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Post-processing helpers
// ---------------------------------------------------------------------------

/**
 * Apply offset + head_limit pagination to output text. Appends a truncation
 * notice when results are clipped.
 *
 * @param text - Raw output text (newline-separated lines)
 * @param headLimit - Max lines to return (0 = unlimited)
 * @param offset - Lines to skip before applying limit
 * @returns Paginated output with optional truncation notice
 */
function paginateOutput(text: string, headLimit: number, offset: number): string {
  if (headLimit === 0 && offset === 0) return text;

  const lines = text.split("\n").filter(Boolean);

  // Apply offset
  const afterOffset = offset > 0 ? lines.slice(offset) : lines;

  // Apply head_limit (0 = unlimited after offset)
  const limited = headLimit > 0 ? afterOffset.slice(0, headLimit) : afterOffset;

  let result = limited.join("\n");

  // Truncation notice
  const remaining = afterOffset.length - limited.length;
  if (remaining > 0) {
    result += `\n\n[${remaining} more results not shown]`;
  }

  return result;
}

/**
 * Strip line numbers from rg content output. Converts
 * `file:linenum:content` to `file:content`.
 *
 * @param text - Raw rg output with line numbers
 * @returns Output with line number portion removed
 */
function stripLineNumbers(text: string): string {
  return text.split("\n").map(line => {
    // Match: file:linenum:content -> file:content
    return line.replace(/^(.+?):(\d+):/, "$1:");
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the native grep tool.
 *
 * Spawns ripgrep (`rg`) as a subprocess to search file contents by regex
 * pattern. Supports 3 output modes: content (default), files_with_matches,
 * and count. Validates search paths against workspace/readOnlyPaths/sharedPaths.
 *
 * @param workspacePath - Workspace root directory
 * @param logger - Optional logger for debug output
 * @param readOnlyPaths - Additional read-only path roots
 * @param sharedPaths - Shared path roots (lazy or static)
 * @returns AgentTool instance for grep operations
 */
export function createComisGrepTool(
  workspacePath: string,
  logger?: ToolLogger,
  readOnlyPaths?: string[],
  sharedPaths?: LazyPaths,
): AgentTool<typeof GrepParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "ALWAYS use this tool for content search. Do NOT use exec with grep/rg commands.",
    "Use `literal: true` when searching for text with special regex characters like [, (, {, ., *.",
    "Default limit is 250 lines. Use offset for pagination.",
  ] };
  return {
    ...ext,
    name: "grep",
    label: "Grep",
    description:
      "Search file contents by regex pattern, powered by ripgrep. Supports glob filtering, " +
      "file type filtering, context lines (-A/-B/-C), case-insensitive (-i), and multiline " +
      "matching. Three output modes: 'content' (matching lines with context), " +
      "'files_with_matches' (file paths only), 'count' (match counts per file). " +
      "Default limit: 250 lines. Use offset for pagination. " +
      "Exit code 1 = no matches (not an error). For finding files by name pattern, use find instead.",
    parameters: GrepParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // 1. Extract parameters
        const pattern = readStringParam(params, "pattern", true)!;
        const filePath = readStringParam(params, "path", false);
        const outputModeRaw = readStringParam(params, "output_mode", false);
        const outputMode: OutputMode =
          outputModeRaw && OUTPUT_MODES.includes(outputModeRaw as OutputMode)
            ? (outputModeRaw as OutputMode)
            : "content";

        // Phase 9: new parameters
        const glob = readStringParam(params, "glob", false);
        const type = readStringParam(params, "type", false);
        const caseInsensitive = readBooleanParam(params, "-i", false) ?? false;
        const multiline = readBooleanParam(params, "multiline", false) ?? false;
        const literal = readBooleanParam(params, "literal", false) ?? false;

        if (literal && multiline) {
          throw new Error(
            "[invalid_value] literal and multiline cannot be used together. " +
            "Literal mode uses --fixed-strings which does not support multiline patterns."
          );
        }
        const afterContext = readNumberParam(params, "-A", false);
        const beforeContext = readNumberParam(params, "-B", false);
        const context = readNumberParam(params, "-C", false);
        const showLineNumbers = readBooleanParam(params, "-n", false) ?? true;
        const headLimit = readNumberParam(params, "head_limit", false) ?? 250;
        const offset = readNumberParam(params, "offset", false) ?? 0;

        // 2. Resolve search path
        let searchPath: string;
        if (filePath) {
          searchPath = resolveSearchPath(
            workspacePath,
            filePath,
            readOnlyPaths,
            sharedPaths,
          );
        } else {
          searchPath = workspacePath;
        }

        // 3. Build rg arguments
        const args = buildRipgrepArgs(pattern, outputMode, {
          glob, type, caseInsensitive, multiline, literal,
          afterContext, beforeContext, context,
          headLimit, offset,
        });

        // 4. Determine cwd and always pass an explicit search path to rg.
        // Why: rg falls back to reading stdin when no path is given and stdin
        // is a pipe (execFile's default), which hangs forever. Always passing
        // "." (or the resolved searchPath) keeps rg in directory-search mode.
        let cwd: string;
        if (filePath) {
          args.push(searchPath);
          cwd = workspacePath;
        } else {
          args.push(".");
          cwd = searchPath;
        }

        // 5. Resolve ripgrep binary path (auto-download if not found)
        if (!rgPathPromise) {
          rgPathPromise = ensureTool("rg", logger ? { debug: (msg: string) => logger.debug?.(msg) } : undefined);
        }
        const resolvedRgPath = await rgPathPromise;
        if (!resolvedRgPath) {
          throw new Error(
            "[grep_not_found] ripgrep (rg) is not available and could not be auto-downloaded. " +
            "Install with: brew install ripgrep / apt install ripgrep",
          );
        }

        logger?.debug?.("grep: searching", pattern, "in", cwd);

        // 6. Execute ripgrep
        const { stdout: rawStdout, exitCode } = await execRipgrep(resolvedRgPath, args, cwd, signal);

        // 7. Handle empty results (exit code 1 = no matches)
        if (exitCode === 1 || !rawStdout.trim()) {
          return {
            content: [{ type: "text" as const, text: "" }],
            details: { matchCount: 0, mode: outputMode },
          };
        }

        // 8. Line width cap for content mode (prevents minified/base64 blowout)
        let stdout = rawStdout;
        if (outputMode === "content" && stdout) {
          const lines = stdout.split("\n");
          stdout = lines.map((line) => truncateLine(line, GREP_MAX_LINE_WIDTH)).join("\n");
        }

        // 9. Format output by mode
        let formattedOutput =
          outputMode === "count" ? formatCountOutput(stdout) : stdout;

        // 10. Strip line numbers if -n is false (content mode only)
        if (outputMode === "content" && !showLineNumbers) {
          formattedOutput = stripLineNumbers(formattedOutput);
        }

        // 11. Apply pagination (all modes)
        formattedOutput = paginateOutput(formattedOutput, headLimit, offset);

        return {
          content: [{ type: "text" as const, text: formattedOutput }],
          details: { mode: outputMode },
        };
      } catch (error: unknown) {
        // Errors are returned as text content so the LLM can read and react
        // to them. The SDK's agent-loop sets isError:true on thrown errors,
        // but grep errors are recoverable (bad regex, missing rg, path
        // traversal) so we return them inline instead of throwing.
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
