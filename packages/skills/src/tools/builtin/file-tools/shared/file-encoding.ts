// SPDX-License-Identifier: Apache-2.0
/**
 * @module file-encoding
 * File encoding detection, BOM stripping, line ending detection/normalization/restoration,
 * and the I/O bridge function for reading files with metadata.
 * Uses only Node.js built-in APIs (Buffer, fs/promises).
 */

import { readFile, writeFile } from "node:fs/promises";
import chardet from "chardet";
import { encode as iconvEncode, decode as iconvDecode } from "iconv-lite";

export type FileEncoding = "utf-8" | "utf-16le" | "latin1";
export type LineEnding = "lf" | "crlf" | "cr";

/** Validate whether a buffer contains valid UTF-8 sequences. */
function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect file encoding from raw buffer by checking BOM bytes and chardet.
 * Uses UTF-8 validation as a tiebreaker when chardet reports ISO-8859-1
 * because chardet cannot reliably distinguish the two for files with sparse
 * non-ASCII content (e.g., UTF-8 pound sign in mostly-ASCII text).
 */
export function detectEncoding(buffer: Buffer): FileEncoding {
  // UTF-16LE BOM takes priority (must check before chardet)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return "utf-16le";
  }

  // For buffers >= 50 bytes, use chardet to detect Latin-1/Windows-1252
  if (buffer.length >= 50) {
    const detected = chardet.detect(buffer);
    if (detected && /^(ISO-8859-1|windows-1252|latin1)$/i.test(detected)) {
      // UTF-8 tiebreaker: chardet can't reliably distinguish the two for files
      // with sparse non-ASCII content (e.g., UTF-8 multi-byte chars in mostly-ASCII text).
      if (isValidUtf8(buffer)) {
        return "utf-8";
      }
      return "latin1";
    }
  }

  return "utf-8";
}

/**
 * Strip the Unicode BOM character (U+FEFF) from the start of a decoded string.
 */
export function stripBom(content: string): string {
  if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

/**
 * Detect the dominant line ending style in content.
 * Checks CRLF before bare CR to avoid misclassification.
 */
export function detectLineEnding(content: string): LineEnding {
  if (content.includes("\r\n")) return "crlf";
  if (content.includes("\r")) return "cr";
  return "lf";
}

/**
 * Normalize all line endings (CRLF, CR) to LF.
 */
export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Restore LF-normalized content to the specified line ending style.
 * Input must be LF-normalized (call normalizeToLF first if needed).
 */
export function restoreLineEndings(
  content: string,
  ending: LineEnding,
): string {
  if (ending === "lf") return content;
  const target = ending === "crlf" ? "\r\n" : "\r";
  return content.replace(/\n/g, target);
}

/**
 * Read a file from disk and return decoded, BOM-stripped, LF-normalized content
 * with encoding and line ending metadata for write-back preservation.
 *
 * This is the I/O bridge between filesystem reads and the pure encoding
 * functions in this module. Both read-tool and edit-tool consume this function.
 *
 * @param absolutePath - Absolute path to the file to read
 * @returns Object with LF-normalized content, detected encoding, original line ending, and raw byte size
 */
export async function readFileWithMetadata(absolutePath: string): Promise<{
  content: string;
  encoding: FileEncoding;
  lineEnding: LineEnding;
  sizeBytes: number;
}> {
  const buffer = await readFile(absolutePath);
  const encoding = detectEncoding(buffer);
  const rawContent =
    encoding === "latin1"
      ? iconvDecode(buffer, "latin1")
      : buffer.toString(encoding);
  const strippedContent = stripBom(rawContent);
  const lineEnding = detectLineEnding(strippedContent);
  const content = normalizeToLF(strippedContent);
  return { content, encoding, lineEnding, sizeBytes: buffer.length };
}

/**
 * Write content back to file preserving original encoding and line endings.
 * Input content must be LF-normalized. Restores BOM, line endings, and
 * encodes to the original encoding before writing.
 *
 * UTF-8 BOM is NOT restored (stripped on read, stays stripped).
 * UTF-16LE BOM IS restored (required for correct decoding).
 *
 * @param absolutePath - Absolute path to write to
 * @param content - LF-normalized content to write
 * @param encoding - Original file encoding (from readFileWithMetadata)
 * @param lineEnding - Original line ending style (from readFileWithMetadata)
 */
export async function writeFilePreserving(
  absolutePath: string,
  content: string,
  encoding: FileEncoding,
  lineEnding: LineEnding,
): Promise<void> {
  const restored = restoreLineEndings(content, lineEnding);

  if (encoding === "utf-16le") {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(restored, "utf-16le");
    await writeFile(absolutePath, Buffer.concat([bom, body]));
  } else if (encoding === "latin1") {
    const body = iconvEncode(restored, "latin1");
    await writeFile(absolutePath, body);
  } else {
    await writeFile(absolutePath, restored, "utf-8");
  }
}
