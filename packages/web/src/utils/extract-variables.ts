/**
 * Utility functions for extracting and substituting `${VAR_NAME}` template
 * variables from pipeline task texts.
 *
 * These target user-defined placeholders like `${TICKER}`, `${BRAND}`, etc.
 * Node-to-node interpolation patterns (`{{varName.result}}`) are intentionally
 * ignored -- those are handled server-side by template-interpolation.ts.
 */

/** Regex matching `${VAR_NAME}` user-variable patterns (not `{{...}}`). */
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Scan task text strings for `${VAR_NAME}` patterns and return
 * unique variable names sorted alphabetically.
 *
 * Node-to-node interpolation patterns (`{{nodeId.result}}`) are handled
 * server-side and are not matched by this function.
 *
 * @param tasks - Array of task text strings to scan
 * @returns Sorted, deduplicated array of user-supplied variable names
 */
export function extractVariables(tasks: string[]): string[] {
  const seen = new Set<string>();
  for (const text of tasks) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for each string (regex has /g flag)
    VAR_PATTERN.lastIndex = 0;
    while ((match = VAR_PATTERN.exec(text)) !== null) {
      seen.add(match[1]);
    }
  }
  return [...seen].sort();
}

/**
 * Replace each `${VAR_NAME}` in the text with the corresponding value
 * from the provided map. Unmatched patterns are left as-is.
 *
 * @param text - The text containing `${VAR_NAME}` placeholders
 * @param values - Map of variable name to replacement value
 * @returns Text with matched variables substituted
 */
export function substituteVariables(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(VAR_PATTERN, (full, name: string) => {
    return name in values ? values[name] : full;
  });
}
