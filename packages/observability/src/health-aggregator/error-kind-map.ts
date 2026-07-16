// SPDX-License-Identifier: Apache-2.0
/**
 * Synthetic errorKind mapping for events that do NOT carry an `errorKind`
 * field in their typed payload but ARE health/safety-relevant. Each entry
 * pins a known event name to a fixed errorKind so the aggregator's
 * per-kind counters stay coherent.
 *
 * Events listed here also drive the aggregator's subscription set —
 * `Object.keys(SYNTHETIC_ERROR_KIND_MAP)` is iterated at attach time.
 *
 * @module
 */
import type { EventMap } from "@comis/core";

export const SYNTHETIC_ERROR_KIND_MAP = {
  "security:injection_detected": "internal",
  "security:memory_tainted":     "internal",
  "execution:aborted":           "internal",
  "execution:prompt_timeout":    "timeout",
  "mcp:server:reconnect_failed": "dependency",
} as const satisfies Partial<Record<keyof EventMap, string>>;

/**
 * Events whose typed payload carries an `errorKind` field. The
 * aggregator subscribes to these and reads `errorKind` directly off
 * the payload. When the field is missing on an optional declaration
 * (e.g. tool:executed.errorKind?), resolveErrorKind returns null and
 * the event is ignored.
 */
export const TYPED_ERROR_KIND_EVENTS = [
  "auth:refresh_failed",
  "tool:executed",
] as const satisfies ReadonlyArray<keyof EventMap>;

export type TypedErrorKindEvent = (typeof TYPED_ERROR_KIND_EVENTS)[number];
export type SyntheticErrorKindEvent = keyof typeof SYNTHETIC_ERROR_KIND_MAP;
export type AggregatorSubscribedEvent = TypedErrorKindEvent | SyntheticErrorKindEvent;

/**
 * Resolve errorKind for one event observation.
 * - Typed events: read `payload.errorKind` (string). null when optional+missing.
 * - Synthetic events: return the fixed mapping value.
 * - Anything else: null (caller must skip).
 */
export function resolveErrorKind(
  eventName: AggregatorSubscribedEvent,
  payload: { readonly errorKind?: string } & Record<string, unknown>,
): string | null {
  if ((TYPED_ERROR_KIND_EVENTS as ReadonlyArray<string>).includes(eventName)) {
    return typeof payload.errorKind === "string" ? payload.errorKind : null;
  }
  const synthetic = (SYNTHETIC_ERROR_KIND_MAP as Record<string, string>)[eventName];
  return synthetic ?? null;
}
