/**
 * Tests for createComisFindTool factory function.
 *
 * Covers:
 * - mtime sort (most recently modified first)
 * - limit + truncation notice
 * - hidden files (include_hidden toggle)
 * - .gitignore respect
 * - path security (safePath, readOnlyPaths, sharedPaths)
 * - no files found message
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createComisFindTool } from "./find-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from AgentToolResult content array. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Create a temporary workspace directory. */
async function createWorkspace(prefix = "find-tool-test"): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `${prefix}-`));
}

/** Write a file at a relative path under a base directory, creating parents. */
async function writeFile(base: string, relPath: string, content = "x"): Promise<string> {
  const abs = nodePath.join(base, relPath);
  await fs.mkdir(nodePath.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
}

/** Set a file's mtime to a specific timestamp (seconds from epoch). */
async function setMtime(filePath: string, epochSeconds: number): Promise<void> {
  await fs.utimes(filePath, epochSeconds, epochSeconds);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await createWorkspace();
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mtime sort (most recently modified first)
// ---------------------------------------------------------------------------

describe("mtime sort", () => {
  it("returns files sorted by modification time descending", async () => {
    const oldest = await writeFile(workspaceDir, "oldest.txt", "old");
    await setMtime(oldest, 1_000_000);

    const middle = await writeFile(workspaceDir, "middle.txt", "mid");
    await setMtime(middle, 1_000_002);

    const newest = await writeFile(workspaceDir, "newest.txt", "new");
    await setMtime(newest, 1_000_004);

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-1", { pattern: "*.txt" });

    const text = textOf(result);
    const lines = text.split("\n").filter(Boolean);

    expect(lines.length).toBe(3);
    // newest first
    expect(lines[0]).toBe("newest.txt");
    expect(lines[1]).toBe("middle.txt");
    expect(lines[2]).toBe("oldest.txt");
  });
});

// ---------------------------------------------------------------------------
// limit + truncation notice
// ---------------------------------------------------------------------------

describe("limit and truncation", () => {
  it("truncates results at limit and appends notice with total count", async () => {
    for (let i = 1; i <= 5; i++) {
      const f = await writeFile(workspaceDir, `file${i}.txt`, String(i));
      await setMtime(f, 1_000_000 + i);
    }

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-2", { pattern: "*.txt", limit: 3 });

    const text = textOf(result);
    const lines = text.split("\n").filter(Boolean);

    // 3 file paths + 1 truncation notice
    const filePaths = lines.filter((l) => !l.startsWith("["));
    expect(filePaths.length).toBe(3);
    expect(text).toContain("[Results limited to 3 files. Total matching: 5. Use a more specific pattern or increase limit.]");
  });

  it("limit=0 returns all files (unlimited)", async () => {
    for (let i = 1; i <= 5; i++) {
      await writeFile(workspaceDir, `file${i}.txt`, String(i));
    }

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-3", { pattern: "*.txt", limit: 0 });

    const text = textOf(result);
    const filePaths = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("["));
    expect(filePaths.length).toBe(5);
    expect(text).not.toContain("Results limited");
  });
});

// ---------------------------------------------------------------------------
// hidden files (include_hidden toggle)
// ---------------------------------------------------------------------------

describe("hidden files", () => {
  it("excludes hidden files by default", async () => {
    await writeFile(workspaceDir, "visible.ts");
    await writeFile(workspaceDir, ".hidden.ts");

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-4", { pattern: "*.ts" });

    const text = textOf(result);
    expect(text).toContain("visible.ts");
    expect(text).not.toContain(".hidden.ts");
  });

  it("includes hidden files when include_hidden is true", async () => {
    await writeFile(workspaceDir, "visible.ts");
    await writeFile(workspaceDir, ".hidden.ts");

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-5", { pattern: "*.ts", include_hidden: true });

    const text = textOf(result);
    expect(text).toContain("visible.ts");
    expect(text).toContain(".hidden.ts");
  });

  it("includes files inside hidden directories when include_hidden is true", async () => {
    await writeFile(workspaceDir, "src/app.ts");
    await writeFile(workspaceDir, ".config/settings.ts");

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-5b", { pattern: "**/*.ts", include_hidden: true });

    const text = textOf(result);
    expect(text).toContain("src/app.ts");
    expect(text).toContain(".config/settings.ts");
  });
});

// ---------------------------------------------------------------------------
// .gitignore respect
// ---------------------------------------------------------------------------

describe("gitignore filtering", () => {
  it("filters results through .gitignore patterns", async () => {
    await fs.writeFile(
      nodePath.join(workspaceDir, ".gitignore"),
      "*.log\ndist/\n",
      "utf-8",
    );
    await writeFile(workspaceDir, "src/app.ts");
    await writeFile(workspaceDir, "debug.log");
    await writeFile(workspaceDir, "dist/bundle.js");

    const tool = createComisFindTool(workspaceDir);
    // Use include_hidden=true so .gitignore file itself is not hidden
    // but the .gitignore filter should remove *.log and dist/
    const result = await tool.execute("call-6", { pattern: "**/*" });

    const text = textOf(result);
    expect(text).toContain("src/app.ts");
    expect(text).not.toContain("debug.log");
    expect(text).not.toContain("dist/bundle.js");
  });

  it("always excludes .git directory", async () => {
    await writeFile(workspaceDir, "src/app.ts");
    await writeFile(workspaceDir, ".git/config");

    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-7", { pattern: "**/*", include_hidden: true });

    const text = textOf(result);
    expect(text).toContain("src/app.ts");
    expect(text).not.toContain(".git/config");
  });
});

// ---------------------------------------------------------------------------
// path security (safePath, readOnlyPaths, sharedPaths)
// ---------------------------------------------------------------------------

describe("path security", () => {
  it("returns error for path traversal attempt", async () => {
    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-8", {
      pattern: "*.txt",
      path: "../../etc/passwd",
    });

    const text = textOf(result);
    expect(text).toContain("[path_traversal]");
  });

  it("allows searching in readOnlyPaths", async () => {
    const roDir = await createWorkspace("find-ro");
    try {
      await writeFile(roDir, "lib.ts");

      const tool = createComisFindTool(workspaceDir, undefined, [roDir]);
      const result = await tool.execute("call-9", {
        pattern: "*.ts",
        path: roDir,
      });

      const text = textOf(result);
      expect(text).toContain("lib.ts");
      expect(text).not.toContain("[path_traversal]");
    } finally {
      await fs.rm(roDir, { recursive: true, force: true });
    }
  });

  it("allows searching in sharedPaths", async () => {
    const sharedDir = await createWorkspace("find-shared");
    try {
      await writeFile(sharedDir, "data.ts");

      const tool = createComisFindTool(workspaceDir, undefined, undefined, [sharedDir]);
      const result = await tool.execute("call-10", {
        pattern: "*.ts",
        path: sharedDir,
      });

      const text = textOf(result);
      expect(text).toContain("data.ts");
      expect(text).not.toContain("[path_traversal]");
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// no files found message
// ---------------------------------------------------------------------------

describe("no files found", () => {
  it("returns 'No files found matching pattern' when nothing matches", async () => {
    const tool = createComisFindTool(workspaceDir);
    const result = await tool.execute("call-11", { pattern: "*.xyz" });

    const text = textOf(result);
    expect(text).toBe("No files found matching pattern");
  });
});
