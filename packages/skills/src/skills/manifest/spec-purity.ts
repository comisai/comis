// SPDX-License-Identifier: Apache-2.0
/**
 * The community-spec allowed-set rule for SKILL.md top-level frontmatter.
 *
 * The authored on-disk frontmatter carries EXACTLY these six top-level fields;
 * every platform extension rides under one `metadata.comis` JSON-string key
 * (and `version` under `metadata.version`). This module is the single source
 * of that rule so the manifest lift, the corpus gate, and future callers all
 * import ONE definition instead of duplicating the field list.
 *
 * @module
 */

/**
 * The exact six top-level fields a spec-pure SKILL.md frontmatter may carry,
 * alphabetically ordered. Frozen so every consumer shares one immutable rule.
 */
export const SPEC_PURE_TOP_LEVEL_FIELDS: readonly string[] = Object.freeze([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

const SPEC_PURE_FIELD_SET = new Set<string>(SPEC_PURE_TOP_LEVEL_FIELDS);

/**
 * True iff every own-enumerable key of `raw` is one of the six spec top-level
 * fields. A pre-migration manifest (top-level `type`/`version`/`comis`/etc.)
 * returns false and is routed through the read-compatibility path by the lift.
 *
 * Iterates own-enumerable keys only (never inherited members), so a prototype
 * carrier cannot smuggle an allowed key.
 *
 * @param raw - The parsed YAML frontmatter object.
 * @returns Whether `raw` uses only the spec-pure top-level carrier.
 */
export function isSpecPureFrontmatter(raw: Record<string, unknown>): boolean {
  for (const key of Object.keys(raw)) {
    if (!SPEC_PURE_FIELD_SET.has(key)) return false;
  }
  return true;
}
