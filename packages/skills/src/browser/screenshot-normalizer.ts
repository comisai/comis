/**
 * Screenshot normalization with byte-limit enforcement.
 *
 * Uses sharp to resize and quality-sweep screenshots to stay under a
 * configurable byte limit. Implements a grid search approach: try
 * decreasing quality at current maxSide, then halve maxSide and
 * retry with reset quality.
 *
 * Ported from Comis's normalizeBrowserScreenshot pattern.
 * Supports rich screenshots with viewport control.
 *
 * @module
 */

import sharp from "sharp";
import { ok, err, type Result } from "@comis/shared";

sharp.cache(false);

const LIMIT_INPUT_PIXELS = 268_402_689;

// ── Types ────────────────────────────────────────────────────────────

/** Options for screenshot normalization. */
export interface NormalizeOptions {
  /** Maximum dimension (width or height) in pixels. Default: 2000. */
  readonly maxSide?: number;
  /** Maximum output size in bytes. Default: 512000 (500KB). */
  readonly maxBytes?: number;
  /** Output image format. Default: "jpeg". */
  readonly format?: "jpeg" | "png" | "webp";
  /** Starting quality for lossy formats. Default: 85. */
  readonly qualityStart?: number;
  /** Quality decrease per sweep attempt. Default: 10. */
  readonly qualityStep?: number;
  /** Minimum quality before halving maxSide. Default: 30. */
  readonly qualityMin?: number;
}

/** Result of screenshot normalization. */
export interface NormalizedScreenshot {
  /** The normalized image buffer. */
  readonly buffer: Buffer;
  /** Output image width. */
  readonly width: number;
  /** Output image height. */
  readonly height: number;
  /** Output format used. */
  readonly format: string;
  /** Quality level used (for lossy formats). */
  readonly quality: number;
  /** Original input buffer size in bytes. */
  readonly originalBytes: number;
  /** Normalized output buffer size in bytes. */
  readonly normalizedBytes: number;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Attempt a single resize + format pass at the given maxSide and quality.
 */
async function attempt(
  inputBuffer: Buffer,
  maxSide: number,
  quality: number,
  format: "jpeg" | "png" | "webp",
): Promise<{ buffer: Buffer; width: number; height: number }> {
  let pipeline = sharp(inputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .resize(maxSide, maxSide, {
      fit: "inside",
      withoutEnlargement: true,
    });

  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality });
  } else {
    // PNG -- quality maps to compressionLevel (0-9), higher = more compression
    const compressionLevel = Math.min(9, Math.max(0, Math.round((100 - quality) / 10)));
    pipeline = pipeline.png({ compressionLevel });
  }

  const outputBuffer = await pipeline.toBuffer();
  const metadata = await sharp(outputBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();

  return {
    buffer: outputBuffer,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}

/**
 * Normalize a screenshot buffer to stay under a byte limit.
 *
 * Uses a grid search approach:
 * 1. Start with maxSide and qualityStart
 * 2. If output exceeds maxBytes, decrease quality by qualityStep
 * 3. If quality drops below qualityMin, halve maxSide and reset quality
 * 4. Repeat up to 6 total attempts (2 maxSide values x 3 quality levels)
 * 5. If still over maxBytes, return the smallest result achieved
 *
 * Returns err only on processing failure, not on "still too large".
 *
 * @param buffer - Input screenshot buffer (PNG, JPEG, etc.)
 * @param opts - Normalization options
 * @returns NormalizedScreenshot with size metadata
 */
export async function normalizeScreenshot(
  buffer: Buffer,
  opts?: NormalizeOptions,
): Promise<Result<NormalizedScreenshot, Error>> {
  const maxSide = opts?.maxSide ?? 2000;
  const maxBytes = opts?.maxBytes ?? 512_000;
  const format = opts?.format ?? "jpeg";
  const qualityStart = opts?.qualityStart ?? 85;
  const qualityStep = opts?.qualityStep ?? 10;
  const qualityMin = opts?.qualityMin ?? 30;
  const originalBytes = buffer.length;

  try {
    let bestResult: { buffer: Buffer; width: number; height: number; quality: number } | null = null;
    let currentMaxSide = maxSide;

    // Try up to 2 maxSide levels (original, then halved)
    for (let sizeLevel = 0; sizeLevel < 2; sizeLevel += 1) {
      let quality = qualityStart;

      // Try up to 3 quality levels per maxSide
      for (let qualityLevel = 0; qualityLevel < 3; qualityLevel += 1) {
        const result = await attempt(buffer, currentMaxSide, quality, format);

        // Track best (smallest) result
        if (!bestResult || result.buffer.length < bestResult.buffer.length) {
          bestResult = { ...result, quality };
        }

        // Under budget -- done
        if (result.buffer.length <= maxBytes) {
          return ok({
            buffer: result.buffer,
            width: result.width,
            height: result.height,
            format,
            quality,
            originalBytes,
            normalizedBytes: result.buffer.length,
          });
        }

        // Decrease quality for next attempt
        quality -= qualityStep;
        if (quality < qualityMin) break;
      }

      // Halve maxSide for next round
      currentMaxSide = Math.max(1, Math.round(currentMaxSide / 2));
    }

    // Return the smallest result we achieved (still over budget but best effort)
    if (bestResult) {
      return ok({
        buffer: bestResult.buffer,
        width: bestResult.width,
        height: bestResult.height,
        format,
        quality: bestResult.quality,
        originalBytes,
        normalizedBytes: bestResult.buffer.length,
      });
    }

    // Should not reach here, but handle gracefully
    return err(new Error("normalizeScreenshot: no output produced"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(new Error(`normalizeScreenshot failed: ${msg}`));
  }
}
