/**
 * Native write tool: file creation and overwrite with read-before-write
 * enforcement, staleness detection, encoding preservation, path safety,
 * and FileStateTracker integration.
 *
 * Replaces pi-mono createWriteTool + wrapper stack with a single
 * self-contained factory. Follows the edit-tool.ts pattern.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { fromPromise } from "@comis/shared";
import { safePath, PathTraversalError } from "@comis/core";
import type { FileStateTracker } from "../file/file-state-tracker.js";
import { isDeviceFile } from "../file/file-state-tracker.js";
import {
  PROTECTED_WORKSPACE_FILES,
  type LazyPaths,
  resolvePaths,
} from "../file/safe-path-wrapper.js";
import {
  readStringParam,
  readBooleanParam,
} from "../platform/tool-helpers.js";
import {
  readFileWithMetadata,
  writeFilePreserving,
} from "./shared/file-encoding.js";
import { validateConfigContent } from "./shared/edit-diff.js";
import { getGitDiffStat } from "./shared/git-diff.js";
import { withFileMutationQueue } from "./shared/file-mutation-queue.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (1 GiB). Existing files above this are rejected. */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

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

const WriteParams = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file to create or overwrite (relative to workspace or absolute)",
    }),
    content: Type.String({
      description: "The full content to write to the file",
    }),
    createDirectories: Type.Optional(
      Type.Boolean({
        description:
          "Create parent directories if they don't exist (default: true)",
        default: true,
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format byte size as human-readable string.
 * Examples: "512B", "4.1KB", "1.3MB", "1.1GB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`;
}

/**
 * Resolve a write path through the workspace -> sharedPaths fallback chain.
 * Returns the resolved absolute path.
 *
 * Unlike resolveReadPath, write does NOT fall back to readOnlyPaths.
 * Only workspace and sharedPaths are valid targets for writes.
 *
 * Throws Error with [path_traversal] prefix when the path cannot be resolved
 * through any allowed root.
 */
function resolveWritePath(
  workspacePath: string,
  filePath: string,
  sharedPaths: LazyPaths | undefined,
): string {
  // Try workspace first
  try {
    return safePath(workspacePath, filePath);
  } catch (error) {
    if (!(error instanceof PathTraversalError)) throw error;
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

  throw new Error(
    `[path_traversal] Path outside workspace bounds: ${filePath}`,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the native write tool.
 *
 * Returns an AgentTool that creates new files or overwrites existing files
 * with read-before-write enforcement, staleness detection, encoding
 * preservation, path safety, and FileStateTracker integration.
 *
 * @param workspacePath - Workspace root directory (all relative paths resolve against this)
 * @param logger - Optional pino-compatible logger
 * @param tracker - Optional FileStateTracker for read-before-write and staleness
 * @param sharedPaths - Optional shared paths (lazily resolved) accessible by all tools
 */
export function createComisWriteTool(
  workspacePath: string,
  logger?: ToolLogger,
  tracker?: FileStateTracker,
  sharedPaths?: LazyPaths,
): AgentTool<typeof WriteParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "For existing files, you MUST read before writing in each response (reads from prior messages do not carry over). Use the edit tool for targeted replacements instead of full rewrites.",
    "Prefer edit over write for modifying existing files — it only sends the diff.",
  ] };
  return {
    ...ext,
    name: "write",
    label: "Write",
    description:
      "Create a new file or overwrite an existing file. For new files, parent directories " +
      "are created automatically. For existing files, you must read the file first in the " +
      "current response (reads from previous messages do not carry over). " +
      "The file content is written exactly as provided. Use the edit tool for targeted text " +
      "replacements instead of rewriting entire files.",
    parameters: WriteParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // --- V1: Extract params ---
      const filePath = readStringParam(params, "path");
      const content = readStringParam(params, "content", false) ?? "";
      const createDirs = readBooleanParam(params, "createDirectories", false) ?? true;

      if (!filePath) {
        throw new Error("[missing_path] path parameter is required");
      }

      // --- V2: Path resolution (workspace -> sharedPaths) ---
      const absolutePath = resolveWritePath(workspacePath, filePath, sharedPaths);

      // --- V3: Device file blocking ---
      if (isDeviceFile(absolutePath)) {
        throw new Error(
          `[device_file] Cannot write to device file: ${absolutePath}. Hint: Use exec tool to interact with device files if needed.`,
        );
      }

      // --- V3.1: Protected workspace file check ---
      const base = basename(absolutePath);
      const redirect = PROTECTED_WORKSPACE_FILES.get(base);
      if (redirect) {
        throw new Error(
          `[protected_file] Cannot write to ${base}. Use ${redirect} instead.`,
        );
      }

      // --- V3.2: Jupyter notebook rejection ---
      if (extname(absolutePath).toLowerCase() === ".ipynb") {
        throw new Error(
          "[jupyter_rejected] Cannot overwrite Jupyter notebooks with the write tool. Use the notebook_edit tool instead for cell-level operations.",
        );
      }

      // --- V4: Check existence ---
      const exists = existsSync(absolutePath);

      // --- Wrap file mutation in queue for per-path serialization ---
      const resultData = await withFileMutationQueue(absolutePath, async () => {
        if (exists) {
          // --- V5: File size limit (1 GiB) ---
          const stat = await fs.stat(absolutePath);
          if (stat.size > MAX_FILE_SIZE) {
            throw new Error(
              `[file_too_large] Existing file too large (${formatSize(stat.size)}). Maximum: 1 GiB`,
            );
          }

          // --- V6: Read-before-write enforcement ---
          if (tracker && !tracker.hasBeenRead(absolutePath)) {
            throw new Error(
              `[not_read] Must read file before overwriting. Call read tool first. Hint: Read the file to see its current contents before making changes.`,
            );
          }

          // --- V7: Staleness check (with content-hash fallback for false positives) ---
          if (tracker) {
            const currentContent = await fs.readFile(absolutePath);
            const staleness = tracker.checkStaleness(absolutePath, stat.mtimeMs, currentContent);
            if (staleness.stale) {
              throw new Error(
                "[stale_file] File was modified since you last read it (mtime changed). Re-read before overwriting.",
              );
            }
          }

          // --- V7.1: Config syntax validation ---
          const ext = extname(absolutePath).toLowerCase();
          const configError = validateConfigContent(ext, content);
          if (configError) {
            throw new Error(`[invalid_config] ${configError}`);
          }

          // --- V8: Overwrite: preserve encoding ---
          // CRITICAL: Pass LF-normalized content directly to writeFilePreserving.
          // Do NOT call restoreLineEndings separately -- writeFilePreserving handles it internally.
          // Double-restoration corrupts CRLF files (see PITFALLS.md).
          const metadata = await readFileWithMetadata(absolutePath);
          await writeFilePreserving(
            absolutePath,
            content,
            metadata.encoding,
            metadata.lineEnding,
          );
        } else {
          // --- New file path ---

          // --- V9: Create parent directories ---
          if (createDirs) {
            const dir = dirname(absolutePath);
            const mkdirResult = await fromPromise(
              fs.mkdir(dir, { recursive: true }),
            );
            if (!mkdirResult.ok) {
              throw new Error(
                `[dir_create_failed] Failed to create directory: ${mkdirResult.error}`,
              );
            }
          }

          // --- V10: Write new file ---
          const writeResult = await fromPromise(
            fs.writeFile(absolutePath, content, "utf-8"),
          );
          if (!writeResult.ok) {
            throw new Error(
              `[write_error] Failed to write file: ${writeResult.error}`,
            );
          }
        }

        // --- Post-write: record in tracker with content hash (both paths converge here) ---
        const newStat = await fs.stat(absolutePath);
        const writtenContent = Buffer.from(content, "utf-8");
        tracker?.recordRead(absolutePath, newStat.mtimeMs, undefined, undefined, writtenContent);

        return {
          path: absolutePath,
          created: !exists,
          sizeBytes: newStat.size,
        };
      });

      const gitStat = await getGitDiffStat(absolutePath, workspacePath);
      const resultText = JSON.stringify(resultData);
      const output = gitStat ? `${resultText}\n\n${gitStat}` : resultText;

      return {
        content: [{ type: "text" as const, text: output }],
        details: { ...resultData, gitDiff: gitStat ?? undefined },
      };
    },
  };
}
