// SPDX-License-Identifier: Apache-2.0
/**
 * Output cleaner for exec tool output streams.
 *
 * Provides stateful per-stream cleaning that handles:
 * 1. Multi-byte UTF-8 decoding across chunk boundaries (via TextDecoder stream mode)
 * 2. ANSI escape sequence stripping (SGR, CSI, OSC, character set, DEC private modes)
 * 3. Carriage return normalization (progress line collapse to final overwrite)
 * 4. Binary sanitization (NUL bytes and non-printable control chars stripped)
 *
 * Each OutputCleaner instance
 * maintains a TextDecoder in streaming mode, so multi-byte characters split across
 * chunk boundaries are decoded correctly without U+FFFD replacement characters.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stateful per-stream output cleaner. */
export interface OutputCleaner {
  /** Process a raw Buffer chunk through the cleaning pipeline. Returns cleaned string. */
  process(chunk: Buffer): string;
  /** Flush any buffered incomplete UTF-8 sequences. Call once after stream ends. */
  flush(): string;
}

// ---------------------------------------------------------------------------
// ANSI escape regex
// ---------------------------------------------------------------------------

/**
 * Comprehensive ANSI escape sequence pattern covering:
 * - SGR (Select Graphic Rendition): \x1b[...m (colors, bold, underline, etc.)
 * - CSI (Control Sequence Introducer): \x1b[...X where X is a-zA-Z
 * - OSC (Operating System Command): \x1b]...\x07 or \x1b]...\x1b\\
 * - Character set selection: \x1b(X, \x1b)X
 * - C1 control codes: \x9b prefix (8-bit CSI)
 *
 * Based on ansi-regex / strip-ansi patterns with additional coverage for
 * 256-color, truecolor, DEC private modes, and OSC with ST terminator.
 */
const ANSI_REGEX =
  // eslint-disable-next-line security/detect-unsafe-regex, no-control-regex
  /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

// ---------------------------------------------------------------------------
// Control char regex
// ---------------------------------------------------------------------------

/**
 * Non-printable control characters to strip (binary sanitization).
 * Excludes: \t (0x09), \n (0x0a), \r (0x0d) — handled elsewhere.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

/**
 * Normalize carriage returns: for each line (split on \n), if the line
 * contains a bare \r (not followed by \n), keep only the content after
 * the last \r. This collapses progress-bar overwrites to the final state.
 *
 * Windows \r\n line endings are first normalized to \n to avoid false
 * positives on the \r collapse logic.
 */
function normalizeCR(input: string): string {
  // First normalize \r\n -> \n so Windows line endings don't trigger collapse
  const normalized = input.replace(/\r\n/g, "\n");

  // If no bare \r remains, nothing to do
  if (!normalized.includes("\r")) {
    return normalized;
  }

  // Process each line: keep only content after last \r
  return normalized
    .split("\n")
    .map((line) => {
      const lastCR = line.lastIndexOf("\r");
      return lastCR === -1 ? line : line.slice(lastCR + 1);
    })
    .join("\n");
}

/** Strip NUL bytes and non-printable control characters. */
function sanitizeBinary(input: string): string {
  return input.replace(CONTROL_CHAR_REGEX, "");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a stateful output cleaner for a single stream (stdout or stderr).
 *
 * Each cleaner maintains its own TextDecoder instance in streaming mode,
 * ensuring multi-byte UTF-8 characters split across chunk boundaries are
 * decoded correctly. Call `flush()` after the stream ends to emit any
 * remaining buffered bytes.
 *
 * @returns OutputCleaner with `process(chunk)` and `flush()` methods
 */
export function createOutputCleaner(): OutputCleaner {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  function clean(text: string): string {
    return sanitizeBinary(normalizeCR(stripAnsi(text)));
  }

  return {
    process(chunk: Buffer): string {
      const decoded = decoder.decode(chunk, { stream: true });
      return clean(decoded);
    },

    flush(): string {
      // Emit any buffered incomplete byte sequences
      const remaining = decoder.decode(new Uint8Array(0), { stream: false });
      return clean(remaining);
    },
  };
}
