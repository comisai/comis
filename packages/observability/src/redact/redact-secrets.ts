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
 * composition for diagnostic artifacts.
 *
 * Order matters: bounding runs first (so size/depth/cycle caps fire
 * before any string/credential scanning sees the bytes), then sanitize
 * drops credential-keyed fields and rewrites image objects, and finally
 * redact masks any credential bodies that survived (e.g., inside
 * free-text fields). Reversing this order risks a truncated-prefix leak
 * of oversize credentials.
 *
 * Pure function — no I/O, no clock, no fs.
 *
 * The pre-fusion implementation composed three full-graph walks
 * (`redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`).
 * Each walk allocated its own WeakSet, its own `isPlainObject` predicate
 * copy, and its own value-graph allocation. Post-fusion,
 * `sanitizeForPersistence` is a single
 * `combinedWalk(value, {boundCheck, sanitizeNode, redactNode}, overrides)`
 * call — ONE WeakSet, ONE descent, ONE value-graph allocation. Public
 * signatures (`redactSecrets`, `sanitizeForPersistence`) are UNCHANGED.
 *
 * @module
 */

import {
  combinedWalk,
  boundCheckHook,
  sanitizeNodeHook,
  redactNodeHook,
} from "../shared/combined-walker.js";
import { type PayloadBoundsOverrides } from "../shared/bounded-payload.js";

/**
 * Apply the structured-walk redactor to `value`.
 *
 * Delegates to `combinedWalk` with the redact-node hook only.
 * The result is a NEW value graph (input is not mutated). Credential-keyed
 * fields are masked at the value level; string bodies are scanned for
 * embedded credentials; cycles are flagged with `"[Circular]"`.
 *
 * @param value - arbitrary JavaScript value
 * @returns the redacted graph
 */
export function redactSecrets<T = unknown>(value: T): unknown {
  return combinedWalk(value, { redactNode: redactNodeHook });
}

/**
 * Canonical "safe to persist to disk" pipeline.
 *
 * Used by every artifact writer (trajectory, system-prompt-report,
 * config-audit, cache-trace) before writing a diagnostic payload.
 *
 * The optional `overrides` argument is forwarded to the bounded-payload
 * stage so callers (cache-trace runtime) can opt specific payload slots
 * out of the 32 KB / 64-item caps. See
 * {@link PayloadBoundsOverrides} for the per-key exemption contract.
 * Default behavior (no overrides) is identical.
 *
 * **Hook order at every node** is `boundCheck → sanitizeNode → redactNode`
 * (bounding BEFORE redacting prevents truncated-prefix leak of
 * oversize credentials). Cycles emit the record-shape sentinel
 * `{__bounded__: 'bounded-payload-cycle-detected'}` because `boundCheck`
 * is active.
 *
 * @param value - arbitrary JavaScript value
 * @param overrides - optional per-key exemption overrides
 * @returns the bounded + sanitized + redacted graph
 */
export function sanitizeForPersistence(
  value: unknown,
  overrides?: PayloadBoundsOverrides,
): unknown {
  return combinedWalk(
    value,
    {
      boundCheck: boundCheckHook,
      sanitizeNode: sanitizeNodeHook,
      redactNode: redactNodeHook,
    },
    overrides,
  );
}
