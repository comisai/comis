/**
 * Text encoding detection and decoding pipeline.
 *
 * Decodes a raw file buffer to a UTF-8 string using a priority chain:
 * 1. BOM detection (UTF-8, UTF-16 LE, UTF-16 BE) — definitive, strips BOM bytes
 * 2. UTF-8 fast path — returns early if no replacement characters appear
 * 3. chardet detection + iconv-lite conversion — handles ISO-8859-x, Shift_JIS, CJK, etc.
 * 4. Last resort — returns UTF-8 string with replacement characters
 *
 * @module
 */

import chardet from "chardet";
import iconv from "iconv-lite";

/**
 * Decode a raw file buffer to a UTF-8 string.
 *
 * BOM bytes are stripped from the output and do not appear as invisible
 * characters (U+FEFF) in the returned string.
 *
 * @param buffer - Raw file content buffer
 * @returns Decoded UTF-8 string
 */
export function decodeTextBuffer(buffer: Buffer): string {
  // 1. BOM detection (highest priority, definitive)
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xEF &&
    buffer[1] === 0xBB &&
    buffer[2] === 0xBF
  ) {
    // UTF-8 BOM: strip 3 bytes, decode remainder as UTF-8
    return buffer.subarray(3).toString("utf-8");
  }

  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    // UTF-16 LE BOM: strip 2 bytes, decode remainder as UTF-16 LE (Node built-in)
    return buffer.subarray(2).toString("utf16le");
  }

  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    // UTF-16 BE BOM: strip 2 bytes, decode remainder via iconv-lite (no Node built-in)
    return iconv.decode(buffer.subarray(2), "utf16be");
  }

  // 2. UTF-8 fast path: if no replacement characters, the buffer is valid UTF-8
  const utf8Attempt = buffer.toString("utf-8");
  if (!utf8Attempt.includes("\uFFFD")) {
    return utf8Attempt;
  }

  // 3. chardet detection fallback for non-UTF-8 encodings (ISO-8859-x, Shift_JIS, CJK, etc.)
  const detected = chardet.detect(buffer);
  if (detected && detected !== "UTF-8" && iconv.encodingExists(detected)) {
    return iconv.decode(buffer, detected);
  }

  // 4. Last resort: return UTF-8 string with replacement characters
  return utf8Attempt;
}
