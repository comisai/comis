// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for API image sanitizer.
 */

import zlib from "node:zlib";
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

/**
 * Forge a tiny PNG whose IHDR DECLARES a `width`×`height` pixel count while the
 * file itself is a few dozen bytes — a decompression bomb. A decoder reads the
 * declared dimensions from the IHDR and can be tricked into allocating a huge
 * bitmap; sharp's `limitInputPixels` guard rejects it on the declared count
 * BEFORE decoding, which is exactly what this fixture exercises. No pixel data is
 * needed (an empty IDAT) — the guard trips on the header alone.
 */
function forgePixelBombPng(width: number, height: number): Buffer {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body) >>> 0)]);
  };
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: width, height, bit depth 8, colour type 2 (RGB), default compression/filter/interlace.
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

  it("rejects a decompression bomb whose decoded pixel count exceeds the decode limit, even though its byte size is tiny", async () => {
    // The decode-side pixel cap is a SECOND, independent bound: a byte-size cap
    // alone is not enough because a tiny file can DECLARE a huge decoded bitmap.
    // Forge an IHDR whose pixel count is well past limitInputPixels.
    const side = 20_000;
    expect(side * side).toBeGreaterThan(IMAGE_API_LIMITS.limitInputPixels);
    const bomb = forgePixelBombPng(side, side);
    // Tiny on disk — far under the 5MB byte cap — yet decodes past the pixel cap,
    // so the byte cap would let it through and only the decode cap stops it.
    expect(bomb.length).toBeLessThan(1024);
    expect(bomb.length).toBeLessThan(IMAGE_API_LIMITS.maxBytes);

    const bombed = await sanitizeImageForApi(bomb, "image/png");
    expect(bombed.ok).toBe(false);
    if (!bombed.ok) {
      expect(bombed.error.toLowerCase()).toContain("pixel limit");
    }

    // Contrast: a genuinely small image still passes — the guard rejects the bomb,
    // not everything.
    const normal = await generatePng(64, 64);
    const passed = await sanitizeImageForApi(normal, "image/png");
    expect(passed.ok).toBe(true);
  });
});
