// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMediaPersistenceService } from "./media-persistence.js";
import type { MediaPersistenceService, PersistedFile } from "./media-persistence.js";

// --- Magic byte buffers for MIME detection ---

/** JPEG: FF D8 FF E0 */
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);

/** PNG: 89 50 4E 47 0D 0A 1A 0A */
const PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...Array(100).fill(0),
]);

/** PDF: 25 50 44 46 (%PDF) */
const PDF_BUFFER = Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(100).fill(0)]);

/** Generic binary with no recognizable magic bytes */
const UNKNOWN_BUFFER = Buffer.from([0x00, 0x01, 0x02, 0x03, ...Array(100).fill(0)]);

let tmpDir: string;
let service: MediaPersistenceService;

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(`${os.tmpdir()}/comis-persist-test-`);
  service = createMediaPersistenceService({
    workspaceDir: tmpDir,
    logger: mockLogger(),
  });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("createMediaPersistenceService", () => {
  describe("image routing", () => {
    it("saves JPEG buffer to photos/ with .jpg extension", async () => {
      const result = await service.persist(JPEG_BUFFER, {
        mediaKind: "image",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^photos\/[0-9a-f-]+\.jpg$/);
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.mediaKind).toBe("image");
      expect(result.value.sizeBytes).toBe(JPEG_BUFFER.length);
      expect(result.value.savedAt).toBeGreaterThan(0);

      // File must exist on disk with correct content
      const diskContent = await fsp.readFile(result.value.filePath);
      expect(diskContent.equals(JPEG_BUFFER)).toBe(true);
    });

    it("saves PNG buffer to photos/ with .png extension", async () => {
      const result = await service.persist(PNG_BUFFER, {
        mediaKind: "image",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^photos\/[0-9a-f-]+\.png$/);
      expect(result.value.mimeType).toBe("image/png");
    });
  });

  describe("video routing", () => {
    it("saves video buffer to videos/ subdirectory", async () => {
      // MP4 files have magic bytes at offset 4: "ftyp"
      const mp4Buffer = Buffer.alloc(200);
      mp4Buffer.write("ftyp", 4, "ascii");

      const result = await service.persist(mp4Buffer, {
        mimeType: "video/mp4",
        mediaKind: "video",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^videos\//);
      expect(result.value.mediaKind).toBe("video");

      // File must exist on disk
      const stat = await fsp.stat(result.value.filePath);
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("document routing", () => {
    it("saves PDF buffer to documents/ with .pdf extension", async () => {
      const result = await service.persist(PDF_BUFFER, {
        mediaKind: "document",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^documents\/[0-9a-f-]+\.pdf$/);
      expect(result.value.mimeType).toBe("application/pdf");
      expect(result.value.mediaKind).toBe("document");
    });
  });

  describe("audio routing", () => {
    it("saves audio buffer to audio/ subdirectory", async () => {
      // OGG magic bytes: OggS
      const oggBuffer = Buffer.alloc(200);
      oggBuffer.write("OggS", 0, "ascii");

      const result = await service.persist(oggBuffer, {
        mimeType: "audio/ogg",
        mediaKind: "audio",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^audio\//);
      expect(result.value.mediaKind).toBe("audio");
    });
  });

  describe("binary/unknown routing", () => {
    it("saves unknown MIME type to files/ with .bin extension", async () => {
      const result = await service.persist(UNKNOWN_BUFFER, {
        mediaKind: "binary",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.relativePath).toMatch(/^files\/[0-9a-f-]+\.bin$/);
      expect(result.value.mediaKind).toBe("binary");
    });
  });

  describe("size limits", () => {
    it("rejects oversized buffers with error result", async () => {
      const smallService = createMediaPersistenceService({
        workspaceDir: tmpDir,
        logger: mockLogger(),
        maxBytes: 50,
      });

      const largeBuf = Buffer.alloc(100);
      const result = await smallService.persist(largeBuf, {
        mediaKind: "image",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("exceeds");
    });

    it("does not write file to disk when size exceeds limit", async () => {
      const smallService = createMediaPersistenceService({
        workspaceDir: tmpDir,
        logger: mockLogger(),
        maxBytes: 50,
      });

      const largeBuf = Buffer.alloc(100);
      await smallService.persist(largeBuf, { mediaKind: "image" });

      // photos/ directory should not have been created
      const photosDir = `${tmpDir}/photos`;
      await expect(fsp.access(photosDir)).rejects.toThrow();
    });
  });

  describe("directory creation", () => {
    it("creates subdirectory when it does not exist", async () => {
      const result = await service.persist(JPEG_BUFFER, {
        mediaKind: "image",
      });

      expect(result.ok).toBe(true);

      // photos/ directory should now exist
      const stat = await fsp.stat(`${tmpDir}/photos`);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("PersistedFile shape", () => {
    it("returns all required fields in PersistedFile", async () => {
      const result = await service.persist(JPEG_BUFFER, {
        mediaKind: "image",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const file: PersistedFile = result.value;
      expect(typeof file.filePath).toBe("string");
      expect(typeof file.relativePath).toBe("string");
      expect(typeof file.mimeType).toBe("string");
      expect(typeof file.sizeBytes).toBe("number");
      expect(typeof file.mediaKind).toBe("string");
      expect(typeof file.savedAt).toBe("number");

      // filePath should be absolute
      expect(file.filePath.startsWith("/")).toBe(true);
      // relativePath should NOT be absolute
      expect(file.relativePath.startsWith("/")).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns err for write failures without throwing", async () => {
      // Use a non-writable path to trigger failure
      const badService = createMediaPersistenceService({
        workspaceDir: "/nonexistent/deeply/nested/path/that/cannot/exist",
        logger: mockLogger(),
      });

      const result = await badService.persist(JPEG_BUFFER, {
        mediaKind: "image",
      });

      // Should return err, not throw
      expect(result.ok).toBe(false);
    });
  });

  describe("subdirOverride routing", () => {
    it("subdirOverride routes to custom subdirectory instead of KIND_TO_SUBDIR default", async () => {
      const result = await service.persist(JPEG_BUFFER, {
        mediaKind: "image",
        subdirOverride: "screenshots",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should route to "screenshots/" instead of the default "photos/" for images
      expect(result.value.relativePath).toMatch(/^screenshots\/[0-9a-f-]+\.jpg$/);
      expect(result.value.mediaKind).toBe("image");
      expect(result.value.mimeType).toBe("image/jpeg");

      // Verify file actually exists on disk at the overridden path
      const stat = await fsp.stat(result.value.filePath);
      expect(stat.isFile()).toBe(true);

      // Verify the screenshots/ subdirectory was created inside tmpDir
      const screenshotsDir = `${tmpDir}/screenshots`;
      const dirStat = await fsp.stat(screenshotsDir);
      expect(dirStat.isDirectory()).toBe(true);
    });
  });

  describe("MIME detection priority", () => {
    it("uses binary magic bytes over provided mimeType", async () => {
      // Send a JPEG buffer but claim it's PNG via mimeType
      const result = await service.persist(JPEG_BUFFER, {
        mimeType: "image/png",
        mediaKind: "image",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Binary sniffing should detect JPEG regardless of header claim
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.relativePath).toMatch(/\.jpg$/);
    });

    it("falls back to provided mimeType when binary detection fails", async () => {
      // Unknown binary but we provide a mimeType hint
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, ...Array(50).fill(0)]);
      const result = await service.persist(buf, {
        mimeType: "text/plain",
        mediaKind: "document",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.mimeType).toBe("text/plain");
      expect(result.value.relativePath).toMatch(/\.txt$/);
    });
  });
});
