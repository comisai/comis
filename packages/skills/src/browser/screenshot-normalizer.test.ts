import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { normalizeScreenshot } from "./screenshot-normalizer.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a solid-color PNG test image. */
async function createTestPng(
  width: number,
  height: number,
  color = { r: 128, g: 128, b: 128 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

// ── Tests ────────────────────────────────────────────────────────────

describe("normalizeScreenshot", () => {
  it("should return NormalizedScreenshot with correct fields", async () => {
    const input = await createTestPng(500, 500);
    const result = await normalizeScreenshot(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.buffer).toBeInstanceOf(Buffer);
    expect(result.value.width).toBeGreaterThan(0);
    expect(result.value.height).toBeGreaterThan(0);
    expect(result.value.format).toBe("jpeg");
    expect(result.value.quality).toBeGreaterThan(0);
    expect(result.value.originalBytes).toBe(input.length);
    expect(result.value.normalizedBytes).toBeGreaterThan(0);
  });

  it("should return at qualityStart for small image under maxBytes", async () => {
    const input = await createTestPng(100, 100);
    const result = await normalizeScreenshot(input, {
      maxBytes: 1_000_000, // 1MB -- plenty of room
      qualityStart: 85,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Small solid color image should be under 1MB at quality 85
    expect(result.value.quality).toBe(85);
    expect(result.value.normalizedBytes).toBeLessThanOrEqual(1_000_000);
  });

  it("should produce webp output when format is webp", async () => {
    const input = await createTestPng(200, 200);
    const result = await normalizeScreenshot(input, { format: "webp" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.format).toBe("webp");
    // Verify it's actually a valid webp by reading metadata
    const meta = await sharp(result.value.buffer).metadata();
    expect(meta.format).toBe("webp");
  });

  it("should respect maxSide for large images", async () => {
    const input = await createTestPng(4000, 3000);
    const result = await normalizeScreenshot(input, {
      maxSide: 500,
      maxBytes: 10_000_000, // large budget so we don't trigger quality sweep
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Output should be resized to fit within 500px max side
    expect(result.value.width).toBeLessThanOrEqual(500);
    expect(result.value.height).toBeLessThanOrEqual(500);
  });

  it("should resize large images down", async () => {
    const input = await createTestPng(4000, 3000);
    const result = await normalizeScreenshot(input, { maxSide: 2000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.width).toBeLessThanOrEqual(2000);
    expect(result.value.height).toBeLessThanOrEqual(2000);
  });

  it("should trigger quality sweep with very low maxBytes", async () => {
    // Create a more complex image that produces larger output
    const input = await createTestPng(1000, 1000, { r: 255, g: 0, b: 128 });
    const result = await normalizeScreenshot(input, {
      maxBytes: 500, // Very small -- will force quality sweep
      qualityStart: 85,
      qualityStep: 10,
      qualityMin: 30,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have tried lower quality or smaller maxSide
    // The quality will be less than qualityStart OR the dimensions will be smaller
    const wentLower =
      result.value.quality < 85 ||
      result.value.width < 1000 ||
      result.value.height < 1000;
    expect(wentLower).toBe(true);
  });

  it("should return err for invalid buffer", async () => {
    const result = await normalizeScreenshot(Buffer.from("not an image"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("normalizeScreenshot failed");
    }
  });

  it("should apply defaults when opts omitted", async () => {
    const input = await createTestPng(300, 300);
    const result = await normalizeScreenshot(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Default format is jpeg
    expect(result.value.format).toBe("jpeg");
    // Default maxSide is 2000 -- 300px image should not be resized
    expect(result.value.width).toBe(300);
    expect(result.value.height).toBe(300);
  });

  it("should produce png output when format is png", async () => {
    const input = await createTestPng(200, 200);
    const result = await normalizeScreenshot(input, { format: "png" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.format).toBe("png");
    const meta = await sharp(result.value.buffer).metadata();
    expect(meta.format).toBe("png");
  });

  it("should not enlarge small images beyond original dimensions", async () => {
    const input = await createTestPng(100, 80);
    const result = await normalizeScreenshot(input, { maxSide: 5000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // withoutEnlargement should prevent upscaling
    expect(result.value.width).toBe(100);
    expect(result.value.height).toBe(80);
  });
});
