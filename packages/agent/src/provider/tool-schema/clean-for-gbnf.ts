// SPDX-License-Identifier: Apache-2.0
/**
 * GBNF-safe structural schema transforms for llama.cpp-family local providers
 * (Ollama / llama-server / LM Studio / vLLM). Four conservative per-node
 * rewrites, applied recursively with the same filter-and-recurse walk shape as
 * the sibling cleaners (clean-for-xai.ts / clean-for-gemini.ts):
 *
 * - T1 nullable anyOf/oneOf collapse + T2 ["T","null"] type-array collapse —
 *   protect against Ollama's Go-side tool-schema strictness ("json: cannot
 *   unmarshal ... into Go struct field .tools.function.parameters...",
 *   ollama#10164; oneOf rejected on Ollama cloud, ollama#13967) and older
 *   local stacks. llama.cpp's own converter handles these forms.
 * - T4 missing-type injection — fixes llama.cpp's grammar-converter top-killer
 *   ("Unrecognized schema" on typeless nodes such as bare description-only
 *   leaves — llama.cpp#19716/#17574).
 * - T3 free-form-object properties injection — template-rendering / Go-side
 *   robustness for `{"type":"object"}` nodes with no shape at all.
 *
 * I6 invariant (security posture untouched) — the real guarantee
 * (175-REVIEW WR-04): no transform ever WIDENS the set of values the schema
 * admits. Transformed schemas accept a SUBSET of the original's values
 * (T1/T2 drop the null branch; T4 injects an inferred `type` that narrows a
 * previously-unconstrained node) or the IDENTICAL set (T3 —
 * `{"type":"object","properties":{}}` WITHOUT `additionalProperties:false`
 * still admits any properties). Narrowing can never authorize new tool
 * inputs, so the security direction is safe; the cost is functional
 * narrowing on pathological inputs, which beats the alternative — a hard
 * grammar-compile 400 that fails the whole toolset. Non-null unions and
 * 3+-entry type arrays are deliberately left untouched — collapsing them
 * would pick one branch arbitrarily.
 *
 * Idempotent by construction: each transform's trigger condition is destroyed
 * by its own rewrite (collapsed unions have no 2-element nullable union left,
 * injected types/properties satisfy the presence checks), and the
 * " (nullable)" description hint is append-guarded — running the cleaner
 * twice produces byte-identical output to running it once.
 *
 * `pattern` and `format` are deliberately NOT stripped here: llama.cpp largely
 * supports them, and stripping them is GBNF-02's REACTIVE remedy (classify a
 * grammar-400, strip, retry once) — never part of this proactive profile.
 *
 * DoS posture (T-175-01): the walk recurses only into schema-bearing keys
 * (`properties`/`items`/`allOf`/`anyOf`/`oneOf`/`additionalProperties`); no
 * `$ref` resolution or expansion (refs pass through untouched), so a
 * maliciously deep third-party MCP schema costs O(nodes), never exponential.
 * STACK DEPTH is bounded too (175-REVIEW WR-03): recursion stops at
 * {@link MAX_GBNF_WALK_DEPTH} — subtrees beyond the cap pass through
 * un-walked (every transform is skip-tolerant, so pass-through is always
 * safe) and `depthLimited` reports the cut so the caller can WARN. Without
 * the cap, a ~4000-level properties chain that JSON.parse accepts at the
 * MCP transport boundary overflowed the call stack and the RangeError
 * failed the WHOLE turn for ALL tools.
 *
 * @module
 */

/** Transform-token vocabulary (content-free identifiers, never schema bodies). */
export type GbnfTransformKeyword =
  | "nullable_union"
  | "type_array"
  | "free_form_object"
  | "missing_type";

/** Stable reporting order for `transformedKeywords` (filtered to those applied). */
const KEYWORD_ORDER: readonly GbnfTransformKeyword[] = [
  "nullable_union",
  "type_array",
  "free_form_object",
  "missing_type",
];

const NULLABLE_HINT = " (nullable)";

/**
 * Stack-depth cap for the recursive walk (175-REVIEW WR-03). Third-party MCP
 * schemas are attacker-controlled: a chain deep enough to overflow the
 * un-capped walk still parses cleanly through JSON.parse at the transport
 * boundary. Nodes deeper than the cap pass through UN-WALKED — fail-safe by
 * design (an un-transformed subtree at worst reproduces the provider 400 the
 * reactive path already handles; it never crashes tool assembly). 64 levels
 * is far beyond any legitimate tool schema.
 */
export const MAX_GBNF_WALK_DEPTH = 64;

/**
 * Keys whose presence means a node already carries type information — T4 must
 * not inject a `type` next to any of them ("Unrecognized schema" only fires on
 * nodes with NONE of these).
 */
const TYPE_BEARING_KEYS = [
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "not",
] as const;

/**
 * Guarded nullable description hint: append-once semantics keep the transform
 * idempotent even when a schema is re-fed through the pipeline (snapshots /
 * caches re-normalize).
 */
const withHint = (desc: string | undefined): string =>
  desc === undefined
    ? "(nullable)"
    : desc.endsWith(NULLABLE_HINT) || desc === "(nullable)"
      ? desc
      : desc + NULLABLE_HINT;

/** Narrow a description value to string-or-undefined (non-strings are pathological). */
function asStringDesc(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** True only for a branch deep-equal to `{ type: "null" }` (exactly one key). */
function isNullBranch(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 1 &&
    (value as Record<string, unknown>).type === "null"
  );
}

/**
 * T1: collapse a nullable `anyOf`/`oneOf` (EXACTLY 2 branches, one deep-equal
 * to `{ type: "null" }`) into the non-null branch merged with the node's
 * sibling keys. The original node's description wins over the branch's; the
 * guarded " (nullable)" hint is applied.
 *
 * Returns the SAME node reference when no collapse applies (the walker uses
 * reference identity for its fixed-point loop).
 */
function collapseNullableUnionOnce(
  node: Record<string, unknown>,
  applied: Set<GbnfTransformKeyword>,
): Record<string, unknown> {
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const branches = node[unionKey];
    if (!Array.isArray(branches) || branches.length !== 2) continue;
    const nullIdx = branches.findIndex(isNullBranch);
    if (nullIdx === -1) continue;
    const nonNull = branches[1 - nullIdx];
    if (nonNull === null || typeof nonNull !== "object" || Array.isArray(nonNull)) continue;

    const nonNullBranch = nonNull as Record<string, unknown>;
    const siblings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== unionKey) siblings[key] = value;
    }
    const merged: Record<string, unknown> = { ...nonNullBranch, ...siblings };
    merged.description = withHint(
      asStringDesc(node.description) ?? asStringDesc(nonNullBranch.description),
    );
    applied.add("nullable_union");
    return merged;
  }
  return node;
}

/**
 * T2: collapse a `type` array of EXACTLY 2 entries where one is `"null"` to
 * the scalar non-null type, with the guarded nullable hint. Non-null
 * multi-types and 3+-entry arrays are left untouched (removal/relaxation only).
 */
function collapseTypeArray(
  node: Record<string, unknown>,
  applied: Set<GbnfTransformKeyword>,
): Record<string, unknown> {
  const type = node.type;
  if (!Array.isArray(type) || type.length !== 2) return node;
  const nullIdx = type.indexOf("null");
  if (nullIdx === -1) return node;
  const other = type[1 - nullIdx];
  if (typeof other !== "string" || other === "null") return node;

  const out: Record<string, unknown> = { ...node, type: other };
  out.description = withHint(asStringDesc(node.description));
  applied.add("type_array");
  return out;
}

/** WR-04: typeless nodes carrying any of these keys infer `type: "number"`. */
const NUMERIC_CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/** WR-04: typeless nodes carrying any of these keys infer `type: "array"`. */
const ARRAY_CONSTRAINT_KEYS = ["minItems", "maxItems", "uniqueItems", "contains"] as const;

/** True when the node carries at least one of the given keys. */
function hasAnyKey(node: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => key in node);
}

/**
 * T4: inject an inferred `type` on a node carrying NONE of the type-bearing
 * keys (the llama.cpp "Unrecognized schema" class). Inference reads the
 * constraint family (175-REVIEW WR-04 — a constraint-only `{minimum: 0}`
 * must become "number", not the string default that would force the model
 * to emit a string where the tool expects a number):
 * properties/required/additionalProperties → "object";
 * items/minItems/maxItems/uniqueItems/contains → "array";
 * minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf → "number";
 * otherwise "string" (the bare description-only leaf, and the
 * minLength/maxLength/pattern/format string-constraint family).
 */
function injectMissingType(
  node: Record<string, unknown>,
  applied: Set<GbnfTransformKeyword>,
): Record<string, unknown> {
  for (const key of TYPE_BEARING_KEYS) {
    if (key in node) return node;
  }
  const inferred =
    "properties" in node || "required" in node || "additionalProperties" in node
      ? "object"
      : "items" in node || hasAnyKey(node, ARRAY_CONSTRAINT_KEYS)
        ? "array"
        : hasAnyKey(node, NUMERIC_CONSTRAINT_KEYS)
          ? "number"
          : "string";
  applied.add("missing_type");
  return { ...node, type: inferred };
}

/**
 * T3: give a free-form object (`type: "object"`, no `properties`, no
 * `additionalProperties`) an explicit empty `properties: {}`. Non-tightening
 * (I6): without `additionalProperties: false` the node still admits anything.
 */
function injectEmptyProperties(
  node: Record<string, unknown>,
  applied: Set<GbnfTransformKeyword>,
): Record<string, unknown> {
  if (node.type !== "object") return node;
  if ("properties" in node || "additionalProperties" in node) return node;
  applied.add("free_form_object");
  return { ...node, properties: {} };
}

/**
 * Recursive walker: per-node transforms in order T1 → T2 → T4 → T3, then
 * recursion into the rewritten node's children. T1 runs to a fixed point so
 * degenerate nodes (both `anyOf` AND `oneOf` nullable forms, or a nullable
 * union whose non-null branch is itself a nullable union) collapse fully in a
 * single pass — keeping twice-equals-once true by construction. Each collapse
 * strictly shrinks the subtree, so the loop terminates in O(nodes).
 *
 * Depth-capped (WR-03): an object node at `depth >= MAX_GBNF_WALK_DEPTH` is
 * returned UN-WALKED and `limited.hit` is set — pass-through, never a throw.
 *
 * Always builds NEW objects; never mutates the input.
 */
function walk(
  schema: unknown,
  applied: Set<GbnfTransformKeyword>,
  depth: number,
  limited: { hit: boolean },
): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  // WR-03: cap BEFORE any per-node transform so the entire subtree passes
  // through byte-identical (a half-transformed cut node would be confusing).
  if (depth >= MAX_GBNF_WALK_DEPTH) {
    limited.hit = true;
    return schema;
  }

  let node = schema as Record<string, unknown>;

  // T1 (fixed point) → T2 → T4 → T3
  let collapsed = collapseNullableUnionOnce(node, applied);
  while (collapsed !== node) {
    node = collapsed;
    collapsed = collapseNullableUnionOnce(node, applied);
  }
  node = collapseTypeArray(node, applied);
  node = injectMissingType(node, applied);
  node = injectEmptyProperties(node, applied);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Recurse into properties (each value is a schema)
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = walk(propSchema, applied, depth + 1, limited);
      }
      out[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or array of schemas)
    if (key === "items") {
      out[key] = Array.isArray(value)
        ? value.map((item) => walk(item, applied, depth + 1, limited))
        : walk(value, applied, depth + 1, limited);
      continue;
    }

    // Recurse into allOf/anyOf/oneOf (array of schemas)
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.map((entry) => walk(entry, applied, depth + 1, limited));
      continue;
    }

    // Recurse into additionalProperties when it is an object schema — the
    // free-form transform needs this branch (deviation from the sibling
    // cleaners' walk, documented in the phase pattern map).
    if (
      key === "additionalProperties" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = walk(value, applied, depth + 1, limited);
      continue;
    }

    // Pass through all other keys unchanged (pattern/format included).
    out[key] = value;
  }

  return out;
}

/**
 * Apply the four GBNF structural transforms to a JSON Schema.
 *
 * Pure. Returns NEW objects. Idempotent:
 * `cleanSchemaForGbnf(cleanSchemaForGbnf(x).schema).schema` deep-equals
 * `cleanSchemaForGbnf(x).schema`, and a second run reports zero transforms.
 *
 * `transformedKeywords` is the content-free report of which transform classes
 * fired anywhere in the tree (deduplicated, stable order) — safe for logging
 * under I7 (keyword names only, never schema bodies).
 *
 * `depthLimited` is true when any subtree exceeded {@link MAX_GBNF_WALK_DEPTH}
 * and passed through un-walked (WR-03 fail-safe) — callers WARN on it.
 */
export function cleanSchemaForGbnf(schema: unknown): {
  schema: unknown;
  transformedKeywords: GbnfTransformKeyword[];
  depthLimited: boolean;
} {
  const applied = new Set<GbnfTransformKeyword>();
  const limited = { hit: false };
  const out = walk(schema, applied, 0, limited);
  return {
    schema: out,
    transformedKeywords: KEYWORD_ORDER.filter((keyword) => applied.has(keyword)),
    depthLimited: limited.hit,
  };
}
