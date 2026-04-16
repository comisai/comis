/**
 * API image sanitizer -- validates, resizes, and re-encodes images
 * to fit within LLM provider API limits (Anthropic vision).
 *
 * Uses iterative JPEG quality reduction when resizing alone does not
 * bring the image under the 5MB limit. Rejects decompression bomb
 * images via sharp's limitInputPixels guard.
 */

import sharp from "sharp";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";

// Disable sharp cache to prevent memory accumulation across calls
sharp.cache(false);

/** Anthropic API image constraints. */
export const IMAGE_API_LIMITS = {
  maxBytes: 5 * 1024 * 1024, // 5MB (Anthropic binding constraint)
  maxDimension: 1568, // Optimal for Anthropic vision
  limitInputPixels: 268_402_689, // Decompression bomb protection
} as const;

/** Result of a successful image sanitization. */
export interface SanitizedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  originalBytes: number;
  sanitizedBytes: number;
}

/** JPEG quality steps for iterative reduction. */
const QUALITY_STEPS = [85, 75, 65, 55, 45] as const;

/**
 * Sanitize an image buffer so it fits within Anthropic vision API limits.
 *
 * - Passthrough if already within limits (no resize, no recompression).
 * - Auto-rotates via EXIF data.
 * - Resizes to fit maxDimension (1568px) without enlargement.
 * - Uses iterative JPEG quality reduction for oversized images.
 * - Preserves PNG output for images with alpha channels.
 * - Returns err() for corrupt, empty, or decompression-bomb images.
 *
 * @param buffer - Raw image bytes.
 * @param mimeType - MIME type of the input image.
 * @returns Result with sanitized image or error message.
 */
export async function sanitizeImageForApi(
  buffer: Buffer,
  mimeType: string,
): Promise<Result<SanitizedImage, string>> {
  if (!buffer || buffer.length === 0) {
    return err("Empty image buffer");
  }

  try {
    const image = sharp(buffer, {
      limitInputPixels: IMAGE_API_LIMITS.limitInputPixels,
    });

    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      return err("Unable to read image dimensions -- possibly corrupt or unsupported format");
    }

    const originalBytes = buffer.length;
    const needsResize =
      metadata.width > IMAGE_API_LIMITS.maxDimension ||
      metadata.height > IMAGE_API_LIMITS.maxDimension;
    const fitsSize = originalBytes <= IMAGE_API_LIMITS.maxBytes;

    // Passthrough: dimensions and size both within limits
    if (!needsResize && fitsSize) {
      return ok({
        buffer,
        mimeType,
        width: metadata.width,
        height: metadata.height,
        originalBytes,
        sanitizedBytes: originalBytes,
      });
    }

    const useAlpha = metadata.hasAlpha === true;

    // Build base pipeline: auto-rotate then conditionally resize
    const pipeline = sharp(buffer, {
      limitInputPixels: IMAGE_API_LIMITS.limitInputPixels,
    }).rotate();

    if (needsResize) {
      pipeline.resize(IMAGE_API_LIMITS.maxDimension, IMAGE_API_LIMITS.maxDimension, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    // Alpha channel images -> PNG (no quality iteration needed for PNG)
    if (useAlpha) {
      const outputBuffer = await pipeline.png().toBuffer();
      const outputMeta = await sharp(outputBuffer).metadata();

      if (outputBuffer.length > IMAGE_API_LIMITS.maxBytes) {
        return err(
          `Image with alpha channel is ${outputBuffer.length} bytes after resize, exceeds ${IMAGE_API_LIMITS.maxBytes} byte limit`,
        );
      }

      return ok({
        buffer: outputBuffer,
        mimeType: "image/png",
        width: outputMeta.width ?? metadata.width,
        height: outputMeta.height ?? metadata.height,
        originalBytes,
        sanitizedBytes: outputBuffer.length,
      });
    }

    // Non-alpha: iterative JPEG quality reduction
    for (const quality of QUALITY_STEPS) {
      // Rebuild pipeline each iteration (sharp pipelines are single-use after toBuffer)
      const iterPipeline = sharp(buffer, {
        limitInputPixels: IMAGE_API_LIMITS.limitInputPixels,
      }).rotate();

      if (needsResize) {
        iterPipeline.resize(IMAGE_API_LIMITS.maxDimension, IMAGE_API_LIMITS.maxDimension, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const outputBuffer = await iterPipeline.jpeg({ quality, mozjpeg: true }).toBuffer();

      if (outputBuffer.length <= IMAGE_API_LIMITS.maxBytes) {
        const outputMeta = await sharp(outputBuffer).metadata();
        return ok({
          buffer: outputBuffer,
          mimeType: "image/jpeg",
          width: outputMeta.width ?? metadata.width,
          height: outputMeta.height ?? metadata.height,
          originalBytes,
          sanitizedBytes: outputBuffer.length,
        });
      }
    }

    return err(
      `Image cannot be reduced below ${IMAGE_API_LIMITS.maxBytes} bytes after all quality steps`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`Image processing failed: ${message}`);
  }
}
