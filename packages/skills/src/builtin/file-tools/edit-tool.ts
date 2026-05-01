// SPDX-License-Identifier: Apache-2.0
/**
 * Native edit tool: batch file editing with fuzzy matching, encoding
 * preservation, config validation, curly quote handling, and structured errors.
 *
 * Replaces pi-mono createEditTool + 3-layer wrapper stack (safePath +
 * pathSuggestion + fileStateGuards) with a single self-contained factory.
 * Follows the read-tool.ts pattern: factory function returning AgentTool.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import { basename, extname } from "node:path";
import { fromPromise } from "@comis/shared";
import { safePath, PathTraversalError } from "@comis/core";
import type { FileStateTracker } from "../file/file-state-tracker.js";
import { isDeviceFile } from "../file/file-state-tracker.js";
import { suggestSimilarPaths } from "../file/path-suggest.js";
import {
  PROTECTED_WORKSPACE_FILES,
  type LazyPaths,
  resolvePaths,
} from "../file/safe-path-wrapper.js";
import { readStringParam } from "../platform/tool-helpers.js";
import {
  readFileWithMetadata,
  writeFilePreserving,
} from "./shared/file-encoding.js";
import {
  applyEdits,
  generateDiffString,
  detectQuoteStyle,
  applyCurlyQuotes,
  cleanupTrailingNewlines,
  validateConfigContent,
} from "./shared/edit-diff.js";
import { getGitDiffStat } from "./shared/git-diff.js";
import { withFileMutationQueue } from "./shared/file-mutation-queue.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (1 GiB). Files above this are rejected. */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger interface (skills does not import @comis/infra). */
interface ToolLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const EditParams = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file to edit (relative to workspace or absolute)",
    }),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String({
          description:
            "Exact text to match in the ORIGINAL file (not after earlier edits). Must be unique. Do NOT include line numbers from read output.",
        }),
        newText: Type.String({
          description: "Replacement text for this edit.",
        }),
        replaceAll: Type.Optional(
          Type.Boolean({
            description:
              "Replace ALL occurrences of oldText (default: false). " +
              "Useful for renaming variables or strings across the file.",
          }),
        ),
      }),
      {
        description:
          "One or more targeted replacements. All matched against the original file, not incrementally. Use smallest unique context (2-4 lines) per oldText.",
      },
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
 * Resolve an edit path through the workspace -> sharedPaths fallback chain.
 * Returns the resolved absolute path.
 *
 * Unlike resolveReadPath, edit is a write operation and does NOT fall back to
 * readOnlyPaths. Only workspace and sharedPaths are valid targets for writes.
 *
 * Throws Error with [path_traversal] prefix when the path cannot be resolved
 * through any allowed root.
 */
function resolveEditPath(
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
 * Create the native edit tool.
 *
 * Returns an AgentTool that performs batch file editing with fuzzy matching,
 * encoding preservation, config validation, curly quote handling, and
 * structured error codes.
 *
 * @param workspacePath - Workspace root directory (all relative paths resolve against this)
 * @param logger - Optional pino-compatible logger
 * @param tracker - Optional FileStateTracker for read-before-edit and staleness
 * @param sharedPaths - Optional shared paths (lazily resolved) accessible by all tools
 */
export function createComisEditTool(
  workspacePath: string,
  logger?: ToolLogger,
  tracker?: FileStateTracker,
  sharedPaths?: LazyPaths,
): AgentTool<typeof EditParams> {
  // Comis extension: promptGuidelines (not part of AgentTool type, spread to bypass excess property check)
  const ext = { promptGuidelines: [
    "You MUST read the file before editing in each response (reads from prior messages do not carry over). Strip line number prefixes from read output before using as oldText.",
    "Use the smallest unique oldText (2-4 lines). Merge adjacent changes into one edit.",
    "Prefer one batch edit call with multiple edits[] over sequential calls to the same file.",
    "On [text_not_found]: re-read the file and retry with fresh content.",
  ] };
  return {
    ...ext,
    name: "edit",
    label: "Edit",
    description:
      "Edit a file using exact text replacement. Supports batch edits via edits[] array. " +
      "Each oldText must match exactly one location in the ORIGINAL file (not after prior edits). " +
      "Auto fuzzy-matches encoding differences (smart quotes, unicode, whitespace). " +
      "You must read the file in the current response before editing (reads from previous messages " +
      "do not carry over). When copying text from read output, strip the " +
      "line number prefix -- only copy the content after it. Use the smallest unique oldText " +
      "(2-4 lines). Merge adjacent changes into one edit. Prefer one batch edit call over " +
      "multiple sequential calls to the same file. " +
      "On [text_not_found]: re-read the file and retry with fresh content.",
    parameters: EditParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // --- V1: Extract params, validate edits array not empty ---
      const filePath = readStringParam(params, "path")!;
      const edits = params.edits as
        | Array<{ oldText: unknown; newText: unknown; replaceAll?: boolean }>
        | undefined;

      if (!edits || edits.length === 0) {
        throw new Error(
          "[empty_edits] No edits provided. The edits array must contain at least one {oldText, newText} pair.",
        );
      }

      // --- V2: Validate each edit has non-empty oldText ---
      for (let i = 0; i < edits.length; i++) {
        const oldText = String(edits[i].oldText ?? "");
        if (oldText.trim().length === 0) {
          throw new Error(
            `[empty_oldtext] edits[${i}].oldText must not be empty.`,
          );
        }
      }

      // --- V3: Validate no noop edits (oldText === newText) ---
      for (let i = 0; i < edits.length; i++) {
        const oldText = String(edits[i].oldText);
        const newText = String(edits[i].newText);
        if (oldText === newText) {
          throw new Error(
            `[noop_edit] edits[${i}] is a no-op (oldText === newText). Remove it or provide different replacement text.`,
          );
        }
      }

      // --- V4: Path resolution (workspace -> sharedPaths) ---
      const resolvedPath = resolveEditPath(
        workspacePath,
        filePath,
        sharedPaths,
      );

      // --- V5: Protected workspace file check ---
      const base = basename(resolvedPath);
      const redirect = PROTECTED_WORKSPACE_FILES.get(base);
      if (redirect) {
        throw new Error(
          `[protected_file] Cannot edit ${base}. Use ${redirect} instead.`,
        );
      }

      // --- V6: File existence + stat (Result-based) ---
      const statResult = await fromPromise(fs.stat(resolvedPath));
      if (!statResult.ok) {
        const suggestions = suggestSimilarPaths(resolvedPath, workspacePath);
        const hint =
          suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : " Use the read tool to verify the file path.";
        throw new Error(
          `[file_not_found] File not found: ${filePath}.${hint}`,
        );
      }
      const stat = statResult.value;

      // --- V7: File size limit (1 GiB) ---
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `[file_too_large] File too large (${formatSize(stat.size)}). Maximum: 1 GiB`,
        );
      }

      // --- V8: Jupyter notebook rejection ---
      if (extname(resolvedPath).toLowerCase() === ".ipynb") {
        throw new Error(
          "[jupyter_rejected] Cannot edit Jupyter notebooks with the edit tool. Use the notebook_edit tool instead for cell-level operations.",
        );
      }

      // --- V9: Device file blocking ---
      if (isDeviceFile(resolvedPath)) {
        throw new Error(
          `[device_file] Cannot edit device file: ${resolvedPath}`,
        );
      }

      // --- V10: Auto-read for edit (silent read-before-edit) ---
      if (tracker && !tracker.hasBeenRead(resolvedPath)) {
        const autoContent = await fs.readFile(resolvedPath);
        tracker.recordRead(resolvedPath, stat.mtimeMs, undefined, undefined, autoContent);
        logger?.debug({ path: resolvedPath }, "Auto-read performed for edit");
      }

      // --- V11: Staleness check (with content-hash fallback for false positives) ---
      if (tracker) {
        const currentContent = await fs.readFile(resolvedPath);
        const staleness = tracker.checkStaleness(resolvedPath, stat.mtimeMs, currentContent);
        if (staleness.stale) {
          throw new Error(
            "[stale_file] File was modified since you last read it (mtime changed). Read the file again before editing.",
          );
        }
      }

      // --- Wrap edit+write in mutation queue for per-path serialization ---
      const editResult = await withFileMutationQueue(resolvedPath, async () => {
        // --- Read file ---
        const fileData = await readFileWithMetadata(resolvedPath);

        // --- Detect quote style for preservation ---
        const quoteStyle = detectQuoteStyle(fileData.content);

        // --- Apply curly quotes to newText if file uses curly quotes ---
        const processedEdits = edits.map((e) => ({
          oldText: String(e.oldText),
          newText: applyCurlyQuotes(String(e.newText), quoteStyle),
          replaceAll: e.replaceAll,
        }));

        // --- V12-V14: Match + apply edits (applyEdits handles not-found, duplicate, overlap) ---
        let applyResult;
        try {
          applyResult = applyEdits(fileData.content, processedEdits, filePath);
        } catch (error) {
          // Map applyEdits errors to our structured error code format
          const msg = error instanceof Error ? error.message : String(error);
          // text_not_found: the LLM's understanding of file content is wrong.
          // Invalidate the read tracker so the next read returns full content
          // instead of a stub (which would block the retry the LLM needs).
          if (msg.startsWith("[text_not_found]") || msg.includes("Could not find")) {
            tracker?.invalidateRead(resolvedPath);
          }
          // replaceAll path already includes [text_not_found] prefix
          if (msg.startsWith("[text_not_found]")) {
            throw error;
          }
          if (msg.includes("Could not find")) {
            // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
            throw new Error(`[text_not_found] ${msg}`);
          }
          if (msg.includes("occurrences")) {
            // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
            throw new Error(`[duplicate_match] ${msg}`);
          }
          if (msg.includes("overlap")) {
            // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
            throw new Error(`[overlapping_edits] ${msg}`);
          }
          if (msg.includes("No changes")) {
            // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
            throw new Error(`[no_changes] ${msg}`);
          }
          throw error;
        }

        // --- Cleanup trailing newlines on deletions ---
        let finalContent = applyResult.newContent;
        const hasDeleteOrShrink = processedEdits.some(
          (e) => e.newText.length < e.oldText.length || e.newText === "",
        );
        if (hasDeleteOrShrink) {
          finalContent = cleanupTrailingNewlines(finalContent);
        }

        // --- V15: Config validation (warning, not rejection) ---
        const ext = extname(resolvedPath).toLowerCase();
        const configWarning = validateConfigContent(ext, finalContent);

        // --- Write file (preserves encoding and line endings) ---
        await writeFilePreserving(
          resolvedPath,
          finalContent,
          fileData.encoding,
          fileData.lineEnding,
        );

        // --- Post-write: record new mtime + content hash in tracker ---
        const newStat = await fs.stat(resolvedPath);
        const newContent = Buffer.from(finalContent, fileData.encoding === "utf-8" ? "utf-8" : "latin1");
        tracker?.recordRead(resolvedPath, newStat.mtimeMs, undefined, undefined, newContent);

        // --- Generate diff ---
        const { diff, firstChangedLine } = generateDiffString(
          applyResult.baseContent,
          finalContent,
        );

        return {
          diff,
          firstChangedLine,
          configWarning,
          matchStrategy: applyResult.matchStrategy,
          editsApplied: processedEdits.length,
        };
      });

      // --- Build result (git diff is read-only, outside mutation queue) ---
      let resultText = `Successfully replaced ${editResult.editsApplied} block(s) in ${filePath}.\n\n${editResult.diff}`;
      if (editResult.configWarning) {
        resultText += `\n\n[invalid_config] Warning: ${editResult.configWarning}`;
      }

      const gitStat = await getGitDiffStat(resolvedPath, workspacePath);
      if (gitStat) {
        resultText += `\n\n${gitStat}`;
      }

      logger?.debug(
        {
          path: filePath,
          editsApplied: editResult.editsApplied,
          matchStrategy: editResult.matchStrategy,
          firstChangedLine: editResult.firstChangedLine,
        },
        "Edit complete",
      );

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          diff: editResult.diff,
          firstChangedLine: editResult.firstChangedLine,
          matchStrategy: editResult.matchStrategy,
          editsApplied: editResult.editsApplied,
          gitDiff: gitStat ?? undefined,
        },
      };
    },
  };
}
