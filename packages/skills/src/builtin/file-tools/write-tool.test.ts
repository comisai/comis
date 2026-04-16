/**
 * Tests for createComisWriteTool factory function.
 *
 * Covers:
 * - Path validation: traversal, sharedPaths
 * - Device file blocking
 * - Read-before-write enforcement
 * - Staleness detection
 * - New file creation
 * - Directory creation
 * - Tracker update after write
 * - Overwrite with encoding preservation
 * - Error code format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { createFileStateTracker } from "../file/file-state-tracker.js";
import type { FileStateTracker } from "../file/file-state-tracker.js";

/**
 * Mutable stat override. When set to a function, write-tool's fs.stat calls
 * are intercepted. Reset to undefined in afterEach.
 */
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

// Import fs AFTER the mock is set up
import * as fs from "node:fs/promises";
import { createComisWriteTool } from "./write-tool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tracker: FileStateTracker;

async function createWorkspace(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `write-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a file and record it as read in the tracker (simulates the agent
 * reading before writing).
 */
async function writeAndRead(
  relPath: string,
  content: string,
): Promise<string> {
  const absPath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf-8");
  const stat = await fs.stat(absPath);
  tracker.recordRead(absPath, stat.mtimeMs);
  return absPath;
}

function createTool(options?: { sharedPaths?: string[] }) {
  return createComisWriteTool(
    workspaceDir,
    undefined,
    tracker,
    options?.sharedPaths,
  );
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

// ---------------------------------------------------------------------------
// Path validation tests
// ---------------------------------------------------------------------------

describe("path validation", () => {
  it("Test 1: rejects path traversal with [path_traversal]", async () => {
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "../../etc/passwd", content: "bad" }),
    ).rejects.toThrow("[path_traversal]");
  });

  it("Test 2: allows sharedPaths -- path outside workspace resolves", async () => {
    const sharedDir = await createWorkspace();
    try {
      const sharedFile = path.join(sharedDir, "shared.txt");
      await fs.writeFile(sharedFile, "shared content", "utf-8");
      const stat = await fs.stat(sharedFile);
      tracker.recordRead(sharedFile, stat.mtimeMs);

      const tool = createTool({ sharedPaths: [sharedDir] });
      const result = await tool.execute("id", {
        path: sharedFile,
        content: "updated content",
      });

      const written = await fs.readFile(sharedFile, "utf-8");
      expect(written).toBe("updated content");
      expect(result.content[0].text).toContain(sharedFile);
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Device file blocking tests
// ---------------------------------------------------------------------------

describe("device file blocking", () => {
  it("Test 3: rejects device file with [device_file]", async () => {
    const tool = createTool({ sharedPaths: ["/dev"] });
    await expect(
      tool.execute("id", { path: "/dev/zero", content: "data" }),
    ).rejects.toThrow("[device_file]");
  });
});

// ---------------------------------------------------------------------------
// Read-before-write enforcement tests
// ---------------------------------------------------------------------------

describe("read-before-write enforcement", () => {
  it("Test 4: rejects overwrite on existing file NOT in tracker with [not_read]", async () => {
    // Create file but do NOT call tracker.recordRead
    const absPath = path.join(workspaceDir, "unread.txt");
    await fs.writeFile(absPath, "content", "utf-8");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "unread.txt", content: "new content" }),
    ).rejects.toThrow("[not_read]");
  });

  it("Test 5: allows overwrite on existing file IN tracker", async () => {
    await writeAndRead("tracked.txt", "original");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "tracked.txt",
      content: "updated",
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "tracked.txt"),
      "utf-8",
    );
    expect(content).toBe("updated");
    expect(result.content[0].text).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Staleness detection tests
// ---------------------------------------------------------------------------

describe("staleness detection", () => {
  it("Test 6: rejects overwrite on stale file with [stale_file]", async () => {
    const absPath = await writeAndRead("stale.txt", "original");
    const realStat = await fs.stat(absPath);
    // Simulate mtime change via stat override
    statOverride.fn = async (p: string) => {
      if (p === absPath)
        return {
          ...realStat,
          mtimeMs: realStat.mtimeMs + 5000,
          size: realStat.size,
          isFile: () => true,
        };
      return undefined;
    };
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "stale.txt", content: "new" }),
    ).rejects.toThrow("[stale_file]");
  });
});

// ---------------------------------------------------------------------------
// New file creation tests
// ---------------------------------------------------------------------------

describe("new file creation", () => {
  it("Test 7: creates file at non-existent path with given content", async () => {
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "newfile.txt",
      content: "hello world",
    });
    const absPath = path.join(workspaceDir, "newfile.txt");
    const content = await fs.readFile(absPath, "utf-8");
    expect(content).toBe("hello world");
    expect(result.content[0].text).toContain('"created":true');
  });

  it("Test 8: created file content matches input (read back and compare)", async () => {
    const tool = createTool();
    const testContent = "line1\nline2\nline3\n";
    await tool.execute("id", {
      path: "verify.txt",
      content: testContent,
    });
    const absPath = path.join(workspaceDir, "verify.txt");
    const readBack = await fs.readFile(absPath, "utf-8");
    expect(readBack).toBe(testContent);
  });
});

// ---------------------------------------------------------------------------
// Directory creation tests
// ---------------------------------------------------------------------------

describe("directory creation", () => {
  it("Test 9: creates parent directories for deep nested path", async () => {
    const tool = createTool();
    await tool.execute("id", {
      path: "deep/nested/dir/file.txt",
      content: "deep content",
    });
    const absPath = path.join(workspaceDir, "deep/nested/dir/file.txt");
    const content = await fs.readFile(absPath, "utf-8");
    expect(content).toBe("deep content");
  });

  it("Test 10: rejects when createDirectories=false and parent does not exist", async () => {
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "nonexistent-parent/file.txt",
        content: "content",
        createDirectories: false,
      }),
    ).rejects.toThrow(/dir_create_failed|ENOENT|write_error/);
  });
});

// ---------------------------------------------------------------------------
// Tracker update tests
// ---------------------------------------------------------------------------

describe("tracker update", () => {
  it("Test 11: after creating a new file, tracker.hasBeenRead returns true", async () => {
    const tool = createTool();
    await tool.execute("id", {
      path: "tracked-new.txt",
      content: "new content",
    });
    const absPath = path.join(workspaceDir, "tracked-new.txt");
    expect(tracker.hasBeenRead(absPath)).toBe(true);
  });

  it("Test 12: after overwriting a file, tracker mtime matches new stat", async () => {
    await writeAndRead("tracked-overwrite.txt", "original");
    const tool = createTool();
    await tool.execute("id", {
      path: "tracked-overwrite.txt",
      content: "updated",
    });
    const absPath = path.join(workspaceDir, "tracked-overwrite.txt");
    const newStat = await fs.stat(absPath);
    const readState = tracker.getReadState(absPath);
    expect(readState).toBeDefined();
    expect(readState!.mtime).toBe(newStat.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// Overwrite with encoding preservation tests
// ---------------------------------------------------------------------------

describe("overwrite existing", () => {
  it("Test 13: overwrite updates file content", async () => {
    await writeAndRead("existing.txt", "old content");
    const tool = createTool();
    await tool.execute("id", {
      path: "existing.txt",
      content: "new content",
    });
    const absPath = path.join(workspaceDir, "existing.txt");
    const content = await fs.readFile(absPath, "utf-8");
    expect(content).toBe("new content");
  });

  it("Test 14: successive writes do not fail staleness (post-write tracker update)", async () => {
    await writeAndRead("multi.txt", "first");
    const tool = createTool();
    // First overwrite
    await tool.execute("id", { path: "multi.txt", content: "second" });
    // Second overwrite immediately -- should NOT get [stale_file]
    await tool.execute("id", { path: "multi.txt", content: "third" });
    const absPath = path.join(workspaceDir, "multi.txt");
    const content = await fs.readFile(absPath, "utf-8");
    expect(content).toBe("third");
  });
});

// ---------------------------------------------------------------------------
// Protected workspace file blocking tests
// ---------------------------------------------------------------------------

describe("protected workspace file blocking", () => {
  it("Test 16: rejects write to AGENTS.md with [protected_file]", async () => {
    await writeAndRead("AGENTS.md", "# Agent instructions");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "AGENTS.md", content: "hacked" }),
    ).rejects.toThrow("[protected_file]");
  });

  it("Test 17: rejects write to SOUL.md with [protected_file]", async () => {
    await writeAndRead("SOUL.md", "# Soul file");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "SOUL.md", content: "hacked" }),
    ).rejects.toThrow("[protected_file]");
  });

  it("Test 18: protected_file error message suggests ROLE.md", async () => {
    await writeAndRead("AGENTS.md", "# Agent instructions");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "AGENTS.md", content: "hacked" }),
    ).rejects.toThrow("Use ROLE.md instead");
  });

  it("Test 19: rejects write to nested AGENTS.md with [protected_file]", async () => {
    await writeAndRead("subdir/AGENTS.md", "# nested");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "subdir/AGENTS.md", content: "hacked" }),
    ).rejects.toThrow("[protected_file]");
  });
});

// ---------------------------------------------------------------------------
// Jupyter notebook rejection tests
// ---------------------------------------------------------------------------

describe("jupyter notebook rejection", () => {
  it("Test 20: rejects write to .ipynb with [jupyter_rejected]", async () => {
    await writeAndRead("notebook.ipynb", '{"cells":[]}');
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "notebook.ipynb", content: '{"cells":[]}' }),
    ).rejects.toThrow("[jupyter_rejected]");
  });

  it("Test 21: rejects write to .IPYNB (case-insensitive)", async () => {
    await writeAndRead("NOTEBOOK.IPYNB", '{"cells":[]}');
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "NOTEBOOK.IPYNB", content: '{"cells":[]}' }),
    ).rejects.toThrow("[jupyter_rejected]");
  });

  it("Test 22: rejects creating NEW .ipynb file", async () => {
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "new.ipynb", content: '{"cells":[]}' }),
    ).rejects.toThrow("[jupyter_rejected]");
  });
});

// ---------------------------------------------------------------------------
// Config validation on overwrite tests
// ---------------------------------------------------------------------------

describe("config validation on overwrite", () => {
  it("Test 23: rejects overwriting .json with invalid JSON", async () => {
    await writeAndRead("config.json", '{"valid": true}');
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "config.json", content: "{invalid json" }),
    ).rejects.toThrow("[invalid_config]");
  });

  it("Test 24: rejects overwriting .yaml with invalid YAML", async () => {
    await writeAndRead("config.yaml", "key: value");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "config.yaml", content: "key: [unclosed" }),
    ).rejects.toThrow("[invalid_config]");
  });

  it("Test 25: rejects overwriting .jsonc with invalid JSONC", async () => {
    await writeAndRead("settings.jsonc", '// comment\n{"valid": true}');
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "settings.jsonc", content: "{invalid" }),
    ).rejects.toThrow("[invalid_config]");
  });

  it("Test 26: allows overwriting .json with valid JSON", async () => {
    await writeAndRead("valid.json", '{"old": true}');
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "valid.json",
      content: '{"valid": true}',
    });
    expect(result.content[0].text).toContain('"created":false');
  });

  it("Test 27: allows creating NEW .json with invalid JSON (no validation on new files)", async () => {
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "new-config.json",
      content: "{invalid json",
    });
    expect(result.content[0].text).toContain('"created":true');
  });
});

// ---------------------------------------------------------------------------
// Encoding preservation tests
// ---------------------------------------------------------------------------

describe("encoding preservation", () => {
  it("Test 28: overwrite Latin-1 file preserves Latin-1 encoding", async () => {
    // Create a Latin-1 file with realistic French text (chardet detects as ISO-8859-1)
    const latin1Text = "Les op\xe9rations de p\xeache dans la r\xe9gion fran\xe7aise sont tr\xe8s importantes.\n";
    const absPath = path.join(workspaceDir, "french.txt");
    await fs.writeFile(absPath, Buffer.from(latin1Text, "latin1"));
    const stat = await fs.stat(absPath);
    tracker.recordRead(absPath, stat.mtimeMs);

    const tool = createTool();
    await tool.execute("id", {
      path: "french.txt",
      content: "Le caf\u00E9 est d\u00E9licieux dans la r\u00E9gion fran\u00E7aise ce matin ensoleill\u00E9.\n",
    });

    // Read raw bytes -- e-acute should be single byte 0xE9 (Latin-1), not 0xC3 0xA9 (UTF-8)
    const rawBuf = await fs.readFile(absPath);
    const eAcuteIndex = rawBuf.indexOf(0xe9);
    expect(eAcuteIndex).toBeGreaterThan(-1);
    // Should NOT have UTF-8 two-byte sequence
    expect(rawBuf.indexOf(0xc3)).toBe(-1);
  });

  it("Test 29: overwrite CRLF file preserves CRLF line endings", async () => {
    // Create a CRLF file
    const absPath = path.join(workspaceDir, "crlf.txt");
    await fs.writeFile(absPath, "line1\r\nline2\r\n", "utf-8");
    const stat = await fs.stat(absPath);
    tracker.recordRead(absPath, stat.mtimeMs);

    const tool = createTool();
    // Write content with LF -- should be restored to CRLF
    await tool.execute("id", {
      path: "crlf.txt",
      content: "newline1\nnewline2\n",
    });

    const rawContent = await fs.readFile(absPath, "utf-8");
    expect(rawContent).toBe("newline1\r\nnewline2\r\n");
    expect(rawContent).toContain("\r\n");
  });
});

// ---------------------------------------------------------------------------
// Error code format test
// ---------------------------------------------------------------------------

describe("error code format", () => {
  it("Test 15: all error messages use [code] format", async () => {
    const tool = createTool();
    const errors: string[] = [];

    // Collect errors from various validation checks
    const testCases = [
      // path traversal
      () => tool.execute("id", { path: "../../etc/passwd", content: "x" }),
      // not_read (create file but don't track)
      async () => {
        const absPath = path.join(workspaceDir, "untracked-err.txt");
        await fs.writeFile(absPath, "content", "utf-8");
        return tool.execute("id", { path: "untracked-err.txt", content: "x" });
      },
    ];

    for (const tc of testCases) {
      try {
        await tc();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    const codePattern = /^\[[\w_]+\] /;
    for (const msg of errors) {
      expect(msg).toMatch(codePattern);
    }
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
