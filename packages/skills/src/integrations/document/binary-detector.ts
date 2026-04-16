/**
 * Binary content detection for text files.
 *
 * Detects whether a buffer contains non-printable binary content by scanning
 * for null bytes (definitive binary signal) and measuring the ratio of
 * non-printable control characters.
 *
 * @module
 */

/**
 * Sample size for binary detection (first 8KB is sufficient for reliable detection).
 */
const SAMPLE_SIZE = 8192;

/**
 * Maximum ratio of non-printable control characters before a buffer is
 * considered binary (10%).
 */
const MAX_NONPRINTABLE_RATIO = 0.10;

/**
 * Determine whether a buffer contains binary (non-text) content.
 *
 * Detection algorithm:
 * 1. Sample the first 8KB of the buffer.
 * 2. Scan for null bytes (0x00) — any null byte is a definitive binary signal.
 * 3. Count non-printable control characters:
 *    - Bytes < 0x09 (below tab)
 *    - Bytes 0x0E–0x1F (after CR, excluding tab/LF/VT/FF/CR)
 *    - Byte 0x7F (DEL)
 *    Allowed printable-adjacent: 0x09 (tab), 0x0A (LF), 0x0B (VT), 0x0C (FF), 0x0D (CR)
 * 4. If non-printable ratio > 10%, return true.
 *
 * An empty buffer is considered valid text (returns false).
 *
 * @param buffer - Raw file content to inspect
 * @returns true if buffer is binary, false if it appears to be text
 */
export function isBinaryContent(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;

  const sampleSize = Math.min(buffer.length, SAMPLE_SIZE);
  const sample = buffer.subarray(0, sampleSize);

  // Null byte = definitive binary signal
  for (let i = 0; i < sampleSize; i++) {
    if (sample[i] === 0x00) return true;
  }

  // Count non-printable control characters
  let nonPrintable = 0;
  for (let i = 0; i < sampleSize; i++) {
    const b = sample[i]!;
    // Control chars: 0x00-0x08, 0x0E-0x1F, 0x7F
    // Allow: 0x09 (tab), 0x0A (LF), 0x0B (VT), 0x0C (FF), 0x0D (CR)
    if (b < 0x09 || (b > 0x0D && b < 0x20) || b === 0x7F) {
      nonPrintable++;
    }
  }

  return nonPrintable / sampleSize > MAX_NONPRINTABLE_RATIO;
}
