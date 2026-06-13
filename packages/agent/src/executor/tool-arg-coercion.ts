// SPDX-License-Identifier: Apache-2.0
/**
 * Per-field stringified-JSON tool-argument coercion (F-3, live 2026-06-12).
 *
 * Small models routinely emit a well-formed arguments object whose ONE
 * array/object field is a *stringified* JSON value, e.g.
 *   memory_manage {action:"delete", ids:"[\"uuid\"]"}
 * The pi-ai SDK validator coerces stringified PRIMITIVES (string→number/boolean)
 * but NOT stringified arrays/objects (`coercePrimitiveByType` has no array/object
 * case), so the call is rejected ("ids: must be array") — and a weak model then
 * fabricates a result for the op that never ran. We coerce such fields back to
 * their structured value via the SDK's per-tool `prepareArguments` hook, which
 * pi-agent-core invokes IMMEDIATELY BEFORE `validateToolArguments`
 * (agent-loop.js prepareToolCall) — the correct interception point.
 *
 * SCHEMA-AWARE + conservative: a field is coerced only when its declared type is
 * array/object and is NOT also satisfiable as a string (a union including
 * "string" is left alone, so a legitimately JSON-array-shaped string value — e.g.
 * file content "[1,2,3]" — is never corrupted). The SDK's schema validation
 * remains the final authority on every coerced value.
 *
 * @module
 */

/**
 * Normalize a JSON-schema property's declared `type` into a Set of type strings.
 * Handles the scalar form (`"array"`), the nullable form (`["array","null"]`), and
 * absent/unknown (empty set). anyOf/oneOf unions are treated as unknown (empty
 * set ⇒ no coercion) — ambiguous, must not be coerced.
 */
export function declaredJsonTypes(prop: unknown): Set<string> {
  const t = (prop as { type?: unknown } | undefined)?.type;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === "string"));
  return new Set();
}

/**
 * Coerce stringified array/object fields of `args` to their parsed value, guided
 * by the tool's parameter schema. Pure: returns a NEW object only when something
 * was coerced (identity otherwise), so the SDK's `preparedArguments === arguments`
 * fast-path is preserved when there is nothing to do.
 */
export function coerceStringifiedStructuredFields(
  args: Record<string, unknown>,
  paramsSchema: { properties?: Record<string, unknown> } | undefined,
): { args: Record<string, unknown>; coercedKeys: string[] } {
  const properties = paramsSchema?.properties;
  if (!properties) return { args, coercedKeys: [] };
  const coercedKeys: string[] = [];
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const types = declaredJsonTypes(properties[key]);
    if (types.size === 0 || types.has("string")) continue; // unknown or string-satisfiable → leave
    const wantsArray = types.has("array");
    const wantsObject = types.has("object");
    if (!wantsArray && !wantsObject) continue;
    const trimmed = value.trim();
    const looksArray = trimmed.startsWith("[");
    const looksObject = trimmed.startsWith("{");
    if (!(wantsArray && looksArray) && !(wantsObject && looksObject)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue; // not valid JSON → let schema validation reject it (model self-corrects)
    }
    const matches =
      (wantsArray && Array.isArray(parsed)) ||
      (wantsObject && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
    if (!matches) continue;
    out ??= { ...args };
    out[key] = parsed;
    coercedKeys.push(key);
  }
  return { args: out ?? args, coercedKeys };
}
