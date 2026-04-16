/**
 * File validation -- MIME whitelist enforcement, size limit checks,
 * and media kind classification.
 *
 * Returns Result<ValidationResult, Error> with valid=true/false
 * (never throws, never returns err() for normal rejections).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { MediaKind } from "./constants.js";
import { SIZE_LIMITS } from "./constants.js";
import { detectMime } from "./mime-detection.js";

/** Default MIME types accepted for media uploads. */
const DEFAULT_WHITELIST: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
] as const;

/** Dependencies for the file validator factory. */
export interface FileValidatorDeps {
  /** Custom size limits per media kind (overrides defaults). */
  readonly sizeLimits?: Record<string, number>;
  /** Allowed MIME types (overrides default whitelist). */
  readonly mimeWhitelist?: string[];
  /** Maximum PDF page count (advisory, checked if metadata available). */
  readonly maxPdfPages?: number;
}

/** Result of a file validation check. */
export interface ValidationResult {
  /** Whether the file passed all validation checks. */
  readonly valid: boolean;
  /** Detected MIME type (present when valid or when MIME was detectable). */
  readonly mime?: string;
  /** Classified media kind (present when MIME was detectable). */
  readonly kind?: MediaKind;
  /** Human-readable rejection reason (present when valid=false). */
  readonly error?: string;
}

/** File validator interface returned by the factory. */
export interface FileValidator {
  /**
   * Validate a file buffer against size limits and MIME whitelist.
   */
  validate(
    buffer: Buffer,
    opts?: { filename?: string; headerMime?: string },
  ): Promise<Result<ValidationResult, Error>>;
}

/**
 * Classify a MIME type into a MediaKind for size limit lookup.
 */
function classifyKind(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime.startsWith("text/")
  ) {
    return "document";
  }
  return "binary";
}

/**
 * Create a file validator with configurable size limits and MIME whitelist.
 */
export function createFileValidator(deps: FileValidatorDeps = {}): FileValidator {
  const whitelist = new Set(deps.mimeWhitelist ?? DEFAULT_WHITELIST);

  return {
    async validate(
      buffer: Buffer,
      opts?: { filename?: string; headerMime?: string },
    ): Promise<Result<ValidationResult, Error>> {
      try {
        // Step 1: Detect MIME
        const mimeResult = await detectMime({
          buffer,
          filePath: opts?.filename,
          headerMime: opts?.headerMime,
        });

        if (!mimeResult.ok) {
          return err(mimeResult.error);
        }

        const mime = mimeResult.value;

        if (!mime) {
          return ok({
            valid: false,
            error: "Unable to determine file type",
          });
        }

        // Step 2: Check MIME whitelist
        if (!whitelist.has(mime)) {
          return ok({
            valid: false,
            mime,
            error: `MIME type not allowed: ${mime}`,
          });
        }

        // Step 3: Classify media kind
        const kind = classifyKind(mime);

        // Step 4: Check size limit
        const customLimit = deps.sizeLimits?.[kind];
        const limit = customLimit ?? SIZE_LIMITS[kind];
        if (buffer.length > limit) {
          return ok({
            valid: false,
            mime,
            kind,
            error: `File exceeds ${kind} size limit: ${buffer.length} > ${limit} bytes`,
          });
        }

        return ok({ valid: true, mime, kind });
      } catch (e: unknown) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}
