// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-03 / E3 — content-free re-redaction at the exporter boundary.
 *
 * Every attribute object and every log-record body the extension emits passes
 * through {@link redactAttributes} FIRST — independent of whatever upstream
 * scrubbing happened. This is the additive E3 guarantee: even if a future
 * careless attribute addition (or the `captureContent`/`genaiSemconv` content
 * path) tries to smuggle a secret/message body into a span attribute, a metric
 * label, or a log body, the boundary strips it here.
 *
 * The boundary enforces a CLOSED ALLOWLIST (CR-02). `sanitizeForPersistence`
 * masks credential-KEYED fields (`apiKey`/`password`/`token`/`secret`/…) and
 * prefix-patterned secret VALUES (`sk-…`/`ghp_…`/`Bearer …`), but it canNOT
 * catch a high-entropy secret under a BENIGN key with no recognisable prefix
 * (`{reason:"<32 random>"}`, `{detail:"<40 hex>"}`, free text) — that value
 * survives value-scanning verbatim. You cannot reliably detect a secret VALUE,
 * so the only robust posture at an egress boundary is to enumerate the KEYS that
 * are allowed out and DROP everything else. {@link ATTRIBUTE_ALLOWLIST} is that
 * closed set: the {@link METRIC_LABELS} union (every metric label is a
 * content-free enum/id/count) + the known span/log attribute keys
 * (`comis.trace_id`, the `gen_ai.*` semconv names, the structural-summary keys).
 * `sanitizeForPersistence` then runs on the ALLOWED values as defense-in-depth
 * (a credential keyed under an allowed name — e.g. an operator who names a label
 * `token` — is still masked).
 *
 * Mirrors the `obs-audit-sink.ts` usage (`sanitizeForPersistence(...)` at the
 * 176 durable-sink boundary) — the same single chokepoint, here behind the
 * allowlist gate.
 *
 * @module
 */
import { sanitizeForPersistence } from "@comis/observability";
import { METRIC_LABELS } from "./metric-catalog.js";

/**
 * The known span/log attribute keys the extension legitimately emits that are
 * NOT metric labels: the Comis span attributes (`traces.ts`), the GenAI semconv
 * attribute names (both the latest `gen_ai.provider.name` and the pre-stable
 * `gen_ai.system`), and the content-free structural-summary keys the span
 * message/system-instruction summaries pass THROUGH `redactAttributes`
 * (`count`/`roles` for a message summary, `present`/`length` for the
 * system-instruction summary). Each is content-free by construction (an id,
 * count, role enum, or boolean — never a message body).
 */
const KNOWN_SPAN_ATTRIBUTE_KEYS = [
  // Comis-native span attributes.
  "comis.trace_id",
  "comis.duration_ms",
  // GenAI semconv (latest + pre-stable provider-name namespaces).
  "gen_ai.provider.name",
  "gen_ai.system",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  // The 3 content attrs (only ever set to a re-redacted content-free SUMMARY
  // string by traces.ts, never a raw body) — allowed so the summary survives.
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  // The structural-summary keys the content-free message / system-instruction
  // summaries build and route through this boundary before serialisation.
  "count",
  "roles",
  "present",
  "length",
] as const;

/**
 * The CLOSED allowlist of attribute keys permitted past the exporter boundary
 * (CR-02). Built ONCE from the {@link METRIC_LABELS} union (the metric labels)
 * plus {@link KNOWN_SPAN_ATTRIBUTE_KEYS}. Adding a NEW emitted attribute is a
 * deliberate act: the new key must be added here (and is necessarily a
 * content-free id/count/enum to belong). A key absent from this set is DROPPED —
 * a careless future attribute addition cannot leak a secret VALUE.
 */
const ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...METRIC_LABELS,
  ...KNOWN_SPAN_ATTRIBUTE_KEYS,
]);

/**
 * Re-redact an attribute object / log body at the exporter boundary.
 *
 * Two layers (CR-02): (1) the CLOSED ALLOWLIST — every key NOT in
 * {@link ATTRIBUTE_ALLOWLIST} is DROPPED (the only posture that survives a
 * benign-keyed, no-prefix, high-entropy secret value); (2) `sanitizeForPersistence`
 * on the surviving allowed values as defense-in-depth (a credential keyed under
 * an allowed name is still masked, and a prefix-patterned body inside an allowed
 * string is still scrubbed).
 *
 * Always returns a `Record<string, unknown>` (never undefined/null) so callers
 * can spread it straight onto an OTel `attributes` bag.
 */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  // Layer 1: drop every non-allowlisted key BEFORE any value ever reaches the
  // attribute bag. This is the robust egress posture — a secret VALUE cannot be
  // reliably detected, so we enumerate the KEYS allowed out and drop the rest.
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (ATTRIBUTE_ALLOWLIST.has(key)) {
      allowed[key] = value;
    }
  }
  // Layer 2: re-redact the allowed values (defense-in-depth — a credential keyed
  // under an allowed name, or a prefix-patterned body inside an allowed string).
  const scrubbed = sanitizeForPersistence(allowed);
  // sanitizeForPersistence walks objects and returns the same structural shape;
  // for an object input it returns an object. Defensive: if it ever returns a
  // non-object (it should not for an object input), degrade to an empty bag
  // rather than leak an unexpected scalar onto an attributes record.
  if (scrubbed !== null && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}
