// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createComisLsTool factory function.
 *
 * Covers:
 * - alphabetical sort + trailing / for directories
 * - limit + truncation notice
 * - dotfiles included by default
 * - path security (safePath, readOnlyPaths, sharedPaths)
 * - error messages (non-directory, missing, empty)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createComisLsTool } from "./ls-tool.js";

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
async function createWorkspace(prefix = "ls-tool-test"): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `${prefix}-`));
}

/** Write a file at a relative path under a base directory, creating parents. */
async function writeFile(base: string, relPath: string, content = "x"): Promise<string> {
  const abs = nodePath.join(base, relPath);
  await fs.mkdir(nodePath.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
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
// alphabetical sort with type indicators
// ---------------------------------------------------------------------------

describe("alphabetical sort with type indicators", () => {
  it("returns entries sorted alphabetically with trailing / for directories", async () => {
    await writeFile(workspaceDir, "banana.txt");
    await writeFile(workspaceDir, "apple.txt");
    await fs.mkdir(nodePath.join(workspaceDir, "docs"));

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-1", { path: "." });

    const text = textOf(result);
    const lines = text.split("\n").filter(Boolean);

    expect(lines).toEqual(["apple.txt", "banana.txt", "docs/"]);
  });

  it("uses case-insensitive sort", async () => {
    await writeFile(workspaceDir, "Zebra.txt");
    await writeFile(workspaceDir, "alpha.txt");
    await writeFile(workspaceDir, "Beta.txt");

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-2", { path: "." });

    const text = textOf(result);
    const lines = text.split("\n").filter(Boolean);

    expect(lines).toEqual(["alpha.txt", "Beta.txt", "Zebra.txt"]);
  });
});

// ---------------------------------------------------------------------------
// limit and truncation
// ---------------------------------------------------------------------------

describe("limit and truncation", () => {
  it("truncates results at limit and appends notice with total count", async () => {
    for (let i = 1; i <= 10; i++) {
      await writeFile(workspaceDir, `file${String(i).padStart(2, "0")}.txt`);
    }

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-3", { path: ".", limit: 3 });

    const text = textOf(result);
    const lines = text.split("\n").filter(Boolean);

    // 3 entries + 1 truncation notice
    const entries = lines.filter((l) => !l.startsWith("["));
    expect(entries.length).toBe(3);
    expect(text).toContain("[7 more entries not shown. Total: 10]");
  });

  it("default limit of 500 allows large directories", async () => {
    for (let i = 1; i <= 5; i++) {
      await writeFile(workspaceDir, `file${i}.txt`);
    }

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-4", { path: "." });

    const text = textOf(result);
    const entries = text.split("\n").filter(Boolean);
    expect(entries.length).toBe(5);
    expect(text).not.toContain("more entries not shown");
  });
});

// ---------------------------------------------------------------------------
// dotfiles included by default
// ---------------------------------------------------------------------------

describe("dotfiles included", () => {
  it("includes dotfiles in listing by default", async () => {
    await writeFile(workspaceDir, ".hidden");
    await writeFile(workspaceDir, ".gitignore");
    await writeFile(workspaceDir, "visible.txt");

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-5", { path: "." });

    const text = textOf(result);
    expect(text).toContain(".hidden");
    expect(text).toContain(".gitignore");
    expect(text).toContain("visible.txt");
  });
});

// ---------------------------------------------------------------------------
// path security (safePath + readOnlyPaths + sharedPaths)
// ---------------------------------------------------------------------------

describe("path security", () => {
  it("returns error for path traversal attempt", async () => {
    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-6", { path: "../../etc" });

    const text = textOf(result);
    expect(text).toContain("[path_traversal]");
  });

  it("allows listing readOnlyPaths directories", async () => {
    const roDir = await createWorkspace("ls-ro");
    try {
      await writeFile(roDir, "lib.ts");

      const tool = createComisLsTool(workspaceDir, undefined, [roDir]);
      const result = await tool.execute("call-7", { path: roDir });

      const text = textOf(result);
      expect(text).toContain("lib.ts");
      expect(text).not.toContain("[path_traversal]");
    } finally {
      await fs.rm(roDir, { recursive: true, force: true });
    }
  });

  it("allows listing sharedPaths directories", async () => {
    const sharedDir = await createWorkspace("ls-shared");
    try {
      await writeFile(sharedDir, "data.ts");

      const tool = createComisLsTool(workspaceDir, undefined, undefined, [sharedDir]);
      const result = await tool.execute("call-8", { path: sharedDir });

      const text = textOf(result);
      expect(text).toContain("data.ts");
      expect(text).not.toContain("[path_traversal]");
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// error messages
// ---------------------------------------------------------------------------

describe("error messages", () => {
  it("returns error for non-directory path", async () => {
    await writeFile(workspaceDir, "regular.txt");

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-9", { path: "regular.txt" });

    const text = textOf(result);
    expect(text).toContain("Not a directory: regular.txt. Use the read tool for files.");
  });

  it("returns error for missing directory", async () => {
    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-10", { path: "nonexistent-dir" });

    const text = textOf(result);
    expect(text).toContain("Directory not found: nonexistent-dir");
  });

  it("returns (empty directory) for empty directory", async () => {
    await fs.mkdir(nodePath.join(workspaceDir, "empty"));

    const tool = createComisLsTool(workspaceDir);
    const result = await tool.execute("call-11", { path: "empty" });

    const text = textOf(result);
    expect(text).toBe("(empty directory)");
  });
});
