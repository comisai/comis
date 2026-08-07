// SPDX-License-Identifier: Apache-2.0
/**
 * Shared egress text scrubber for the secret egress firewall.
 * Intra-core only — imports only from within @comis/core (no cross-package observability import
 * allowed here; that would invert the one-way core←observability dependency graph).
 * Uses PLAINTEXT_SECRET_PREFIXES + PREFIX_MIN_BODY_LENGTHS from the secret-detection keystone.
 * @module
 */

import {
  looksLikeSecretValue,
  PLAINTEXT_SECRET_PREFIXES,
  PREFIX_MIN_BODY_LENGTHS,
} from "./secret-detection.js";

export interface ScrubResult {
  readonly text: string;
  readonly redactions: number;
}

// eslint-disable-next-line no-restricted-syntax -- egress scrubber sentinel (intra-core, not the Pino censor literal)
const REDACTED = "[REDACTED]";

const SECRET_FIELD_FRAGMENT =
  "(?:password|passwd|pwd|secret|token|api[_-]?key|credential|private[_-]?key|username|env[_-]?value)";
const SECRET_FIELD_HINTS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api_key",
  "api-key",
  "apikey",
  "credential",
  "private_key",
  "private-key",
  "username",
  "env_value",
  "env-value",
] as const;

const LABELED_SECRET_ASSIGNMENT_RE = new RegExp(
  `((?:^|[\\s,{])["']?[A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}["']?\\s*[:=]\\s*)` +
    `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|(\\$\\{[^}\\r\\n]+\\}|\\[REDACTED\\]|[^\\s,;}\\r\\n]+))`,
  "gim",
);
const ESCAPED_LABELED_SECRET_ASSIGNMENT_RE = new RegExp(
  `((?:^|[\\s,{])\\\\["'][A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}\\\\["']\\s*[:=]\\s*\\\\")` +
    `([^"\\r\\n]*)(\\\\")`,
  "gim",
);

const SECRET_STORAGE_ACTION_FRAGMENT =
  "(?:confirm(?:ed|ation)?|stor(?:e|ing)|sav(?:e|ing)|set(?:ting)?|put(?:ting)?)";
const SECRET_STORAGE_ACTION_RE = new RegExp(
  `\\b${SECRET_STORAGE_ACTION_FRAGMENT}\\b`,
  "i",
);
const LABELED_SECRET_CONFIRMATION_RE = new RegExp(
    `((?:^|[\\s,{])${SECRET_STORAGE_ACTION_FRAGMENT}\\b[^\\r\\n]{0,96}?` +
    `["']?[A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}["']?[^\\r\\n]{0,160}?` +
    `(?:(?:confirmed\\s+)?value\\s+is|with\\s+the\\s+value)\\s*)` +
    `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s\\r\\n]+?)(?=[,;]|\\.(?=\\s|$)|\\s|$))`,
  "gim",
);
const LABELED_SECRET_STORAGE_REQUEST_RE = new RegExp(
  `((?:^|[\\s,{])${SECRET_STORAGE_ACTION_FRAGMENT}\\b[^\\r\\n]{0,160}?` +
    `["']?[A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}["']?[^\\r\\n]{0,160}?` +
    `(?:store|vault)\\s*:\\s*)` +
    `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s\\r\\n]+?)(?=[,;]|\\.(?=\\s|$)|\\s|$))`,
  "gim",
);
const SECRET_DISCLOSURE_INTRO_FRAGMENT = "(?:here(?:'s|\\s+is)|heres)";
const SECRET_DISCLOSURE_INTRO_RE = /\b(?:here(?:'s|\s+is)|heres)\b/i;
const LABELED_SECRET_DISCLOSURE_RE = new RegExp(
  `((?:^|[\\s,{])${SECRET_DISCLOSURE_INTRO_FRAGMENT}\\s+(?:the\\s+)?` +
    `["']?[A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}["']?\\s*(?:is\\s+)?)` +
    `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s,;}\\r\\n]+?)(?=[,;]|\\.(?=\\s|$)|\\s|$))`,
  "gim",
);
const SECRET_REPLACEMENT_ACTION_FRAGMENT =
  "(?:replac(?:e|ing)|updat(?:e|ing)|chang(?:e|ing)|overwrit(?:e|ing)|rotat(?:e|ing))";
const SECRET_REPLACEMENT_ACTION_RE =
  /\b(?:replac(?:e|ing)|updat(?:e|ing)|chang(?:e|ing)|overwrit(?:e|ing)|rotat(?:e|ing))\b/i;
const LABELED_SECRET_REPLACEMENT_RE = new RegExp(
  `((?:^|[\\s,{])${SECRET_REPLACEMENT_ACTION_FRAGMENT}\\b[^\\r\\n]{0,96}?`
    + `["']?[A-Za-z0-9_.-]*${SECRET_FIELD_FRAGMENT}["']?\\s+(?:with|to)\\s*)`
    + `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s\\r\\n]+?)(?=[,;]|\\.(?=\\s|$)|\\s|$))`,
  "gim",
);
const NON_WHITESPACE_TOKEN_RE = /\S+/g;
const LEADING_TEXT_WRAPPERS = "([{<\"'`*";
const TRAILING_TEXT_WRAPPERS = ")]}>\"'`*.,;:!?";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * O(prefixes) pre-filter. Returns true if text MIGHT contain a secret.
 * Gates the full scrub loop so secret-free messages pay near-zero cost.
 * Conservative: may return true for non-secrets (fine — scrubLoop handles false positives).
 */
export function mightContainSecret(text: string): boolean {
  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (text.includes(prefix)) return true;
  }
  if (text.includes("Bearer ") || text.includes("Token ")) return true;
  if (containsOpaqueSecretValue(text)) return true;
  const lower = text.toLowerCase();
  if (!SECRET_FIELD_HINTS.some((field) => lower.includes(field))) return false;
  if (text.includes(":") || text.includes("=")) return true;
  if (lower.includes("value") && SECRET_STORAGE_ACTION_RE.test(text)) return true;
  if (SECRET_REPLACEMENT_ACTION_RE.test(text)) return true;
  return SECRET_DISCLOSURE_INTRO_RE.test(text);
}

function isSafeSecretPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === REDACTED || (trimmed.startsWith("${") && trimmed.endsWith("}"));
}

function scrubLabeledAssignments(text: string): ScrubResult {
  let redactions = 0;
  const direct = text.replace(
    LABELED_SECRET_ASSIGNMENT_RE,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (value.length === 0 || isSafeSecretPlaceholder(value)) return _match;
      redactions++;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
  const scrubbed = direct.replace(
    ESCAPED_LABELED_SECRET_ASSIGNMENT_RE,
    (match, prefix: string, value: string, suffix: string) => {
      if (value.length === 0 || isSafeSecretPlaceholder(value)) return match;
      redactions++;
      return `${prefix}${REDACTED}${suffix}`;
    },
  );
  return { text: scrubbed, redactions };
}

function scrubLabeledConfirmations(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(
    LABELED_SECRET_CONFIRMATION_RE,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (value.length === 0 || isSafeSecretPlaceholder(value)) return _match;
      redactions++;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
  return { text: scrubbed, redactions };
}

/** Redact a value placed after a human-readable secret-store destination. */
function scrubLabeledStorageRequests(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(
    LABELED_SECRET_STORAGE_REQUEST_RE,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!isPlausibleDisclosedSecret(value)) return match;
      redactions++;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
  return { text: scrubbed, redactions };
}

/**
 * Recognize a human disclosing an otherwise format-less credential in prose.
 *
 * The explicit introduction plus credential field name is the authority here;
 * the value still needs to look opaque enough to avoid redacting ordinary
 * phrases such as "heres the token count". Known prefixes and structured
 * assignments remain covered by the stricter detectors above.
 */
function isPlausibleDisclosedSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || isSafeSecretPlaceholder(trimmed)) return false;
  return /[0-9]/.test(trimmed)
    || /[._~+/=-]/.test(trimmed)
    || trimmed.length >= 16;
}

function scrubLabeledDisclosures(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(
    LABELED_SECRET_DISCLOSURE_RE,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!isPlausibleDisclosedSecret(value)) return _match;
      redactions++;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
  return { text: scrubbed, redactions };
}

function scrubLabeledReplacements(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(
    LABELED_SECRET_REPLACEMENT_RE,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!isPlausibleDisclosedSecret(value)) return match;
      redactions++;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
  return { text: scrubbed, redactions };
}

function splitTextToken(token: string): {
  readonly leading: string;
  readonly candidate: string;
  readonly trailing: string;
} {
  let start = 0;
  while (
    start < token.length
    && LEADING_TEXT_WRAPPERS.includes(token.charAt(start))
  ) {
    start++;
  }
  let end = token.length;
  while (
    end > start
    && TRAILING_TEXT_WRAPPERS.includes(token.charAt(end - 1))
  ) {
    end--;
  }
  return {
    leading: token.slice(0, start),
    candidate: token.slice(start, end),
    trailing: token.slice(end),
  };
}

function containsOpaqueSecretValue(text: string): boolean {
  for (const match of text.matchAll(NON_WHITESPACE_TOKEN_RE)) {
    const token = match[0];
    if (looksLikeSecretValue(splitTextToken(token).candidate)) return true;
  }
  return false;
}

function scrubOpaqueSecretValues(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(NON_WHITESPACE_TOKEN_RE, (token) => {
    const { leading, candidate, trailing } = splitTextToken(token);
    if (!looksLikeSecretValue(candidate)) return token;
    redactions++;
    return `${leading}${REDACTED}${trailing}`;
  });
  return { text: scrubbed, redactions };
}

/**
 * Scrub unstructured text of secret-shaped values.
 * Self-contained intra-core loop — does NOT call redactSecretsInText from observability.
 * Called at delivery, sub-agent relay, memory write, and write-tool boundaries.
 *
 * Uses PREFIX_MIN_BODY_LENGTHS from the secret-detection keystone for the same length-gate
 * as looksLikeSecretValue, ensuring false-positive rate matches the observability scanner.
 */
export function scrubSecretsFromText(text: string): ScrubResult {
  if (!mightContainSecret(text)) return { text, redactions: 0 };
  const labeled = scrubLabeledAssignments(text);
  const confirmed = scrubLabeledConfirmations(labeled.text);
  const stored = scrubLabeledStorageRequests(confirmed.text);
  const disclosed = scrubLabeledDisclosures(stored.text);
  const replaced = scrubLabeledReplacements(disclosed.text);
  let result = replaced.text;
  let redactions =
    labeled.redactions
    + confirmed.redactions
    + stored.redactions
    + disclosed.redactions
    + replaced.redactions;

  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    const minBody = PREFIX_MIN_BODY_LENGTHS.get(prefix) ?? 0;
    // Use word-boundary start; allow alphanumeric + underscore + hyphen in token body.
    // The prefix itself may contain special chars (sk-ant-, glpat-, ya29.), so escape it.
    const pattern = new RegExp(
      `\\b${escapeRegex(prefix)}[A-Za-z0-9_\\-]{${minBody},}`,
      "g",
    );
    result = result.replace(pattern, () => {
      redactions++;
      return REDACTED;
    });
  }

  // Also strip bare Bearer/Token scheme values not yet caught by prefix patterns
  // (e.g. "Bearer <opaque-jwt-or-base64>" that doesn't start with a known prefix).
  // Only run if still might contain Bearer after prefix substitution.
  if (result.includes("Bearer ")) {
    const bearerPattern = /Bearer\s+[A-Za-z0-9_\-.]{20,}/g;
    result = result.replace(bearerPattern, () => {
      redactions++;
      return `Bearer ${REDACTED}`;
    });
  }

  const opaque = scrubOpaqueSecretValues(result);
  result = opaque.text;
  redactions += opaque.redactions;

  return { text: result, redactions };
}
