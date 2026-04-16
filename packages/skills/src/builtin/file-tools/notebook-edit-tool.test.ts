/**
 * Tests for createComisNotebookEditTool factory function.
 *
 * Covers the full V1-V11 validation pipeline plus replace/insert/delete
 * operations, post-edit mtime recording, and result format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { createFileStateTracker } from "../file/file-state-tracker.js";
import type { FileStateTracker } from "../file/file-state-tracker.js";

const statOverride = vi.hoisted(() => {
  return { fn: undefined as ((path: string) => Promise<unknown>) | undefined };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (statOverride.fn) {
        const result = await statOverride.fn(String(args[0]));
        if (result !== undefined) return result;
      }
      return actual.stat(...args);
    },
  };
});

import * as fs from "node:fs/promises";
import { createComisNotebookEditTool } from "./notebook-edit-tool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tracker: FileStateTracker;

async function createWorkspace(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `nb-edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Minimal valid notebook JSON for testing. */
function makeNotebook(
  cells: Array<{
    id?: string;
    cell_type: string;
    source: string;
    outputs?: unknown[];
    execution_count?: number | null;
  }>,
  nbformat = 4,
  nbformatMinor = 5,
): string {
  return (
    JSON.stringify(
      {
        nbformat,
        nbformat_minor: nbformatMinor,
        metadata: {},
        cells: cells.map((c) => ({
          cell_type: c.cell_type,
          source: c.source,
          metadata: {},
          ...(c.id ? { id: c.id } : {}),
          ...(c.cell_type === "code"
            ? {
                outputs: c.outputs ?? [],
                execution_count: c.execution_count ?? null,
              }
            : {}),
        })),
      },
      null,
      1,
    ) + "\n"
  );
}

/** Write notebook, register in tracker, return path. */
async function writeAndRead(
  filename: string,
  content: string,
): Promise<string> {
  const filePath = path.join(workspaceDir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  const stat = await fs.stat(filePath);
  tracker.recordRead(filePath, stat.mtimeMs);
  return filePath;
}

beforeEach(async () => {
  workspaceDir = await createWorkspace();
  tracker = createFileStateTracker();
  statOverride.fn = undefined;
});

afterEach(async () => {
  statOverride.fn = undefined;
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("createComisNotebookEditTool", () => {
  // V1 - Extension check
  it("Test 1: rejects non-.ipynb file with [not_notebook]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t1", { path: "test.py", edit_mode: "replace", cell_id: "cell-0", new_source: "x" }),
    ).rejects.toThrow(/\[not_notebook\]/);
  });

  it("Test 2: .ipynb file passes extension check", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "x" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t2", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "y",
    });
    expect(result.content[0]!.text).toContain("Replaced");
  });

  // V2 - Edit mode validation
  it("Test 3: invalid edit_mode throws [invalid_edit_mode]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t3", { path: "test.ipynb", edit_mode: "patch", cell_id: "c", new_source: "x" }),
    ).rejects.toThrow(/\[invalid_edit_mode\]/);
  });

  it("Test 4: missing edit_mode defaults to replace", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "old" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t4", {
      path: "test.ipynb",
      cell_id: "abc",
      new_source: "new",
    });
    expect(result.content[0]!.text).toContain("Replaced");
  });

  // V3 - Cell type required for insert
  it("Test 5: insert without cell_type throws [missing_cell_type]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t5", { path: "test.ipynb", edit_mode: "insert", new_source: "x" }),
    ).rejects.toThrow(/\[missing_cell_type\]/);
  });

  // V3b - Cell ID required for replace/delete
  it("Test 6: replace without cell_id throws [missing_cell_id]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t6", { path: "test.ipynb", edit_mode: "replace", new_source: "x" }),
    ).rejects.toThrow(/\[missing_cell_id\]/);
  });

  it("Test 7: delete without cell_id throws [missing_cell_id]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t7", { path: "test.ipynb", edit_mode: "delete" }),
    ).rejects.toThrow(/\[missing_cell_id\]/);
  });

  // V3c - Source required for replace/insert
  it("Test 8: replace without new_source throws [missing_source]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t8", { path: "test.ipynb", edit_mode: "replace", cell_id: "c" }),
    ).rejects.toThrow(/\[missing_source\]/);
  });

  it("Test 9: insert without new_source throws [missing_source]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t9", { path: "test.ipynb", edit_mode: "insert", cell_type: "code" }),
    ).rejects.toThrow(/\[missing_source\]/);
  });

  // V4 - Path traversal
  it("Test 10: path traversal throws [path_traversal]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t10", {
        path: "../escape.ipynb",
        edit_mode: "replace",
        cell_id: "c",
        new_source: "x",
      }),
    ).rejects.toThrow(/\[path_traversal\]/);
  });

  // V5 - File not found
  it("Test 11: nonexistent file throws [file_not_found]", async () => {
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t11", {
        path: "nonexistent.ipynb",
        edit_mode: "replace",
        cell_id: "c",
        new_source: "x",
      }),
    ).rejects.toThrow(/\[file_not_found\]/);
  });

  // V8 - Read-before-edit
  it("Test 12: file not read throws [not_read]", async () => {
    const filePath = path.join(workspaceDir, "unread.ipynb");
    await fs.writeFile(filePath, makeNotebook([{ id: "a", cell_type: "code", source: "x" }]), "utf-8");
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t12", {
        path: "unread.ipynb",
        edit_mode: "replace",
        cell_id: "a",
        new_source: "y",
      }),
    ).rejects.toThrow(/\[not_read\]/);
  });

  // V9 - Staleness
  it("Test 13: stale file throws [stale_file]", async () => {
    const filePath = await writeAndRead(
      "stale.ipynb",
      makeNotebook([{ id: "a", cell_type: "code", source: "x" }]),
    );
    // Override stat to return different mtime
    statOverride.fn = async (p: string) => {
      if (p === filePath) {
        return { mtimeMs: Date.now() + 99999, size: 100, isFile: () => true };
      }
      return undefined;
    };
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t13", {
        path: "stale.ipynb",
        edit_mode: "replace",
        cell_id: "a",
        new_source: "y",
      }),
    ).rejects.toThrow(/\[stale_file\]/);
  });

  // V10 - Invalid JSON
  it("Test 14: invalid JSON throws [invalid_json]", async () => {
    await writeAndRead("bad.ipynb", "not json at all");
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t14", {
        path: "bad.ipynb",
        edit_mode: "replace",
        cell_id: "a",
        new_source: "y",
      }),
    ).rejects.toThrow(/\[invalid_json\]/);
  });

  // V11 - Cell not found
  it("Test 15: nonexistent cell throws [cell_not_found]", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "x" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await expect(
      tool.execute("t15", {
        path: "test.ipynb",
        edit_mode: "replace",
        cell_id: "nonexistent",
        new_source: "y",
      }),
    ).rejects.toThrow(/\[cell_not_found\]/);
  });

  // Replace operations
  it("Test 16: replace cell by ID updates source on disk", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "old code" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t16", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "new code",
    });
    expect(result.content[0]!.text).toContain("Replaced");
    expect(result.content[0]!.text).toContain("abc");
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells[0].source).toBe("new code");
  });

  it("Test 17: replace code cell clears outputs", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([
        {
          id: "abc",
          cell_type: "code",
          source: "old",
          outputs: [{ output_type: "stream", text: "hello" }],
          execution_count: 5,
        },
      ]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await tool.execute("t17", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "new",
    });
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells[0].outputs).toEqual([]);
    expect(nb.cells[0].execution_count).toBeNull();
  });

  it("Test 18: replace with cell_type change", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "code" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await tool.execute("t18", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "# Title",
      cell_type: "markdown",
    });
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells[0].cell_type).toBe("markdown");
    expect(nb.cells[0].source).toBe("# Title");
  });

  // Insert operations
  it("Test 19: insert cell after cell_id", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "first" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t19", {
      path: "test.ipynb",
      edit_mode: "insert",
      cell_id: "abc",
      new_source: "second",
      cell_type: "code",
    });
    expect(result.content[0]!.text).toContain("Inserted");
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[1].source).toBe("second");
  });

  it("Test 20: insert at beginning (no cell_id)", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "existing" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await tool.execute("t20", {
      path: "test.ipynb",
      edit_mode: "insert",
      new_source: "prepended",
      cell_type: "markdown",
    });
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0].source).toBe("prepended");
    expect(nb.cells[0].cell_type).toBe("markdown");
  });

  it("Test 21: inserted cell in nbformat 4.5 has id field", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "x" }], 4, 5),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await tool.execute("t21", {
      path: "test.ipynb",
      edit_mode: "insert",
      new_source: "new cell",
      cell_type: "code",
    });
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells[0].id).toMatch(/^[a-f0-9]{8}$/);
  });

  // Delete operation
  it("Test 22: delete cell by ID", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([
        { id: "abc", cell_type: "code", source: "first" },
        { id: "def", cell_type: "code", source: "second" },
      ]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t22", {
      path: "test.ipynb",
      edit_mode: "delete",
      cell_id: "abc",
    });
    expect(result.content[0]!.text).toContain("Deleted");
    const nb = JSON.parse(await fs.readFile(path.join(workspaceDir, "test.ipynb"), "utf-8"));
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0].source).toBe("second");
  });

  // Post-edit mtime
  it("Test 23: after edit, tracker allows immediate re-edit", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "old" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    await tool.execute("t23", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "new",
    });
    const resolvedPath = path.join(workspaceDir, "test.ipynb");
    expect(tracker.hasBeenRead(resolvedPath)).toBe(true);
    const stat = await fs.stat(resolvedPath);
    expect(tracker.checkStaleness(resolvedPath, stat.mtimeMs)).toEqual({ stale: false });
  });

  // Result format
  it("Test 24: result has content and details", async () => {
    await writeAndRead(
      "test.ipynb",
      makeNotebook([{ id: "abc", cell_type: "code", source: "old" }]),
    );
    const tool = createComisNotebookEditTool(workspaceDir, undefined, tracker);
    const result = await tool.execute("t24", {
      path: "test.ipynb",
      edit_mode: "replace",
      cell_id: "abc",
      new_source: "new",
    });
    expect(result.content[0]).toHaveProperty("type", "text");
    const details = result.details as Record<string, unknown>;
    expect(details).toHaveProperty("operation", "replace");
    expect(details).toHaveProperty("cellId", "abc");
    expect(details).toHaveProperty("cellCount", 1);
  });
});
