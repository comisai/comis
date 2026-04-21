// SPDX-License-Identifier: Apache-2.0
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
  it("Test 4: cold-registers existing file when tracker is empty and appends audit notice", async () => {
    // Create file but do NOT call tracker.recordRead -- simulates the session-
    // start "seeded workspace template" case where the LLM has the file in
    // its system prompt but never read it via the read tool.
    const absPath = path.join(workspaceDir, "unread.txt");
    const priorContent = "prior content bytes";
    await fs.writeFile(absPath, priorContent, "utf-8");

    const tool = createTool();
    const result = await tool.execute("id", {
      path: "unread.txt",
      content: "new content",
    });

    // Write must succeed -- no [not_read] throw.
    const writtenBack = await fs.readFile(absPath, "utf-8");
    expect(writtenBack).toBe("new content");

    // Result must include the original JSON stat block AND the audit notice.
    expect(result.content).toHaveLength(2);
    const auditText = result.content[1].text;
    expect(auditText).toContain("without a prior read");
    // Audit notice mentions the prior byte count (human-readable format).
    expect(auditText).toMatch(/Previous content \(\d+B\) overwritten/);
    // And the "First N bytes were:" preview delimiter.
    expect(auditText).toContain("First");
    expect(auditText).toContain("bytes were:");
    expect(auditText).toContain("---");
    expect(auditText).toContain(priorContent);

    // details.coldRead exposed for callers that inspect the structured result.
    expect(result.details.coldRead).toBe(true);
    // Tracker is now populated for this path.
    expect(tracker.hasBeenRead(absPath)).toBe(true);
  });

  it("Test 4b: [stale_file] still fires when on-disk state changes between cold-register and staleness re-read", async () => {
    // Setup: file exists on disk with content v1, tracker is empty.
    // Execution sequence the tool follows on the cold-register path:
    //   V5 (initial stat, mtime=A)
    //   V6 cold-register: readFile -> v1, recordRead(A, hash(v1))
    //   V7 staleness: freshStat (mtime=B, different) + readFile -> v2
    //   checkStaleness(recorded=A, current=B, sample=v2)
    //     mtime differs (A != B) -> fall through to content-hash compare
    //     recorded hash = hash(v1), current hash = hash(v2) -> mismatch
    //     -> stale: true -> throws [stale_file]
    //
    // To trigger this without racing a real external writer, we intercept
    // stat to return A first, then B on subsequent calls; and intercept
    // readFile to return v1 first (cold-register), then v2 (staleness
    // re-read). This simulates an external writer mutating the file after
    // cold-register recorded v1's state.
    const absPath = path.join(workspaceDir, "stale-race.txt");
    const v1 = "original content v1";
    await fs.writeFile(absPath, v1, "utf-8");
    const realStat = await fs.stat(absPath);

    let statCallCount = 0;
    statOverride.fn = async (p: string) => {
      if (p !== absPath) return undefined;
      statCallCount++;
      // First stat (V5): mtime A.
      // Subsequent stat (V7 freshStat, and post-write): mtime B.
      const mtimeMs = statCallCount === 1 ? realStat.mtimeMs : realStat.mtimeMs + 5000;
      return { ...realStat, mtimeMs, size: v1.length, isFile: () => true };
    };

    let readCallCount = 0;
    const originalReadFile = fs.readFile;
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (p: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
        if (String(p) === absPath) {
          readCallCount++;
          // 1st: cold-register read -> v1 (matches recorded hash).
          // 2nd: staleness re-read -> v2 (external-writer mutation).
          // 3rd+: readFileWithMetadata for overwrite (would run if staleness
          //       didn't throw; not reached in this test).
          if (readCallCount === 1) return Buffer.from(v1, "utf-8");
          return Buffer.from("mutated content v2 -- external writer", "utf-8");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalReadFile as any)(p, ...rest);
      });

    const tool = createTool();
    try {
      await expect(
        tool.execute("id", { path: "stale-race.txt", content: "rewritten by agent" }),
      ).rejects.toThrow("[stale_file]");
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("Test 4c: new file write does not cold-register (no audit notice, coldRead=false)", async () => {
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "brand-new.txt",
      content: "fresh content",
    });

    // Exactly one content block -- no audit notice for new files.
    expect(result.content).toHaveLength(1);
    // coldRead is explicitly false (set in the outer scope, never toggled
    // on the !exists branch).
    expect(result.details.coldRead).toBe(false);
    expect(result.content[0].text).toContain('"created":true');
  });

  it("Test 4d: audit notice preview caps at 500 bytes with truncation suffix", async () => {
    // Write a 2000-byte file so the preview must truncate to 500.
    const absPath = path.join(workspaceDir, "big-unread.txt");
    const bigContent = "x".repeat(2000);
    await fs.writeFile(absPath, bigContent, "utf-8");

    const tool = createTool();
    const result = await tool.execute("id", {
      path: "big-unread.txt",
      content: "new",
    });

    expect(result.content).toHaveLength(2);
    const auditText = result.content[1].text;
    // Preview should contain exactly 500 x's (bytes 0..499) plus the
    // truncation suffix for the remaining 1500 bytes.
    expect(auditText).toContain("... (truncated, 1500 more bytes)");
    // Extract the preview portion between "---" delimiters and verify length.
    const match = auditText.match(/---\n(x+)\n\.\.\./);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(500);
  });

  it("Test 5: allows overwrite on existing file IN tracker (fast path, no cold-register)", async () => {
    await writeAndRead("tracked.txt", "original");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "tracked.txt",
      content: "updated",
    });
    const contents = await fs.readFile(
      path.join(workspaceDir, "tracked.txt"),
      "utf-8",
    );
    expect(contents).toBe("updated");
    expect(result.content[0].text).toBeDefined();
    // Confirms cold-register path did NOT run when tracker already had the file.
    expect(result.content).toHaveLength(1);
    expect(result.details.coldRead).toBe(false);
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

    // Collect errors from multiple validation checks. [not_read] is no
    // longer raised (replaced by cold-register) -- substitute two other
    // gates that do still throw: protected_file and jupyter_rejected.
    const testCases = [
      // path traversal
      () => tool.execute("id", { path: "../../etc/passwd", content: "x" }),
      // protected_file (AGENTS.md write attempt)
      async () => {
        const absPath = path.join(workspaceDir, "AGENTS.md");
        await fs.writeFile(absPath, "original", "utf-8");
        return tool.execute("id", { path: "AGENTS.md", content: "x" });
      },
      // jupyter_rejected (.ipynb write attempt)
      () => tool.execute("id", { path: "notebook.ipynb", content: "x" }),
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
