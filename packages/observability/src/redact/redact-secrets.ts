// SPDX-License-Identifier: Apache-2.0
/**
 * `redactSecrets` structured walker + `sanitizeForPersistence` pipeline.
 *
 * Walks an arbitrary value recursively and applies value-mode redaction:
 *
 *   - **String values** are piped through `redactSecretsInText` so any
 *     in-string credential body is masked via the edge-keeping pattern.
 *   - **Object fields with credential-keyed names** have their value
 *     replaced by `maskToken(<stringified>)` (string values) or `"***"`
 *     (non-string values). The credential-key set + allowlist are
 *     reused from `sanitizeDiagnosticPayload`'s `isCredentialFieldName`
 *     helper (single source of truth for what counts as a credential
 *     key in the Comis observability substrate).
 *   - **Arrays** are walked element-by-element.
 *   - **Cyclic references** produce the literal string `"[Circular]"`
 *     at the back-edge (operator-readable, matches Node.js
 *     `util.inspect` convention and `sanitizeDiagnosticPayload`'s
 *     own contract).
 *   - **Primitives** (number / boolean / null / undefined) pass through.
 *
 * `sanitizeForPersistence(value)` is the canonical "safe-to-disk"
 * composition for diagnostic artifacts (design §5.3.3):
 *
 *   `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`
 *
 * Order matters: `limitPayloadValue` first bounds size/depth, then
 * `sanitizeDiagnosticPayload` drops credential-keyed fields entirely
 * and applies image-shape rewrites, and finally `redactSecrets` masks
 * any credential bodies that survived (e.g., inside free-text fields).
 *
 * Pure function — no I/O, no clock, no fs.
 *
 * @module
 */

import { limitPayloadValue } from "../shared/bounded-payload.js";
import { isCredentialFieldName } from "../shared/sanitize-diagnostic-payload.js";
import { sanitizeDiagnosticPayload } from "../shared/sanitize-diagnostic-payload.js";

import { maskToken } from "./edge-keeping.js";
import { redactSecretsInText } from "./redact-text.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSecretsInText(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const mapped = value.map((entry) => walk(entry, seen));
    seen.delete(value);
    return mapped;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // Read via Object.keys + indexed access; treat the entry as
      // `unknown` to keep this generic for arbitrary structures.
      const v = (value as Record<string, unknown>)[key];

      if (isCredentialFieldName(key)) {
        if (typeof v === "string") {
          // Value-mode mask: edge-keeping over the string.
          out[key] = maskToken(v);
        } else {
          // Non-string (number, boolean, object) under a credential
          // key — collapse to the short-token sentinel since there is
          // no body to mask.
          out[key] = "***";
        }
        continue;
      }

      out[key] = walk(v, seen);
    }

    seen.delete(value);
    return out;
  }

  // Primitives (number, boolean, null, undefined, symbol, bigint).
  return value;
}

/**
 * Apply the structured-walk redactor to `value`.
 *
 * The result is a NEW value graph (input is not mutated). Credential-
 * keyed fields are masked at the value level; string bodies are scanned
 * for embedded credentials; cycles are flagged with `"[Circular]"`.
 *
 * @param value - arbitrary JavaScript value
 * @returns the redacted graph
 */
export function redactSecrets<T = unknown>(value: T): unknown {
  const seen = new WeakSet<object>();
  return walk(value, seen);
}

/**
 * Canonical "safe to persist to disk" pipeline (design §5.3.3).
 *
 * `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`
 *
 * Used by every artifact writer (trajectory, system-prompt-report,
 * config-audit) before writing a diagnostic payload.
 *
 * @param value - arbitrary JavaScript value
 * @returns the bounded + sanitized + redacted graph
 */
export function sanitizeForPersistence(value: unknown): unknown {
  return redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)));
}
