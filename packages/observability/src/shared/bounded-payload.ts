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
 * Every sentinel name carries the `bounded-payload-*` prefix (rather than a
 * `trajectory-*` one) so the same limiter is reusable across the trajectory
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
 * The recursive `walk` body, WeakSet allocation, and `isPlainObject`
 * predicate live in the shared `combined-walker.ts`. `limitPayloadValue`
 * is a one-line delegate invoking `combinedWalk` with the
 * `boundCheckHook` only. The five canonical bounds (depth, string size,
 * array length, object key count, cycle) are enforced inside
 * `boundCheckHook` — the bounds constants (`PAYLOAD_BOUNDS`,
 * `BOUNDED_PAYLOAD_REASONS`) and the `BoundedSentinel` shape are still
 * owned here and consumed by the hook + downstream callers
 * (config-audit, cache-trace, trajectory).
 *
 * @module
 */

import { combinedWalk, boundCheckHook } from "./combined-walker.js";

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
 * Use case (cache-trace): when the operator opts in to `includeSystem`
 * / `includeMessages` on the cache-trace runtime, the `system` /
 * `messages` payload slots must carry full SDK content even when it
 * exceeds 32 KB. Without exemption the limiter replaced the payload
 * with the `bounded-payload-field-size-limit` sentinel, silently
 * defeating the opt-in.
 *
 * Both sets are READ-ONLY and OPTIONAL. Default behavior (no overrides
 * argument) caps every string.
 */
export interface PayloadBoundsOverrides {
  readonly stringFieldExempt?: ReadonlySet<string>;
  readonly arrayFieldExempt?: ReadonlySet<string>;
}

/**
 * Top-level entry — bounds `value` against the five canonical limits.
 *
 * Delegates to `combinedWalk` with the bound-check hook only.
 * The walker scaffolding (WeakSet allocation, recursion, `isPlainObject`
 * predicate) lives in `combined-walker.ts`; this function preserves the
 * EXACT pre-fusion public signature for `@comis/infra`, `@comis/daemon`,
 * trajectory, cache-trace, and config-audit consumers.
 */
export function limitPayloadValue(
  value: unknown,
  overrides?: PayloadBoundsOverrides,
): unknown {
  return combinedWalk(value, { boundCheck: boundCheckHook }, overrides);
}
