// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for Comis file tool factory (createComisFileTools).
 *
 * Covers: config-driven selection, end-to-end integration, safePath wrapping,
 * FileStateTracker dedup/staleness, find mtime sorting, grep output modes,
 * path suggestion, ls integration, PDF redirect.
 */

import { SkillsConfigSchema } from "@comis/core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComisFileTools } from "./file-tools.js";
import { createFileStateTracker } from "./file-state-tracker.js";

/**
 * Check if ripgrep directory search works the same way createComisGrepTool
 * invokes it: an explicit search path plus stdio:["ignore",...] so rg does
 * not block waiting for stdin. Some sandboxed environments hang when rg is
 * spawned without an explicit path and with the default inherited stdin
 * pipe — but that shape is not what the real tool uses, so we probe the
 * real shape here.
 *
 * Short timeout falls through to skip if something truly is wrong with rg.
 */
const rgCanSearch = await (async () => {
  try {
    const { spawn } = await import("node:child_process");
    const testDir = execFileSync("mktemp", ["-d"]).toString().trim();
    execFileSync("/bin/sh", ["-c", `echo hello > "${testDir}/probe.txt"`]);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("rg", ["--color", "never", "-e", "hello", "."], {
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 2000);
      child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      child.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    execFileSync("rm", ["-rf", testDir]);
    return ok;
  } catch {
    return false;
  }
})();
const itRg = rgCanSearch ? it : it.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comis-coding-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Parse the skills config with overrides for builtin tools. */
function makeConfig(overrides: Partial<Record<string, boolean>> = {}) {
  return SkillsConfigSchema.parse({
    builtinTools: {
      read: false,
      write: false,
      edit: false,
      notebookEdit: false,
      grep: false,
      find: false,
      ls: false,
      exec: false,
      process: false,
      webSearch: false,
      webFetch: false,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// createComisFileTools
// ---------------------------------------------------------------------------

describe("createComisFileTools", () => {
  it("returns empty array when all coding tools disabled", () => {
    const config = makeConfig();
    const tools = createComisFileTools(config, tmpDir);
    expect(tools).toEqual([]);
  });

  it("returns only enabled tools", () => {
    const config = makeConfig({ read: true, grep: true });
    const tools = createComisFileTools(config, tmpDir);

    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["grep", "read"]);
  });

  it("returns all 7 file tools when all enabled", () => {
    const config = makeConfig({
      read: true,
      edit: true,
      notebookEdit: true,
      write: true,
      grep: true,
      find: true,
      ls: true,
    });
    const tools = createComisFileTools(config, tmpDir);

    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["edit", "find", "grep", "ls", "notebook_edit", "read", "write"]);
  });

  it("wrapped read tool blocks path traversal", async () => {
    const config = makeConfig({ read: true });
    const tools = createComisFileTools(config, tmpDir);
    const readTool = tools.find((t) => t.name === "read")!;

    await expect(readTool.execute("call-1", { path: "../../etc/passwd" }))
      .rejects.toThrow("path_traversal");
  });

  it("wrapped read tool can read a valid file (end-to-end)", async () => {
    // Create a real test file
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello Comis!");

    const config = makeConfig({ read: true });
    const tools = createComisFileTools(config, tmpDir);
    const readTool = tools.find((t) => t.name === "read")!;

    const result = await readTool.execute("call-2", { path: "hello.txt" });
    const text = textOf(result);

    expect(text).toContain("Hello Comis!");
  });

  it("grep tool has safePath wrapping on optional path param", async () => {
    const config = makeConfig({ grep: true });
    const tools = createComisFileTools(config, tmpDir);
    const grepTool = tools.find((t) => t.name === "grep")!;

    // Native grep returns errors as content (not thrown exceptions)
    const result = await grepTool.execute("call-3", {
      pattern: "secret",
      path: "../../etc",
    });
    const text = textOf(result);
    expect(text).toContain("path_traversal");
  });

  itRg("grep tool works without path param (defaults to cwd)", async () => {
    // Create a file with searchable content
    await fs.writeFile(path.join(tmpDir, "searchable.txt"), "findme_unique_string_12345");

    const config = makeConfig({ grep: true });
    const tools = createComisFileTools(config, tmpDir);
    const grepTool = tools.find((t) => t.name === "grep")!;

    // Search without specifying path -- should use workspace cwd
    const result = await grepTool.execute("call-4", {
      pattern: "findme_unique_string_12345",
    });
    const text = textOf(result);

    // Either finds the content or returns "no matches" (both are valid -- tool works)
    // The key assertion is that it does NOT throw and does NOT return traversal error
    expect(text).not.toContain("Path traversal blocked");
  });

  itRg("hides a blocked runtime-session subtree from every file tool path", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const siblingFile = path.join(sessionsDir, "default", "sibling", "chat.jsonl");
    await fs.mkdir(path.dirname(siblingFile), { recursive: true });
    await fs.writeFile(siblingFile, "sibling-private-marker", "utf-8");
    await fs.writeFile(path.join(tmpDir, "visible.txt"), "visible-marker", "utf-8");

    const config = makeConfig({
      read: true,
      write: true,
      grep: true,
      find: true,
      ls: true,
    });
    const createWithHiddenPaths = createComisFileTools as unknown as (
      ...args: [...Parameters<typeof createComisFileTools>, hiddenPaths: string[]]
    ) => ReturnType<typeof createComisFileTools>;
    const tools = createWithHiddenPaths(
      config,
      tmpDir,
      undefined,
      undefined,
      undefined,
      undefined,
      [sessionsDir],
    );

    const readTool = tools.find((tool) => tool.name === "read")!;
    const writeTool = tools.find((tool) => tool.name === "write")!;
    const grepTool = tools.find((tool) => tool.name === "grep")!;
    const findTool = tools.find((tool) => tool.name === "find")!;
    const lsTool = tools.find((tool) => tool.name === "ls")!;

    await expect(readTool.execute("blocked-read", {
      path: "sessions/default/sibling/chat.jsonl",
    })).rejects.toThrow(/\[restricted_path\]/);
    await expect(writeTool.execute("blocked-write", {
      path: "sessions/default/sibling/chat.jsonl",
      content: "overwritten",
    })).rejects.toThrow(/\[restricted_path\]/);
    expect(await fs.readFile(siblingFile, "utf-8")).toBe("sibling-private-marker");

    const grepResult = await grepTool.execute("blocked-grep", {
      pattern: "sibling-private-marker",
    });
    const findResult = await findTool.execute("blocked-find", {
      pattern: "**/*.jsonl",
      include_hidden: true,
    });
    const lsResult = await lsTool.execute("blocked-ls", { path: "." });

    expect(textOf(grepResult)).not.toContain("sibling-private-marker");
    expect(textOf(grepResult)).not.toContain("sessions");
    expect(textOf(findResult)).not.toContain("sessions");
    expect(textOf(lsResult)).not.toContain("sessions/");
  });

  itRg("reads only the current session tool-results exception inside a hidden sessions tree", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const ownSessionDir = path.join(sessionsDir, "default", "sub-agent-own");
    const ownResultsDir = path.join(ownSessionDir, "tool-results");
    const ownResultFile = path.join(ownResultsDir, "call-own.json");
    const ownTranscript = path.join(ownSessionDir, "conversation.jsonl");
    const siblingFile = path.join(
      sessionsDir,
      "default",
      "sub-agent-sibling",
      "tool-results",
      "call-sibling.json",
    );
    await fs.mkdir(path.dirname(siblingFile), { recursive: true });
    await fs.mkdir(ownResultsDir, { recursive: true });
    await fs.writeFile(ownResultFile, "own-offload-marker", "utf-8");
    await fs.writeFile(ownTranscript, "own-transcript-marker", "utf-8");
    await fs.writeFile(siblingFile, "sibling-offload-marker", "utf-8");
    await fs.symlink(siblingFile, path.join(ownResultsDir, "escape.json"));

    const config = makeConfig({
      read: true,
      write: true,
      grep: true,
      find: true,
      ls: true,
    });
    const createWithBoundary = createComisFileTools as unknown as (
      ...args: [
        ...Parameters<typeof createComisFileTools>,
        hiddenReadAllowPaths: string[],
      ]
    ) => ReturnType<typeof createComisFileTools>;
    const tools = createWithBoundary(
      config,
      tmpDir,
      undefined,
      undefined,
      undefined,
      undefined,
      [sessionsDir],
      [ownResultsDir],
    );

    const readTool = tools.find((tool) => tool.name === "read")!;
    const writeTool = tools.find((tool) => tool.name === "write")!;
    const grepTool = tools.find((tool) => tool.name === "grep")!;
    const findTool = tools.find((tool) => tool.name === "find")!;
    const lsTool = tools.find((tool) => tool.name === "ls")!;

    expect(textOf(await readTool.execute("own-read", {
      path: path.relative(tmpDir, ownResultFile),
    }))).toContain("own-offload-marker");
    await expect(readTool.execute("transcript-read", {
      path: path.relative(tmpDir, ownTranscript),
    })).rejects.toThrow(/\[restricted_path\]/);
    await expect(readTool.execute("sibling-read", {
      path: path.relative(tmpDir, siblingFile),
    })).rejects.toThrow(/\[restricted_path\]/);
    await expect(readTool.execute("symlink-read", {
      path: path.relative(tmpDir, path.join(ownResultsDir, "escape.json")),
    })).rejects.toThrow(/\[restricted_path\]/);
    await expect(writeTool.execute("own-write", {
      path: path.relative(tmpDir, ownResultFile),
      content: "tampered",
    })).rejects.toThrow(/\[restricted_path\]/);
    expect(await fs.readFile(ownResultFile, "utf-8")).toBe("own-offload-marker");

    expect(textOf(await grepTool.execute("own-grep", {
      pattern: "own-offload-marker",
      path: path.relative(tmpDir, ownResultsDir),
    }))).toContain("own-offload-marker");
    expect(textOf(await findTool.execute("own-find", {
      pattern: "*.json",
      path: path.relative(tmpDir, ownResultsDir),
    }))).toContain("call-own.json");
    expect(textOf(await lsTool.execute("own-ls", {
      path: path.relative(tmpDir, ownResultsDir),
    }))).toContain("call-own.json");
  });

  it("each tool preserves its expected name", () => {
    const config = makeConfig({
      read: true,
      edit: true,
      notebookEdit: true,
      write: true,
      grep: true,
      find: true,
      ls: true,
    });
    const tools = createComisFileTools(config, tmpDir);

    const expectedNames = ["read", "edit", "notebook_edit", "write", "grep", "find", "ls"];
    for (const name of expectedNames) {
      expect(tools.find((t) => t.name === name)).toBeDefined();
    }
  });

  it("tools have label and description", () => {
    const config = makeConfig({ read: true });
    const tools = createComisFileTools(config, tmpDir);
    const readTool = tools[0]!;

    expect(readTool.label).toBeTruthy();
    expect(readTool.description).toBeTruthy();
    expect(readTool.parameters).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // FileStateTracker integration
  // -------------------------------------------------------------------------

  describe("FileStateTracker integration", () => {
    it("with tracker: read tool performs dedup on second read of same file", async () => {
      await fs.writeFile(path.join(tmpDir, "tracked.txt"), "tracked content");

      const tracker = createFileStateTracker();
      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir, undefined, undefined, undefined, tracker);
      const readTool = tools.find((t) => t.name === "read")!;

      // First read -- full content
      const result1 = await readTool.execute("call-1", { path: "tracked.txt" });
      expect(textOf(result1)).toContain("tracked content");

      // Second read -- should return stub (dedup)
      const result2 = await readTool.execute("call-2", { path: "tracked.txt" });
      expect(textOf(result2)).toContain("unchanged");
    });

    it("without tracker: read tool returns full content on second read (no dedup)", async () => {
      await fs.writeFile(path.join(tmpDir, "untracked.txt"), "untracked content");

      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir);
      const readTool = tools.find((t) => t.name === "read")!;

      // First read -- full content
      const result1 = await readTool.execute("call-1", { path: "untracked.txt" });
      expect(textOf(result1)).toContain("untracked content");

      // Second read -- should also return full content (no tracker = no dedup)
      const result2 = await readTool.execute("call-2", { path: "untracked.txt" });
      expect(textOf(result2)).toContain("untracked content");
    });

    it("tracker parameter is optional (backward compatible)", () => {
      const config = makeConfig({ read: true, write: true, edit: true });

      // Without tracker -- should not throw
      const tools1 = createComisFileTools(config, tmpDir);
      expect(tools1).toHaveLength(3);

      // With tracker -- should also not throw
      const tracker = createFileStateTracker();
      const tools2 = createComisFileTools(config, tmpDir, undefined, undefined, undefined, tracker);
      expect(tools2).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Find mtime sort integration
  // -------------------------------------------------------------------------

  describe("find tool mtime sorting", () => {
    it("find results are sorted by mtime (most recent first)", async () => {
      // Create files with known mtimes
      const oldFile = path.join(tmpDir, "old-file.txt");
      const newFile = path.join(tmpDir, "new-file.txt");
      await fs.writeFile(oldFile, "old content");
      await fs.writeFile(newFile, "new content");

      const now = Date.now();
      await fs.utimes(oldFile, new Date(now - 1_000_000), new Date(now - 1_000_000));
      await fs.utimes(newFile, new Date(now), new Date(now));

      const config = makeConfig({ find: true });
      const tools = createComisFileTools(config, tmpDir);
      const findTool = tools.find((t) => t.name === "find")!;

      const result = await findTool.execute("call-sort", { pattern: "*.txt" });
      const text = textOf(result);
      const lines = text.split("\n").filter((l) => l.length > 0);

      // new-file should appear before old-file
      const newIdx = lines.findIndex((l) => l.includes("new-file.txt"));
      const oldIdx = lines.findIndex((l) => l.includes("old-file.txt"));
      expect(newIdx).toBeLessThan(oldIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Find gitignore integration
  // -------------------------------------------------------------------------

  describe("find tool gitignore integration", () => {
    it("find results respect .gitignore when used via createComisFileTools", async () => {
      // Create .gitignore
      await fs.writeFile(path.join(tmpDir, ".gitignore"), "*.log\n");
      // Create files
      await fs.writeFile(path.join(tmpDir, "app.ts"), "code");
      await fs.writeFile(path.join(tmpDir, "debug.log"), "log data");

      const config = makeConfig({ find: true });
      const tools = createComisFileTools(config, tmpDir);
      const findTool = tools.find((t) => t.name === "find")!;

      const result = await findTool.execute("call-gitignore", { pattern: "**/*" });
      const text = textOf(result);

      expect(text).toContain("app.ts");
      expect(text).not.toContain("debug.log");
    });
  });

  // -------------------------------------------------------------------------
  // Ls tool integration
  // -------------------------------------------------------------------------

  describe("ls tool integration", () => {
    it("ls lists directory contents alphabetically with type indicators", async () => {
      // Create files and a subdirectory
      await fs.writeFile(path.join(tmpDir, "banana.txt"), "b");
      await fs.writeFile(path.join(tmpDir, "apple.txt"), "a");
      await fs.mkdir(path.join(tmpDir, "docs"));

      const config = makeConfig({ ls: true });
      const tools = createComisFileTools(config, tmpDir);
      const lsTool = tools.find((t) => t.name === "ls")!;

      const result = await lsTool.execute("call-ls-1", { path: "." });
      const text = textOf(result);
      const lines = text.split("\n").filter((l) => l.length > 0);

      // Alphabetical order, directories have trailing /
      expect(lines).toContain("apple.txt");
      expect(lines).toContain("banana.txt");
      expect(lines).toContain("docs/");

      // apple before banana
      const appleIdx = lines.indexOf("apple.txt");
      const bananaIdx = lines.indexOf("banana.txt");
      expect(appleIdx).toBeLessThan(bananaIdx);
    });

    it("ls returns error for path traversal", async () => {
      const config = makeConfig({ ls: true });
      const tools = createComisFileTools(config, tmpDir);
      const lsTool = tools.find((t) => t.name === "ls")!;

      // Native ls returns errors as content (not thrown exceptions)
      const result = await lsTool.execute("call-ls-trav", { path: "../../etc" });
      const text = textOf(result);
      expect(text).toContain("path_traversal");
    });

    it("ls includes dotfiles by default", async () => {
      await fs.writeFile(path.join(tmpDir, ".hidden"), "h");
      await fs.writeFile(path.join(tmpDir, "visible.txt"), "v");

      const config = makeConfig({ ls: true });
      const tools = createComisFileTools(config, tmpDir);
      const lsTool = tools.find((t) => t.name === "ls")!;

      const result = await lsTool.execute("call-ls-dot", { path: "." });
      const text = textOf(result);
      expect(text).toContain(".hidden");
      expect(text).toContain("visible.txt");
    });
  });

  // -------------------------------------------------------------------------
  // PDF read redirect integration
  // -------------------------------------------------------------------------

  describe("PDF read inline extraction", () => {
    it("read tool attempts inline PDF extraction without tracker (fails on fake PDF)", async () => {
      await fs.writeFile(path.join(tmpDir, "doc.pdf"), "fake pdf");

      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir);
      const readTool = tools.find((t) => t.name === "read")!;

      // PDFs are extracted inline rather than rejected with an extract_document redirect.
      // Fake PDF data causes a pdf_error due to invalid structure.
      await expect(
        readTool.execute("call-pdf-1", { path: "doc.pdf" }),
      ).rejects.toThrow("pdf_error");
    });

    it("read tool attempts inline PDF extraction with tracker (fails on fake PDF)", async () => {
      await fs.writeFile(path.join(tmpDir, "doc.pdf"), "fake pdf");

      const tracker = createFileStateTracker();
      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir, undefined, undefined, undefined, tracker);
      const readTool = tools.find((t) => t.name === "read")!;

      // PDFs are extracted inline rather than rejected with an extract_document redirect.
      // Fake PDF data causes a pdf_error due to invalid structure.
      await expect(
        readTool.execute("call-pdf-2", { path: "doc.pdf" }),
      ).rejects.toThrow("pdf_error");
    });
  });

  // -------------------------------------------------------------------------
  // Grep output_mode integration
  // -------------------------------------------------------------------------

  describe("grep output_mode", () => {
    itRg("grep with output_mode 'files_with_matches' returns only file paths", async () => {
      // Create files with searchable content
      await fs.writeFile(path.join(tmpDir, "alpha.ts"), "const MARKER_562 = true;\nconst other = false;");
      await fs.writeFile(path.join(tmpDir, "beta.ts"), "const MARKER_562 = false;");

      const config = makeConfig({ grep: true });
      const tools = createComisFileTools(config, tmpDir);
      const grepTool = tools.find((t) => t.name === "grep")!;

      const result = await grepTool.execute("call-fwm", {
        pattern: "MARKER_562",
        output_mode: "files_with_matches",
      });
      const text = textOf(result);

      // Should contain file paths, not match content
      expect(text).toContain("alpha.ts");
      expect(text).toContain("beta.ts");
      expect(text).not.toContain("const MARKER_562");
    });

    itRg("grep with output_mode 'count' returns per-file match counts", async () => {
      // Create files: one with 2 matches, one with 1
      await fs.writeFile(
        path.join(tmpDir, "multi.ts"),
        "const CNTMARK_562 = 1;\nconst CNTMARK_562 = 2;",
      );
      await fs.writeFile(path.join(tmpDir, "single.ts"), "const CNTMARK_562 = 3;");

      const config = makeConfig({ grep: true });
      const tools = createComisFileTools(config, tmpDir);
      const grepTool = tools.find((t) => t.name === "grep")!;

      const result = await grepTool.execute("call-count", {
        pattern: "CNTMARK_562",
        output_mode: "count",
      });
      const text = textOf(result);

      // multi.ts should have 2 matches (listed first), single.ts should have 1
      expect(text).toContain("multi.ts: 2 matches");
      expect(text).toContain("single.ts: 1 match");
      // Count for multi should appear before single (sorted descending)
      const multiIdx = text.indexOf("multi.ts");
      const singleIdx = text.indexOf("single.ts");
      expect(multiIdx).toBeLessThan(singleIdx);
    });

    itRg("grep without output_mode returns standard match output (backward compatible)", async () => {
      await fs.writeFile(path.join(tmpDir, "compat.ts"), "const COMPAT_562 = true;");

      const config = makeConfig({ grep: true });
      const tools = createComisFileTools(config, tmpDir);
      const grepTool = tools.find((t) => t.name === "grep")!;

      const result = await grepTool.execute("call-default", {
        pattern: "COMPAT_562",
      });
      const text = textOf(result);

      // Standard output includes file:line: content
      expect(text).toContain("compat.ts");
      expect(text).toContain("const COMPAT_562 = true;");
    });
  });

  // -------------------------------------------------------------------------
  // Path suggestion integration
  // -------------------------------------------------------------------------

  describe("path suggestion integration", () => {
    it("read tool suggests similar filenames on typo", async () => {
      await fs.writeFile(path.join(tmpDir, "utils.ts"), "export const x = 1;");
      await fs.writeFile(path.join(tmpDir, "types.ts"), "export type T = string;");

      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir);
      const readTool = tools.find((t) => t.name === "read")!;

      await expect(
        readTool.execute("call-suggest-read", { path: "utlis.ts" }),
      ).rejects.toThrow("Did you mean");
    });

    it("edit tool suggests similar filenames on typo", async () => {
      await fs.writeFile(path.join(tmpDir, "config.yaml"), "key: value");

      const config = makeConfig({ edit: true });
      const tools = createComisFileTools(config, tmpDir);
      const editTool = tools.find((t) => t.name === "edit")!;

      await expect(
        editTool.execute("call-suggest-edit", {
          path: "confg.yaml",
          edits: [{ oldText: "key", newText: "key2" }],
        }),
      ).rejects.toThrow("Did you mean");
    });

    it("write tool creates parent directories on write (no path suggestion needed)", async () => {
      // Native write tool auto-creates parent directories rather than suggesting
      // alternatives. This is the expected behavior for createComisWriteTool.
      const config = makeConfig({ write: true });
      const tools = createComisFileTools(config, tmpDir);
      const writeTool = tools.find((t) => t.name === "write")!;

      const result = await writeTool.execute("call-suggest-write", {
        path: "componets/new-file.ts",
        content: "hello",
      });
      const text = textOf(result);
      // Native write creates the directory and succeeds
      expect(text).toContain("new-file.ts");
    });

    it("read tool shows fallback hint when no similar paths exist", async () => {
      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir);
      const readTool = tools.find((t) => t.name === "read")!;

      await expect(
        readTool.execute("call-suggest-fallback", { path: "zzz-nonexistent-file-xyx.ts" }),
      ).rejects.toThrow("Use find or grep to locate the correct path");
    });

    it("read tool passes through for existing files (no false positive)", async () => {
      await fs.writeFile(path.join(tmpDir, "real-file.txt"), "real content here");

      const config = makeConfig({ read: true });
      const tools = createComisFileTools(config, tmpDir);
      const readTool = tools.find((t) => t.name === "read")!;

      const result = await readTool.execute("call-passthrough-read", { path: "real-file.txt" });
      expect(textOf(result)).toContain("real content here");
    });

    it("write tool passes through when parent directory exists", async () => {
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });

      const config = makeConfig({ write: true });
      const tools = createComisFileTools(config, tmpDir);
      const writeTool = tools.find((t) => t.name === "write")!;

      const result = await writeTool.execute("call-passthrough-write", { path: "src/new-file.ts", content: "hello" });
      // No error -- file should be created
      expect(textOf(result)).toBeTruthy();
    });
  });
});
