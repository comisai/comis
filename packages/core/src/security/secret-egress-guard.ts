// SPDX-License-Identifier: Apache-2.0
/**
 * Shared egress text scrubber for the secret egress firewall.
 * Intra-core only — imports only from within @comis/core (no cross-package observability import
 * allowed here; that would invert the one-way core←observability dependency graph).
 * Uses PLAINTEXT_SECRET_PREFIXES + PREFIX_MIN_BODY_LENGTHS from the secret-detection keystone.
 * @module
 */

import {
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

const SECRET_STORAGE_ACTION_FRAGMENT =
  "(?:confirm(?:ed|ation)?|stor(?:e|ing)|sav(?:e|ing)|set(?:ting)?)";
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
  const lower = text.toLowerCase();
  if (!SECRET_FIELD_HINTS.some((field) => lower.includes(field))) return false;
  if (text.includes(":") || text.includes("=")) return true;
  return lower.includes("value") && SECRET_STORAGE_ACTION_RE.test(text);
}

function isSafeSecretPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === REDACTED || (trimmed.startsWith("${") && trimmed.endsWith("}"));
}

function scrubLabeledAssignments(text: string): ScrubResult {
  let redactions = 0;
  const scrubbed = text.replace(
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
  let result = confirmed.text;
  let redactions = labeled.redactions + confirmed.redactions;

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

  return { text: result, redactions };
}
