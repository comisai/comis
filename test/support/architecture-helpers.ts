// SPDX-License-Identifier: Apache-2.0
/**
 * Verbose-failure rendering helper for architecture tests.
 *
 * Every architecture rule's `expect(...).toEqual([])` carries a custom
 * message produced by `formatViolations()`. The output includes
 * `file:line[:column]`, optional snippet context, suggested fix, and a
 * design-doc citation -- making the architecture suite's failure
 * messages self-documenting.
 *
 * Pattern analog: `log-validator.ts:formatReport` (multi-line breakdown
 * keyed off the violation list).
 *
 * @module
 */

/**
 * One offending location. `column` is optional because some helpers
 * (e.g. graph-level edge checks) report at file:line granularity only.
 * `snippet` is optional because some rules don't capture surrounding
 * context.
 */
export interface ViolationCitation {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly snippet?: string;
}

/**
 * Inputs for `formatViolations()`. `description` states the broken
 * invariant in one sentence. `suggestedFix` is operator-actionable.
 * `designRef` cites the design-doc anchor for the invariant.
 * `allowlistRef` is omitted when no allowlist exception is applicable.
 */
export interface ArchitectureFailureContext {
  readonly description: string;
  readonly violations: readonly ViolationCitation[];
  readonly suggestedFix: string;
  readonly designRef: string;
  readonly allowlistRef?: string;
}

/**
 * Render a verbose architecture-failure message.
 *
 * Empty violations: `${description}\nNo violations found.`
 *
 * Non-empty violations: multi-line block with description, violation
 * count, per-violation `file:line[:column]` + indented snippet lines,
 * suggested fix, optional allowlist reference, and design citation.
 */
export function formatViolations(ctx: ArchitectureFailureContext): string {
  if (ctx.violations.length === 0) {
    return `${ctx.description}\nNo violations found.`;
  }
  const lines: string[] = [];
  lines.push(ctx.description);
  lines.push(`Found ${ctx.violations.length} violation(s):`);
  for (const v of ctx.violations) {
    const loc =
      v.column !== undefined
        ? `${v.file}:${v.line}:${v.column}`
        : v.line > 0
          ? `${v.file}:${v.line}`
          : v.file;
    lines.push(`  - ${loc}`);
    if (v.snippet) {
      for (const sl of v.snippet.split("\n")) {
        lines.push(`    ${sl}`);
      }
    }
  }
  lines.push("");
  lines.push("Suggested fix:");
  lines.push(`  ${ctx.suggestedFix}`);
  lines.push("");
  if (ctx.allowlistRef) {
    lines.push(`Allowlist reference: ${ctx.allowlistRef}`);
    lines.push("");
  }
  lines.push(`See: ${ctx.designRef}`);
  return lines.join("\n");
}
