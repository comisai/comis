// SPDX-License-Identifier: Apache-2.0
/**
 * Pure parser for the *** Begin Patch format.
 *
 * Parses Claude-style patch directives (Add, Update, Delete, Move) into
 * structured PatchOperation objects. No I/O -- context matching and file
 * operations happen in the tool layer.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * A single hunk within an update operation.
 * Context lines appear before/after the change; removals and additions
 * represent the actual diff.
 */
export interface PatchHunk {
  contextBefore: string[];
  removals: string[];
  additions: string[];
  contextAfter: string[];
  /** True when this hunk was preceded by *** End of File marker. */
  endOfFile?: boolean;
}

/**
 * A parsed patch operation (add, update, or delete a file).
 */
export interface PatchOperation {
  type: "add" | "update" | "delete";
  path: string;
  /** Rename target (update only). */
  moveTo?: string;
  /** Hunks for update operations. */
  hunks?: PatchHunk[];
  /** Full content for add operations (lines without + prefix). */
  newContent?: string[];
}

// ---------------------------------------------------------------------------
// Directive patterns
// ---------------------------------------------------------------------------

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const HUNK_HEADER = "@@ ";

/**
 * Create a fresh, empty PatchHunk.
 */
function emptyHunk(endOfFile = false): PatchHunk {
  const h: PatchHunk = {
    contextBefore: [],
    removals: [],
    additions: [],
    contextAfter: [],
  };
  if (endOfFile) {
    h.endOfFile = true;
  }
  return h;
}

/**
 * Hunk accumulation state. Context lines that appear before any +/- go into
 * contextBefore. After the first +/- block, subsequent context lines go into
 * contextAfter.
 */
type HunkPhase = "before" | "changes" | "after";

/**
 * Finalize a hunk being accumulated and push it onto the operation's hunks.
 * Only pushes if the hunk contains meaningful content.
 */
function finalizeHunk(hunk: PatchHunk, hunks: PatchHunk[]): void {
  if (
    hunk.contextBefore.length > 0 ||
    hunk.removals.length > 0 ||
    hunk.additions.length > 0 ||
    hunk.contextAfter.length > 0 ||
    hunk.endOfFile
  ) {
    hunks.push(hunk);
  }
}

/**
 * Parse a *** Begin Patch formatted string into structured PatchOperations.
 *
 * The parser is a simple state machine:
 * 1. Scan for *** Begin Patch
 * 2. Parse file directives (Add, Update, Delete) and their content
 * 3. Within Update, parse hunks (context, removals, additions)
 * 4. *** End Patch terminates
 *
 * @param input - The raw patch text
 * @returns Result with array of PatchOperations or error string
 */
export function parsePatch(input: string): Result<PatchOperation[], string> {
  const lines = input.split("\n");
  const operations: PatchOperation[] = [];

  // 1. Find *** Begin Patch
  let idx = 0;
  while (idx < lines.length && lines[idx]!.trim() !== BEGIN_PATCH) {
    idx++;
  }
  if (idx >= lines.length) {
    return err("Missing *** Begin Patch marker");
  }
  idx++; // advance past Begin Patch

  // Track whether we saw End Patch
  let endPatchSeen = false;

  // Current operation state
  let currentOp: PatchOperation | null = null;
  let currentHunk: PatchHunk | null = null;
  let hunkPhase: HunkPhase = "before";

  /**
   * Flush the current hunk into the current operation.
   */
  function flushHunk(): void {
    if (currentHunk && currentOp && currentOp.hunks) {
      finalizeHunk(currentHunk, currentOp.hunks);
    }
    currentHunk = null;
    hunkPhase = "before";
  }

  /**
   * Flush the current operation into the operations list.
   */
  function flushOp(): void {
    flushHunk();
    if (currentOp) {
      operations.push(currentOp);
    }
    currentOp = null;
  }

  while (idx < lines.length) {
    const line = lines[idx]!;

    // *** End Patch
    if (line.trim() === END_PATCH) {
      flushOp();
      endPatchSeen = true;
      break;
    }

    // *** Add File: <path>
    if (line.startsWith(ADD_FILE)) {
      flushOp();
      const filePath = line.slice(ADD_FILE.length).trim();
      currentOp = { type: "add", path: filePath, newContent: [] };
      idx++;
      continue;
    }

    // *** Delete File: <path>
    if (line.startsWith(DELETE_FILE)) {
      flushOp();
      const filePath = line.slice(DELETE_FILE.length).trim();
      currentOp = { type: "delete", path: filePath };
      idx++;
      continue;
    }

    // *** Update File: <path>
    if (line.startsWith(UPDATE_FILE)) {
      flushOp();
      const filePath = line.slice(UPDATE_FILE.length).trim();
      currentOp = { type: "update", path: filePath, hunks: [] };
      currentHunk = null;
      hunkPhase = "before";
      idx++;
      continue;
    }

    // *** Move to: <path> (only valid after Update File)
    if (line.startsWith(MOVE_TO)) {
      if (currentOp && currentOp.type === "update") {
        currentOp.moveTo = line.slice(MOVE_TO.length).trim();
      }
      idx++;
      continue;
    }

    // *** End of File (insert-at-end marker)
    if (line.trim() === END_OF_FILE) {
      if (currentOp && currentOp.type === "update") {
        flushHunk();
        currentHunk = emptyHunk(true);
        hunkPhase = "before";
      }
      idx++;
      continue;
    }

    // @@ hunk header (start new hunk)
    if (line.startsWith(HUNK_HEADER)) {
      if (currentOp && currentOp.type === "update") {
        flushHunk();
        currentHunk = emptyHunk();
        hunkPhase = "before";
      }
      idx++;
      continue;
    }

    // Unrecognized *** directive
    if (line.startsWith("*** ")) {
      return err(`Unrecognized directive: ${line}`);
    }

    // Content lines for Add operations
    if (currentOp && currentOp.type === "add") {
      if (line.startsWith("+")) {
        currentOp.newContent!.push(line.slice(1));
      }
      // Lines that don't start with + in an Add block are ignored
      idx++;
      continue;
    }

    // Content lines for Update operations (hunk lines)
    if (currentOp && currentOp.type === "update") {
      // Lazily start a hunk if we haven't yet
      if (!currentHunk) {
        currentHunk = emptyHunk();
        hunkPhase = "before";
      }

      if (line.startsWith("-")) {
        // Removal line -- transition to "changes" phase
        if (hunkPhase === "after") {
          // Context after a change block means we need a new implicit hunk
          // Actually, contextAfter followed by - means the contextAfter
          // was really contextBefore of this removal in the same hunk.
          // In our model, once we're in "after" and see a change, it means
          // those after-context lines belong to the current hunk's contextAfter
          // and we don't start a new hunk -- the hunk just has interleaved changes.
          // However, for simplicity, let's move contextAfter lines to be part of
          // a continuation. Actually let's keep it simple: contextAfter lines
          // that appear before more changes mean the hunk has mixed content.
          // We'll move them back to be context between change regions.
          // For correctness of context matching in the tool, we keep them as
          // contextAfter and the matcher must handle it.
          // Actually, re-examining: the plan says hunks are separated by @@.
          // Context after changes is trailing context. If more changes appear
          // WITHOUT an @@ separator, they're part of the same hunk.
          // We'll just keep accumulating in the same hunk.
        }
        hunkPhase = "changes";
        currentHunk.removals.push(line.slice(1));
      } else if (line.startsWith("+")) {
        hunkPhase = "changes";
        currentHunk.additions.push(line.slice(1));
      } else if (line.startsWith(" ") || line === "") {
        // Context line (space-prefixed) or empty line
        const content = line === "" ? "" : line.slice(1);
        if (hunkPhase === "before") {
          currentHunk.contextBefore.push(content);
        } else {
          // After seeing changes, context goes to contextAfter
          hunkPhase = "after";
          currentHunk.contextAfter.push(content);
        }
      }
      idx++;
      continue;
    }

    // Line outside any operation -- skip
    idx++;
  }

  if (!endPatchSeen) {
    return err("Missing *** End Patch marker");
  }

  return ok(operations);
}
