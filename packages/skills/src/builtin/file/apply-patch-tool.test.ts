// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for apply-patch tool.
 *
 * Covers:
 * - Apply Add File creates new file with correct content
 * - Apply Delete File removes file
 * - Apply Update File with matching context modifies file correctly
 * - Apply Update with context mismatch returns clear error
 * - Multi-file patch applies all operations
 * - Invalid patch returns parse error (not exception)
 * - Path traversal attempt blocked by safePath
 * - Update with Move renames file after applying changes
 * - End of File marker appends at end
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "./apply-patch-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comis-patch-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function writeFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

async function readFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, relativePath), "utf-8");
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApplyPatchTool", () => {
  it("returns an AgentTool with correct metadata", () => {
    const tool = createApplyPatchTool(tmpDir);
    expect(tool.name).toBe("apply_patch");
    expect(tool.label).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  it("applies Add File -- creates new file with correct content", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/hello.ts",
      '+export const greeting = "hello";',
      "+",
      "+export function greet(name: string) {",
      "+  return `${greeting}, ${name}!`;",
      "+}",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-1", { patch });
    const text = textOf(result);

    expect(text).toContain("success");
    expect(await fileExists("src/hello.ts")).toBe(true);

    const content = await readFile("src/hello.ts");
    expect(content).toContain('export const greeting = "hello";');
    expect(content).toContain("export function greet(name: string) {");
  });

  it("applies Delete File -- removes file", async () => {
    await writeFile("src/delete-me.ts", "some content");
    expect(await fileExists("src/delete-me.ts")).toBe(true);

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Delete File: src/delete-me.ts",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-2", { patch });
    const text = textOf(result);

    expect(text).toContain("success");
    expect(await fileExists("src/delete-me.ts")).toBe(false);
  });

  it("applies Update File with matching context", async () => {
    await writeFile(
      "src/config.ts",
      [
        "const port = 3000;",
        "const host = 'localhost';",
        "export { port, host };",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/config.ts",
      " const port = 3000;",
      "-const host = 'localhost';",
      "+const host = '0.0.0.0';",
      " export { port, host };",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-3", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/config.ts");
    expect(content).toContain("const host = '0.0.0.0';");
    expect(content).not.toContain("localhost");
  });

  it("throws on context mismatch", async () => {
    await writeFile("src/file.ts", "line one\nline two\nline three\n");

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/file.ts",
      " WRONG CONTEXT LINE",
      "-line two",
      "+line TWO",
      " line three",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-4", { patch })).rejects.toThrow(/\[conflict\].*context/i);
  });

  it("applies multi-file patch", async () => {
    await writeFile("src/existing.ts", "const x = 1;\nconst y = 2;\n");

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const added = true;",
      "*** Update File: src/existing.ts",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 99;",
      "*** Delete File: src/to-remove.ts",
      "*** End Patch",
    ].join("\n");

    // Create file to delete
    await writeFile("src/to-remove.ts", "remove me");

    const result = await tool.execute("call-5", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    // Verify add
    expect(await fileExists("src/new.ts")).toBe(true);
    const newContent = await readFile("src/new.ts");
    expect(newContent).toContain("export const added = true;");

    // Verify update
    const updatedContent = await readFile("src/existing.ts");
    expect(updatedContent).toContain("const y = 99;");

    // Verify delete
    expect(await fileExists("src/to-remove.ts")).toBe(false);
  });

  it("throws parse error for invalid patch", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = "this is not a valid patch at all";

    await expect(tool.execute("call-6", { patch })).rejects.toThrow(/\[invalid_value\].*Failed to parse patch/);
  });

  it("throws on path traversal attempts via safePath", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: ../../etc/evil.txt",
      "+pwned",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-7", { patch })).rejects.toThrow(/permission_denied|Path traversal/);
  });

  it("applies Update with Move -- renames file after changes", async () => {
    await writeFile("src/old-name.ts", "const val = 1;\nconst keep = true;\n");

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "-const val = 1;",
      "+const val = 2;",
      " const keep = true;",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-8", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    // Old file gone
    expect(await fileExists("src/old-name.ts")).toBe(false);
    // New file has updated content
    expect(await fileExists("src/new-name.ts")).toBe(true);
    const content = await readFile("src/new-name.ts");
    expect(content).toContain("const val = 2;");
    expect(content).toContain("const keep = true;");
  });

  it("handles End of File marker -- appends at end of file", async () => {
    await writeFile("src/module.ts", "const a = 1;\nconst b = 2;\n");

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/module.ts",
      "*** End of File",
      "+const c = 3;",
      "+export { a, b, c };",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-9", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/module.ts");
    expect(content).toContain("const a = 1;");
    expect(content).toContain("const b = 2;");
    expect(content).toContain("const c = 3;");
    expect(content).toContain("export { a, b, c };");
  });

  it("handles Update with multiple hunks", async () => {
    await writeFile(
      "src/multi.ts",
      [
        "// header",
        "const a = 1;",
        "const b = 2;",
        "",
        "// middle",
        "const c = 3;",
        "const d = 4;",
        "",
        "// footer",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/multi.ts",
      " // header",
      "-const a = 1;",
      "+const a = 10;",
      " const b = 2;",
      "@@ second hunk",
      " // middle",
      "-const c = 3;",
      "+const c = 30;",
      " const d = 4;",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-10", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/multi.ts");
    expect(content).toContain("const a = 10;");
    expect(content).toContain("const b = 2;");
    expect(content).toContain("const c = 30;");
    expect(content).toContain("const d = 4;");
  });

  it("handles trailing whitespace differences in context matching", async () => {
    // File has trailing spaces that the patch context doesn't include
    await writeFile("src/ws.ts", "const x = 1;  \nconst y = 2;\n");

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/ws.ts",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 99;",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-11", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/ws.ts");
    expect(content).toContain("const y = 99;");
  });

  // -------------------------------------------------------------------------
  // sharedPaths tests
  // -------------------------------------------------------------------------

  it("apply-patch can write to sharedPaths directory", async () => {
    // Create a second temp directory simulating another agent's workspace
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "comis-patch-shared-"));
    try {
      const tool = createApplyPatchTool(tmpDir, [sharedDir]);
      const targetFile = path.join(sharedDir, "shared-file.ts");
      const relPath = targetFile; // absolute path is the "relative" path to safePath

      const patch = [
        "*** Begin Patch",
        `*** Add File: ${relPath}`,
        "+export const shared = true;",
        "*** End Patch",
      ].join("\n");

      const result = await tool.execute("call-shared-1", { patch });
      const text = textOf(result);
      expect(text).toContain("success");

      const content = await fs.readFile(targetFile, "utf-8");
      expect(content).toContain("export const shared = true;");
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("apply-patch throws on paths outside workspace and sharedPaths", async () => {
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "comis-patch-shared-"));
    try {
      const tool = createApplyPatchTool(tmpDir, [sharedDir]);
      const patch = [
        "*** Begin Patch",
        "*** Add File: ../../etc/evil.txt",
        "+pwned",
        "*** End Patch",
      ].join("\n");

      await expect(tool.execute("call-shared-block", { patch })).rejects.toThrow(/permission_denied|Path traversal/);
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Protected workspace files
// ---------------------------------------------------------------------------

describe("protected workspace files", () => {
  it("throws when patching AGENTS.md at workspace root", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: AGENTS.md",
      "+overwritten content",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-prot-1", { patch })).rejects.toThrow(/Cannot modify AGENTS\.md/);
  });

  it("throws when patching SOUL.md at workspace root", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: SOUL.md",
      "+overwritten content",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-prot-2", { patch })).rejects.toThrow(/Cannot modify SOUL\.md/);
  });

  it("allows patch targeting nested AGENTS.md", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Add File: projects/foo/AGENTS.md",
      "+nested content",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-prot-3", { patch });
    const text = textOf(result);
    // Should succeed (creates nested file) -- protection only applies to workspace root
    expect(text).toContain("Applied");
    expect(text).not.toContain("Cannot modify");
  });
});

// ---------------------------------------------------------------------------
// Fuzzy patch matching (three-pass cascade)
// ---------------------------------------------------------------------------

describe("fuzzy patch matching", () => {
  // --- Pass 2: Normalized matching ---

  it("succeeds when file has smart quotes but patch has ASCII quotes", async () => {
    // File uses smart double quotes (U+201C, U+201D)
    await writeFile(
      "src/smart.ts",
      [
        "const greeting = \u201Chello world\u201D;",
        "const farewell = \u201Cgoodbye\u201D;",
        "export { greeting, farewell };",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/smart.ts",
      ' const greeting = "hello world";',
      '-const farewell = "goodbye";',
      '+const farewell = "see you later";',
      " export { greeting, farewell };",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-fuzzy-1", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/smart.ts");
    expect(content).toContain('const farewell = "see you later";');
  });

  it("succeeds when file has BOM but patch does not", async () => {
    // File starts with BOM (U+FEFF)
    await writeFile(
      "src/bom.ts",
      "\uFEFFconst version = 1;\nconst name = \"old\";\nexport { version, name };\n",
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/bom.ts",
      " const version = 1;",
      '-const name = "old";',
      '+const name = "new";',
      " export { version, name };",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-fuzzy-2", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/bom.ts");
    expect(content).toContain('const name = "new";');
  });

  it("succeeds when file has NBSP but patch has regular spaces", async () => {
    // File uses NBSP (U+00A0) in indentation
    await writeFile(
      "src/nbsp.ts",
      [
        "function test() {",
        "\u00A0\u00A0const longVariableName = getValue();",
        "\u00A0\u00A0return longVariableName;",
        "}",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/nbsp.ts",
      " function test() {",
      "   const longVariableName = getValue();",
      "-  return longVariableName;",
      "+  return longVariableName + 1;",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-fuzzy-3", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/nbsp.ts");
    expect(content).toContain("return longVariableName + 1;");
  });

  // --- Pass 3: Similarity matching ---

  it("succeeds when file uses different indentation (tabs vs spaces) with sufficient context", async () => {
    // File uses tab indentation
    await writeFile(
      "src/tabs.ts",
      [
        "function calculate() {",
        "\tconst longVariableName = getValue();",
        "\tconst anotherLongVariable = process();",
        "\treturn longVariableName + anotherLongVariable;",
        "}",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    // Patch uses space indentation (4 spaces) -- context lines > 10 chars each
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/tabs.ts",
      " function calculate() {",
      "     const longVariableName = getValue();",
      "-    const anotherLongVariable = process();",
      "+    const anotherLongVariable = transform();",
      "     return longVariableName + anotherLongVariable;",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-fuzzy-4", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/tabs.ts");
    // Verify the replacement was applied
    expect(content).toContain("const anotherLongVariable = transform();");
    // Verify original tab indentation is preserved in context lines
    expect(content).toContain("\tconst longVariableName = getValue();");
    expect(content).toContain("\treturn longVariableName + anotherLongVariable;");
  });

  it("rejects similarity match on short context lines (< 10 chars)", async () => {
    // File has multiple closing braces at different positions
    await writeFile(
      "src/short.ts",
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function beta() {",
        "  return 2;",
        "}",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    // Patch tries to match using only a short "}" context line
    // but the context doesn't match at the right position because
    // "WRONG CONTEXT" doesn't exist in the file
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/short.ts",
      " }",
      " ",
      " WRONG CONTEXT HERE",
      "-  return 2;",
      "+  return 99;",
      " }",
      "*** End Patch",
    ].join("\n");

    // Should fail: short "}" lines require exact/normalized match, and
    // "WRONG CONTEXT HERE" doesn't exist in the file at all
    await expect(tool.execute("call-fuzzy-5", { patch })).rejects.toThrow(/\[conflict\].*context/i);
  });

  // --- Whitespace preservation ---

  it("fuzzy match preserves original file whitespace", async () => {
    // File uses tab indentation throughout
    await writeFile(
      "src/preserve.ts",
      [
        "class Handler {",
        "\tprivate readonly longServiceName: ServiceType;",
        "\tprivate readonly anotherLongField: FieldType;",
        "\tconstructor() {",
        "\t\tthis.longServiceName = createService();",
        "\t}",
        "}",
      ].join("\n"),
    );

    const tool = createApplyPatchTool(tmpDir);
    // Patch uses space indentation in context -- matches via similarity
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/preserve.ts",
      " class Handler {",
      "     private readonly longServiceName: ServiceType;",
      "     private readonly anotherLongField: FieldType;",
      "-    constructor() {",
      "+    constructor(config: Config) {",
      "         this.longServiceName = createService();",
      "     }",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute("call-fuzzy-6", { patch });
    const text = textOf(result);
    expect(text).toContain("success");

    const content = await readFile("src/preserve.ts");
    // Replacement was applied
    expect(content).toContain("constructor(config: Config) {");
    // Original tab indentation preserved in context lines (not space from patch)
    expect(content).toContain("\tprivate readonly longServiceName: ServiceType;");
    expect(content).toContain("\tprivate readonly anotherLongField: FieldType;");
    expect(content).toContain("\t\tthis.longServiceName = createService();");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic error messages
// ---------------------------------------------------------------------------

describe("diagnostic error messages", () => {
  it("error includes actual and expected content on mismatch", async () => {
    await writeFile(
      "src/diag1.ts",
      "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;",
    );

    const tool = createApplyPatchTool(tmpDir);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/diag1.ts",
      " const WRONG = 1;",
      "-const beta = 2;",
      "+const beta = 99;",
      " const gamma = 3;",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-diag-1", { patch })).rejects.toThrow(/Actual:.*const alpha/);
    // Re-run to check the Expected side separately
    await expect(tool.execute("call-diag-1b", { patch })).rejects.toThrow(/Expected:.*const WRONG/);
  });

  it("error describes indentation difference on whitespace-only mismatch", async () => {
    // File uses tabs; patch context uses spaces for first line + wrong second line
    await writeFile(
      "src/diag2.ts",
      "\tconst longEnoughVar = true;\nconst other = false;",
    );

    const tool = createApplyPatchTool(tmpDir);
    // Context line 1: spaces instead of tab (indentation mismatch)
    // Context line 2: genuinely wrong (forces all three passes to fail)
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/diag2.ts",
      "     const longEnoughVar = true;",
      "-const WRONG = false;",
      "+const replacement = true;",
      "*** End Patch",
    ].join("\n");

    await expect(tool.execute("call-diag-2", { patch })).rejects.toThrow(/indent|tab|space/i);
  });

  it("error describes specific whitespace counts", async () => {
    // File with 2-space indentation
    await writeFile(
      "src/diag3.ts",
      "  const val = someFunction();\nconst other = false;",
    );

    const tool = createApplyPatchTool(tmpDir);
    // Patch with 4-space indentation + wrong second context line to force failure
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/diag3.ts",
      "     const val = someFunction();",
      "-const WRONG = false;",
      "+const replacement = true;",
      "*** End Patch",
    ].join("\n");

    // Error should describe space counts
    await expect(tool.execute("call-diag-3", { patch })).rejects.toThrow(/space\(s\)/);
  });
});
