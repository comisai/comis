/**
 * Server-side user-variable extraction, substitution, and template escaping
 * for execution graph pipelines.
 * These are the server-side equivalents of the web package's
 * `extract-variables.ts`. They are kept separate because the web package
 * operates on `PipelineNode` shapes with `.id` and accepts `string[]` input,
 * whereas this module works on `GraphNode` shapes with `.nodeId` and accepts
 * `{ task: string }[]` from the validated execution graph.
 * Three exported functions:
 * - `extractUserVariables` — find all `${VAR}` names across node tasks
 * - `substituteUserVariables` — replace `${VAR}` patterns with values
 * - `escapeTemplatePatterns` — prevent `{{...}}` injection in substituted values
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `${VAR_NAME}` user-variable patterns (not `{{...}}` templates). */
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan all node tasks for `${VAR_NAME}` patterns and return unique variable
 * names sorted alphabetically.
 * Node-to-node interpolation patterns (`{{nodeId.result}}`) are NOT matched.
 * @param nodes - Array of objects with a `task` string property
 * @returns Sorted, deduplicated array of user-supplied variable names
 */
export function extractUserVariables(nodes: Array<{ task: string }>): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    VAR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VAR_PATTERN.exec(node.task)) !== null) {
      seen.add(match[1]!);
    }
  }
  return [...seen].sort();
}

/**
 * Replace each `${VAR_NAME}` in the text with the corresponding value from
 * the provided map. Unmatched patterns are left as-is.
 * Each value is passed through `escapeTemplatePatterns()` before substitution
 * to prevent template injection — a user could otherwise supply
 * `{{secret.result}}` as a variable value and leak node data when
 * `interpolateTaskText()` runs afterwards.
 * @param text - The text containing `${VAR_NAME}` placeholders
 * @param variables - Map of variable name to replacement value
 * @returns Text with matched variables substituted (and template patterns escaped)
 */
export function substituteUserVariables(
  text: string,
  variables: Record<string, string>,
): string {
  return text.replace(VAR_PATTERN, (full, name: string) => {
    return name in variables ? escapeTemplatePatterns(variables[name]!) : full;
  });
}

/**
 * Escape `{{` sequences in a value to prevent `interpolateTaskText()` from
 * matching `{{nodeId.result}}` patterns inside user-substituted content.
 * Replaces `{{` with `{\u200B{` (left brace + zero-width space + left brace).
 * This is invisible in rendered output but breaks the `{{...}}` regex pattern.
 * @param value - Raw user-provided variable value
 * @returns Value with `{{` escaped to `{\u200B{`
 */
export function escapeTemplatePatterns(value: string): string {
  return value.replace(/\{\{/g, "{\u200B{");
}
