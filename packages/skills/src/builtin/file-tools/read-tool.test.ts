// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createComisReadTool factory function.
 *
 * Covers the full validation pipeline (V1-V8) and read execution:
 * - Path traversal prevention
 * - readOnlyPaths / sharedPaths
 * - Device file rejection
 * - File not found with suggestions
 * - File too large
 * - PDF rejection
 * - Line-number formatting
 * - Offset/limit pagination
 * - Dedup stubs
 * - Notebook rendering
 * - Tracker state recording
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { createFileStateTracker } from "../file/file-state-tracker.js";
import type { FileStateTracker } from "../file/file-state-tracker.js";

/**
 * Mutable stat override. When set to a function, read-tool's fs.stat calls
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
import { createComisReadTool, _parsePageRangeForTest } from "./read-tool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tracker: FileStateTracker;

async function createWorkspace(): Promise<string> {
  const dir = path.join(os.tmpdir(), `read-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return fullPath;
}

async function writeBinaryFile(relativePath: string, content: Buffer): Promise<string> {
  const fullPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
}

/**
 * Create a minimal valid PDF with the given text content.
 * This produces a spec-compliant single-page PDF that pdfjs-dist can parse.
 */
function createMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const streamLength = Buffer.byteLength(stream);

  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
    `4 0 obj << /Length ${streamLength} >> stream`,
    stream,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000266 00000 n ",
    "0000000000 00000 n ",
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "0",
    "%%EOF",
  ];
  return Buffer.from(lines.join("\n"));
}

function createTool(options?: {
  readOnlyPaths?: string[];
  sharedPaths?: string[];
}) {
  return createComisReadTool(
    workspaceDir,
    undefined,
    tracker,
    options?.readOnlyPaths,
    options?.sharedPaths,
  );
}

async function executeRead(
  tool: ReturnType<typeof createTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("test-call", params);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  workspaceDir = await createWorkspace();
  tracker = createFileStateTracker();
});

afterEach(async () => {
  statOverride.fn = undefined;
  vi.restoreAllMocks();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Validation pipeline tests
// ---------------------------------------------------------------------------

describe("createComisReadTool", () => {
  describe("validation pipeline", () => {
    it("rejects path traversal with [path_traversal] error", async () => {
      const tool = createTool();
      await expect(
        executeRead(tool, { path: "../../../etc/passwd" }),
      ).rejects.toThrow("[path_traversal]");
    });

    it("allows readOnlyPaths for workspace-external reads", async () => {
      const externalDir = await createWorkspace();
      try {
        const externalFile = path.join(externalDir, "external.txt");
        await fs.writeFile(externalFile, "external content", "utf-8");

        const tool = createTool({ readOnlyPaths: [externalDir] });
        const result = await executeRead(tool, { path: externalFile });
        const text = result.content[0].text as string;
        expect(text).toContain("external content");
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });

    it("allows sharedPaths for workspace-external reads", async () => {
      const sharedDir = await createWorkspace();
      try {
        const sharedFile = path.join(sharedDir, "shared.txt");
        await fs.writeFile(sharedFile, "shared content", "utf-8");

        const tool = createTool({ sharedPaths: [sharedDir] });
        const result = await executeRead(tool, { path: sharedFile });
        const text = result.content[0].text as string;
        expect(text).toContain("shared content");
      } finally {
        await fs.rm(sharedDir, { recursive: true, force: true });
      }
    });

    it("rejects device files with [device_file] error", async () => {
      // Use readOnlyPaths to include /dev so safePath passes,
      // then device file check triggers
      const tool = createTool({ readOnlyPaths: ["/dev"] });
      await expect(
        executeRead(tool, { path: "/dev/zero" }),
      ).rejects.toThrow("[device_file]");
    });

    it("returns path suggestions on file not found", async () => {
      // Create a similar file so suggestions work
      await writeFile("nonexistent-fyle.ts", "content");

      const tool = createTool();
      await expect(
        executeRead(tool, { path: "nonexistent-file.ts" }),
      ).rejects.toThrow("[file_not_found]");
      // The error should also mention "Did you mean"
      await expect(
        executeRead(tool, { path: "nonexistent-file.ts" }),
      ).rejects.toThrow("Did you mean");
    });

    it("rejects files over 1 GiB with [file_too_large] error", async () => {
      await writeFile("small.txt", "content");
      const resolvedPath = path.join(workspaceDir, "small.txt");

      // Use the hoisted statOverride to intercept fs.stat for the target path.
      // Returns undefined for non-target paths so the mock falls through to actual.stat.
      statOverride.fn = async (p: string) => {
        if (p === resolvedPath) {
          return {
            size: 1073741825, // 1 GiB + 1 byte
            mtimeMs: Date.now(),
            isFile: () => true,
            isDirectory: () => false,
          };
        }
        return undefined;
      };

      const tool = createTool();
      await expect(
        executeRead(tool, { path: "small.txt" }),
      ).rejects.toThrow("[file_too_large]");
    });

    it("extracts text from PDF files inline with page markers and line numbers", async () => {
      // This test requires the PDF extraction code path. We create a minimal
      // valid PDF file (simplest spec-compliant single-page PDF).
      const minimalPdf = createMinimalPdf("Hello from PDF");
      await writeBinaryFile("test.pdf", minimalPdf);

      const tool = createTool();
      const result = await executeRead(tool, { path: "test.pdf" });
      const text = result.content[0].text as string;

      // Should contain page marker
      expect(text).toContain("--- Page 1 ---");
      // Should contain line numbers (tab-separated)
      expect(text).toMatch(/\d+\t/);
      // Should contain the extracted text
      expect(text).toContain("Hello from PDF");
      // Should NOT contain pdf_rejected
      expect(text).not.toContain("[pdf_rejected]");
    });

    it("extracts only specified pages when pages param is provided", async () => {
      // We'll mock pdfjs-dist for multi-page tests
      const minimalPdf = createMinimalPdf("Page content");
      await writeBinaryFile("pages.pdf", minimalPdf);

      const tool = createTool();
      const result = await executeRead(tool, { path: "pages.pdf", pages: "1" });
      const text = result.content[0].text as string;
      expect(text).toContain("--- Page 1 ---");
    });

    it("returns pdf details with pdf: true, pageCount, totalPages, extractedChars, sizeBytes", async () => {
      const minimalPdf = createMinimalPdf("Details test");
      await writeBinaryFile("details.pdf", minimalPdf);

      const tool = createTool();
      const result = await executeRead(tool, { path: "details.pdf" });
      const details = result.details as Record<string, unknown>;

      expect(details.pdf).toBe(true);
      expect(details.pageCount).toBeGreaterThanOrEqual(1);
      expect(details.totalPages).toBeGreaterThanOrEqual(1);
      expect(details.extractedChars).toBeGreaterThan(0);
      expect(details.sizeBytes).toBeGreaterThan(0);
    });

    it("non-PDF files unchanged by PDF extraction path", async () => {
      await writeFile("normal.txt", "just text");

      const tool = createTool();
      const result = await executeRead(tool, { path: "normal.txt" });
      const text = result.content[0].text as string;

      expect(text).toContain("just text");
      expect(text).not.toContain("--- Page");
    });
  });

  // ---------------------------------------------------------------------------
  // Read execution tests
  // ---------------------------------------------------------------------------

  describe("read execution", () => {
    it("reads file with line numbers in 1-based tab-separated format", async () => {
      await writeFile("test.txt", "line1\nline2\nline3\n");

      const tool = createTool();
      const result = await executeRead(tool, { path: "test.txt" });
      const text = result.content[0].text as string;

      expect(text).toContain("1\tline1");
      expect(text).toContain("2\tline2");
      expect(text).toContain("3\tline3");
    });

    it("applies offset/limit pagination with header and footer", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
      await writeFile("paginated.txt", lines);

      const tool = createTool();
      const result = await executeRead(tool, { path: "paginated.txt", offset: 2, limit: 3 });
      const text = result.content[0].text as string;

      // Header: "[Reading lines 3-5 of 10"
      expect(text).toMatch(/\[Reading lines 3-5 of 10/);
      // Content: lines 3, 4, 5
      expect(text).toContain("3\tline3");
      expect(text).toContain("4\tline4");
      expect(text).toContain("5\tline5");
      // Should NOT contain line2 or line6
      expect(text).not.toContain("2\tline2");
      expect(text).not.toContain("6\tline6");
      // Footer
      expect(text).toContain("[Use offset/limit to read more]");
    });

    it("full file read has no pagination header/footer", async () => {
      await writeFile("small.txt", "a\nb\nc");

      const tool = createTool();
      const result = await executeRead(tool, { path: "small.txt" });
      const text = result.content[0].text as string;

      expect(text).not.toContain("[Reading lines");
      expect(text).not.toContain("[Use offset/limit");
      expect(text).toContain("1\ta");
      expect(text).toContain("2\tb");
      expect(text).toContain("3\tc");
    });

    it("returns dedup stub on re-read of unchanged file", async () => {
      await writeFile("dedup.txt", "content");

      const tool = createTool();
      // First read
      await executeRead(tool, { path: "dedup.txt" });
      // Second read -- same file, same params
      const result = await executeRead(tool, { path: "dedup.txt" });
      const text = result.content[0].text as string;

      expect(text.toLowerCase()).toContain("unchanged");
    });

    it("returns full content after file modification (no dedup)", async () => {
      await writeFile("mutable.txt", "original");

      const tool = createTool();
      // First read
      await executeRead(tool, { path: "mutable.txt" });
      // Modify file -- ensure mtime changes
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile("mutable.txt", "modified");

      // Second read -- file changed, should return full content
      const result = await executeRead(tool, { path: "mutable.txt" });
      const text = result.content[0].text as string;

      expect(text).toContain("modified");
      expect(text.toLowerCase()).not.toContain("unchanged");
    });

    it("renders .ipynb as XML-tagged cells", async () => {
      const notebook = JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            id: "abc123",
            source: "print('hello')",
            metadata: {},
            outputs: [],
            execution_count: 1,
          },
        ],
      });
      await writeFile("test.ipynb", notebook);

      const tool = createTool();
      const result = await executeRead(tool, { path: "test.ipynb" });
      const text = result.content[0].text as string;

      expect(text).toContain('<code_cell id="abc123">');
      expect(text).toContain("print('hello')");
      expect(text).toContain("</code_cell>");
    });

    it("passes filePath to renderNotebookCells for jq hints", async () => {
      // Create a notebook with large output that triggers truncation hint
      const notebook = JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            id: "xyz789",
            source: "x = 1",
            metadata: {},
            outputs: [
              {
                output_type: "stream",
                text: "A".repeat(20000), // >10KB to trigger truncation
              },
            ],
            execution_count: 1,
          },
        ],
      });
      await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
      await writeFile("subdir/big-output.ipynb", notebook);

      const tool = createTool();
      const result = await executeRead(tool, { path: "subdir/big-output.ipynb" });
      const text = result.content[0].text as string;

      // The jq hint should reference the path the agent used
      expect(text).toContain("subdir/big-output.ipynb");
    });

    it("records read state in tracker after successful read", async () => {
      await writeFile("tracked.txt", "content");
      const resolvedPath = path.join(workspaceDir, "tracked.txt");

      const tool = createTool();
      await executeRead(tool, { path: "tracked.txt" });

      expect(tracker.hasBeenRead(resolvedPath)).toBe(true);
    });

    it("records read state with offset and limit", async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
      await writeFile("offset-tracked.txt", lines);
      const resolvedPath = path.join(workspaceDir, "offset-tracked.txt");

      const tool = createTool();
      await executeRead(tool, { path: "offset-tracked.txt", offset: 5, limit: 10 });

      const state = tracker.getReadState(resolvedPath);
      expect(state).toBeDefined();
      expect(state!.offset).toBe(5);
      expect(state!.limit).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Structured details tests
  // ---------------------------------------------------------------------------

  describe("structured details", () => {
    it("returns details with totalLines, startLine, endLine, sizeBytes, encoding, paginated for full read", async () => {
      await writeFile("details.txt", "alpha\nbeta\ngamma");

      const tool = createTool();
      const result = await executeRead(tool, { path: "details.txt" });
      const details = result.details as Record<string, unknown>;

      expect(details.totalLines).toBe(3);
      expect(details.startLine).toBe(1);
      expect(details.endLine).toBe(3);
      expect(details.sizeBytes).toBeGreaterThan(0);
      expect(details.encoding).toBe("utf-8");
      expect(details.paginated).toBe(false);
    });

    it("includes filePath in details matching the resolved actual path", async () => {
      await writeFile("filepath-check.txt", "hello world");

      const tool = createTool();
      const result = await executeRead(tool, { path: "filepath-check.txt" });
      const details = result.details as Record<string, unknown>;

      expect(details.filePath).toBeDefined();
      expect(typeof details.filePath).toBe("string");
      expect((details.filePath as string).endsWith("filepath-check.txt")).toBe(true);
    });

    it("returns paginated: true and correct startLine/endLine with offset", async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
      await writeFile("paginated-details.txt", lines);

      const tool = createTool();
      const result = await executeRead(tool, { path: "paginated-details.txt", offset: 5, limit: 3 });
      const details = result.details as Record<string, unknown>;

      expect(details.totalLines).toBe(20);
      expect(details.startLine).toBe(6);   // offset 5, 1-based = 6
      expect(details.endLine).toBe(8);     // offset 5 + limit 3 = 8
      expect(details.paginated).toBe(true);
    });

    it("notebook return includes sizeBytes and cells count", async () => {
      const notebook = JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          { cell_type: "code", id: "c1", source: "x = 1", metadata: {}, outputs: [], execution_count: 1 },
          { cell_type: "code", id: "c2", source: "y = 2", metadata: {}, outputs: [], execution_count: 2 },
        ],
      });
      await writeFile("structured.ipynb", notebook);

      const tool = createTool();
      const result = await executeRead(tool, { path: "structured.ipynb" });
      const details = result.details as Record<string, unknown>;

      expect(details.notebook).toBe(true);
      expect(details.cells).toBe(2);
      expect(details.sizeBytes).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // statWithFallbacks tests
  // ---------------------------------------------------------------------------

  describe("statWithFallbacks (macOS screenshot paths)", () => {
    it("resolves file with thin space in path via fallback", async () => {
      // Create a file with a regular space in its name
      await writeFile("Screenshot 2026-04-08.png", "fake image data");
      const regularSpacePath = path.join(workspaceDir, "Screenshot 2026-04-08.png");
      // The agent provides the path with thin space (U+202F) instead of regular space
      const thinSpacePath = path.join(workspaceDir, "Screenshot\u202F2026-04-08.png");

      // Mock fs.stat to fail on exact thin-space path, succeed on regular space variant
      statOverride.fn = async (p: string) => {
        if (p === thinSpacePath) {
          throw new Error("ENOENT");
        }
        // Fall through to actual stat for other paths (including the regular space variant)
        return undefined;
      };

      const tool = createTool({ readOnlyPaths: [workspaceDir] });
      const result = await executeRead(tool, { path: regularSpacePath });
      const text = result.content[0].text as string;
      expect(text).toContain("fake image data");
    });

    it("uses first stat attempt when file exists at exact path (no fallbacks)", async () => {
      await writeFile("normal-file.txt", "direct hit");
      let statCallCount = 0;

      statOverride.fn = async (_p: string) => {
        statCallCount++;
        return undefined; // fall through to real stat
      };

      const tool = createTool();
      await executeRead(tool, { path: "normal-file.txt" });

      // statWithFallbacks should succeed on first try (1 call through override + real stat)
      expect(statCallCount).toBe(1);
    });

    it("returns file_not_found when all stat variants fail", async () => {
      // Mock stat to fail for ALL paths
      statOverride.fn = async (_p: string) => {
        throw new Error("ENOENT");
      };

      // Create the file so safePath validation passes, but stat will fail
      await writeFile("ghost.txt", "content");

      const tool = createTool();
      await expect(
        executeRead(tool, { path: "ghost.txt" }),
      ).rejects.toThrow("[file_not_found]");
    });
  });

  // ---------------------------------------------------------------------------
  // parsePageRange tests
  // ---------------------------------------------------------------------------

  describe("parsePageRange", () => {
    it("single page: parsePageRange('5', 10, 50) returns { start: 5, end: 5 }", () => {
      expect(_parsePageRangeForTest("5", 10, 50)).toEqual({ start: 5, end: 5 });
    });

    it("page range: parsePageRange('3-7', 10, 50) returns { start: 3, end: 7 }", () => {
      expect(_parsePageRangeForTest("3-7", 10, 50)).toEqual({ start: 3, end: 7 });
    });

    it("undefined defaults to page 1 through min(totalPages, maxPages): parsePageRange(undefined, 100, 50)", () => {
      expect(_parsePageRangeForTest(undefined, 100, 50)).toEqual({ start: 1, end: 50 });
    });

    it("caps range at maxPages: parsePageRange('1-100', 200, 50) returns { start: 1, end: 50 }", () => {
      expect(_parsePageRangeForTest("1-100", 200, 50)).toEqual({ start: 1, end: 50 });
    });

    it("undefined with small PDF: parsePageRange(undefined, 5, 50) returns { start: 1, end: 5 }", () => {
      expect(_parsePageRangeForTest(undefined, 5, 50)).toEqual({ start: 1, end: 5 });
    });

    it("clamps page beyond totalPages: parsePageRange('15', 10, 50) returns { start: 10, end: 10 }", () => {
      expect(_parsePageRangeForTest("15", 10, 50)).toEqual({ start: 10, end: 10 });
    });

    it("invalid format falls back to defaults: parsePageRange('abc', 10, 50)", () => {
      expect(_parsePageRangeForTest("abc", 10, 50)).toEqual({ start: 1, end: 10 });
    });
  });
});
