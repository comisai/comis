/**
 * @module notebook-edit-ops
 * Pure-logic cell mutation algorithms for Jupyter notebook editing:
 * cell ID resolution, replace/insert/delete operations, cell ID
 * generation, and notebook serialization.
 *
 * This module has NO I/O, NO state, NO side effects. All functions
 * are pure and testable without filesystem setup. The notebook edit
 * tool factory (notebook-edit-tool.ts) consumes these functions.
 *
 * CRITICAL: Mutations operate on raw JSON objects (snake_case keys
 * like cell_type, execution_count). Do NOT use parsed NotebookData
 * types (camelCase) for mutations -- they are for read-only access.
 */

import { randomUUID } from "node:crypto";
import type { NotebookCell } from "./notebook-utils.js";

/**
 * Resolve a cell identifier to an array index.
 * 1. Exact ID match (handles both real IDs and synthetic cell-N from parseNotebook)
 * 2. cell-N numeric fallback (0-based index)
 * @returns Array index or undefined if not found
 */
export function resolveCellIndex(
  cells: NotebookCell[],
  cellId: string,
): number | undefined {
  const byId = cells.findIndex((c) => c.id === cellId);
  if (byId !== -1) return byId;

  const match = cellId.match(/^cell-(\d+)$/);
  if (match) {
    const index = parseInt(match[1]!, 10);
    if (index >= 0 && index < cells.length) return index;
  }

  return undefined;
}

/**
 * Generate an 8-character lowercase hex cell ID from a random UUID.
 */
export function generateCellId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Replace a cell's source content, optionally changing cell type.
 * Clears outputs and execution_count for code cells.
 * Mutates rawCells in place.
 */
export function replaceCell(
  rawCells: Record<string, unknown>[],
  index: number,
  newSource: string,
  newCellType?: "code" | "markdown" | "raw",
): void {
  const cell = rawCells[index]!;
  cell.source = newSource;
  if (newCellType !== undefined) {
    cell.cell_type = newCellType;
  }
  if ((cell.cell_type as string) === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }
}

/**
 * Insert a new cell after the given index. Use afterIndex=-1 to prepend.
 * Generates cell ID only for nbformat >= 4.5.
 * Code cells get outputs/execution_count; markdown/raw cells do not.
 * Mutates rawCells in place.
 */
export function insertCell(
  rawCells: Record<string, unknown>[],
  afterIndex: number,
  source: string,
  cellType: "code" | "markdown" | "raw",
  nbformat: number,
  nbformatMinor: number,
): void {
  const newCell: Record<string, unknown> = {
    cell_type: cellType,
    source,
    metadata: {},
  };
  if (nbformat > 4 || (nbformat === 4 && nbformatMinor >= 5)) {
    newCell.id = generateCellId();
  }
  if (cellType === "code") {
    newCell.outputs = [];
    newCell.execution_count = null;
  }
  rawCells.splice(afterIndex + 1, 0, newCell);
}

/**
 * Delete a cell at the given index. Mutates rawCells in place.
 */
export function deleteCell(
  rawCells: Record<string, unknown>[],
  index: number,
): void {
  rawCells.splice(index, 1);
}

/**
 * Serialize a raw notebook object to JSON with 1-space indent and trailing newline.
 */
export function serializeNotebook(raw: Record<string, unknown>): string {
  return JSON.stringify(raw, null, 1) + "\n";
}
