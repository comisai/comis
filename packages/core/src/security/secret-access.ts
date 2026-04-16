/**
 * Secret access pattern matching utilities.
 *
 * Provides case-insensitive glob matching for secret name filtering.
 * Used by ScopedSecretManager to restrict per-agent
 * access to specific secrets based on glob patterns like "openai_*".
 *
 * Design decisions:
 * - Case-insensitive: env vars are UPPERCASE, config patterns are lowercase
 * - Empty allow array = unrestricted access (backward compat)
 * - Custom 15-line implementation instead of picomatch/minimatch (sufficient for * wildcards)
 */

/**
 * Check if a secret name matches a glob pattern.
 *
 * Supports `*` as a wildcard that matches any number of characters.
 * Comparison is case-insensitive (env vars are UPPERCASE, config is lowercase).
 * Regex special characters in the pattern are treated as literals.
 *
 * @param secretName - The secret name to check (e.g., "OPENAI_API_KEY")
 * @param pattern - The glob pattern to match against (e.g., "openai_*")
 * @returns true if the name matches the pattern
 */
export function matchesSecretPattern(
  secretName: string,
  pattern: string,
): boolean {
  const name = secretName.toLowerCase();
  const pat = pattern.toLowerCase();

  if (!pat.includes("*")) {
    return name === pat;
  }

  // Escape regex special chars except *, then replace * with .*
  const regex = new RegExp(
    "^" +
      pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  );
  return regex.test(name);
}

/**
 * Check if a secret is accessible given a list of allow patterns.
 *
 * If the allow list is empty, all secrets are accessible (backward compat).
 * This is critical: existing agents have no `secrets.allow` config, which
 * Zod parses as `[]`. This must mean "no restrictions", not "deny all".
 *
 * @param secretName - The secret name to check
 * @param allowPatterns - Glob patterns that grant access. Empty = unrestricted.
 * @returns true if access is allowed
 */
export function isSecretAccessible(
  secretName: string,
  allowPatterns: string[],
): boolean {
  if (allowPatterns.length === 0) {
    return true;
  }
  return allowPatterns.some((p) => matchesSecretPattern(secretName, p));
}
