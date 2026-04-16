/**
 * Image processing pipeline -- resize, format-convert, compress, and
 * normalize orientation using sharp.
 *
 * All methods return Result<T, Error> and never throw. Decompression
 * bomb protection is enforced via limitInputPixels on every sharp call.
 *
 * Usage:
 *   const processor = createImageProcessor({ logger });
 *   const result = await processor.resize(buf, { maxSide: 1024 });
 *   if (result.ok) { ... result.value ... }
 */

import sharp from "sharp";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import { LIMIT_INPUT_PIXELS, DEFAULT_QUALITY } from "./constants.js";

// Disable sharp cache to prevent memory accumulation across calls
sharp.cache(false);

/** Dependencies injected into the image processor factory. */
export interface ImageProcessorDeps {
  readonly logger: {
    warn(msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** Options for the resize operation. */
export interface ResizeOptions {
  /** Maximum side length in pixels (longest edge). */
  readonly maxSide: number;
  /** JPEG/WebP quality 1-100 (default: 80). */
  readonly quality?: number;
  /** Output format (default: preserves original format). */
  readonly format?: "jpeg" | "png" | "webp";
  /** Prevent upscaling images smaller than maxSide (default: true). */
  readonly withoutEnlargement?: boolean;
}

/** Image metadata extracted from a buffer. */
export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly format?: string;
  readonly hasAlpha?: boolean;
  readonly sizeBytes?: number;
}

/** Image processor interface returned by the factory. */
export interface ImageProcessor {
  /**
   * Resize an image so its longest edge fits within maxSide.
   * Auto-rotates based on EXIF orientation, preserves aspect ratio.
   */
  resize(buffer: Buffer, opts: ResizeOptions): Promise<Result<Buffer, Error>>;

  /**
   * Convert an image buffer to the specified format.
   */
  convertFormat(
    buffer: Buffer,
    format: "jpeg" | "png" | "webp",
    quality?: number,
  ): Promise<Result<Buffer, Error>>;

  /**
   * Read image dimensions, format, alpha channel, and byte size.
   */
  metadata(buffer: Buffer): Promise<Result<ImageMetadata, Error>>;

  /**
   * Auto-rotate based on EXIF orientation, then strip EXIF data.
   */
  normalizeOrientation(buffer: Buffer): Promise<Result<Buffer, Error>>;
}

/**
 * Apply the target format to a sharp pipeline.
 */
function applyFormat(
  pipeline: sharp.Sharp,
  format: "jpeg" | "png" | "webp",
  quality: number,
): sharp.Sharp {
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality, mozjpeg: true });
    case "png":
      return pipeline.png({ compressionLevel: 6 });
    case "webp":
      return pipeline.webp({ quality });
  }
}

/**
 * Create an image processor with decompression bomb protection
 * and Result-based error handling.
 */
export function createImageProcessor(deps: ImageProcessorDeps): ImageProcessor {
  const { logger } = deps;

  return {
    async resize(
      buffer: Buffer,
      opts: ResizeOptions,
    ): Promise<Result<Buffer, Error>> {
      try {
        const quality = opts.quality ?? DEFAULT_QUALITY;
        const withoutEnlargement = opts.withoutEnlargement ?? true;

        const pipeline = sharp(buffer, {
          limitInputPixels: LIMIT_INPUT_PIXELS,
          failOnError: false,
        })
          .rotate() // Auto-rotate based on EXIF
          .resize({
            width: opts.maxSide,
            height: opts.maxSide,
            fit: "inside",
            withoutEnlargement,
          });

        // Determine output format: explicit or inferred from source
        if (opts.format) {
          const output = await applyFormat(pipeline, opts.format, quality).toBuffer();
          return ok(output);
        }

        // When no format specified, read source format and match it
        const meta = await sharp(buffer, {
          limitInputPixels: LIMIT_INPUT_PIXELS,
        }).metadata();

        const sourceFormat = meta.format;
        if (sourceFormat === "jpeg" || sourceFormat === "jpg") {
          const output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
          return ok(output);
        } else if (sourceFormat === "webp") {
          const output = await pipeline.webp({ quality }).toBuffer();
          return ok(output);
        } else {
          // Default to PNG for unknown formats (lossless, safe default)
          const output = await pipeline.png({ compressionLevel: 6 }).toBuffer();
          return ok(output);
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "Check input image format and dimensions", errorKind: "dependency" as const }, "Image resize failed");
        return err(error);
      }
    },

    async convertFormat(
      buffer: Buffer,
      format: "jpeg" | "png" | "webp",
      quality?: number,
    ): Promise<Result<Buffer, Error>> {
      try {
        const q = quality ?? DEFAULT_QUALITY;
        const pipeline = sharp(buffer, {
          limitInputPixels: LIMIT_INPUT_PIXELS,
          failOnError: false,
        });

        const output = await applyFormat(pipeline, format, q).toBuffer();
        return ok(output);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "Check target format compatibility with input image", errorKind: "dependency" as const }, "Image format conversion failed");
        return err(error);
      }
    },

    async metadata(buffer: Buffer): Promise<Result<ImageMetadata, Error>> {
      try {
        const meta = await sharp(buffer, {
          limitInputPixels: LIMIT_INPUT_PIXELS,
        }).metadata();

        if (!meta.width || !meta.height) {
          return err(new Error("Unable to read image dimensions"));
        }

        return ok({
          width: meta.width,
          height: meta.height,
          format: meta.format,
          hasAlpha: meta.hasAlpha,
          sizeBytes: buffer.length,
        });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "Input buffer may not be a valid image", errorKind: "validation" as const }, "Image metadata read failed");
        return err(error);
      }
    },

    async normalizeOrientation(
      buffer: Buffer,
    ): Promise<Result<Buffer, Error>> {
      try {
        const output = await sharp(buffer, {
          limitInputPixels: LIMIT_INPUT_PIXELS,
          failOnError: false,
        })
          .rotate() // Auto-rotate based on EXIF, then strip orientation tag
          .toBuffer();

        return ok(output);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "EXIF rotation failed; image will be used without orientation correction", errorKind: "dependency" as const }, "Image orientation normalization failed");
        return err(error);
      }
    },
  };
}
