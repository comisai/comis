import { describe, it, expect } from "vitest";
import { parseNotebook, renderNotebookCells } from "./notebook-utils.js";

// Minimal valid .ipynb fixture
function makeNotebook(cells: unknown[], nbformat = 4, nbformatMinor = 5, metadata: Record<string, unknown> = {}): string {
  return JSON.stringify({ nbformat, nbformat_minor: nbformatMinor, metadata, cells });
}

function codeCell(source: string | string[], id?: string, outputs: unknown[] = [], executionCount: number | null = null): unknown {
  const cell: Record<string, unknown> = { cell_type: "code", source, outputs, metadata: {}, execution_count: executionCount };
  if (id !== undefined) cell.id = id;
  return cell;
}

function markdownCell(source: string | string[], id?: string): unknown {
  const cell: Record<string, unknown> = { cell_type: "markdown", source, outputs: [], metadata: {} };
  if (id !== undefined) cell.id = id;
  return cell;
}

describe("parseNotebook", () => {
  it("parses valid notebook with 2 cells", () => {
    const json = makeNotebook([codeCell("print(1)", "c1"), markdownCell("# Hello", "m1")]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells).toHaveLength(2);
  });

  it("extracts code cell with correct cellType, source, and outputs", () => {
    const json = makeNotebook([codeCell("x = 1", "c1", [{ output_type: "stream", text: "hello\n" }])]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cell = result.value.cells[0];
    expect(cell.cellType).toBe("code");
    expect(cell.source).toBe("x = 1");
    expect(cell.outputs).toHaveLength(1);
  });

  it("extracts markdown cell with empty outputs", () => {
    const json = makeNotebook([markdownCell("# Title", "m1")]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cell = result.value.cells[0];
    expect(cell.cellType).toBe("markdown");
    expect(cell.outputs).toHaveLength(0);
  });

  it("preserves cell id when present", () => {
    const json = makeNotebook([codeCell("1", "my-id")]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells[0].id).toBe("my-id");
  });

  it("generates synthetic cell-N id when missing", () => {
    const json = makeNotebook([codeCell("a"), codeCell("b")]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells[0].id).toBe("cell-1");
    expect(result.value.cells[1].id).toBe("cell-2");
  });

  it("extracts nbformat and nbformatMinor", () => {
    const json = makeNotebook([], 4, 5);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nbformat).toBe(4);
    expect(result.value.nbformatMinor).toBe(5);
  });

  it("returns err for invalid JSON", () => {
    const result = parseNotebook("{not valid json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("Invalid notebook JSON");
  });

  it("returns err for missing cells array", () => {
    const result = parseNotebook(JSON.stringify({ nbformat: 4 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("missing cells array");
  });

  it("joins source array into string", () => {
    const json = makeNotebook([codeCell(["line1\n", "line2"], "c1")]);
    const result = parseNotebook(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells[0].source).toBe("line1\nline2");
  });
});

describe("renderNotebookCells", () => {
  it("renders code cell with XML tags and id", () => {
    const json = makeNotebook([codeCell("print(1)", "cell-1")]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain('<code_cell id="cell-1">');
    expect(output).toContain("print(1)");
    expect(output).toContain("</code_cell>");
  });

  it("renders markdown cell with markdown_cell tag", () => {
    const json = makeNotebook([markdownCell("# Hello", "abc")]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain('<markdown_cell id="abc">');
    expect(output).toContain("</markdown_cell>");
  });

  it("renders output tag for cell with outputs", () => {
    const json = makeNotebook([codeCell("x", "c1", [{ output_type: "stream", text: "hello\n" }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain("<output>");
    expect(output).toContain("hello");
    expect(output).toContain("</output>");
  });

  it("renders execute_result text/plain content", () => {
    const json = makeNotebook([codeCell("1+1", "c1", [{ output_type: "execute_result", data: { "text/plain": "2" }, metadata: {} }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain("2");
  });

  it("renders stream output text", () => {
    const json = makeNotebook([codeCell("print('hi')", "c1", [{ output_type: "stream", text: "hi\n" }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain("hi");
  });

  it("does not render output tag for cell with no outputs", () => {
    const json = makeNotebook([codeCell("x = 1", "c1")]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).not.toContain("<output>");
  });
});

describe("truncation", () => {
  it("truncates output exceeding 10KB at last newline", () => {
    const bigLine = "x".repeat(500) + "\n";
    const bigOutput = bigLine.repeat(30); // ~15KB
    const json = makeNotebook([codeCell("x", "c1", [{ output_type: "stream", text: bigOutput }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain("[Output truncated. Use: jq '.cells[0].outputs' notebook.ipynb]");
  });

  it("does not truncate output under 10KB", () => {
    const smallOutput = "hello\n".repeat(10);
    const json = makeNotebook([codeCell("x", "c1", [{ output_type: "stream", text: smallOutput }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).not.toContain("truncated");
  });

  it("truncates at byte boundary when no newlines before 10KB", () => {
    const noNewlines = "x".repeat(15000);
    const json = makeNotebook([codeCell("x", "c1", [{ output_type: "stream", text: noNewlines }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value);
    expect(output).toContain("[Output truncated");
  });

  it("uses filePath option in jq hint when provided", () => {
    const bigOutput = ("x".repeat(500) + "\n").repeat(30);
    const json = makeNotebook([codeCell("x", "c1", [{ output_type: "stream", text: bigOutput }])]);
    const nb = parseNotebook(json);
    if (!nb.ok) throw new Error("parse failed");
    const output = renderNotebookCells(nb.value, { filePath: "my.ipynb" });
    expect(output).toContain("my.ipynb");
  });
});
