// SPDX-License-Identifier: Apache-2.0
/**
 * Payload-bounding limiter for diagnostic artifacts.
 *
 * Walks a payload value, replacing any sub-tree that exceeds one of the
 * five canonical bounds with a sentinel record. Bounds:
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

/** Numeric thresholds. */
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

/**
 * Per-key exemption overrides for the bounded-payload limiter.
 *
 * When a child value lives under a parent object key whose name is in
 * `stringFieldExempt` (for string-typed children) or `arrayFieldExempt`
 * (for array-typed children), the default 32 KB / 64-item caps are
 * bypassed for that exact slot. The exemption is on the CONTAINING
 * field name only — it does not propagate into nested children of the
 * exempted value.
 *
 * Use case (260520-wcf, cache-trace): when the operator opts in to
 * `includeSystem` / `includeMessages` on the cache-trace runtime, the
 * `system` / `messages` payload slots must carry full SDK content even
 * when it exceeds 32 KB. Without exemption the limiter replaced the
 * payload with the `bounded-payload-field-size-limit` sentinel,
 * silently defeating the opt-in.
 *
 * Both sets are READ-ONLY and OPTIONAL. Default behavior (no overrides
 * argument) is identical to pre-260520-wcf — every string is capped.
 */
export interface PayloadBoundsOverrides {
  readonly stringFieldExempt?: ReadonlySet<string>;
  readonly arrayFieldExempt?: ReadonlySet<string>;
}

/** Top-level entry — bounds `value` against the five canonical limits. */
export function limitPayloadValue(
  value: unknown,
  overrides?: PayloadBoundsOverrides,
): unknown {
  const seen = new WeakSet<object>();
  return walk(value, 0, seen, overrides, undefined);
}

function walk(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  overrides: PayloadBoundsOverrides | undefined,
  parentKey: string | undefined,
): unknown {
  // 1) Depth cap — strictly greater than maxDepth means the path went too deep.
  if (depth > PAYLOAD_BOUNDS.maxDepth) {
    const out: BoundedSentinel = {
      __bounded__: BOUNDED_PAYLOAD_REASONS.depthLimit,
    };
    return out;
  }

  // 2) String size cap.
  if (typeof value === "string") {
    // Per-key exemption: when the immediate parent object's key is in
    // overrides.stringFieldExempt, bypass the 32 KB cap. The exemption
    // is on the slot, not on the value — nested strings inside an
    // exempted parent are NOT automatically exempted (cap restored on
    // descent because parentKey is reset to the child's own key).
    if (
      parentKey !== undefined &&
      overrides?.stringFieldExempt?.has(parentKey) === true
    ) {
      return value;
    }
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
    // Per-key exemption for arrays — same semantics as strings.
    const arrayExempt =
      parentKey !== undefined &&
      overrides?.arrayFieldExempt?.has(parentKey) === true;
    if (!arrayExempt && value.length > PAYLOAD_BOUNDS.maxArrayLength) {
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
    // Propagate parentKey UNCHANGED into array elements — the exemption
    // covers the array slot, not each element (the element key is the
    // numeric index, which is meaningless to operator-named exemptions).
    const mapped = value.map((entry) =>
      walk(entry, depth + 1, seen, overrides, parentKey),
    );
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
      // Pass the property key as parentKey for the child so the
      // exemption check sees it. Resets at each object boundary — the
      // exemption never tunnels deeper than one level.
      out[key] = walk(value[key], depth + 1, seen, overrides, key);
    }
    seen.delete(value);
    return out;
  }

  // 5) Other primitives — passthrough.
  return value;
}
