// SPDX-License-Identifier: Apache-2.0
/**
 * Reactive 2-keyword tool-schema strip — GBNF-02's repair payload.
 *
 * REACTIVE-ONLY: the proactive gbnf normalize profile (clean-for-gbnf.ts)
 * deliberately does NOT strip `pattern`/`format` — llama.cpp largely
 * supports them. This module is the once-per-session remedy applied AFTER a
 * provider has already rejected the toolset at grammar-compile/unmarshal
 * time (`tool_schema_unsupported` classification), mirroring the Hermes
 * precedent. Deliberately a 2-keyword subset of clean-for-xai's
 * XAI_REJECTED; defined here to keep this module self-contained.
 *
 * IN-PLACE MUTATION RATIONALE (A5, proven by the real-SDK decider in
 * tool-schema-strip.test.ts): the AgentSession holds REFERENCES to the
 * exact ToolDefinition objects passed as `customTools` (pi-executor.ts:580;
 * the post-creation `tool.execute` mutation at pi-executor.ts:1517-1526 is
 * prior evidence), and the SDK's wrapped AgentTools capture
 * `definition.parameters` BY REFERENCE at wrap time
 * (tool-definition-wrapper.js property copy). pi-ai then converts
 * `parameters: tool.parameters` VERBATIM per request at request-build time
 * (openai-completions.js:819). Therefore:
 *   - mutating the CONTENTS of the existing parameters object propagates to
 *     BOTH the SDK registry (`getToolDefinition`) and the wire;
 *   - replacing `tool.parameters` with a new object would update the
 *     registry but ORPHAN the wrapped tools the wire reads — the silent
 *     no-propagation failure RESEARCH Pitfall 6 warns about.
 * `applyReactiveSchemaStripInPlace` accordingly write-backs CONTENT into the
 * same parameters object (identity preserved — test-pinned).
 *
 * SECURITY (I6 / T-175-15): strictly REMOVAL — the strip never adds or
 * tightens constraints. The stripped schema becomes the validation schema
 * for the retry turn, i.e. strictly FEWER constraints than the
 * operator-registered schema. Accepted: tool handlers already treat
 * arguments as untrusted input (existing posture), and no policy gate reads
 * `pattern`/`format` (research-verified).
 *
 * @module
 */

/**
 * The reactive strip set — exactly the two keywords llama.cpp
 * grammar-compile chokes on in the wild (unanchored patterns, PCRE
 * shorthands, exotic formats).
 */
export const REACTIVE_STRIP_KEYWORDS: ReadonlySet<string> = new Set(["pattern", "format"]);

/**
 * Pure deep strip: returns a NEW schema with the given keywords removed at
 * every nesting depth, plus the deduplicated keyword names that were
 * removed (ordered by the keyword set's declaration order).
 *
 * Walk shape mirrors clean-for-xai.ts (filter-and-recurse over
 * `properties`/`items`/`allOf`/`anyOf`/`oneOf`) plus the
 * `additionalProperties`-as-schema branch. Property NAMES inside
 * `properties` are never treated as keywords (a property literally named
 * "pattern" survives). Non-object inputs pass through unchanged.
 */
export function stripSchemaKeywordsDeep(
  schema: unknown,
  keywords: ReadonlySet<string>,
): { schema: unknown; stripped: string[] } {
  const found = new Set<string>();
  const rebuilt = walkAndStrip(schema, keywords, found);
  return { schema: rebuilt, stripped: [...keywords].filter((k) => found.has(k)) };
}

/** Recursive worker for {@link stripSchemaKeywordsDeep}. Pure — new objects out. */
function walkAndStrip(schema: unknown, keywords: ReadonlySet<string>, found: Set<string>): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  const node = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    // Drop strip keywords at this node.
    if (keywords.has(key)) {
      found.add(key);
      continue;
    }

    // Recurse into properties (each VALUE is a schema; property NAMES are
    // not keyword-checked).
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = walkAndStrip(propSchema, keywords, found);
      }
      cleaned[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or tuple array of schemas).
    if (key === "items") {
      cleaned[key] = Array.isArray(value)
        ? value.map((item) => walkAndStrip(item, keywords, found))
        : walkAndStrip(value, keywords, found);
      continue;
    }

    // Recurse into allOf/anyOf/oneOf (array of schemas).
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => walkAndStrip(entry, keywords, found));
      continue;
    }

    // Recurse into additionalProperties when it is a schema object (the
    // free-form-object family carries pattern/format here in the wild).
    if (key === "additionalProperties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = walkAndStrip(value, keywords, found);
      continue;
    }

    // Pass through all other keys unchanged.
    cleaned[key] = value;
  }

  return cleaned;
}

/**
 * Mutates `tool.parameters` IN PLACE on the given tool objects (the session
 * holds references to these exact objects — and the SDK's wrapped
 * AgentTools hold the exact parameters object — so identity-preserving
 * content mutation is THE propagation mechanism; see the module JSDoc and
 * the A5 decider test). Returns the names of tools whose schemas changed
 * plus the union of stripped keywords.
 *
 * Tools without an object `parameters` value are skipped (nothing to strip,
 * never a throw).
 */
export function applyReactiveSchemaStripInPlace(
  tools: Array<{ name: string; parameters?: unknown }>,
): { strippedToolNames: string[]; strippedKeywords: string[] } {
  const strippedToolNames: string[] = [];
  const keywordUnion = new Set<string>();

  for (const tool of tools) {
    const params = tool.parameters;
    if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
      continue;
    }

    const { schema, stripped } = stripSchemaKeywordsDeep(params, REACTIVE_STRIP_KEYWORDS);
    if (stripped.length === 0) continue;

    // CONTENT-level write-back into the SAME parameters object (identity
    // preserved). Removal-only at every depth (I6) means the only top-level
    // keys that can disappear are the two strip keywords themselves —
    // delete them statically, then copy the rebuilt subtrees over.
    const target = params as Record<string, unknown>;
    delete target.pattern;
    delete target.format;
    Object.assign(target, schema as Record<string, unknown>);

    strippedToolNames.push(tool.name);
    for (const keyword of stripped) keywordUnion.add(keyword);
  }

  return {
    strippedToolNames,
    strippedKeywords: [...REACTIVE_STRIP_KEYWORDS].filter((k) => keywordUnion.has(k)),
  };
}
