// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeAll } from "vitest";
import sharp from "sharp";
import { createImageProcessor } from "./image-ops.js";
import type { ImageProcessor } from "./image-ops.js";

/**
 * Minimal 1x1 red PNG (base64-decoded).
 * Used for tests that just need a valid image buffer.
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

/** 100x200 red PNG generated via sharp for resize testing. */
let LARGE_PNG: Buffer;

/** Reusable mock logger. */
function mockLogger() {
  return { warn: vi.fn() };
}

/** Fresh processor for each test. */
function makeProcessor(): ImageProcessor {
  return createImageProcessor({ logger: mockLogger() });
}

beforeAll(async () => {
  LARGE_PNG = await sharp({
    create: {
      width: 100,
      height: 200,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
});

describe("createImageProcessor", () => {
  it("returns an object with resize, convertFormat, metadata, normalizeOrientation methods", () => {
    const processor = makeProcessor();
    expect(typeof processor.resize).toBe("function");
    expect(typeof processor.convertFormat).toBe("function");
    expect(typeof processor.metadata).toBe("function");
    expect(typeof processor.normalizeOrientation).toBe("function");
  });
});

describe("metadata", () => {
  it("returns correct width, height, format for a known PNG buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.metadata(LARGE_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.width).toBe(100);
    expect(result.value.height).toBe(200);
    expect(result.value.format).toBe("png");
  });

  it("returns sizeBytes matching buffer length", async () => {
    const processor = makeProcessor();
    const result = await processor.metadata(LARGE_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sizeBytes).toBe(LARGE_PNG.length);
  });

  it("returns err Result for empty buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.metadata(Buffer.alloc(0));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("resize", () => {
  it("with maxSide=50 on a 100x200 image returns dimensions within 50x50 bounds", async () => {
    const processor = makeProcessor();
    const result = await processor.resize(LARGE_PNG, { maxSide: 50 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the output dimensions via sharp metadata
    const meta = await sharp(result.value).metadata();
    expect(meta.width).toBeLessThanOrEqual(50);
    expect(meta.height).toBeLessThanOrEqual(50);
    // Aspect ratio 1:2 => 25x50
    expect(meta.width).toBe(25);
    expect(meta.height).toBe(50);
  });

  it("with withoutEnlargement=true (default) does not upscale a small image", async () => {
    const processor = makeProcessor();
    // TINY_PNG is 1x1, maxSide=500 -- should NOT upscale
    const result = await processor.resize(TINY_PNG, { maxSide: 500 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await sharp(result.value).metadata();
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
  });

  it("respects explicit format option", async () => {
    const processor = makeProcessor();
    const result = await processor.resize(LARGE_PNG, {
      maxSide: 50,
      format: "jpeg",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // JPEG magic bytes: 0xFF 0xD8
    expect(result.value[0]).toBe(0xff);
    expect(result.value[1]).toBe(0xd8);
  });

  it("returns err Result for invalid buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.resize(Buffer.from("not an image"), {
      maxSide: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("convertFormat", () => {
  it("to jpeg produces a valid JPEG buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.convertFormat(LARGE_PNG, "jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // JPEG magic bytes: 0xFF 0xD8
    expect(result.value[0]).toBe(0xff);
    expect(result.value[1]).toBe(0xd8);
  });

  it("to webp produces a valid WebP buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.convertFormat(LARGE_PNG, "webp");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // WebP starts with RIFF header: "RIFF"
    const header = result.value.subarray(0, 4).toString("ascii");
    expect(header).toBe("RIFF");
  });

  it("to png produces a valid PNG buffer", async () => {
    const processor = makeProcessor();
    const result = await processor.convertFormat(LARGE_PNG, "png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(result.value[0]).toBe(0x89);
    expect(result.value[1]).toBe(0x50); // "P"
    expect(result.value[2]).toBe(0x4e); // "N"
    expect(result.value[3]).toBe(0x47); // "G"
  });

  it("respects custom quality parameter", async () => {
    const processor = makeProcessor();
    const lowQ = await processor.convertFormat(LARGE_PNG, "jpeg", 10);
    const highQ = await processor.convertFormat(LARGE_PNG, "jpeg", 95);

    expect(lowQ.ok).toBe(true);
    expect(highQ.ok).toBe(true);
    if (!lowQ.ok || !highQ.ok) return;

    // Lower quality should produce a smaller buffer
    expect(lowQ.value.length).toBeLessThan(highQ.value.length);
  });
});

describe("normalizeOrientation", () => {
  it("returns ok Result for a valid image", async () => {
    const processor = makeProcessor();
    const result = await processor.normalizeOrientation(LARGE_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Output should still be a valid image buffer
    const meta = await sharp(result.value).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("returns ok Result for tiny PNG (no EXIF to strip)", async () => {
    const processor = makeProcessor();
    const result = await processor.normalizeOrientation(TINY_PNG);

    expect(result.ok).toBe(true);
  });
});

describe("Result type contract", () => {
  it("all methods return objects with an ok property", async () => {
    const processor = makeProcessor();

    const resizeResult = await processor.resize(LARGE_PNG, { maxSide: 50 });
    const convertResult = await processor.convertFormat(LARGE_PNG, "jpeg");
    const metaResult = await processor.metadata(LARGE_PNG);
    const orientResult = await processor.normalizeOrientation(LARGE_PNG);

    expect("ok" in resizeResult).toBe(true);
    expect("ok" in convertResult).toBe(true);
    expect("ok" in metaResult).toBe(true);
    expect("ok" in orientResult).toBe(true);
  });

  it("error results have error property that is an Error instance", async () => {
    const processor = makeProcessor();

    const badBuffer = Buffer.from("definitely not an image file contents");
    const result = await processor.metadata(badBuffer);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
  });
});
