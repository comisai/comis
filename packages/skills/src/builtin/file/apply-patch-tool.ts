// SPDX-License-Identifier: Apache-2.0
/**
 * Apply-patch tool for multi-file modifications.
 *
 * Wraps the pure apply-patch parser with filesystem I/O and safePath
 * security. Applies parsed patch operations (add, update, delete, move)
 * to the workspace directory.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { safePath, PathTraversalError } from "@comis/core";
import { throwToolError } from "../platform/tool-helpers.js";
import { parsePatch } from "./apply-patch-parser.js";
import { similarity, normalizeLine } from "./apply-patch-similarity.js";
import type { PatchHunk, PatchOperation } from "./apply-patch-parser.js";
import { PROTECTED_WORKSPACE_FILES, resolvePaths, type LazyPaths, type SafePathLogger } from "./safe-path-wrapper.js";
import { withFileMutationQueue } from "../file-tools/shared/file-mutation-queue.js";

const ApplyPatchParams = Type.Object({
  patch: Type.String({
    description: "The patch content in *** Begin Patch format",
  }),
});

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function successResult(summary: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: summary }],
    details: { success: true },
  };
}

// Local errorResult removed -- all error paths now use throwToolError from tool-helpers

// ---------------------------------------------------------------------------
// Hunk application logic
// ---------------------------------------------------------------------------

/**
 * Trim trailing whitespace for context comparison.
 * Both file lines and patch context lines are trimmed before comparison.
 */
function trimTrailing(s: string): string {
  return s.replace(/\s+$/, "");
}

/**
 * Describe the leading whitespace of a string in human-readable form.
 * Reports tab and space counts for diagnostic error messages.
 */
function describeWhitespace(s: string): string {
  const leading = s.match(/^(\s*)/)?.[1] ?? "";
  const tabs = (leading.match(/\t/g) ?? []).length;
  const spaces = (leading.match(/ /g) ?? []).length;
  if (tabs && spaces) return `${tabs} tab(s) + ${spaces} space(s)`;
  if (tabs) return `${tabs} tab(s)`;
  return `${spaces} space(s)`;
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

/**
 * Build a diagnostic error message when all three matching passes fail.
 * Compares actual file content at searchIdx against expected patch content
 * and categorizes the mismatch (encoding artifact, indentation, or content).
 */
function buildDiagnosticError(
  filePath: string,
  fileLines: string[],
  expectedLines: string[],
  searchIdx: number,
): string {
  // Case: expected content past end of file
  if (searchIdx >= fileLines.length) {
    return (
      `Context mismatch in ${filePath}: expected ${expectedLines.length} context lines ` +
      `starting from line ${searchIdx + 1} but file only has ${fileLines.length} lines.`
    );
  }

  // Find first mismatching line
  for (let j = 0; j < expectedLines.length; j++) {
    const fileIdx = searchIdx + j;
    if (fileIdx >= fileLines.length) {
      return (
        `Context mismatch in ${filePath}: expected ${expectedLines.length} context lines ` +
        `starting from line ${searchIdx + 1} but file only has ${fileLines.length} lines.`
      );
    }

    const actual = fileLines[fileIdx]!;
    const expected = expectedLines[j]!;

    if (trimTrailing(actual) === trimTrailing(expected)) {
      continue; // This line matches, check next
    }

    const lineNum = fileIdx + 1;
    const actualTrunc = truncate(actual, 120);
    const expectedTrunc = truncate(expected, 120);

    // Check if normalized versions are equal (encoding artifact difference)
    if (normalizeLine(actual) === normalizeLine(expected)) {
      return (
        `Context mismatch in ${filePath} at line ${lineNum}. ` +
        `Expected: "${expectedTrunc}". Actual: "${actualTrunc}". ` +
        `Hint: lines match after normalization -- check for invisible characters (BOM, smart quotes, NBSP).`
      );
    }

    // Check if content matches after trimming leading whitespace (indentation mismatch)
    if (actual.trimStart() === expected.trimStart()) {
      return (
        `Context mismatch in ${filePath} at line ${lineNum}. ` +
        `Expected: "${expectedTrunc}" (indent: ${describeWhitespace(expected)}). ` +
        `Actual: "${actualTrunc}" (indent: ${describeWhitespace(actual)}). ` +
        `Hint: content matches but indentation differs.`
      );
    }

    // Genuinely different content
    return (
      `Context mismatch in ${filePath} at line ${lineNum}. ` +
      `Expected: "${expectedTrunc}". Actual: "${actualTrunc}".`
    );
  }

  // Fallback: no specific mismatch found (shouldn't reach here)
  return (
    `Context mismatch in ${filePath}: ` +
    `could not find matching context starting from line ${searchIdx + 1}.`
  );
}

/**
 * Find the line index in `fileLines` where `contextLines` starts matching,
 * searching from `startIdx` onward. Uses a three-pass matching cascade:
 *
 * - Pass 1 (exact): trimTrailing() byte-for-byte comparison
 * - Pass 2 (normalized): normalizeLine() comparison (handles BOM, smart quotes, NBSP)
 * - Pass 3 (similarity): Ratcliff/Obershelp similarity >= 0.8 threshold,
 *   with a 10-char minimum on context lines for the similarity pass
 *
 * @returns Match result with index and matchType, or { index: -1 } if not found.
 */
function findContextMatch(
  fileLines: string[],
  contextLines: string[],
  startIdx: number,
): { index: number; matchType: "exact" | "normalized" | "similarity" } | { index: -1 } {
  if (contextLines.length === 0) {
    return { index: startIdx, matchType: "exact" };
  }

  const upperBound = fileLines.length - contextLines.length;

  // Pass 1: exact (trimTrailing comparison -- preserves original behavior)
  for (let i = startIdx; i <= upperBound; i++) {
    let matched = true;
    for (let j = 0; j < contextLines.length; j++) {
      if (trimTrailing(fileLines[i + j]!) !== trimTrailing(contextLines[j]!)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { index: i, matchType: "exact" };
    }
  }

  // Pass 2: normalized (normalizeLine comparison -- handles encoding artifacts)
  for (let i = startIdx; i <= upperBound; i++) {
    let matched = true;
    for (let j = 0; j < contextLines.length; j++) {
      if (normalizeLine(fileLines[i + j]!) !== normalizeLine(contextLines[j]!)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { index: i, matchType: "normalized" };
    }
  }

  // Pass 3: similarity (Ratcliff/Obershelp >= 0.8, with 10-char minimum)
  for (let i = startIdx; i <= upperBound; i++) {
    let matched = true;
    for (let j = 0; j < contextLines.length; j++) {
      const contextTrimmed = contextLines[j]!.trim();
      if (contextTrimmed.length < 10) {
        // Short lines: must match via exact or normalized comparison
        if (
          trimTrailing(fileLines[i + j]!) !== trimTrailing(contextLines[j]!) &&
          normalizeLine(fileLines[i + j]!) !== normalizeLine(contextLines[j]!)
        ) {
          matched = false;
          break;
        }
      } else {
        // Long lines: similarity score must be >= 0.8
        const score = similarity(
          normalizeLine(fileLines[i + j]!),
          normalizeLine(contextLines[j]!),
        );
        if (score < 0.8) {
          matched = false;
          break;
        }
      }
    }
    if (matched) {
      return { index: i, matchType: "similarity" };
    }
  }

  return { index: -1 };
}

/**
 * Apply a single hunk to file lines, starting search from `searchIdx`.
 *
 * @returns Updated file lines and the new search index, or an error string.
 */
function applyHunk(
  fileLines: string[],
  hunk: PatchHunk,
  searchIdx: number,
  filePath: string,
): { lines: string[]; nextIdx: number } | { error: string } {
  // End of File hunks: append additions at end
  if (hunk.endOfFile) {
    return {
      lines: [...fileLines, ...hunk.additions],
      nextIdx: fileLines.length + hunk.additions.length,
    };
  }

  // Build the full expected sequence: contextBefore + removals
  const expectedLines = [...hunk.contextBefore, ...hunk.removals];

  if (expectedLines.length === 0) {
    // No context or removals -- only additions. Insert at current position.
    const result = [...fileLines];
    result.splice(searchIdx, 0, ...hunk.additions);
    return { lines: result, nextIdx: searchIdx + hunk.additions.length };
  }

  // Find where contextBefore starts
  const matchResult = findContextMatch(fileLines, expectedLines, searchIdx);
  if ("index" in matchResult && matchResult.index === -1) {
    return {
      error: buildDiagnosticError(filePath, fileLines, expectedLines, searchIdx),
    };
  }
  const matchIdx = matchResult.index;

  // Build result: everything before match + contextBefore + additions + contextAfter + rest
  const beforeMatch = fileLines.slice(0, matchIdx);
  const afterRemoval = fileLines.slice(
    matchIdx + hunk.contextBefore.length + hunk.removals.length,
  );

  // Keep original context lines (not patch versions) to preserve original whitespace
  const originalContextBefore = fileLines.slice(
    matchIdx,
    matchIdx + hunk.contextBefore.length,
  );

  // Context after: we need to keep the original file lines for contextAfter too.
  // The contextAfter from the hunk tells us how many trailing context lines to expect.
  // Those lines remain in the file (they come from afterRemoval's start).

  const result = [
    ...beforeMatch,
    ...originalContextBefore,
    ...hunk.additions,
  ];

  // afterRemoval already contains the lines after the removed block,
  // which includes the contextAfter lines (they weren't removed).
  result.push(...afterRemoval);

  const nextIdx =
    beforeMatch.length +
    originalContextBefore.length +
    hunk.additions.length +
    hunk.contextAfter.length;

  return { lines: result, nextIdx };
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

/**
 * Validate a file path through safePath and return the resolved absolute path.
 * Falls back to sharedPaths if the path is outside the workspace.
 * Returns an error result if path traversal is detected in all bases.
 */
function validatePath(
  workspacePath: string,
  filePath: string,
  resolvedSharedPaths?: string[],
): string {
  try {
    return safePath(workspacePath, filePath);
  } catch (error) {
    if (error instanceof PathTraversalError) {
      // Try shared paths before returning error
      if (resolvedSharedPaths && resolvedSharedPaths.length > 0) {
        for (const sp of resolvedSharedPaths) {
          try {
            return safePath(sp, filePath);
          } catch {
            // This shared path didn't match -- try next
          }
        }
      }
      throwToolError("permission_denied", `Path traversal blocked: ${filePath}.`);
    }
    throw error;
  }
}

async function handleAdd(
  op: PatchOperation,
  workspacePath: string,
  resolvedSharedPaths?: string[],
): Promise<void> {
  const resolved = validatePath(workspacePath, op.path, resolvedSharedPaths);

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const content = (op.newContent ?? []).join("\n");
  await fs.writeFile(resolved, content, "utf-8");
}

async function handleDelete(
  op: PatchOperation,
  workspacePath: string,
  resolvedSharedPaths?: string[],
): Promise<void> {
  const resolved = validatePath(workspacePath, op.path, resolvedSharedPaths);

  try {
    await fs.unlink(resolved);
  } catch {
    // File may not exist -- that's acceptable for delete
  }
}

async function handleUpdate(
  op: PatchOperation,
  workspacePath: string,
  resolvedSharedPaths?: string[],
): Promise<void> {
  const resolved = validatePath(workspacePath, op.path, resolvedSharedPaths);

  // Read current file content
  let fileContent: string;
  try {
    fileContent = await fs.readFile(resolved, "utf-8");
  } catch {
    return throwToolError("not_found", `Cannot read file for update: ${op.path}.`);
  }

  let fileLines = fileContent.split("\n");
  let searchIdx = 0;

  // Apply each hunk sequentially
  for (const hunk of op.hunks ?? []) {
    const result = applyHunk(fileLines, hunk, searchIdx, op.path);
    if ("error" in result) {
      let hint = "Re-read the file to get current content.";
      if (result.error.includes("indentation differs")) {
        hint = "Check tabs vs spaces in context lines.";
      } else if (result.error.includes("invisible characters")) {
        hint = "Strip encoding artifacts (BOM, smart quotes, NBSP) from context lines.";
      }
      throwToolError("conflict", result.error, { hint });
    }
    fileLines = result.lines;
    searchIdx = result.nextIdx;
  }

  // Write updated content
  const updatedContent = fileLines.join("\n");
  await fs.writeFile(resolved, updatedContent, "utf-8");

  // Handle move (rename) if specified
  if (op.moveTo) {
    const moveResolved = validatePath(workspacePath, op.moveTo, resolvedSharedPaths);

    await fs.mkdir(path.dirname(moveResolved), { recursive: true });
    await fs.rename(resolved, moveResolved);
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create an apply-patch AgentTool bound to a workspace directory.
 *
 * The tool parses *** Begin Patch formatted input and applies the operations
 * (add, update, delete, move) to files under the workspace. All file paths
 * are validated through safePath to prevent directory traversal.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @returns AgentTool that applies *** Begin Patch formatted patches
 */
/**
 * Check if a file path targets a protected workspace file.
 * Throws throwToolError if the file is protected, returns void otherwise.
 */
function checkProtectedFile(
  filePath: string,
  workspacePath: string,
  resolvedSharedPaths: string[],
  logger?: SafePathLogger,
): void {
  const basename = filePath.split("/").pop() ?? "";
  const redirectFile = PROTECTED_WORKSPACE_FILES.get(basename);
  if (!redirectFile) return;

  const allRoots = [workspacePath, ...resolvedSharedPaths];
  for (const root of allRoots) {
    try {
      const resolvedPath = safePath(root, filePath);
      const expectedPath = safePath(root, basename);
      if (resolvedPath === expectedPath) {
        logger?.warn({
          tool: "apply_patch",
          protectedFile: basename,
          redirectFile,
          hint: `Agent attempted to patch protected file ${basename}; use ${redirectFile} instead`,
          errorKind: "validation",
        }, "Protected workspace file patch blocked");
        throwToolError(
          "permission_denied",
          `Cannot modify ${basename} — this file contains protected platform instructions.`,
          { hint: `Use ${redirectFile} for agent-specific content instead.` },
        );
      }
    } catch (e) {
      // Re-throw tool errors (from throwToolError), skip path resolution errors
      if (e instanceof Error && e.message.startsWith("[")) throw e;
      // Path not in this root — try next
    }
  }
}

export function createApplyPatchTool(
  workspacePath: string,
  sharedPaths?: LazyPaths,
  logger?: SafePathLogger,
): AgentTool<typeof ApplyPatchParams> {
  return {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Apply multi-file modifications using *** Begin Patch format. " +
      "Supports Add, Update, Delete, and Move operations.",
    parameters: ApplyPatchParams,
    async execute(
      _toolCallId: string,
      params: { patch: string },
    ): Promise<AgentToolResult<unknown>> {
      // 1. Parse the patch
      const parseResult = parsePatch(params.patch);
      if (!parseResult.ok) {
        throwToolError("invalid_value", `Failed to parse patch: ${parseResult.error}.`);
      }

      const operations = parseResult.value;
      const applied: string[] = [];

      // Resolve sharedPaths once per patch execution (atomic for a single patch)
      const resolvedShared = resolvePaths(sharedPaths);

      // 2. Apply each operation (per-file mutation queue serializes same-file writes)
      for (const op of operations) {
        // Check protected workspace files before applying operation (throws if protected)
        checkProtectedFile(op.path, workspacePath, resolvedShared, logger);
        if (op.moveTo) {
          checkProtectedFile(op.moveTo, workspacePath, resolvedShared, logger);
        }

        // Resolve path for queue key (same resolution the handlers use internally)
        const queuePath = validatePath(workspacePath, op.path, resolvedShared);

        // Wrap each file operation individually -- different files run in parallel
        await withFileMutationQueue(queuePath, async () => {
          // Each handler throws throwToolError on failure, returns void on success
          switch (op.type) {
            case "add":
              await handleAdd(op, workspacePath, resolvedShared);
              break;
            case "delete":
              await handleDelete(op, workspacePath, resolvedShared);
              break;
            case "update":
              await handleUpdate(op, workspacePath, resolvedShared);
              break;
          }
        });

        const desc = op.moveTo
          ? `${op.type} ${op.path} -> ${op.moveTo}`
          : `${op.type} ${op.path}`;
        applied.push(desc);
      }

      // 3. Return success summary
      const summary = [
        `Applied ${applied.length} operation(s) successfully:`,
        ...applied.map((a) => `  - ${a}`),
      ].join("\n");

      return successResult(summary);
    },
  };
}
