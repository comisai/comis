// SPDX-License-Identifier: Apache-2.0
/**
 * Payload-bounding limiter for diagnostic artifacts.
 *
 * Walks a payload value, replacing any sub-tree that exceeds one of the
 * five canonical bounds with a sentinel record. Bounds (design §4.2):
 *
 *   - string > 32 KB        → `bounded-payload-field-size-limit`
 *   - array > 64 items      → `bounded-payload-array-length-limit`
 *   - object > 64 keys      → `bounded-payload-object-key-limit`
 *   - depth > 6             → `bounded-payload-depth-limit`
 *   - cyclic reference      → `bounded-payload-cycle-detected`
 *
 * The Comis improvement over OpenClaw's original is the
 * `bounded-payload-*` prefix on every sentinel name (instead of
 * `trajectory-*`), so the same limiter is reusable across the trajectory
 * writer, system-prompt-report, config-audit, and any future
 * diagnostic-artifact pipeline without coupling the name to the
 * trajectory call site.
 *
 * The sentinel record shape is `{ __bounded__: <reason>, ... }` where the
 * extra fields are a quantitative breadcrumb for the operator
 * (`originalBytes` for strings, `originalLength` for arrays,
 * `originalKeyCount` for objects). The `__bounded__` key is the stable
 * machine-readable marker; downstream consumers grep on it.
 *
 * Cycle detection uses a `WeakSet` on the descent path — siblings can
 * legitimately reference the same shared object (DAG), only back-edges
 * (the same node already in the current descent path) are flagged as
 * cycles. Tracked-and-removed on ascent: a `WeakSet` is the simplest
 * shape for the contract.
 *
 * Pure function — no I/O, no side effects, no clock dependency. Used by
 * the observability substrate at write time, before the sanitizer pass
 * (which has its own image-base64 / credential-key rules — see
 * `sanitize-diagnostic-payload.ts`).
 *
 * @module
 */

/** Numeric thresholds (design §4.2). */
export const PAYLOAD_BOUNDS = Object.freeze({
  maxFieldSizeBytes: 32 * 1024,
  maxArrayLength: 64,
  maxObjectKeys: 64,
  maxDepth: 6,
} as const);

/**
 * Canonical sentinel reasons (Comis-renamed: `bounded-payload-*` prefix
 * decoupled from the trajectory call site).
 */
export const BOUNDED_PAYLOAD_REASONS = Object.freeze({
  fieldSizeLimit: "bounded-payload-field-size-limit",
  arrayLengthLimit: "bounded-payload-array-length-limit",
  objectKeyLimit: "bounded-payload-object-key-limit",
  depthLimit: "bounded-payload-depth-limit",
  cycleDetected: "bounded-payload-cycle-detected",
} as const);

/** Closed union of the sentinel reason string values (literal types). */
export type BoundedPayloadReason =
  (typeof BOUNDED_PAYLOAD_REASONS)[keyof typeof BOUNDED_PAYLOAD_REASONS];

/** Sentinel record returned in place of an over-bound sub-tree. */
export interface BoundedSentinel {
  readonly __bounded__: BoundedPayloadReason;
  readonly originalBytes?: number;
  readonly originalLength?: number;
  readonly originalKeyCount?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level entry — bounds `value` against the five canonical limits. */
export function limitPayloadValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return walk(value, 0, seen);
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // 1) Depth cap — strictly greater than maxDepth means the path went too deep.
  if (depth > PAYLOAD_BOUNDS.maxDepth) {
    const out: BoundedSentinel = {
      __bounded__: BOUNDED_PAYLOAD_REASONS.depthLimit,
    };
    return out;
  }

  // 2) String size cap.
  if (typeof value === "string") {
    if (value.length > PAYLOAD_BOUNDS.maxFieldSizeBytes) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
        originalBytes: value.length,
      };
      return out;
    }
    return value;
  }

  // 3) Array length cap.
  if (Array.isArray(value)) {
    if (value.length > PAYLOAD_BOUNDS.maxArrayLength) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.arrayLengthLimit,
        originalLength: value.length,
      };
      return out;
    }
    if (seen.has(value)) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.cycleDetected,
      };
      return out;
    }
    seen.add(value);
    const mapped = value.map((entry) => walk(entry, depth + 1, seen));
    seen.delete(value);
    return mapped;
  }

  // 4) Plain-object key cap.
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > PAYLOAD_BOUNDS.maxObjectKeys) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.objectKeyLimit,
        originalKeyCount: keys.length,
      };
      return out;
    }
    if (seen.has(value)) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.cycleDetected,
      };
      return out;
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = walk(value[key], depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }

  // 5) Other primitives — passthrough.
  return value;
}
