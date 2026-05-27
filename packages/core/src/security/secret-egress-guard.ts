// SPDX-License-Identifier: Apache-2.0
/**
 * Shared egress text scrubber for the secret egress firewall (R4).
 * Intra-core only — imports only from within @comis/core (no cross-package observability import
 * allowed here; that would invert the one-way core←observability dependency graph).
 * Uses PLAINTEXT_SECRET_PREFIXES + PREFIX_MIN_BODY_LENGTHS from the R0 keystone.
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

// eslint-disable-next-line no-restricted-syntax -- R4 egress scrubber sentinel (intra-core, not the Pino censor literal)
const REDACTED = "[REDACTED]";

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
  return text.includes("Bearer ") || text.includes("Token ");
}

/**
 * Scrub unstructured text of secret-shaped values.
 * Self-contained intra-core loop — does NOT call redactSecretsInText from observability.
 * Called at delivery, sub-agent relay, memory write, and write-tool boundaries.
 *
 * Uses PREFIX_MIN_BODY_LENGTHS from the R0 keystone for the same length-gate as
 * looksLikeSecretValue, ensuring false-positive rate matches the observability scanner.
 */
export function scrubSecretsFromText(text: string): ScrubResult {
  if (!mightContainSecret(text)) return { text, redactions: 0 };
  let result = text;
  let redactions = 0;

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
