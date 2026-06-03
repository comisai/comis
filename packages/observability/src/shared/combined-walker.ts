// SPDX-License-Identifier: Apache-2.0
/**
 * Combined observability walker — one descent, one WeakSet, three hooks.
 *
 * Replaces the three full-graph walks performed by
 * `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`
 * with ONE recursive descent that applies the three concerns via per-node
 * hooks. The hooks fire in canonical order at every node:
 *
 *   1. boundCheck    - size/depth/cycle caps; returns sentinel on violation.
 *   2. sanitizeNode  - credential-key drop, name/value pair masking, image-shape rewrite.
 *   3. redactNode    - value-mode credential mask (edge-keeping).
 *
 * Ordering is LOAD-BEARING. Bounding BEFORE redacting prevents a
 * truncated-prefix leak of oversize credentials.
 *
 * Cycle sentinel convention:
 *   - With `boundCheck` set (e.g., sanitizeForPersistence) → record-shape
 *     sentinel `{__bounded__: "bounded-payload-cycle-detected"}` at first
 *     back-edge.
 *   - Without `boundCheck` (e.g., sanitizeDiagnosticPayload / redactSecrets
 *     solo) → string `"[Circular]"` at first back-edge (preserves the
 *     pre-fusion observable convention of walkers 2/3).
 *
 * Pure function — no I/O, no clock, no fs.
 *
 * @module
 */

import {
  PAYLOAD_BOUNDS,
  BOUNDED_PAYLOAD_REASONS,
  type BoundedSentinel,
  type PayloadBoundsOverrides,
} from "./bounded-payload.js";
import {
  isCredentialFieldName,
  sanitizeString,
  maybeRewriteImageObject,
} from "./sanitize-diagnostic-payload.js";
import { maskToken } from "../redact/edge-keeping.js";
import { redactSecretsInText } from "../redact/redact-text.js";

// --- Public types ---------------------------------------------------------

/**
 * Per-node walker context handed to every hook. `value` is the current
 * node being visited; `depth` is the recursion depth from the root;
 * `parentKey` is the name of the object property that holds `value`
 * (undefined at the root or inside arrays — array indices are not
 * surfaced because operator-named exemptions are key-based, not
 * positional); `seen` is the descent-path tracker for cycle detection.
 */
export interface NodeContext {
  readonly value: unknown;
  readonly depth: number;
  readonly parentKey: string | undefined;
  readonly seen: WeakSet<object>;
}

/**
 * Context flavor for object-keyed callbacks. The walker narrows the
 * `value` type to `Record<string, unknown>` before invoking
 * `sanitizeNode`.
 */
export interface ObjectNodeContext extends NodeContext {
  readonly value: Record<string, unknown>;
}

/**
 * Per-key decision returned by `sanitizeNode`:
 *   - `passthrough` → the walker descends into the child normally.
 *   - `drop`        → the key is omitted from the output object.
 *   - `replace`     → the walker uses `with` as the child value WITHOUT
 *     further descent (but still applies `redactNode` if set, so a
 *     sanitize-stage replacement still passes through redact-stage
 *     masking — preserves config-4 behavior).
 */
export type SanitizeAction =
  | { kind: "passthrough" }
  | { kind: "drop"; reason: "credential-key" }
  | { kind: "replace"; with: unknown };

/**
 * Hook trio consumed by {@link combinedWalk}.
 *
 * Each hook is OPTIONAL. The presence of a hook activates its stage at
 * every node visited. The four canonical configurations are:
 *
 *   - `{ boundCheck }`                                       ≡ pre-fusion `limitPayloadValue`
 *   - `{ sanitizeNode }`                                     ≡ pre-fusion `sanitizeDiagnosticPayload`
 *   - `{ redactNode }`                                       ≡ pre-fusion `redactSecrets`
 *   - `{ boundCheck, sanitizeNode, redactNode }`             ≡ pre-fusion `sanitizeForPersistence`
 */
export interface WalkerHooks {
  /**
   * Returns a replacement sentinel if the value violates a bound; otherwise
   * returns `undefined` to pass through to the next stage.
   *
   * The hook is responsible for cycle detection when active — it sees
   * `seen` via the context and decides whether to emit the cycle sentinel.
   */
  boundCheck?: (
    ctx: NodeContext,
    overrides: PayloadBoundsOverrides | undefined,
  ) => unknown | undefined;

  /**
   * Returns a per-key sanitize decision (`drop` / `replace` / `passthrough`).
   * Called once per object key inside the object branch of the walker.
   */
  sanitizeNode?: (ctx: ObjectNodeContext, key: string) => SanitizeAction;

  /**
   * Returns a redact-stage replacement value for credential-keyed slots,
   * or `undefined` to fall through to normal descent. Called for each
   * object-key value AND for string replacements produced by
   * `sanitizeNode` (so a sanitize-stage replacement is still redact-masked
   * when both stages are active).
   */
  redactNode?: (
    ctx: NodeContext,
    key: string | undefined,
  ) => unknown | undefined;
}

// --- isPlainObject (lifted from the three pre-fusion walkers) -------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Built-in hook implementations ----------------------------------------

/**
 * boundCheck hook — extracted from `bounded-payload.ts`'s walk body.
 *
 * Applies the five canonical bounds: depth > 6, string > 32 KB, array >
 * 64, object > 64 keys, cycle. Returns a `BoundedSentinel` record on
 * violation, `undefined` otherwise. Honors `PayloadBoundsOverrides` for
 * per-key string / array exemptions.
 */
export function boundCheckHook(
  ctx: NodeContext,
  overrides: PayloadBoundsOverrides | undefined,
): unknown | undefined {
  const { value, depth, parentKey, seen } = ctx;

  // 1) Depth cap — strictly greater than maxDepth means the path went too deep.
  if (depth > PAYLOAD_BOUNDS.maxDepth) {
    const out: BoundedSentinel = {
      __bounded__: BOUNDED_PAYLOAD_REASONS.depthLimit,
    };
    return out;
  }

  // 2) String size cap (with per-key exemption).
  if (typeof value === "string") {
    if (
      parentKey !== undefined &&
      overrides?.stringFieldExempt?.has(parentKey) === true
    ) {
      return undefined;
    }
    if (value.length > PAYLOAD_BOUNDS.maxFieldSizeBytes) {
      const out: BoundedSentinel = {
        __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
        originalBytes: value.length,
      };
      return out;
    }
    return undefined;
  }

  // 3) Array length cap + cycle.
  if (Array.isArray(value)) {
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
    return undefined;
  }

  // 4) Plain-object key cap + cycle.
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
    return undefined;
  }

  // Other primitives — under no cap.
  return undefined;
}

/**
 * sanitizeNode hook — extracted from `sanitize-diagnostic-payload.ts`'s
 * walk body (the per-object-key decision logic).
 *
 * Returns:
 *   - `drop`   when `key` matches a credential name (case-insensitive).
 *   - `replace` with `"<redacted>"` for the `value` key of a name/value
 *     pair when the pair's `name` field matches a credential name.
 *   - `passthrough` otherwise (including for the `name` field of a
 *     name/value pair — the credential-name string itself is preserved).
 *
 * Image-shape rewrite happens once per OBJECT in the walker (before this
 * hook fires per key); see the object branch of `walk`.
 */
export function sanitizeNodeHook(
  ctx: ObjectNodeContext,
  key: string,
): SanitizeAction {
  const subject = ctx.value;

  const isNameValuePair =
    typeof subject["name"] === "string" &&
    Object.prototype.hasOwnProperty.call(subject, "value") &&
    isCredentialFieldName(subject["name"] as string);

  if (isNameValuePair && key === "value") {
    return { kind: "replace", with: "<redacted>" };
  }
  if (isNameValuePair && key === "name") {
    // Preserve `name` as-is (the credential-name string).
    return { kind: "passthrough" };
  }

  if (isCredentialFieldName(key)) {
    return { kind: "drop", reason: "credential-key" };
  }

  return { kind: "passthrough" };
}

/**
 * redactNode hook — extracted from `redact-secrets.ts`'s walk body (the
 * per-key value-mode mask decision).
 *
 * For credential-keyed string values, returns `maskToken(v)` (edge-keeping
 * mask). For credential-keyed non-string values, returns the `"***"`
 * sentinel. For non-credential keys (or for the root call with
 * `key === undefined`), returns `undefined` to fall through to normal
 * descent — descending strings still get `redactSecretsInText` applied
 * inside the walker's string branch.
 */
export function redactNodeHook(
  ctx: NodeContext,
  key: string | undefined,
): unknown | undefined {
  if (key === undefined) return undefined;
  if (!isCredentialFieldName(key)) return undefined;

  const v = ctx.value;
  if (typeof v === "string") {
    return maskToken(v);
  }
  return "***";
}

// --- Combined walker ------------------------------------------------------

/**
 * One-descent walker driving the three observability hooks.
 *
 * Allocates ONE `WeakSet<object>` for cycle tracking and performs ONE
 * recursive descent. Configurations:
 *
 *   - `{ boundCheck }`                            → `limitPayloadValue` semantics
 *   - `{ sanitizeNode }`                          → `sanitizeDiagnosticPayload` semantics
 *   - `{ redactNode }`                            → `redactSecrets` semantics
 *   - `{ boundCheck, sanitizeNode, redactNode }`  → `sanitizeForPersistence` semantics
 *
 * @param value     - any JavaScript value
 * @param hooks     - per-stage hooks; absent stages behave as identity
 * @param overrides - per-key bounds exemptions threaded to `boundCheck`
 * @returns         - a new value graph (input not mutated)
 */
export function combinedWalk(
  value: unknown,
  hooks: WalkerHooks,
  overrides?: PayloadBoundsOverrides,
): unknown {
  const seen = new WeakSet<object>();
  return walk(value, 0, seen, hooks, overrides, undefined);
}

function walk(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  hooks: WalkerHooks,
  overrides: PayloadBoundsOverrides | undefined,
  parentKey: string | undefined,
): unknown {
  // (a) boundCheck FIRST — depth/size/cycle caps before any other hook.
  if (hooks.boundCheck) {
    const ctx: NodeContext = { value, depth, parentKey, seen };
    const sentinel = hooks.boundCheck(ctx, overrides);
    if (sentinel !== undefined) return sentinel;
  }

  // (b) String branch — apply stage-string passes.
  if (typeof value === "string") {
    let s = value;
    if (hooks.sanitizeNode) s = sanitizeString(s);
    if (hooks.redactNode) s = redactSecretsInText(s);
    return s;
  }

  // (c) Array branch.
  if (Array.isArray(value)) {
    // Cycle detection when boundCheck is not active. Without boundCheck,
    // the convention is the string "[Circular]" (matches pre-fusion
    // walker 2/3 behavior).
    if (!hooks.boundCheck && seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    // parentKey propagates UNCHANGED into elements (operator-named
    // exemptions are slot-based, not positional within the array).
    const mapped = value.map((entry) =>
      walk(entry, depth + 1, seen, hooks, overrides, parentKey),
    );
    seen.delete(value);
    return mapped;
  }

  // (d) Plain-object branch.
  if (isPlainObject(value)) {
    if (!hooks.boundCheck && seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    // Image-shape rewrite happens once per object during sanitize stage.
    let subject: Record<string, unknown> = value;
    if (hooks.sanitizeNode) {
      const imageRewritten = maybeRewriteImageObject(value);
      if (imageRewritten !== undefined) subject = imageRewritten;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(subject)) {
      const child = subject[key];

      // sanitizeNode decision (object-only per-key).
      let action: SanitizeAction = { kind: "passthrough" };
      if (hooks.sanitizeNode) {
        const objectCtx: ObjectNodeContext = {
          value: subject,
          depth,
          parentKey: key,
          seen,
        };
        action = hooks.sanitizeNode(objectCtx, key);
      }

      if (action.kind === "drop") {
        continue;
      }

      if (action.kind === "replace") {
        let resolved = action.with;
        // Still apply redactNode to the sanitize-stage replacement so
        // config-4 (all three hooks) preserves the pre-fusion semantic:
        // redactSecrets walks the sanitize-stage output.
        if (hooks.redactNode) {
          const replaceCtx: NodeContext = {
            value: resolved,
            depth: depth + 1,
            parentKey: key,
            seen,
          };
          const masked = hooks.redactNode(replaceCtx, key);
          if (masked !== undefined) resolved = masked;
        }
        out[key] = resolved;
        continue;
      }

      // passthrough → check redactNode mask BEFORE descent. For
      // credential-keyed slots, redactNode returns the masked value and
      // we skip descent entirely (matches pre-fusion walker 3 semantics:
      // credential-keyed strings get edge-keeping mask, NOT the in-text
      // regex pass).
      if (hooks.redactNode) {
        const childCtx: NodeContext = {
          value: child,
          depth: depth + 1,
          parentKey: key,
          seen,
        };
        const masked = hooks.redactNode(childCtx, key);
        if (masked !== undefined) {
          out[key] = masked;
          continue;
        }
      }

      out[key] = walk(child, depth + 1, seen, hooks, overrides, key);
    }

    seen.delete(value);
    return out;
  }

  // (e) Other primitives (number, boolean, null, undefined, symbol, bigint) —
  // passthrough.
  return value;
}
