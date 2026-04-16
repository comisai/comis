import { describe, it, expect } from "vitest";
import {
  detectMime,
  getExtensionForMime,
  getExtensionMime,
  normalizeHeaderMime,
  isGenericMime,
} from "./mime-detection.js";

/** First bytes of a PNG (magic number). */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** First bytes of a JPEG (magic number). */
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

/** Minimal valid PNG (1x1 transparent). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("detectMime", () => {
  it("detects PNG via binary sniffing", async () => {
    const result = await detectMime({ buffer: TINY_PNG });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("image/png");
  });

  it("detects JPEG via binary sniffing", async () => {
    // Minimal JPEG-like buffer (enough for file-type to identify)
    const jpegBuf = Buffer.alloc(32);
    jpegBuf[0] = 0xff;
    jpegBuf[1] = 0xd8;
    jpegBuf[2] = 0xff;
    jpegBuf[3] = 0xe0;
    // file-type needs a valid JFIF header for full detection, but
    // we test fallback chain instead for short buffers
    const result = await detectMime({
      buffer: jpegBuf,
      filePath: "photo.jpg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Either binary sniffing succeeds or extension fallback kicks in
    expect(result.value).toMatch(/^image\/jpeg$/);
  });

  it("falls back to headerMime when buffer is unrecognizable", async () => {
    const unknownBuf = Buffer.from("not a real file format");
    const result = await detectMime({
      buffer: unknownBuf,
      headerMime: "audio/mpeg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("audio/mpeg");
  });

  it("falls back to filePath extension when no buffer", async () => {
    const result = await detectMime({ filePath: "document.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("application/pdf");
  });

  it("returns undefined when nothing can be determined", async () => {
    const result = await detectMime({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it("skips generic headerMime (application/octet-stream)", async () => {
    const result = await detectMime({
      headerMime: "application/octet-stream",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it("prefers binary sniff over extension", async () => {
    // TINY_PNG has a .jpg extension but is actually PNG
    const result = await detectMime({
      buffer: TINY_PNG,
      filePath: "misleading.jpg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("image/png");
  });
});

describe("getExtensionForMime", () => {
  it("returns .jpg for image/jpeg", () => {
    expect(getExtensionForMime("image/jpeg")).toBe(".jpg");
  });

  it("returns .png for image/png", () => {
    expect(getExtensionForMime("image/png")).toBe(".png");
  });

  it("returns .pdf for application/pdf", () => {
    expect(getExtensionForMime("application/pdf")).toBe(".pdf");
  });

  it("returns undefined for unknown MIME", () => {
    expect(getExtensionForMime("application/x-unknown")).toBeUndefined();
  });
});

describe("getExtensionMime", () => {
  it("returns image/jpeg for .jpg path", () => {
    expect(getExtensionMime("photo.jpg")).toBe("image/jpeg");
  });

  it("returns application/pdf for .pdf path", () => {
    expect(getExtensionMime("doc.pdf")).toBe("application/pdf");
  });

  it("handles uppercase extensions via lowercase normalization", () => {
    expect(getExtensionMime("Image.PNG")).toBe("image/png");
  });

  it("returns undefined for unknown extension", () => {
    expect(getExtensionMime("file.xyz")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(getExtensionMime(undefined)).toBeUndefined();
  });

  it("returns undefined for files with no extension", () => {
    expect(getExtensionMime("noextension")).toBeUndefined();
  });
});

describe("normalizeHeaderMime", () => {
  it("strips charset parameter", () => {
    expect(normalizeHeaderMime("image/png; charset=utf-8")).toBe("image/png");
  });

  it("lowercases MIME types", () => {
    expect(normalizeHeaderMime("TEXT/PLAIN")).toBe("text/plain");
  });

  it("trims whitespace", () => {
    expect(normalizeHeaderMime("  image/jpeg  ")).toBe("image/jpeg");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeHeaderMime("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeHeaderMime(undefined)).toBeUndefined();
  });
});

describe("isGenericMime", () => {
  it("returns true for application/octet-stream", () => {
    expect(isGenericMime("application/octet-stream")).toBe(true);
  });

  it("returns true for application/zip", () => {
    expect(isGenericMime("application/zip")).toBe(true);
  });

  it("returns true for undefined", () => {
    expect(isGenericMime(undefined)).toBe(true);
  });

  it("returns false for image/png", () => {
    expect(isGenericMime("image/png")).toBe(false);
  });

  it("returns false for text/plain", () => {
    expect(isGenericMime("text/plain")).toBe(false);
  });
});
