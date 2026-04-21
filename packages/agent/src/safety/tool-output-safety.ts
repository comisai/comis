// SPDX-License-Identifier: Apache-2.0
/**
 * Tool output safety: text sanitization and image sanitization for tool results.
 *
 * Combines tool output text sanitization (indirect prompt injection detection)
 * with tool image sanitization (resize, re-encode, decompression bomb protection).
 *
 * @module
 */

import {
  stripInvisible,
  containsTagBlockChars,
  IGNORE_PREV_INSTRUCTIONS,
  YOU_ARE_NOW,
  FORGET_EVERYTHING,
  NEW_INSTRUCTIONS,
  SYSTEM_COLON,
  SYSTEM_BRACKET,
  INST_BRACKET,
  SYSTEM_TAG,
  IMPORTANT_OVERRIDE,
  DISREGARD_INSTRUCTIONS,
  ACT_AS_ROLE,
  ASSISTANT_ROLE_MARKER,
  SPECIAL_TOKEN_DELIMITERS,
  CONTEXT_RESET,
  RULE_REPLACEMENT,
  OVERRIDE_SAFETY,
} from "@comis/core";
import sharp from "sharp";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";

// --- Tool output text sanitization (formerly tool-sanitizer.ts) ---

/**
 * Normalize text for secure pattern matching.
 * 1. Apply Unicode NFKC normalization (compatibility decomposition + canonical composition)
 * 2. Strip zero-width and invisible formatting characters (including tag block bypass)
 *
 * IMPORTANT: Always normalize FIRST, then do pattern matching on the normalized string.
 * NFKC can change string length (e.g., fullwidth A -> A, ligatures decompose).
 */
export function normalizeForMatching(text: string): string {
  return stripInvisible(text.normalize("NFKC")).text;
}

/** Default maximum characters for tool output */
const DEFAULT_MAX_CHARS = 50_000;

/** Truncation message appended when output is cut */
const TRUNCATION_MSG = "\n[Content truncated -- exceeded size limit]";

/**
 * Regex patterns that indicate potential prompt injection attempts.
 *
 * Imported from @comis/core injection-patterns.ts (single source of truth).
 * Each pattern uses the `gi` flag for case-insensitive global matching.
 *
 * Note: The `system\s*:\s+` pattern requires whitespace after colon
 * to avoid matching URLs like `https://system.example.com:8080`
 * or code like `process.env.system`.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  IGNORE_PREV_INSTRUCTIONS,  // /ignore\s+(all\s+)?previous\s+instructions/gi
  YOU_ARE_NOW,               // /you\s+are\s+now\s+/gi
  FORGET_EVERYTHING,         // /forget\s+(everything|all|your)\s/gi
  NEW_INSTRUCTIONS,          // /new\s+instructions?\s*:/gi
  SYSTEM_COLON,              // /system\s*:\s+/gi
  SYSTEM_BRACKET,            // /\[SYSTEM\]/gi
  INST_BRACKET,              // /\[INST\]/gi
  SYSTEM_TAG,                // /<\/?system>/gi
  IMPORTANT_OVERRIDE,        // /IMPORTANT\s*:\s*override/gi
  DISREGARD_INSTRUCTIONS,    // /disregard ... instructions/
  ACT_AS_ROLE,               // /act as root|admin|.../
  ASSISTANT_ROLE_MARKER,     // /assistant:|user:/
  SPECIAL_TOKEN_DELIMITERS,  // /<|...|>/
  CONTEXT_RESET,             // /context reset|cleared|.../
  RULE_REPLACEMENT,          // /new rules:|updated guidelines:/
  OVERRIDE_SAFETY,           // /override safety|bypass security/
];

/**
 * Sanitize tool output against indirect prompt injection.
 *
 * 1. Checks for Unicode tag block bypass characters (for caller-side INFO logging)
 * 2. Replaces instruction-like injection patterns with "[REDACTED]"
 * 3. Truncates output exceeding `maxChars` at the last newline before
 *    the 95% mark, appending a truncation notice
 *
 * @param text - Raw tool output text
 * @param maxChars - Maximum allowed characters (default: 50,000)
 * @param options - Optional callbacks for tag block detection logging
 * @returns Sanitized text with injections redacted and size enforced
 */
export function sanitizeToolOutput(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  options?: { onTagBlockDetected?: () => void },
): string {
  if (text.length === 0) return text;

  // Check for tag block bypass BEFORE normalization strips them
  if (containsTagBlockChars(text)) {
    options?.onTagBlockDetected?.();
  }

  // Phase 1: Normalize for pattern matching (NFKC + strip zero-width + tag block)
  let sanitized = normalizeForMatching(text);

  // Phase 2: Redact injection patterns (on normalized text)
  for (const pattern of INSTRUCTION_PATTERNS) {
    // Reset lastIndex for sticky/global regexes across multiple calls
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  // Phase 3: Truncate oversized output
  if (sanitized.length > maxChars) {
    const cutPoint = Math.floor(maxChars * 0.95);
    const lastNewline = sanitized.lastIndexOf("\n", cutPoint);

    if (lastNewline > 0) {
      sanitized = sanitized.slice(0, lastNewline + 1) + TRUNCATION_MSG;
    } else {
      // No newline found -- hard cut at 95%
      sanitized = sanitized.slice(0, cutPoint) + TRUNCATION_MSG;
    }
  }

  return sanitized;
}

// --- Tool image sanitization (formerly tool-image-sanitizer.ts) ---

// Disable sharp cache to prevent memory accumulation across calls
sharp.cache(false);

/** Configuration options for image sanitization. */
export interface ImageSanitizeOptions {
  /** Max width in pixels (default: 1024) */
  maxWidth?: number;
  /** Max height in pixels (default: 1024) */
  maxHeight?: number;
  /** Max input size in bytes (default: 10_485_760 = 10MB) */
  maxInputBytes?: number;
  /** Output format (default: "png") */
  outputFormat?: "png" | "jpeg" | "webp";
  /** JPEG/WebP quality 1-100 (default: 85) */
  quality?: number;
}

/** Result of a successful image sanitization. */
export interface SanitizeResult {
  buffer: Buffer;
  format: string;
  width: number;
  height: number;
  originalBytes: number;
  sanitizedBytes: number;
}

/** Tool image sanitizer interface. */
export interface ToolImageSanitizer {
  /** Sanitize a base64-encoded image. Returns Result with sanitized buffer or error. */
  sanitize(base64Data: string, mimeType?: string): Promise<Result<SanitizeResult, string>>;
}

/** Default limit for decompression bomb protection (268 million pixels). */
const DEFAULT_LIMIT_INPUT_PIXELS = 268_402_689;

/**
 * Create a tool image sanitizer instance.
 *
 * @param opts - Optional configuration overriding defaults.
 * @returns A ToolImageSanitizer instance.
 */
export function createToolImageSanitizer(opts?: ImageSanitizeOptions): ToolImageSanitizer {
  const maxWidth = opts?.maxWidth ?? 1024;
  const maxHeight = opts?.maxHeight ?? 1024;
  const maxInputBytes = opts?.maxInputBytes ?? 10_485_760;
  const outputFormat = opts?.outputFormat ?? "png";
  const quality = opts?.quality ?? 85;

  return {
     
    async sanitize(base64Data: string, _mimeType?: string): Promise<Result<SanitizeResult, string>> {
      // Reject empty input
      if (!base64Data || base64Data.length === 0) {
        return err("Empty image data provided");
      }

      // Decode base64 to buffer
      let inputBuffer: Buffer;
      try {
        inputBuffer = Buffer.from(base64Data, "base64");
      } catch {
        return err("Failed to decode base64 image data");
      }

      // Reject if decoded buffer is empty (empty base64 decodes to empty buffer)
      if (inputBuffer.length === 0) {
        return err("Empty image data after base64 decode");
      }

      // Check size against maxInputBytes
      if (inputBuffer.length > maxInputBytes) {
        return err(
          `Image size ${inputBuffer.length} bytes exceeds maximum allowed ${maxInputBytes} bytes`,
        );
      }

      try {
        // Create sharp instance with decompression bomb protection
        const image = sharp(inputBuffer, {
          limitInputPixels: DEFAULT_LIMIT_INPUT_PIXELS,
        });

        // Read metadata to determine if resize is needed
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height) {
          return err("Unable to read image dimensions -- possibly corrupt or unsupported format");
        }

        // Resize if exceeds limits (fit: inside preserves aspect ratio)
        const needsResize = metadata.width > maxWidth || metadata.height > maxHeight;
        if (needsResize) {
          image.resize(maxWidth, maxHeight, { fit: "inside" });
        }

        // Convert to output format
        let outputBuffer: Buffer;
        switch (outputFormat) {
          case "jpeg":
            outputBuffer = await image.jpeg({ quality }).toBuffer();
            break;
          case "webp":
            outputBuffer = await image.webp({ quality }).toBuffer();
            break;
          case "png":
          default:
            outputBuffer = await image.png().toBuffer();
            break;
        }

        // Read final metadata from the output
        const outputMeta = await sharp(outputBuffer).metadata();

        return ok({
          buffer: outputBuffer,
          format: outputFormat,
          width: outputMeta.width ?? (needsResize ? maxWidth : metadata.width),
          height: outputMeta.height ?? (needsResize ? maxHeight : metadata.height),
          originalBytes: inputBuffer.length,
          sanitizedBytes: outputBuffer.length,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(`Image processing failed: ${message}`);
      }
    },
  };
}
