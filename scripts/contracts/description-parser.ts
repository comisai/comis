// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function parser: determines which required H2 section headings are
 * absent from a PR or issue body string.
 *
 * Used by .github/scripts/check-pr-description.mjs (inline copy) and tested
 * here via the scripts/contracts vitest project.
 *
 * NOTE: The function below is ALSO inlined verbatim in
 * `.github/scripts/check-pr-description.mjs`. The sparse-checkout boundary
 * (only `.github/scripts` is checked out from base_ref) prevents importing
 * from `scripts/contracts/` at CI runtime. Keep the two copies in sync.
 *
 * @module
 */

/**
 * Returns the subset of `requiredSections` whose H2 headings (`## Section Name`)
 * are absent from `body`. Matching is case-insensitive.
 *
 * @param body - PR or issue body markdown text
 * @param requiredSections - section heading texts to require
 * @returns names of sections absent from the body
 */
export function findMissingSections(
  body: string,
  requiredSections: string[]
): string[] {
  if (!body || body.trim().length === 0) return [...requiredSections];
  return requiredSections.filter((section) => {
    const pattern = new RegExp(`^##\\s+${escapeRegExp(section)}`, "im");
    return !pattern.test(body);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
