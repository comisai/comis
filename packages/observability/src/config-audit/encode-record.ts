// SPDX-License-Identifier: Apache-2.0
/**
 * Single-pass encoder for config-audit JSONL records.
 *
 * Extracted from byte-identical-modulo-shape copies in append.ts
 * (`encodeRecord`), append-observe.ts (`encodeObserveRecord`), and
 * scrub.ts (`reEncodeRecord` body) — REFACTOR-03 successor to
 * DUP-CONS-11 sentinel extraction.
 *
 * Argv goes through the dedicated `redactConfigAuditArgv` (which knows
 * `--flag=value` shape); the rest of the record goes through
 * `sanitizeForPersistence`. The two redactors are NOT composed because
 * they would mutually over-redact — `redactSecretsInText` matches
 * `--api-key=...` as a credential pattern and would collapse the
 * already-masked `--api-key=***` to a bare `***`, losing the flag-name
 * evidence operators need for forensics.
 *
 * Non-array argv (the scrub edge case where the parsed JSONL line
 * carried a malformed argv field) is preserved verbatim — the scrubber
 * elects to leave invalid shapes alone for forensic traceability.
 *
 * On `safeJsonStringify` returning `undefined` (BigInt, circular ref,
 * host throw in JSON.stringify) the encoder falls through to
 * `emitSerializationErrorSentinel()` — a JSON-parseable sentinel
 * preserves audit-log forensic integrity; downstream consumers can
 * recognize and skip the sentinel without parse failures.
 *
 * INTERNAL: not exported from the @comis/observability public barrel.
 *
 * @module
 */

import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import {
  redactConfigAuditArgv,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";
import { emitSerializationErrorSentinel } from "./serialization-sentinel.js";

/**
 * Encode a config-audit record to a newline-terminated JSON string.
 *
 * The input record type is `Record<string, unknown>` (not the
 * narrower `ConfigWriteAuditRecord` / `ConfigObserveAuditRecord`)
 * because the scrubber path feeds parsed-from-disk values whose
 * shape may have drifted across schema versions.
 */
export function encodeAuditRecord(
  record: Record<string, unknown>,
): string {
  const rawArgv = record.argv;
  const safeArgv = Array.isArray(rawArgv)
    ? rawArgv.map((v) => (typeof v === "string" ? v : String(v)))
    : undefined;
  // Sanitize everything EXCEPT argv. Use a placeholder marker for
  // argv so the sanitizer leaves the slot alone, then splice the
  // dedicated redacted argv back in via the parsed graph.
  const withoutArgv: Record<string, unknown> = { ...record };
  delete (withoutArgv as { argv?: unknown }).argv;
  const sanitized = sanitizeForPersistence(withoutArgv) as Record<string, unknown>;
  if (safeArgv !== undefined) {
    // We trust `redactConfigAuditArgv` is strictly safer than the
    // regex pass would be for the argv shape.
    sanitized.argv = redactConfigAuditArgv(safeArgv).slice(
      0,
      CONFIG_AUDIT_ARGV_CAP,
    );
  } else if (rawArgv !== undefined) {
    // Preserve non-array argv verbatim (scrub edge case).
    sanitized.argv = rawArgv;
  }
  const json = safeJsonStringify(sanitized);
  if (json === undefined) {
    // safeJsonStringify returned undefined (BigInt, circular ref,
    // or host throw in JSON.stringify). Falling back to a JSON-parseable
    // sentinel preserves audit-log forensic integrity; downstream
    // consumers can recognize and skip the sentinel without parse failures.
    return emitSerializationErrorSentinel();
  }
  return json + "\n";
}
