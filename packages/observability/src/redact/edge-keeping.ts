// SPDX-License-Identifier: Apache-2.0
/**
 * Edge-keeping mask helper.
 *
 * Masks a string by preserving a fixed-length prefix + suffix with a
 * single-codepoint ellipsis (U+2026) between them. Tokens below the
 * `MIN_LENGTH` threshold are collapsed to the literal `"***"` sentinel —
 * a partial preview of a very short token would re-leak the secret.
 *
 * Defaults (design §5.4 + §2.4):
 *   MIN_LENGTH = 18  — minimum input length to keep edge-mask shape
 *   KEEP_START = 6   — characters preserved at the head
 *   KEEP_END   = 4   — characters preserved at the tail
 *   ELLIPSIS   = "…" — U+2026 HORIZONTAL ELLIPSIS (single codepoint)
 *
 * The single-codepoint ellipsis is load-bearing: byte-grep-style residency
 * scanners look for the literal three-dot ASCII sequence "..." and would
 * miss a U+2026 mask, ensuring an accidental plaintext leak that happened
 * to start with three dots can't be confused for a mask. Tests pin the
 * codepoint to prevent silent regression.
 *
 * Also exports `maskPemBlock(input)` which preserves the BEGIN/END label
 * lines of a PEM block and replaces the body with `…redacted…`.
 *
 * Pure function — no I/O, no clock, no fs. Composable in `redactSecrets`
 * (value-mode masking) and the Pino `censor` callback in
 * `packages/infra/src/logging/logger.ts`.
 *
 * @module
 */

/** Default edge-keeping mask parameters (design §5.4). */
export const REDACT_DEFAULTS = Object.freeze({
  /** Minimum input length to apply the edge-keeping mask; below → "***". */
  MIN_LENGTH: 18,
  /** Characters preserved at the head of the input. */
  KEEP_START: 6,
  /** Characters preserved at the tail of the input. */
  KEEP_END: 4,
  /** Single-codepoint ellipsis U+2026 (NOT the ASCII "..." sequence). */
  ELLIPSIS: "…",
} as const);

/** Options for {@link maskToken}; each overrides the {@link REDACT_DEFAULTS} value. */
export interface MaskTokenOptions {
  /** Minimum input length to apply edge mask; below → `"***"`. */
  minLength?: number;
  /** Head characters preserved. */
  keepStart?: number;
  /** Tail characters preserved. */
  keepEnd?: number;
  /** Connector between head and tail (defaults to U+2026). */
  ellipsis?: string;
}

/**
 * Apply an edge-keeping mask to a string.
 *
 *   maskToken("sk-1234567890abcdef")          → "sk-123…cdef"
 *   maskToken("a".repeat(17))                  → "***"
 *   maskToken("abcdefghij", {minLength:10, keepStart:3, keepEnd:2})
 *                                              → "abc…ij"
 *
 * @param input - the string to mask
 * @param options - override defaults for this call
 * @returns the masked string
 */
export function maskToken(input: string, options: MaskTokenOptions = {}): string {
  const minLength = options.minLength ?? REDACT_DEFAULTS.MIN_LENGTH;
  const keepStart = options.keepStart ?? REDACT_DEFAULTS.KEEP_START;
  const keepEnd = options.keepEnd ?? REDACT_DEFAULTS.KEEP_END;
  const ellipsis = options.ellipsis ?? REDACT_DEFAULTS.ELLIPSIS;

  if (input.length < minLength) return "***";
  return input.slice(0, keepStart) + ellipsis + input.slice(input.length - keepEnd);
}

/**
 * Mask a PEM-encoded block: preserve the first `-----BEGIN ...-----`
 * line and the last `-----END ...-----` line, replace everything between
 * (and the BEGIN/END terminators on the same lines) with `…redacted…`.
 *
 * If the input does not look like a PEM block (no BEGIN line found) it
 * is returned unchanged.
 *
 * @param input - a PEM-shaped multi-line string
 * @returns the masked string with body replaced
 */
export function maskPemBlock(input: string): string {
  const lines = input.split("\n");
  const beginIdx = lines.findIndex((l) => l.startsWith("-----BEGIN ") && l.endsWith("-----"));
  if (beginIdx === -1) return input;

  // Find the END line at or after the BEGIN line.
  const endIdx = lines.findIndex(
    (l, i) => i > beginIdx && l.startsWith("-----END ") && l.endsWith("-----"),
  );
  if (endIdx === -1) return input;

  const before = lines.slice(0, beginIdx);
  const after = lines.slice(endIdx + 1);
  const out = [
    ...before,
    lines[beginIdx]!,
    REDACT_DEFAULTS.ELLIPSIS + "redacted" + REDACT_DEFAULTS.ELLIPSIS,
    lines[endIdx]!,
    ...after,
  ];
  return out.join("\n");
}
