// SPDX-License-Identifier: Apache-2.0
/** Credential-safe free-text redaction for operator-visible output. */

import { CREDENTIAL_LOG_PATTERNS } from "./patterns/credential-log.js";
import { SECRET_FORMAT_PATTERNS } from "./patterns/secret-formats.js";

// eslint-disable-next-line no-restricted-syntax -- output redaction sentinel
const REDACTED = "[REDACTED]";

export interface OutputRedactionResult {
  readonly text: string;
  readonly redactions: number;
}

const OUTPUT_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  ...CREDENTIAL_LOG_PATTERNS,
  ...SECRET_FORMAT_PATTERNS,
];

const PRIVATE_KEY_BEGIN_MARKER = "-----BEGIN";
const PRIVATE_KEY_END_MARKER = "-----END";
const PRIVATE_KEY_BOUNDARY_SUFFIX = "-----";
const MAX_PRIVATE_KEY_LABEL_CHARS = 64;

interface PrivateKeyBoundary {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

function normalizePrivateKeyLabel(rawLabel: string): string | undefined {
  let normalized = "";
  let pendingSpace = false;
  for (const character of rawLabel) {
    if (character === " " || character === "\t") {
      pendingSpace = normalized.length > 0;
      continue;
    }
    const codePoint = character.codePointAt(0);
    const allowed = codePoint !== undefined && (
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      character === "-"
    );
    if (!allowed) return undefined;
    if (pendingSpace) normalized += " ";
    normalized += character;
    pendingSpace = false;
  }
  if (
    normalized === "PRIVATE KEY" ||
    normalized === "PGP PRIVATE KEY BLOCK"
  ) return normalized;
  const algorithmSuffix = " PRIVATE KEY";
  if (!normalized.endsWith(algorithmSuffix)) return undefined;
  const algorithm = normalized.slice(0, -algorithmSuffix.length);
  return algorithm.length > 0 ? normalized : undefined;
}

function parsePrivateKeyBoundary(
  input: string,
  start: number,
  marker: string,
): PrivateKeyBoundary | undefined {
  let labelStart = start + marker.length;
  let separatorLength = 0;
  while (
    separatorLength < 5 &&
    (input.charAt(labelStart) === " " || input.charAt(labelStart) === "\t")
  ) {
    separatorLength++;
    labelStart++;
  }
  if (separatorLength === 0) return undefined;
  let suffixStart = -1;
  const lastSuffixStart = Math.min(
    input.length - PRIVATE_KEY_BOUNDARY_SUFFIX.length,
    labelStart + MAX_PRIVATE_KEY_LABEL_CHARS,
  );
  for (let cursor = labelStart; cursor <= lastSuffixStart; cursor++) {
    if (input.startsWith(PRIVATE_KEY_BOUNDARY_SUFFIX, cursor)) {
      suffixStart = cursor;
      break;
    }
  }
  if (suffixStart < 0) return undefined;
  const label = normalizePrivateKeyLabel(input.slice(labelStart, suffixStart));
  if (label === undefined) return undefined;
  return {
    start,
    end: suffixStart + PRIVATE_KEY_BOUNDARY_SUFFIX.length,
    label,
  };
}

function findPrivateKeyBoundary(
  input: string,
  marker: string,
  fromIndex: number,
  expectedLabel?: string,
): PrivateKeyBoundary | undefined {
  let cursor = fromIndex;
  while (cursor < input.length) {
    const start = input.indexOf(marker, cursor);
    if (start < 0) return undefined;
    const boundary = parsePrivateKeyBoundary(input, start, marker);
    if (boundary !== undefined && (
      expectedLabel === undefined || boundary.label === expectedLabel
    )) return boundary;
    cursor = start + marker.length;
  }
  return undefined;
}

/**
 * Redact private-key armor with a deterministic linear scan. A valid matching
 * footer ends one block; an unterminated or mismatched block consumes the rest
 * of the field so no key body can survive a header-only replacement.
 */
export function redactPrivateKeyMaterial(
  input: string,
  replacement = REDACTED,
): OutputRedactionResult {
  const output: string[] = [];
  let cursor = 0;
  let redactions = 0;
  while (cursor < input.length) {
    const begin = findPrivateKeyBoundary(
      input,
      PRIVATE_KEY_BEGIN_MARKER,
      cursor,
    );
    if (begin === undefined) break;
    output.push(input.slice(cursor, begin.start), replacement);
    redactions++;
    const end = findPrivateKeyBoundary(
      input,
      PRIVATE_KEY_END_MARKER,
      begin.end,
      begin.label,
    );
    if (end === undefined) return { text: output.join(""), redactions };
    cursor = end.end;
  }
  output.push(input.slice(cursor));
  return { text: output.join(""), redactions };
}

/**
 * Apply the canonical credential catalog to a complete output field.
 *
 * The catalog contains only linear, bounded credential-shape expressions, so
 * scanning the complete field is both work-bounded by its input length and
 * cannot miss a credential that crosses an arbitrary chunk boundary.
 */
export function redactOutputText(input: string): OutputRedactionResult {
  const privateKeys = redactPrivateKeyMaterial(input);
  let text = privateKeys.text;
  let redactions = privateKeys.redactions;
  for (const canonicalPattern of OUTPUT_CREDENTIAL_PATTERNS) {
    canonicalPattern.lastIndex = 0;
    text = text.replace(canonicalPattern, () => {
      redactions++;
      return REDACTED;
    });
    canonicalPattern.lastIndex = 0;
  }
  return { text, redactions };
}
