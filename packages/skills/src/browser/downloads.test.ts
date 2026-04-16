import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { safePath } from "@comis/core";
import {
  waitForDownload,
  listDownloads,
  _getArmCounter,
  _resetArmCounter,
} from "./downloads.js";

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockDownload(overrides: {
  url?: string;
  suggestedFilename?: string;
  saveAs?: (path: string) => Promise<void>;
} = {}) {
  return {
    url: () => overrides.url ?? "https://example.com/file.pdf",
    suggestedFilename: () => overrides.suggestedFilename ?? "report.pdf",
    saveAs: overrides.saveAs ?? (async (savePath: string) => {
      await fs.promises.writeFile(savePath, "mock file content");
    }),
  };
}

function createMockPage(download: ReturnType<typeof createMockDownload>) {
  return {
    waitForEvent: vi.fn(async (_event: string, _opts?: { timeout: number }) => {
      return download;
    }),
  };
}

describe("downloads", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(safePath(os.tmpdir(), "comis-downloads-test-"));
    _resetArmCounter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("waitForDownload", () => {
    it("saves file and returns DownloadResult", async () => {
      const mockDownload = createMockDownload();
      const mockPage = createMockPage(mockDownload);

      const result = await waitForDownload(
        mockPage as any,
        { downloadsDir: tmpDir, timeoutMs: 5000 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.url).toBe("https://example.com/file.pdf");
      expect(result.value.suggestedFilename).toBe("report.pdf");
      expect(result.value.sizeBytes).toBeGreaterThan(0);
      expect(result.value.path).toContain("report.pdf");
      // Verify UUID prefix in path
      expect(result.value.path).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      // Verify file exists
      expect(fs.existsSync(result.value.path)).toBe(true);
    });

    it("handles timeout error", async () => {
      const mockPage = {
        waitForEvent: vi.fn(async () => {
          throw new Error("Timeout 5000ms exceeded");
        }),
      };

      const result = await waitForDownload(
        mockPage as any,
        { downloadsDir: tmpDir, timeoutMs: 500 },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Timeout");
      }
    });

    it("clamps timeout to valid range", async () => {
      const mockDownload = createMockDownload();
      const mockPage = createMockPage(mockDownload);

      // timeoutMs below minimum should be clamped to 500
      await waitForDownload(mockPage as any, { downloadsDir: tmpDir, timeoutMs: 10 });
      expect(mockPage.waitForEvent).toHaveBeenCalledWith("download", { timeout: 500 });
    });

    it("increments arm counter on each call", async () => {
      const mockDownload = createMockDownload();
      const mockPage = createMockPage(mockDownload);

      const before = _getArmCounter();
      await waitForDownload(mockPage as any, { downloadsDir: tmpDir });
      const after = _getArmCounter();

      expect(after).toBe(before + 1);
    });

    it("detects superseded downloads via arm-id pattern", async () => {
      // Simulate a slow download that gets superseded
      let resolveFirst: ((d: any) => void) | null = null;
      const slowPage = {
        waitForEvent: vi.fn(
          () => new Promise<any>((resolve) => { resolveFirst = resolve; }),
        ),
      };

      const firstPromise = waitForDownload(slowPage as any, { downloadsDir: tmpDir });

      // Second call bumps the arm counter, superseding the first
      const mockDownload2 = createMockDownload();
      const fastPage = createMockPage(mockDownload2);
      const secondResult = await waitForDownload(fastPage as any, { downloadsDir: tmpDir });

      // Now resolve the first waiter
      const mockDownload1 = createMockDownload({ suggestedFilename: "old.pdf" });
      resolveFirst!(mockDownload1);
      const firstResult = await firstPromise;

      // First should be superseded
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) {
        expect(firstResult.error.message).toContain("superseded");
      }

      // Second should succeed
      expect(secondResult.ok).toBe(true);
    });
  });

  describe("listDownloads", () => {
    it("reads directory entries with UUID-prefixed filenames", async () => {
      // Create files with UUID-prefix pattern
      const uuid1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const uuid2 = "11223344-5566-7788-99aa-bbccddeeff00";
      const file1 = safePath(tmpDir, `${uuid1}-document.pdf`);
      const file2 = safePath(tmpDir, `${uuid2}-image.png`);
      await fs.promises.writeFile(file1, "pdf content");
      await fs.promises.writeFile(file2, "image content");

      // Also create a non-UUID file that should be skipped
      await fs.promises.writeFile(safePath(tmpDir, "not-a-uuid-file.txt"), "ignored");

      const result = await listDownloads(tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      const filenames = result.value.map((r) => r.suggestedFilename).sort();
      expect(filenames).toEqual(["document.pdf", "image.png"]);

      for (const entry of result.value) {
        expect(entry.sizeBytes).toBeGreaterThan(0);
        expect(entry.path).toBeTruthy();
      }
    });

    it("returns empty list for empty directory", async () => {
      const result = await listDownloads(tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it("returns err for non-existent directory", async () => {
      const result = await listDownloads(safePath(tmpDir, "nonexistent"));
      expect(result.ok).toBe(false);
    });
  });
});
