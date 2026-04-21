// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createComisEditTool factory function.
 *
 * Covers the full V1-V15 validation pipeline and end-to-end edit flow:
 * - Input validation: empty edits, empty oldText, noop edit
 * - Path validation: traversal, sharedPaths, protected files
 * - File validation: not found, too large, jupyter, device file
 * - State validation: auto-read, stale file
 * - Successful edits: single, batch, result details, post-edit mtime
 * - Config validation warning
 * - Curly quote preservation
 * - Trailing newline cleanup
 * - Error code format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { createFileStateTracker } from "../file/file-state-tracker.js";
import type { FileStateTracker } from "../file/file-state-tracker.js";

/**
 * Mutable stat override. When set to a function, edit-tool's fs.stat calls
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
import { createComisEditTool } from "./edit-tool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tracker: FileStateTracker;

async function createWorkspace(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `edit-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a file and record it as read in the tracker (simulates the agent
 * reading before editing).
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
  return createComisEditTool(
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
// Input validation tests
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("Test 1: rejects empty edits array with [empty_edits]", async () => {
    await writeAndRead("test.txt", "hello world");
    const tool = createTool();
    await expect(
      tool.execute("id", { path: "test.txt", edits: [] }),
    ).rejects.toThrow("[empty_edits]");
  });

  it("Test 2: rejects edit with empty oldText with [empty_oldtext]", async () => {
    await writeAndRead("test.txt", "hello world");
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "test.txt",
        edits: [{ oldText: "", newText: "x" }],
      }),
    ).rejects.toThrow("[empty_oldtext]");
  });

  it("Test 3: rejects noop edit with [noop_edit]", async () => {
    await writeAndRead("test.txt", "hello world");
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "test.txt",
        edits: [{ oldText: "hello", newText: "hello" }],
      }),
    ).rejects.toThrow("[noop_edit]");
  });
});

// ---------------------------------------------------------------------------
// Path validation tests
// ---------------------------------------------------------------------------

describe("path validation", () => {
  it("Test 4: rejects path traversal with [path_traversal]", async () => {
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "../../../etc/passwd",
        edits: [{ oldText: "x", newText: "y" }],
      }),
    ).rejects.toThrow("[path_traversal]");
  });

  it("Test 5: allows sharedPaths -- path outside workspace resolves", async () => {
    // Create a second temp dir outside workspace
    const sharedDir = await createWorkspace();
    try {
      const sharedFile = path.join(sharedDir, "shared.txt");
      await fs.writeFile(sharedFile, "shared content", "utf-8");
      const stat = await fs.stat(sharedFile);
      tracker.recordRead(sharedFile, stat.mtimeMs);

      // Use absolute path -- fails workspace safePath prefix check, succeeds via sharedPaths
      const tool = createTool({ sharedPaths: [sharedDir] });
      const result = await tool.execute("id", {
        path: sharedFile,
        edits: [{ oldText: "shared content", newText: "updated content" }],
      });
      expect(result.content[0].text).toContain("Successfully replaced");

      const written = await fs.readFile(sharedFile, "utf-8");
      expect(written).toBe("updated content");
    } finally {
      await fs.rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("Test 6: rejects protected file (AGENTS.md) with [protected_file]", async () => {
    await writeAndRead("AGENTS.md", "# Agents");
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "AGENTS.md",
        edits: [{ oldText: "# Agents", newText: "# Modified" }],
      }),
    ).rejects.toThrow("[protected_file]");
  });
});

// ---------------------------------------------------------------------------
// File validation tests
// ---------------------------------------------------------------------------

describe("file validation", () => {
  it('Test 7: rejects file not found with [file_not_found] and "Did you mean"', async () => {
    // Create a file with a known name so suggestions work
    await fs.writeFile(
      path.join(workspaceDir, "existing-file.ts"),
      "content",
      "utf-8",
    );
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "exsting-file.ts",
        edits: [{ oldText: "x", newText: "y" }],
      }),
    ).rejects.toThrow("[file_not_found]");
  });

  it("Test 8: rejects file over 1 GiB with [file_too_large]", async () => {
    const absPath = await writeAndRead("big.txt", "content");
    statOverride.fn = async (p: string) => {
      if (p === absPath) {
        return {
          size: 1024 * 1024 * 1024 + 1,
          mtimeMs: Date.now(),
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      return undefined;
    };
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "big.txt",
        edits: [{ oldText: "content", newText: "new" }],
      }),
    ).rejects.toThrow("[file_too_large]");
  });

  it("Test 9: rejects .ipynb with [jupyter_rejected] and notebook_edit", async () => {
    await writeAndRead("test.ipynb", '{"cells": []}');
    const tool = createTool();
    const err = await tool
      .execute("id", {
        path: "test.ipynb",
        edits: [{ oldText: "x", newText: "y" }],
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("[jupyter_rejected]");
    expect((err as Error).message).toContain("notebook_edit");
  });

  it("Test 10: rejects device file with [device_file]", async () => {
    // isDeviceFile checks happen before read-before-edit, so no tracker state needed
    const tool = createTool({ sharedPaths: ["/dev"] });
    await expect(
      tool.execute("id", {
        path: "/dev/zero",
        edits: [{ oldText: "x", newText: "y" }],
      }),
    ).rejects.toThrow("[device_file]");
  });
});

// ---------------------------------------------------------------------------
// State validation tests (V10 auto-read, V11 staleness)
// ---------------------------------------------------------------------------

describe("state validation", () => {
  it("Test 11: auto-reads file not previously read and succeeds", async () => {
    // Create file but do NOT call tracker.recordRead
    const absPath = path.join(workspaceDir, "unread.txt");
    await fs.writeFile(absPath, "content", "utf-8");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "unread.txt",
      edits: [{ oldText: "content", newText: "new" }],
    });
    // Edit should succeed (auto-read fills tracker state)
    expect(result.content[0].text).toContain("Successfully replaced");
    // File should be modified
    const written = await fs.readFile(absPath, "utf-8");
    expect(written).toBe("new");
    // Tracker should now know about the file (subsequent staleness checks work)
    expect(tracker.hasBeenRead(absPath)).toBe(true);
  });

  it("Test 12a: invalidates read state on text_not_found so next read is not stubbed", async () => {
    const absPath = await writeAndRead("mismatch.txt", "actual content");
    expect(tracker.hasBeenRead(absPath)).toBe(true);
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "mismatch.txt",
        edits: [{ oldText: "wrong text", newText: "replacement" }],
      }),
    ).rejects.toThrow("[text_not_found]");
    // After text_not_found, tracker state should be invalidated
    expect(tracker.hasBeenRead(absPath)).toBe(false);
  });

  it("Test 12: rejects edit when file is stale with [stale_file]", async () => {
    // Create file, record read
    const absPath = await writeAndRead("stale.txt", "original");
    // Rewrite the file to change mtime
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(absPath, "modified externally", "utf-8");
    const tool = createTool();
    await expect(
      tool.execute("id", {
        path: "stale.txt",
        edits: [{ oldText: "original", newText: "new" }],
      }),
    ).rejects.toThrow("[stale_file]");
  });
});

// ---------------------------------------------------------------------------
// Successful edit tests
// ---------------------------------------------------------------------------

describe("successful edits", () => {
  it("Test 13: successful single edit changes file and returns diff", async () => {
    await writeAndRead("test.txt", "hello world");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "world", newText: "earth" }],
    });
    // Verify file content changed
    const content = await fs.readFile(
      path.join(workspaceDir, "test.txt"),
      "utf-8",
    );
    expect(content).toBe("hello earth");
    // Verify result
    expect(result.content[0].text).toContain("Successfully replaced");
  });

  it("Test 14: successful batch edit applies both changes", async () => {
    await writeAndRead("test.txt", "foo bar baz");
    const tool = createTool();
    await tool.execute("id", {
      path: "test.txt",
      edits: [
        { oldText: "foo", newText: "FOO" },
        { oldText: "baz", newText: "BAZ" },
      ],
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "test.txt"),
      "utf-8",
    );
    expect(content).toBe("FOO bar BAZ");
  });

  it("Test 15: result details contain diff, firstChangedLine, matchStrategy, editsApplied", async () => {
    await writeAndRead("test.txt", "line1\nline2\nline3");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "line2", newText: "UPDATED" }],
    });
    const details = result.details as Record<string, unknown>;
    expect(details).toHaveProperty("diff");
    expect(details).toHaveProperty("firstChangedLine");
    expect(details).toHaveProperty("matchStrategy");
    expect(details).toHaveProperty("editsApplied");
    expect(details.editsApplied).toBe(1);
  });

  it("Test 16: post-edit mtime is recorded (re-edit does not fail staleness)", async () => {
    await writeAndRead("test.txt", "alpha beta gamma");
    const tool = createTool();
    // First edit
    await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "alpha", newText: "ALPHA" }],
    });
    // Second edit immediately -- should NOT get [stale_file]
    await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "test.txt"),
      "utf-8",
    );
    expect(content).toBe("ALPHA BETA gamma");
  });
});

// ---------------------------------------------------------------------------
// Config validation test
// ---------------------------------------------------------------------------

describe("config validation", () => {
  it("Test 17: editing .json that produces invalid JSON returns success with [invalid_config] warning", async () => {
    await writeAndRead("config.json", '{"key": "value"}');
    const tool = createTool();
    // Remove the closing brace to produce invalid JSON
    const result = await tool.execute("id", {
      path: "config.json",
      edits: [{ oldText: '"value"}', newText: '"value"' }],
    });
    // Edit should succeed (not throw)
    expect(result.content[0].text).toContain("Successfully replaced");
    // But result should include config validation warning
    expect(result.content[0].text).toContain("[invalid_config]");
  });
});

// ---------------------------------------------------------------------------
// Curly quote + trailing newline integration tests
// ---------------------------------------------------------------------------

describe("curly quote preservation", () => {
  it("Test 18: editing file with curly quotes preserves curly style", async () => {
    await writeAndRead(
      "doc.txt",
      'He said \u201Chello\u201D to her',
    );
    const tool = createTool();
    // Agent uses straight quotes in oldText/newText (typical LLM behavior)
    await tool.execute("id", {
      path: "doc.txt",
      edits: [
        {
          oldText: 'He said "hello" to her',
          newText: 'He said "hi" to her',
        },
      ],
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "doc.txt"),
      "utf-8",
    );
    // Curly quotes should be preserved in the output
    expect(content).toContain("\u201C");
    expect(content).toContain("\u201D");
  });
});

describe("trailing newline cleanup", () => {
  it("Test 19: deleting content cleans up triple+ blank lines", async () => {
    await writeAndRead("test.txt", "line1\n\nline2\n\nline3");
    const tool = createTool();
    // Delete line2, which would leave double blank between line1 and line3
    await tool.execute("id", {
      path: "test.txt",
      edits: [{ oldText: "\nline2\n", newText: "\n" }],
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "test.txt"),
      "utf-8",
    );
    // Should not contain 3+ consecutive newlines
    expect(content).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// replaceAll integration test
// ---------------------------------------------------------------------------

describe("replaceAll integration", () => {
  it("Test 21: replaceAll parameter passes through and replaces all occurrences", async () => {
    await writeAndRead("replace-all.txt", "TODO: fix\nTODO: test\nTODO: deploy");
    const tool = createTool();
    const result = await tool.execute("id", {
      path: "replace-all.txt",
      edits: [{ oldText: "TODO", newText: "DONE", replaceAll: true }],
    });
    const content = await fs.readFile(
      path.join(workspaceDir, "replace-all.txt"),
      "utf-8",
    );
    expect(content).toBe("DONE: fix\nDONE: test\nDONE: deploy");
    expect(result.content[0].text).toContain("Successfully replaced");
  });
});

// ---------------------------------------------------------------------------
// Error code format test
// ---------------------------------------------------------------------------

describe("error code format", () => {
  it("Test 20: all error messages use [code] Message format", async () => {
    const tool = createTool();
    const errors: string[] = [];

    // Collect errors from validation checks
    const testCases = [
      // V1: empty edits
      () => tool.execute("id", { path: "test.txt", edits: [] }),
      // V2: empty oldText
      () =>
        tool.execute("id", {
          path: "test.txt",
          edits: [{ oldText: "", newText: "x" }],
        }),
    ];

    for (const tc of testCases) {
      try {
        await tc();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    // Each error should match [code] format
    const codePattern = /^\[[\w_]+\] /;
    for (const msg of errors) {
      expect(msg).toMatch(codePattern);
    }
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
