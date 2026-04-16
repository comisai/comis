import { ok, err, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";

export interface NotebookOutput {
  outputType: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface NotebookCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  outputs: NotebookOutput[];
  metadata: Record<string, unknown>;
  executionCount: number | null;
}

export interface NotebookData {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformatMinor: number;
}

const MAX_OUTPUT_BYTES = 10 * 1024;

/**
 * Parse Jupyter notebook JSON into typed NotebookData.
 * Returns err() for invalid JSON or missing cells array — never throws.
 */
export function parseNotebook(json: string): Result<NotebookData, Error> {
  const parsed = tryCatch(() => JSON.parse(json) as Record<string, unknown>);
  if (!parsed.ok) {
    return err(new Error(`Invalid notebook JSON: ${String(parsed.error)}`));
  }

  const raw = parsed.value;

  if (!Array.isArray(raw.cells)) {
    return err(new Error("Invalid notebook: missing cells array"));
  }

  const cells: NotebookCell[] = (raw.cells as Record<string, unknown>[]).map(
    (cell, index) => {
      const source = Array.isArray(cell.source)
        ? (cell.source as string[]).join("")
        : String(cell.source ?? "");

      const rawOutputs = Array.isArray(cell.outputs)
        ? (cell.outputs as Record<string, unknown>[])
        : [];

      const outputs: NotebookOutput[] = rawOutputs.map((o) => {
        const out: NotebookOutput = {
          outputType: String(o.output_type ?? ""),
        };
        if (typeof o.text === "string") {
          out.text = o.text;
        } else if (Array.isArray(o.text)) {
          out.text = (o.text as string[]).join("");
        }
        if (o.data && typeof o.data === "object") {
          out.data = o.data as Record<string, unknown>;
        }
        return out;
      });

      return {
        id: typeof cell.id === "string" ? cell.id : `cell-${index + 1}`,
        cellType: String(cell.cell_type ?? "code") as NotebookCell["cellType"],
        source,
        outputs,
        metadata: (cell.metadata as Record<string, unknown>) ?? {},
        executionCount:
          typeof cell.execution_count === "number"
            ? cell.execution_count
            : null,
      };
    },
  );

  return ok({
    cells,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    nbformat: typeof raw.nbformat === "number" ? raw.nbformat : 0,
    nbformatMinor:
      typeof raw.nbformat_minor === "number" ? raw.nbformat_minor : 0,
  });
}

function formatOutputText(output: NotebookOutput): string {
  if (output.outputType === "stream" && output.text) {
    return output.text;
  }
  if (
    (output.outputType === "execute_result" ||
      output.outputType === "display_data") &&
    output.data
  ) {
    const plain = output.data["text/plain"];
    if (typeof plain === "string") return plain;
    if (Array.isArray(plain)) return (plain as string[]).join("");
  }
  if (output.outputType === "error" && output.data) {
    const tb = output.data["traceback"];
    if (Array.isArray(tb)) return (tb as string[]).join("\n");
  }
  return "";
}

function truncateAtLine(text: string, maxBytes: number): string {
  const lastNewline = text.lastIndexOf("\n", maxBytes);
  if (lastNewline > 0) {
    return text.slice(0, lastNewline);
  }
  // No newline found — truncate at byte boundary
  return text.slice(0, maxBytes);
}

/**
 * Render notebook cells as XML-tagged text.
 * Outputs exceeding 10KB are truncated with a jq command hint.
 */
export function renderNotebookCells(
  notebook: NotebookData,
  options?: { filePath?: string },
): string {
  const filePath = options?.filePath ?? "notebook.ipynb";
  const parts: string[] = [];

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    const tagName =
      cell.cellType === "code"
        ? "code_cell"
        : cell.cellType === "markdown"
          ? "markdown_cell"
          : "raw_cell";

    let result = `<${tagName} id="${cell.id}">\n${cell.source}\n`;

    if (cell.outputs.length > 0) {
      let outputText = cell.outputs.map(formatOutputText).join("");

      if (Buffer.byteLength(outputText) > MAX_OUTPUT_BYTES) {
        outputText = truncateAtLine(outputText, MAX_OUTPUT_BYTES);
        outputText += `\n[Output truncated. Use: jq '.cells[${i}].outputs' ${filePath}]`;
      }

      result += `<output>\n${outputText}\n</output>\n`;
    }

    result += `</${tagName}>`;
    parts.push(result);
  }

  return parts.join("\n");
}
