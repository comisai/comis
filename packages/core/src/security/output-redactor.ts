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
const MAX_CREDENTIAL_FIELD_NAME_CHARS = 128;

interface PrivateKeyBoundary {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

interface CredentialAssignmentBoundary {
  readonly valueStart: number;
  readonly valueEnd: number;
}

function isCredentialFieldCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    character === "_" ||
    character === "-"
  );
}

/** Recognize a bounded credential field name without treating generic keys as secrets. */
function isCredentialFieldName(fieldName: string): boolean {
  const normalized = fieldName.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return normalized === "pwd" ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("username") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("privatekey") ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "authorization" ||
    normalized === "proxyauthorization";
}

function skipHorizontalWhitespace(input: string, start: number): number {
  let cursor = start;
  while (input.charAt(cursor) === " " || input.charAt(cursor) === "\t") cursor++;
  return cursor;
}

/** Locate the value boundary for one JSON, YAML, or environment-style assignment. */
function credentialAssignmentAt(
  input: string,
  start: number,
): CredentialAssignmentBoundary | undefined {
  const openingQuote = input.charAt(start);
  const quotedKey = openingQuote === '"' || openingQuote === "'";
  const fieldStart = quotedKey ? start + 1 : start;
  if (!isCredentialFieldCharacter(input.charAt(fieldStart))) return undefined;
  if (
    !quotedKey &&
    start > 0 &&
    isCredentialFieldCharacter(input.charAt(start - 1))
  ) return undefined;

  let fieldEnd = fieldStart;
  while (
    fieldEnd - fieldStart < MAX_CREDENTIAL_FIELD_NAME_CHARS &&
    isCredentialFieldCharacter(input.charAt(fieldEnd))
  ) fieldEnd++;
  if (
    fieldEnd === fieldStart ||
    isCredentialFieldCharacter(input.charAt(fieldEnd)) ||
    !isCredentialFieldName(input.slice(fieldStart, fieldEnd))
  ) return undefined;
  if (quotedKey) {
    if (input.charAt(fieldEnd) !== openingQuote) return undefined;
    fieldEnd++;
  }

  let cursor = skipHorizontalWhitespace(input, fieldEnd);
  if (input.charAt(cursor) !== ":" && input.charAt(cursor) !== "=") return undefined;
  cursor = skipHorizontalWhitespace(input, cursor + 1);
  const valueQuote = input.charAt(cursor);
  if (valueQuote === '"' || valueQuote === "'") {
    const valueStart = cursor + 1;
    cursor = valueStart;
    let escaped = false;
    while (cursor < input.length) {
      const character = input.charAt(cursor);
      if (!escaped && character === valueQuote) {
        return cursor === valueStart ? undefined : { valueStart, valueEnd: cursor };
      }
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      cursor++;
    }
    return cursor === valueStart ? undefined : { valueStart, valueEnd: input.length };
  }

  const valueStart = cursor;
  while (cursor < input.length) {
    const character = input.charAt(cursor);
    if (
      character === "\n" ||
      character === "\r" ||
      character === "," ||
      character === "}" ||
      character === "]"
    ) break;
    cursor++;
  }
  while (
    cursor > valueStart &&
    (input.charAt(cursor - 1) === " " || input.charAt(cursor - 1) === "\t")
  ) cursor--;
  return cursor === valueStart ? undefined : { valueStart, valueEnd: cursor };
}

/** Redact arbitrary values when their assignment key itself identifies a credential. */
function redactNamedCredentialAssignments(input: string): OutputRedactionResult {
  const output: string[] = [];
  let scanCursor = 0;
  let copyCursor = 0;
  let redactions = 0;
  while (scanCursor < input.length) {
    const boundary = credentialAssignmentAt(input, scanCursor);
    if (boundary === undefined) {
      scanCursor++;
      continue;
    }
    output.push(input.slice(copyCursor, boundary.valueStart), REDACTED);
    redactions++;
    copyCursor = boundary.valueEnd;
    scanCursor = boundary.valueEnd;
  }
  output.push(input.slice(copyCursor));
  return { text: output.join(""), redactions };
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
  const namedAssignments = redactNamedCredentialAssignments(privateKeys.text);
  let text = namedAssignments.text;
  let redactions = privateKeys.redactions + namedAssignments.redactions;
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
