// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-03 / E3 — content-free re-redaction at the exporter boundary.
 *
 * Every attribute object and every log-record body the extension emits passes
 * through {@link redactAttributes} FIRST — independent of whatever upstream
 * scrubbing happened. This is the additive E3 guarantee: even if a future
 * careless attribute addition (or the `captureContent`/`genaiSemconv` content
 * path) tries to smuggle a secret/message body into a span attribute, a metric
 * label, or a log body, the single `@comis/observability` `sanitizeForPersistence`
 * chokepoint (keys + scalar counts/ids/digests only) strips it here.
 *
 * The catalog labels are content-free BY CONSTRUCTION (the closed `MetricLabel`
 * union — ids/enums/counts only), so this wrapper is the belt to that suspenders:
 * it guards the free-form content path the spec's GenAI opt-in opens.
 *
 * Mirrors the `obs-audit-sink.ts` usage (`sanitizeForPersistence(...)` at the
 * 176 durable-sink boundary) — the same single chokepoint, re-applied here.
 *
 * @module
 */
import { sanitizeForPersistence } from "@comis/observability";

/**
 * Re-redact an attribute object / log body at the exporter boundary. Routes the
 * input through `sanitizeForPersistence` (the single redaction chokepoint) and
 * returns a plain attribute record. A planted secret value (keyed credential or
 * a pattern-matched secret) does not survive; benign scalar ids/counts/enums do.
 *
 * Always returns a `Record<string, unknown>` (never undefined/null) so callers
 * can spread it straight onto an OTel `attributes` bag.
 */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = sanitizeForPersistence(attrs);
  // sanitizeForPersistence walks objects and returns the same structural shape;
  // for an object input it returns an object. Defensive: if it ever returns a
  // non-object (it should not for an object input), degrade to an empty bag
  // rather than leak an unexpected scalar onto an attributes record.
  if (scrubbed !== null && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}
