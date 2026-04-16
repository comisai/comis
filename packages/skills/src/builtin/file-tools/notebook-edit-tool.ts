/**
 * Native notebook edit tool: cell-level Jupyter notebook editing with
 * replace, insert, and delete operations.
 *
 * Follows the edit-tool.ts pattern: factory function returning AgentTool
 * with inline validation pipeline (V1-V11).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import { extname } from "node:path";
import { fromPromise } from "@comis/shared";
import { safePath, PathTraversalError } from "@comis/core";
import type { FileStateTracker } from "../file/file-state-tracker.js";
import { isDeviceFile } from "../file/file-state-tracker.js";
import { readStringParam } from "../platform/tool-helpers.js";
import {
  readFileWithMetadata,
  writeFilePreserving,
} from "./shared/file-encoding.js";
import { parseNotebook } from "./shared/notebook-utils.js";
import {
  resolveCellIndex,
  replaceCell,
  insertCell,
  deleteCell,
  serializeNotebook,
} from "./shared/notebook-edit-ops.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (1 GiB). Files above this are rejected. */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

const VALID_EDIT_MODES = new Set(["replace", "insert", "delete"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const NotebookEditParams = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the Jupyter notebook (.ipynb) to edit (relative to workspace or absolute)",
    }),
    cell_id: Type.Optional(
      Type.String({
        description:
          "Cell ID or index ('cell-N' format). For replace/delete: identifies the target cell. For insert: new cell goes after this cell. Omit to insert at beginning.",
      }),
    ),
    new_source: Type.Optional(
      Type.String({
        description:
          "New source content for the cell. Required for replace and insert.",
      }),
    ),
    cell_type: Type.Optional(
      Type.Union(
        [Type.Literal("code"), Type.Literal("markdown"), Type.Literal("raw")],
        {
          description:
            "Cell type. Required for insert. For replace, defaults to existing cell type.",
        },
      ),
    ),
    edit_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("replace"),
          Type.Literal("insert"),
          Type.Literal("delete"),
        ],
        {
          description:
            "Edit operation: replace (default), insert (new cell), or delete (remove cell).",
          default: "replace",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a notebook edit tool for cell-level Jupyter notebook operations.
 *
 * @param workspacePath - Workspace root for path resolution
 * @param logger - Optional structured logger
 * @param tracker - Optional file state tracker for read-before-edit enforcement
 * @returns AgentTool implementing notebook_edit
 */
export function createComisNotebookEditTool(
  workspacePath: string,
  logger?: ToolLogger,
  tracker?: FileStateTracker,
): AgentTool<typeof NotebookEditParams> {
  return {
    name: "notebook_edit",
    label: "Notebook Edit",
    description:
      "Edit Jupyter notebook (.ipynb) cells. Supports replace (update cell source), " +
      "insert (add new cell), and delete (remove cell) operations. Target cells by ID " +
      "or index (cell-1, cell-2, ...). You must read the notebook in the current response " +
      "before editing (reads from previous messages do not carry over). " +
      "For insert mode, cell_type is required. Code cell outputs and execution counts " +
      "are cleared on replace.",
    parameters: NotebookEditParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // V1 -- Extension check
      const filePath = readStringParam(params, "path")!;
      if (extname(filePath).toLowerCase() !== ".ipynb") {
        throw new Error(
          "[not_notebook] Only .ipynb files can be edited with notebook_edit. Use the edit tool for other file types.",
        );
      }

      // V2 -- Edit mode validation
      const editMode = (params.edit_mode as string | undefined) ?? "replace";
      if (!VALID_EDIT_MODES.has(editMode)) {
        throw new Error(
          `[invalid_edit_mode] Invalid edit_mode "${editMode}". Must be one of: replace, insert, delete.`,
        );
      }

      // V3 -- Conditional parameter validation
      const cellId = params.cell_id as string | undefined;
      const newSource = params.new_source as string | undefined;
      const cellType = params.cell_type as
        | "code"
        | "markdown"
        | "raw"
        | undefined;

      if (editMode === "insert" && !cellType) {
        throw new Error(
          "[missing_cell_type] cell_type is required for insert mode. Specify 'code', 'markdown', or 'raw'.",
        );
      }

      if ((editMode === "replace" || editMode === "delete") && !cellId) {
        throw new Error(
          `[missing_cell_id] cell_id is required for ${editMode} mode. Specify the target cell ID or index (e.g., 'cell-1').`,
        );
      }

      if (
        (editMode === "replace" || editMode === "insert") &&
        newSource === undefined
      ) {
        throw new Error(
          `[missing_source] new_source is required for ${editMode} mode. Provide the new cell content.`,
        );
      }

      // V4 -- Path resolution
      let resolvedPath: string;
      try {
        resolvedPath = safePath(workspacePath, filePath);
      } catch (error) {
        if (!(error instanceof PathTraversalError)) throw error;
        throw new Error(
          `[path_traversal] Path outside workspace bounds: ${filePath}`,
          { cause: error },
        );
      }

      // V5 -- File existence + stat
      const statResult = await fromPromise(fs.stat(resolvedPath));
      if (!statResult.ok) {
        throw new Error(`[file_not_found] File not found: ${filePath}`);
      }
      const stat = statResult.value;

      // V6 -- File size limit
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error("[file_too_large] File too large. Maximum: 1 GiB");
      }

      // V7 -- Device file check
      if (isDeviceFile(resolvedPath)) {
        throw new Error(
          `[device_file] Cannot edit device file: ${resolvedPath}`,
        );
      }

      // V8 -- Read-before-edit
      if (tracker && !tracker.hasBeenRead(resolvedPath)) {
        throw new Error(
          `[not_read] You must read the notebook before editing. Use the read tool first: read ${filePath}`,
        );
      }

      // V9 -- Staleness with content-hash fallback
      if (tracker) {
        const currentContent = await fs.readFile(resolvedPath);
        const staleness = tracker.checkStaleness(resolvedPath, stat.mtimeMs, currentContent);
        if (staleness.stale) {
          throw new Error(
            "[stale_file] Notebook was modified since you last read it (mtime changed). Read the notebook again before editing.",
          );
        }
      }

      // V10 -- Read and parse notebook
      const fileData = await readFileWithMetadata(resolvedPath);
      const parseResult = parseNotebook(fileData.content);
      if (!parseResult.ok) {
        throw new Error(
          `[invalid_json] Failed to parse notebook: ${parseResult.error.message}`,
        );
      }
      const notebook = parseResult.value;

      // Also parse raw JSON for mutations (raw uses snake_case keys)
      const raw = JSON.parse(fileData.content) as Record<string, unknown>;
      const rawCells = raw.cells as Record<string, unknown>[];

      // V11 -- Cell resolution (for replace and delete)
      let cellIndex: number | undefined;
      if (cellId) {
        cellIndex = resolveCellIndex(notebook.cells, cellId);
        if (cellIndex === undefined) {
          throw new Error(
            `[cell_not_found] Cell "${cellId}" not found. Available cells: ${notebook.cells.map((c) => c.id).join(", ")}`,
          );
        }
      }

      // -- Execute operation --
      if (editMode === "replace") {
        replaceCell(rawCells, cellIndex!, newSource!, cellType);
      } else if (editMode === "insert") {
        const afterIdx = cellIndex !== undefined ? cellIndex : -1;
        insertCell(
          rawCells,
          afterIdx,
          newSource!,
          cellType!,
          notebook.nbformat,
          notebook.nbformatMinor,
        );
      } else if (editMode === "delete") {
        deleteCell(rawCells, cellIndex!);
      }

      // -- Write back and record mtime --
      const serialized = serializeNotebook(raw);
      await writeFilePreserving(
        resolvedPath,
        serialized,
        fileData.encoding,
        fileData.lineEnding,
      );

      // Post-write: record new mtime + content hash for immediate re-edit support
      const newStat = await fs.stat(resolvedPath);
      const newNotebookContent = await fs.readFile(resolvedPath);
      tracker?.recordRead(resolvedPath, newStat.mtimeMs, undefined, undefined, newNotebookContent);

      // -- Build result --
      const opLabel =
        editMode === "replace"
          ? "Replaced"
          : editMode === "insert"
            ? "Inserted"
            : "Deleted";
      const targetLabel = cellId ?? "beginning";
      const resultText = `${opLabel} cell "${targetLabel}" in ${filePath}. Notebook now has ${rawCells.length} cell(s).`;

      logger?.debug(
        {
          path: filePath,
          operation: editMode,
          cellId: cellId ?? null,
          cellCount: rawCells.length,
        },
        "Notebook edit complete",
      );

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          operation: editMode,
          cellId: cellId ?? null,
          cellCount: rawCells.length,
        },
      };
    },
  };
}
