// SPDX-License-Identifier: Apache-2.0
/**
 * Pure validators for `comis config tooling-fill`.
 *
 * - PACKAGE_NAME_REGEX: npm scoped-pkg + pip name shape.
 *   /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i
 * - validatePackageNames: drops names that fail the regex; returns
 *   {valid, dropped}; dedupes valid (preserves first occurrence).
 * - isStubValued: a hint is "stub-valued" iff
 *   description ∈ {missing, "", "TODO"} AND replacesPackages ∈ {missing, []}.
 *
 * No I/O, no logger, no Result-wrapping at this layer (callers compose).
 *
 * @module
 */

/**
 * Single source of truth for package-name shape.
 *
 * Matches:
 *   - bare npm/pip names: yfinance, pandas-datareader, yfinance.cache, Pillow
 *   - scoped npm names:   @scope/pkg
 *
 * Rejects (load-bearing for shell-injection safety):
 *   - leading dash:   -leading-dash
 *   - whitespace:     "package with spaces"
 *   - shell metas:    "; rm -rf /", "eval()", "$(...)", "&", "|"
 *   - empty/scope:    "", "@/no-name"
 */
export const PACKAGE_NAME_REGEX =
  // eslint-disable-next-line security/detect-unsafe-regex -- no catastrophic backtracking (no nested/overlapping quantifiers; two `[a-z0-9._-]*` runs separated by literal `/`; anchored ^…$; bounded short input).
  /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i;

export interface ValidatedPackages {
  readonly valid: string[];
  readonly dropped: string[];
}

/**
 * Filter a candidate list against PACKAGE_NAME_REGEX.
 *
 * - Inputs that pass the regex are returned in `valid` (deduplicated,
 *   first-occurrence-wins, original case preserved).
 * - Inputs that fail are returned in `dropped` (in original order).
 * - Non-string inputs (defense-in-depth — agent could emit JSON with
 *   numbers/null in a malformed array) are stringified and dropped.
 */
export function validatePackageNames(
  candidates: readonly unknown[],
): ValidatedPackages {
  const seen = new Set<string>();
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string") {
      dropped.push(String(c));
      continue;
    }
    if (!PACKAGE_NAME_REGEX.test(c)) {
      dropped.push(c);
      continue;
    }
    if (seen.has(c)) {
      continue;
    }
    seen.add(c);
    valid.push(c);
  }
  return { valid, dropped };
}

/** Shape of a parsed capability hint as it comes back from the YAML AST. */
export interface HintShape {
  readonly description?: string;
  readonly replacesPackages?: readonly string[];
}

/**
 * Stub predicate.
 *
 * A hint is "stub-valued" iff:
 *   - description is missing, "", or "TODO", AND
 *   - replacesPackages is missing or [].
 *
 * Any other shape is operator-authored and refuses fill without --force.
 *
 * Both conditions must hold; an operator-edited value in either field
 * fails the predicate (so `--force` is required to overwrite).
 */
export function isStubValued(hint: HintShape): boolean {
  const desc = hint.description;
  const pkgs = hint.replacesPackages;
  const descIsStub = desc === undefined || desc === "" || desc === "TODO";
  const pkgsIsStub = pkgs === undefined || pkgs.length === 0;
  return descIsStub && pkgsIsStub;
}
