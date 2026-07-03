// SPDX-License-Identifier: Apache-2.0
/**
 * Reactive 2-keyword tool-schema strip — the repair payload for
 * `tool_schema_unsupported` rejections.
 *
 * REACTIVE-ONLY: the proactive gbnf normalize profile (clean-for-gbnf.ts)
 * deliberately does NOT strip `pattern`/`format` — llama.cpp largely
 * supports them. This module is the once-per-session remedy applied AFTER a
 * provider has already rejected the toolset at grammar-compile/unmarshal
 * time (`tool_schema_unsupported` classification): schemas are only ever
 * degraded in reaction to a real rejection, never up front.
 * Deliberately a 2-keyword subset of clean-for-xai's
 * XAI_REJECTED; defined here to keep this module self-contained.
 *
 * IN-PLACE MUTATION RATIONALE (proven by the real-SDK decider in
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
 *     registry but ORPHAN the wrapped tools the wire reads — a silent
 *     no-propagation failure.
 * `applyReactiveSchemaStripInPlace` accordingly write-backs CONTENT into the
 * same parameters object (identity preserved — test-pinned).
 *
 * SECURITY: strictly REMOVAL — the strip never adds or
 * tightens constraints. The stripped schema becomes the validation schema
 * for the retry turn, i.e. strictly FEWER constraints than the
 * operator-registered schema. Accepted: tool handlers already treat
 * arguments as untrusted input (existing posture), and no policy gate reads
 * `pattern`/`format`.
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
 * Stack-depth cap for the recursive strip walk.
 * Third-party MCP schemas are attacker-controlled: a chain deep enough to
 * overflow the un-capped walk still parses cleanly through JSON.parse at the
 * transport boundary — and this walk runs on the REPAIR path the schema
 * rejection itself triggered. Nodes deeper than the cap pass through
 * UN-WALKED (fail-safe: surviving keywords at worst reproduce the 400 the
 * once-gate then terminates honestly; never a crash). Deliberately a
 * module-local twin of clean-for-gbnf's MAX_GBNF_WALK_DEPTH to keep this
 * module self-contained (same rationale as REACTIVE_STRIP_KEYWORDS above).
 */
const MAX_STRIP_WALK_DEPTH = 64;

/**
 * Pure deep strip: returns a NEW schema with the given keywords removed at
 * every nesting depth REACHABLE THROUGH the recursion key set:
 * schema maps (`properties`/`$defs`/`definitions`/`patternProperties` —
 * map keys are names, values are schemas), `items`/`prefixItems` (single or
 * tuple array), `allOf`/`anyOf`/`oneOf`, and `additionalProperties`-as-schema.
 * `$defs`/`definitions` matter because llama.cpp RESOLVES `$ref` at
 * grammar-compile — a `pattern` surviving inside a definition guarantees the
 * one-shot retry re-sends the rejected keyword. Returns the deduplicated
 * keyword names that were removed (ordered by the keyword set's declaration
 * order).
 *
 * Map KEYS (property names, definition names, patternProperties key regexes)
 * are never treated as keywords — a property literally named "pattern"
 * survives, and a patternProperties key regex is preserved verbatim.
 * Non-object inputs pass through unchanged; subtrees beyond the depth
 * cap pass through un-walked (`depthLimited: true`).
 */
export function stripSchemaKeywordsDeep(
  schema: unknown,
  keywords: ReadonlySet<string>,
): { schema: unknown; stripped: string[]; depthLimited: boolean } {
  const found = new Set<string>();
  const limited = { hit: false };
  const rebuilt = walkAndStrip(schema, keywords, found, 0, limited);
  return {
    schema: rebuilt,
    stripped: [...keywords].filter((k) => found.has(k)),
    depthLimited: limited.hit,
  };
}

/** Recursive worker for {@link stripSchemaKeywordsDeep}. Pure — new objects
 *  out. Depth-capped: an object node at the cap is returned
 *  UN-WALKED and `limited.hit` is set — pass-through, never a throw. */
function walkAndStrip(
  schema: unknown,
  keywords: ReadonlySet<string>,
  found: Set<string>,
  depth: number,
  limited: { hit: boolean },
): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  // Cap BEFORE stripping at this node so the entire subtree passes
  // through byte-identical (a half-stripped cut node would be confusing).
  if (depth >= MAX_STRIP_WALK_DEPTH) {
    limited.hit = true;
    return schema;
  }

  const node = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    // Drop strip keywords at this node.
    if (keywords.has(key)) {
      found.add(key);
      continue;
    }

    // Recurse into schema MAPS: properties / $defs / definitions /
    // patternProperties. Each VALUE is a schema; map KEYS (property
    // names, definition names, key regexes) are NOT keyword-checked — a
    // patternProperties key regex is preserved verbatim.
    if (
      (key === "properties" ||
        key === "$defs" ||
        key === "definitions" ||
        key === "patternProperties") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = walkAndStrip(propSchema, keywords, found, depth + 1, limited);
      }
      cleaned[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or tuple array of schemas) and
    // prefixItems (the draft-2020 tuple form).
    if (key === "items" || key === "prefixItems") {
      cleaned[key] = Array.isArray(value)
        ? value.map((item) => walkAndStrip(item, keywords, found, depth + 1, limited))
        : walkAndStrip(value, keywords, found, depth + 1, limited);
      continue;
    }

    // Recurse into allOf/anyOf/oneOf (array of schemas).
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => walkAndStrip(entry, keywords, found, depth + 1, limited));
      continue;
    }

    // Recurse into additionalProperties when it is a schema object (the
    // free-form-object family carries pattern/format here in the wild).
    if (key === "additionalProperties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = walkAndStrip(value, keywords, found, depth + 1, limited);
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
 * the real-SDK decider test). Returns the names of tools whose schemas changed
 * plus the union of stripped keywords.
 *
 * Tools without an object `parameters` value are skipped (nothing to strip,
 * never a throw).
 */
export function applyReactiveSchemaStripInPlace(
  tools: Array<{ name: string; parameters?: unknown }>,
): { strippedToolNames: string[]; strippedKeywords: string[]; depthLimited: boolean } {
  const strippedToolNames: string[] = [];
  const keywordUnion = new Set<string>();
  let depthLimited = false;

  for (const tool of tools) {
    const params = tool.parameters;
    if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
      continue;
    }

    const { schema, stripped, depthLimited: toolDepthLimited } = stripSchemaKeywordsDeep(
      params,
      REACTIVE_STRIP_KEYWORDS,
    );
    if (toolDepthLimited) depthLimited = true;
    if (stripped.length === 0) continue;

    // CONTENT-level write-back into the SAME parameters object (identity
    // preserved). Removal-only at every depth means the only top-level
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
    depthLimited,
  };
}
