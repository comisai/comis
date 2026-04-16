/**
 * Tests for createComisGrepTool factory function.
 *
 * Covers:
 * - regex search via rg subprocess
 * - 3 output modes (content, files_with_matches, count)
 * - path validation (workspace, readOnlyPaths, sharedPaths)
 * - exit code handling (code 1 = no matches, code 2 = error)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Mock tool-provisioner so ensureTool always resolves to "rg" (avoids spawnSync
// dependency on the real child_process module which is mocked above).
vi.mock("../tool-provisioner.js", () => ({
  ensureTool: vi.fn().mockResolvedValue("rg"),
}));

// Import AFTER mocks are registered
const { createComisGrepTool } = await import("./grep-tool.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Workspace path for all tests. */
const WORKSPACE = "/workspace/project";

/** Simulate rg returning matching content. */
function mockRgSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout, stderr: "" });
    },
  );
}

/** Simulate rg exit code 1 (no matches). */
function mockRgNoMatches(): void {
  mockExecFile.mockImplementation(
    (
      _binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      const error = new Error("process exited with code 1") as NodeJS.ErrnoException & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 1 as unknown as string;
      error.stdout = "";
      error.stderr = "";
      callback(error);
    },
  );
}

/** Simulate rg exit code 2 (bad regex or other error). */
function mockRgError(stderr = "regex parse error"): void {
  mockExecFile.mockImplementation(
    (
      _binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      const error = new Error("process exited with code 2") as NodeJS.ErrnoException & {
        code: number;
        stdout: string;
        stderr: string;
      };
      error.code = 2 as unknown as string;
      error.stdout = "";
      error.stderr = stderr;
      callback(error);
    },
  );
}

/** Simulate rg binary not found (ENOENT). */
function mockRgNotFound(): void {
  mockExecFile.mockImplementation(
    (
      _binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      const error = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      callback(error);
    },
  );
}

/** Helper to extract text from AgentToolResult. */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const textBlock = result.content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}

// ---------------------------------------------------------------------------
// regex search via rg subprocess
// ---------------------------------------------------------------------------

describe("regex search via rg subprocess", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("searches for a literal pattern and returns matching lines", async () => {
    mockRgSuccess("file.ts:1:hello world\nfile.ts:3:hello again\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-1", { pattern: "hello" });

    expect(resultText(result)).toContain("hello world");
    expect(resultText(result)).toContain("hello again");
  });

  it("searches for a regex pattern", async () => {
    mockRgSuccess("lib.ts:5:fn add(a, b) {\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-2", { pattern: "fn\\s+\\w+" });

    expect(resultText(result)).toContain("fn add");
  });

  it("returns helpful error when rg is not installed", async () => {
    mockRgNotFound();

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-3", { pattern: "hello" });

    expect(resultText(result)).toContain("ripgrep (rg) is not available");
  });

  it("passes -e flag to avoid pattern confused with flags", async () => {
    mockRgSuccess("");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-4", { pattern: "--version" });

    // Verify -e was passed in the args
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-e");
    const eIndex = args.indexOf("-e");
    expect(args[eIndex + 1]).toBe("--version");
  });

  it("spawns rg binary specifically", async () => {
    mockRgSuccess("");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-5", { pattern: "test" });

    expect(mockExecFile.mock.calls[0]?.[0]).toBe("rg");
  });
});

// ---------------------------------------------------------------------------
// output modes
// ---------------------------------------------------------------------------

describe("output modes", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("content mode (default) returns lines with filename:linenum: prefix", async () => {
    mockRgSuccess("src/app.ts:10:const x = 1;\nsrc/app.ts:20:const y = 2;\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-6", { pattern: "const" });

    const text = resultText(result);
    expect(text).toContain("src/app.ts:10:");
    expect(text).toContain("src/app.ts:20:");

    // Verify --line-number flag was passed
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--line-number");
  });

  it("files_with_matches mode returns only file paths", async () => {
    mockRgSuccess("src/a.ts\nsrc/b.ts\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-7", {
      pattern: "import",
      output_mode: "files_with_matches",
    });

    const text = resultText(result);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");

    // Verify --files-with-matches flag
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--files-with-matches");
  });

  it("count mode returns per-file counts sorted descending", async () => {
    mockRgSuccess("src/a.ts:3\nsrc/b.ts:10\nsrc/c.ts:1\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-8", {
      pattern: "TODO",
      output_mode: "count",
    });

    const text = resultText(result);
    const lines = text.split("\n").filter(Boolean);
    // Should be sorted descending: b(10), a(3), c(1)
    expect(lines[0]).toContain("src/b.ts");
    expect(lines[0]).toContain("10");
    expect(lines[1]).toContain("src/a.ts");
    expect(lines[1]).toContain("3");
    expect(lines[2]).toContain("src/c.ts");
    expect(lines[2]).toContain("1");

    // Verify --count flag
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--count");
  });

  it("count mode uses singular 'match' for count of 1", async () => {
    mockRgSuccess("src/one.ts:1\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-9", {
      pattern: "rare",
      output_mode: "count",
    });

    const text = resultText(result);
    expect(text).toContain("1 match");
    expect(text).not.toContain("1 matches");
  });
});

// ---------------------------------------------------------------------------
// path validation
// ---------------------------------------------------------------------------

describe("path validation", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockRgSuccess("match.ts:1:found\n");
  });

  it("path within workspace succeeds", async () => {
    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-10", {
      pattern: "found",
      path: "src/app.ts",
    });

    // Should not contain path_traversal error
    expect(resultText(result)).not.toContain("[path_traversal]");
  });

  it("path outside workspace but in readOnlyPaths succeeds", async () => {
    const tool = createComisGrepTool(WORKSPACE, undefined, ["/allowed/readonly"]);
    const result = await tool.execute("call-11", {
      pattern: "found",
      path: "/allowed/readonly/lib.ts",
    });

    expect(resultText(result)).not.toContain("[path_traversal]");
  });

  it("path outside workspace but in sharedPaths succeeds", async () => {
    const tool = createComisGrepTool(WORKSPACE, undefined, undefined, ["/allowed/shared"]);
    const result = await tool.execute("call-12", {
      pattern: "found",
      path: "/allowed/shared/data.ts",
    });

    expect(resultText(result)).not.toContain("[path_traversal]");
  });

  it("path outside all boundaries returns path_traversal error", async () => {
    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-13", {
      pattern: "found",
      path: "/etc/passwd",
    });

    expect(resultText(result)).toContain("[path_traversal]");
  });

  it("no path param searches workspace root", async () => {
    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-14", { pattern: "test" });

    // Verify cwd is workspace
    const opts = mockExecFile.mock.calls[0]?.[2] as { cwd?: string };
    expect(opts.cwd).toBe(WORKSPACE);
  });
});

// ---------------------------------------------------------------------------
// exit code handling
// ---------------------------------------------------------------------------

describe("exit code handling", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("pattern matching nothing returns empty text, not error", async () => {
    mockRgNoMatches();

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-15", { pattern: "nonexistent_xyz" });

    expect(resultText(result)).toBe("");
    // Should NOT contain any error indicators
    expect(resultText(result)).not.toContain("[grep_error]");
  });

  it("rg exit code 2 (bad regex) returns error with grep_error prefix", async () => {
    mockRgError("regex parse error at position 5");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-16", { pattern: "[invalid" });

    expect(resultText(result)).toContain("[grep_error]");
  });
});

// ---------------------------------------------------------------------------
// VCS exclusion, literal mode, line width cap
// ---------------------------------------------------------------------------

describe("VCS exclusion", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("rg args include VCS exclusion globs (--glob !.git etc)", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-vcs1", { pattern: "test" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    // VCS exclusion globs should be present
    expect(args).toContain("--glob");
    const globPairs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--glob") globPairs.push(args[i + 1]);
    }
    expect(globPairs).toContain("!.git");
    expect(globPairs).toContain("!.svn");
    expect(globPairs).toContain("!.hg");
    expect(globPairs).toContain("!.bzr");
    expect(globPairs).toContain("!.jj");
    expect(globPairs).toContain("!.sl");
  });
});

describe("literal mode", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("literal=true adds --fixed-strings to rg args", async () => {
    mockRgSuccess("file.ts:1:[test]\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-lit1", { pattern: "[test]", literal: true });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--fixed-strings");
  });

  it("literal not set (default false) does NOT add --fixed-strings", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-lit2", { pattern: "test" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--fixed-strings");
  });

  it("literal=true + multiline=true returns [invalid_value] error", async () => {
    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-lit3", {
      pattern: "test",
      literal: true,
      multiline: true,
    });

    expect(resultText(result)).toContain("[invalid_value]");
    expect(resultText(result)).toContain("literal and multiline cannot be used together");
  });
});

describe("line width cap", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("truncates lines longer than 500 chars in content mode", async () => {
    const longLine = "file.ts:1:" + "x".repeat(600);
    mockRgSuccess(longLine + "\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-lwc1", { pattern: "x" });

    const text = resultText(result);
    // Line should be truncated
    expect(text).toContain("\u2026 [truncated]");
    // Should not contain the full 600-char content
    expect(text.length).toBeLessThan(longLine.length);
  });

  it("does NOT truncate lines in files_with_matches mode", async () => {
    const longPath = "a".repeat(600) + ".ts";
    mockRgSuccess(longPath + "\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-lwc2", {
      pattern: "x",
      output_mode: "files_with_matches",
    });

    const text = resultText(result);
    // Should contain the full long path (no truncation in files_with_matches mode)
    expect(text).toContain(longPath);
  });
});

// ---------------------------------------------------------------------------
// Helpers for Phase 9 tests
// ---------------------------------------------------------------------------

/** Generate N lines of mock content output (file.ts:linenum:line N). */
function generateMockLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `file.ts:${i + 1}:line ${i + 1}`).join("\n") + "\n";
}

/** Generate N lines of mock files_with_matches output. */
function generateMockFiles(n: number): string {
  return Array.from({ length: n }, (_, i) => `src/file${i + 1}.ts`).join("\n") + "\n";
}

/** Generate N lines of mock count output. */
function generateMockCounts(n: number): string {
  return Array.from({ length: n }, (_, i) => `src/file${i + 1}.ts:${n - i}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Pagination (head_limit + offset)
// ---------------------------------------------------------------------------

describe("pagination (head_limit + offset)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("default head_limit=250 truncates output with 300 lines", async () => {
    mockRgSuccess(generateMockLines(300));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p1", { pattern: "line" });

    const text = resultText(result);
    const outputLines = text.split("\n").filter(Boolean);
    // Should have 250 content lines + possibly a truncation notice
    expect(outputLines.length).toBeLessThanOrEqual(251); // 250 lines + notice line
    expect(text).toContain("[50 more results not shown]");
  });

  it("head_limit=5 with 10 result lines returns 5 lines + notice", async () => {
    mockRgSuccess(generateMockLines(10));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p2", {
      pattern: "line",
      head_limit: 5,
    });

    const text = resultText(result);
    expect(text).toContain("[5 more results not shown]");
    // Should contain lines 1-5 but not line 6+
    expect(text).toContain("line 1");
    expect(text).toContain("line 5");
    expect(text).not.toContain("file.ts:6:");
  });

  it("offset=3 with head_limit=5 skips first 3 lines", async () => {
    mockRgSuccess(generateMockLines(10));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p3", {
      pattern: "line",
      head_limit: 5,
      offset: 3,
    });

    const text = resultText(result);
    // Should NOT contain lines 1-3 (offset skips them)
    expect(text).not.toContain("file.ts:1:");
    expect(text).not.toContain("file.ts:2:");
    expect(text).not.toContain("file.ts:3:");
    // Should contain lines 4-8
    expect(text).toContain("file.ts:4:");
    expect(text).toContain("file.ts:8:");
    // Should NOT contain lines 9+ (head_limit=5 from offset 3 = lines 4-8)
    expect(text).not.toContain("file.ts:9:");
    expect(text).toContain("[2 more results not shown]");
  });

  it("head_limit=0 returns all lines (unlimited)", async () => {
    mockRgSuccess(generateMockLines(500));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p4", {
      pattern: "line",
      head_limit: 0,
    });

    const text = resultText(result);
    expect(text).not.toContain("more results not shown");
    expect(text).toContain("file.ts:500:");
  });

  it("pagination applies to files_with_matches mode", async () => {
    mockRgSuccess(generateMockFiles(10));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p5", {
      pattern: "import",
      output_mode: "files_with_matches",
      head_limit: 3,
    });

    const text = resultText(result);
    expect(text).toContain("[7 more results not shown]");
  });

  it("pagination applies to count mode", async () => {
    mockRgSuccess(generateMockCounts(8));

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-p6", {
      pattern: "TODO",
      output_mode: "count",
      head_limit: 3,
    });

    const text = resultText(result);
    expect(text).toContain("[5 more results not shown]");
  });

  it("rg args include -m flag in content mode (per-file cap)", async () => {
    mockRgSuccess(generateMockLines(5));

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-p7", {
      pattern: "line",
      head_limit: 100,
      offset: 50,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-m");
    const mIndex = args.indexOf("-m");
    // Per-file cap = Math.max(head_limit + offset, 500) = Math.max(150, 500) = 500
    expect(args[mIndex + 1]).toBe("500");
  });
});

// ---------------------------------------------------------------------------
// Multiline matching
// ---------------------------------------------------------------------------

describe("multiline matching", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("multiline=true adds -U and --multiline-dotall to rg args", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-m1", {
      pattern: "struct \\{[\\s\\S]*?field",
      multiline: true,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-U");
    expect(args).toContain("--multiline-dotall");
  });

  it("multiline not set (default false) does NOT add -U flag", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-m2", { pattern: "simple" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-U");
    expect(args).not.toContain("--multiline-dotall");
  });
});

// ---------------------------------------------------------------------------
// File type filtering
// ---------------------------------------------------------------------------

describe("file type filtering", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("type='js' adds --type js to rg args", async () => {
    mockRgSuccess("app.js:1:import\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-t1", {
      pattern: "import",
      type: "js",
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--type");
    const typeIndex = args.indexOf("--type");
    expect(args[typeIndex + 1]).toBe("js");
  });

  it("type not set does NOT add --type flag", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-t2", { pattern: "match" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--type");
  });
});

// ---------------------------------------------------------------------------
// Glob filtering
// ---------------------------------------------------------------------------

describe("glob filtering", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("glob='*.ts' adds --glob '*.ts' to rg args", async () => {
    mockRgSuccess("app.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-g1", {
      pattern: "match",
      glob: "*.ts",
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    // Collect all --glob values (VCS exclusions come first, user glob after)
    const globValues: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--glob") globValues.push(args[i + 1]);
    }
    expect(globValues).toContain("*.ts");
  });

  it("glob not set only has VCS exclusion globs", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-g2", { pattern: "match" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    // Only VCS exclusion globs should be present (all start with !)
    const globValues: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--glob") globValues.push(args[i + 1]);
    }
    expect(globValues.every((g) => g.startsWith("!"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context lines and line numbers
// ---------------------------------------------------------------------------

describe("context lines and line numbers", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("-A=3 adds -A 3 to rg args in content mode", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-c1", {
      pattern: "match",
      "-A": 3,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-A");
    const aIndex = args.indexOf("-A");
    expect(args[aIndex + 1]).toBe("3");
  });

  it("-B=2 adds -B 2 to rg args in content mode", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-c2", {
      pattern: "match",
      "-B": 2,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-B");
    const bIndex = args.indexOf("-B");
    expect(args[bIndex + 1]).toBe("2");
  });

  it("-C=5 adds -C 5 to rg args in content mode", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-c3", {
      pattern: "match",
      "-C": 5,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-C");
    const cIndex = args.indexOf("-C");
    expect(args[cIndex + 1]).toBe("5");
  });

  it("context params ignored in files_with_matches mode", async () => {
    mockRgSuccess("file.ts\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-c4", {
      pattern: "match",
      output_mode: "files_with_matches",
      "-A": 3,
      "-B": 2,
      "-C": 5,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-A");
    expect(args).not.toContain("-B");
    expect(args).not.toContain("-C");
  });

  it("-n defaults to true (line numbers shown by default in content mode)", async () => {
    mockRgSuccess("file.ts:10:const x = 1;\nfile.ts:20:const y = 2;\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-c5", { pattern: "const" });

    const text = resultText(result);
    // Line numbers should be preserved (not stripped)
    expect(text).toContain("file.ts:10:");
    expect(text).toContain("file.ts:20:");
  });

  it("-n=false strips line numbers from output", async () => {
    mockRgSuccess("file.ts:10:const x = 1;\nfile.ts:20:const y = 2;\n");

    const tool = createComisGrepTool(WORKSPACE);
    const result = await tool.execute("call-c6", {
      pattern: "const",
      "-n": false,
    });

    const text = resultText(result);
    // Line numbers should be stripped: file.ts:10: -> file.ts:
    expect(text).toContain("file.ts:const x = 1;");
    expect(text).toContain("file.ts:const y = 2;");
    expect(text).not.toContain("file.ts:10:");
    expect(text).not.toContain("file.ts:20:");
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive search
// ---------------------------------------------------------------------------

describe("case-insensitive search", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("-i=true adds -i to rg args", async () => {
    mockRgSuccess("file.ts:1:Hello World\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-i1", {
      pattern: "hello",
      "-i": true,
    });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-i");
  });

  it("-i not set (default false) does NOT add -i flag", async () => {
    mockRgSuccess("file.ts:1:match\n");

    const tool = createComisGrepTool(WORKSPACE);
    await tool.execute("call-i2", { pattern: "match" });

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-i");
  });
});
