// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { NotebookCell } from "./notebook-utils.js";
import {
  resolveCellIndex,
  generateCellId,
  replaceCell,
  insertCell,
  deleteCell,
  serializeNotebook,
} from "./notebook-edit-ops.js";

function makeParsedCells(ids: string[]): NotebookCell[] {
  return ids.map((id, i) => ({
    id,
    cellType: "code" as const,
    source: `cell ${i}`,
    outputs: [],
    metadata: {},
    executionCount: null,
  }));
}

function makeRawCodeCell(source: string): Record<string, unknown> {
  return {
    cell_type: "code",
    source,
    metadata: {},
    outputs: [{ output_type: "stream", text: "hello" }],
    execution_count: 5,
  };
}

function makeRawMarkdownCell(source: string): Record<string, unknown> {
  return {
    cell_type: "markdown",
    source,
    metadata: {},
  };
}

describe("resolveCellIndex", () => {
  it("finds cell by exact ID match", () => {
    const cells = makeParsedCells(["abc123", "def456"]);
    expect(resolveCellIndex(cells, "def456")).toBe(1);
  });

  it("finds cell by synthetic cell-N ID", () => {
    const cells = makeParsedCells(["cell-1", "cell-2"]);
    expect(resolveCellIndex(cells, "cell-1")).toBe(0);
  });

  it("falls back to cell-N numeric format", () => {
    const cells = makeParsedCells(["realid1", "realid2"]);
    expect(resolveCellIndex(cells, "cell-0")).toBe(0);
  });

  it("cell-N out of bounds returns undefined", () => {
    const cells = makeParsedCells(["a", "b"]);
    expect(resolveCellIndex(cells, "cell-5")).toBeUndefined();
  });

  it("non-matching ID returns undefined", () => {
    const cells = makeParsedCells(["a", "b"]);
    expect(resolveCellIndex(cells, "nonexistent")).toBeUndefined();
  });

  it("prefers exact match over numeric", () => {
    const cells = makeParsedCells(["cell-0", "other"]);
    expect(resolveCellIndex(cells, "cell-0")).toBe(0);
  });
});

describe("generateCellId", () => {
  it("returns 8-character string", () => {
    expect(generateCellId()).toHaveLength(8);
  });

  it("returns only lowercase hex characters", () => {
    expect(generateCellId()).toMatch(/^[a-f0-9]{8}$/);
  });

  it("returns unique values on repeated calls", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateCellId()));
    expect(ids.size).toBe(10);
  });
});

describe("replaceCell", () => {
  it("sets source to new string value on raw cell", () => {
    const rawCells = [makeRawCodeCell("old")];
    replaceCell(rawCells, 0, "new content");
    expect(rawCells[0]!.source).toBe("new content");
  });

  it("clears outputs and execution_count for code cell", () => {
    const rawCells = [makeRawCodeCell("old")];
    replaceCell(rawCells, 0, "new");
    expect(rawCells[0]!.outputs).toEqual([]);
    expect(rawCells[0]!.execution_count).toBeNull();
  });

  it("preserves outputs for markdown cell", () => {
    const rawCells = [makeRawMarkdownCell("old")];
    replaceCell(rawCells, 0, "new");
    expect(rawCells[0]!.source).toBe("new");
    expect(Object.prototype.hasOwnProperty.call(rawCells[0], "outputs")).toBe(false);
  });

  it("changes cell_type when newCellType provided", () => {
    const rawCells = [makeRawCodeCell("old")];
    replaceCell(rawCells, 0, "new", "markdown");
    expect(rawCells[0]!.cell_type).toBe("markdown");
  });

  it("clears outputs when changing TO code cell_type", () => {
    const rawCells = [makeRawMarkdownCell("old")];
    replaceCell(rawCells, 0, "new", "code");
    expect(rawCells[0]!.outputs).toEqual([]);
    expect(rawCells[0]!.execution_count).toBeNull();
  });
});

describe("insertCell", () => {
  it("adds cell after specified index", () => {
    const rawCells = [makeRawCodeCell("a"), makeRawCodeCell("b")];
    insertCell(rawCells, 0, "new", "code", 4, 5);
    expect(rawCells).toHaveLength(3);
    expect(rawCells[1]!.source).toBe("new");
  });

  it("at index -1 prepends cell", () => {
    const rawCells = [makeRawCodeCell("a"), makeRawCodeCell("b")];
    insertCell(rawCells, -1, "new", "code", 4, 5);
    expect(rawCells).toHaveLength(3);
    expect(rawCells[0]!.source).toBe("new");
  });

  it("sets source, cell_type, metadata on new cell", () => {
    const rawCells: Record<string, unknown>[] = [];
    insertCell(rawCells, -1, "print(1)", "code", 4, 5);
    expect(rawCells[0]!.source).toBe("print(1)");
    expect(rawCells[0]!.cell_type).toBe("code");
    expect(rawCells[0]!.metadata).toEqual({});
  });

  it("generates id for nbformat 4.5+", () => {
    const rawCells: Record<string, unknown>[] = [];
    insertCell(rawCells, -1, "x", "code", 4, 5);
    expect(rawCells[0]!.id).toMatch(/^[a-f0-9]{8}$/);
  });

  it("omits id field for nbformat 4.4", () => {
    const rawCells: Record<string, unknown>[] = [];
    insertCell(rawCells, -1, "x", "code", 4, 4);
    expect(Object.prototype.hasOwnProperty.call(rawCells[0], "id")).toBe(false);
  });

  it("code cell has outputs [] and execution_count null", () => {
    const rawCells: Record<string, unknown>[] = [];
    insertCell(rawCells, -1, "x", "code", 4, 5);
    expect(rawCells[0]!.outputs).toEqual([]);
    expect(rawCells[0]!.execution_count).toBeNull();
  });

  it("markdown cell has NO outputs or execution_count keys", () => {
    const rawCells: Record<string, unknown>[] = [];
    insertCell(rawCells, -1, "x", "markdown", 4, 5);
    expect(Object.prototype.hasOwnProperty.call(rawCells[0], "outputs")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rawCells[0], "execution_count")).toBe(false);
  });
});

describe("deleteCell", () => {
  it("removes cell at index", () => {
    const rawCells = [makeRawCodeCell("a"), makeRawCodeCell("b"), makeRawCodeCell("c")];
    deleteCell(rawCells, 1);
    expect(rawCells).toHaveLength(2);
  });

  it("preserves order of remaining cells", () => {
    const rawCells = [makeRawCodeCell("a"), makeRawCodeCell("b"), makeRawCodeCell("c")];
    deleteCell(rawCells, 1);
    expect(rawCells[0]!.source).toBe("a");
    expect(rawCells[1]!.source).toBe("c");
  });
});

describe("serializeNotebook", () => {
  it("produces valid JSON with 1-space indent", () => {
    const raw = { cells: [], metadata: {} };
    const result = serializeNotebook(raw);
    const lines = result.split("\n");
    // 1-space indent means nested keys start with single space
    expect(lines.some((l) => l.startsWith(" ") && !l.startsWith("  "))).toBe(true);
  });

  it("appends trailing newline", () => {
    const raw = { cells: [] };
    const result = serializeNotebook(raw);
    expect(result.endsWith("}\n")).toBe(true);
  });

  it("round-trips: parse output with JSON.parse succeeds", () => {
    const raw = { cells: [{ source: "hello" }], metadata: { lang: "python" } };
    const result = serializeNotebook(raw);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
