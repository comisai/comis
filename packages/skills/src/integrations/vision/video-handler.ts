/**
 * Video handling utilities for vision analysis.
 *
 * Provides base64 size estimation and encoding with size limit validation.
 * Uses the Result pattern to handle errors without throwing.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Estimate the base64-encoded size of raw bytes.
 *
 * Base64 encoding expands data by a factor of 4/3 (3 raw bytes -> 4 base64 chars).
 *
 * @param rawBytes - Size of the raw data in bytes
 * @returns Estimated base64-encoded size in bytes
 */
export function estimateBase64Size(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Encode a video buffer to base64 with size limit validation.
 *
 * Validates against both raw byte limits and estimated base64 size limits
 * before performing the encoding, preventing API limit overflows.
 *
 * @param video - Raw video data
 * @param maxBase64Bytes - Maximum allowed base64-encoded size in bytes
 * @param maxRawBytes - Maximum allowed raw file size in bytes
 * @returns Base64 string with estimated size, or an error if limits exceeded
 */
export function encodeVideoForApi(
  video: Buffer,
  maxBase64Bytes: number,
  maxRawBytes: number,
): Result<{ base64: string; estimatedSize: number }, Error> {
  if (video.byteLength === 0) {
    return err(new Error("Video buffer is empty"));
  }

  if (video.byteLength > maxRawBytes) {
    return err(
      new Error(
        `Video raw size ${video.byteLength} bytes exceeds limit of ${maxRawBytes} bytes`,
      ),
    );
  }

  const estimatedSize = estimateBase64Size(video.byteLength);
  if (estimatedSize > maxBase64Bytes) {
    return err(
      new Error(
        `Video estimated base64 size ${estimatedSize} bytes exceeds limit of ${maxBase64Bytes} bytes`,
      ),
    );
  }

  const base64 = video.toString("base64");

  return ok({ base64, estimatedSize });
}
