/**
 * Tests for API image sanitizer.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeImageForApi, IMAGE_API_LIMITS } from "./image-sanitizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a solid-color PNG of the given dimensions. */
async function generatePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

/** Generate a solid-color JPEG of the given dimensions and quality. */
async function generateJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 200 },
    },
  })
    .jpeg({ quality })
    .toBuffer();
}

/** Generate a PNG with an alpha channel. */
async function generatePngWithAlpha(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 128, g: 64, b: 200, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sanitizeImageForApi", () => {
  it("passes through small images without modification", async () => {
    const input = await generatePng(100, 100);
    const result = await sanitizeImageForApi(input, "image/png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.width).toBe(100);
    expect(result.value.height).toBe(100);
    expect(result.value.mimeType).toBe("image/png");
    // Buffer should be the same reference (passthrough)
    expect(result.value.buffer).toBe(input);
    expect(result.value.originalBytes).toBe(input.length);
    expect(result.value.sanitizedBytes).toBe(input.length);
  });

  it("resizes large dimension images to fit maxDimension", async () => {
    const input = await generateJpeg(3000, 2000);
    const result = await sanitizeImageForApi(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should fit within 1568px on the longest side
    expect(result.value.width).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
    expect(result.value.height).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
    expect(result.value.mimeType).toBe("image/jpeg");
    expect(result.value.sanitizedBytes).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxBytes);
  });

  it("resizes tall images (portrait orientation)", async () => {
    const input = await generateJpeg(800, 3000);
    const result = await sanitizeImageForApi(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.height).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
    expect(result.value.width).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
  });

  it("outputs PNG for alpha channel images", async () => {
    const input = await generatePngWithAlpha(2000, 2000);
    const result = await sanitizeImageForApi(input, "image/png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.width).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
    expect(result.value.height).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
  });

  it("returns err for empty buffer", async () => {
    const result = await sanitizeImageForApi(Buffer.alloc(0), "image/png");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Empty image buffer");
  });

  it("returns err for invalid image data", async () => {
    const garbage = Buffer.from("not an image at all, just random text data");
    const result = await sanitizeImageForApi(garbage, "image/jpeg");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  it("uses iterative quality reduction for oversized images", async () => {
    // Create a high-quality image that needs quality reduction
    // 1568x1568 at max quality can be large
    const input = await generateJpeg(1568, 1568, 100);
    const result = await sanitizeImageForApi(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sanitizedBytes).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxBytes);
    expect(result.value.mimeType).toBe("image/jpeg");
  });

  it("preserves images that are under both dimension and size limits", async () => {
    const input = await generatePng(500, 500);
    const result = await sanitizeImageForApi(input, "image/png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should be passthrough -- same buffer
    expect(result.value.buffer).toBe(input);
    expect(result.value.originalBytes).toBe(result.value.sanitizedBytes);
  });

  it("reports correct originalBytes and sanitizedBytes after resize", async () => {
    const input = await generateJpeg(3000, 2000);
    const result = await sanitizeImageForApi(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.originalBytes).toBe(input.length);
    // Sanitized bytes should differ from original (resized)
    expect(result.value.sanitizedBytes).not.toBe(result.value.originalBytes);
  });

  it("handles JPEG input that only needs dimension resize", async () => {
    const input = await generateJpeg(2000, 1500);
    const result = await sanitizeImageForApi(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const longest = Math.max(result.value.width, result.value.height);
    expect(longest).toBeLessThanOrEqual(IMAGE_API_LIMITS.maxDimension);
  });
});
