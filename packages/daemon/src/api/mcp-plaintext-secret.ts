// SPDX-License-Identifier: Apache-2.0
/**
 * Plaintext-secret detection heuristic for the pre-Zod guard on
 * `mcp.connect` and `mcp.test`.
 *
 * Extracted from `mcp-handlers.ts` to keep that leaf under the 800-line
 * per-file cap. The delimiter-char predicate excludes URL-/path-/sentence-shaped
 * values from the entropy backstop. Exported so the architecture-tier
 * `mcp-plaintext-secret-false-positives.test.ts` negative + positive control
 * table can re-use the helper via the `@comis/daemon` barrel.
 *
 * @module
 */

/**
 * Real-world credential prefixes that almost-certainly indicate a raw
 * secret pasted into MCP env. Includes Notion v2 (`ntn_`), Notion legacy
 * (`secret_`), GitLab PAT (`glpat-`), Stripe live/test (`sk_live_`,
 * `sk_test_`), and GitHub fine-grained PAT (`github_pat_`).
 *
 * Order matters for the early-return scan: list longer / more-specific
 * prefixes BEFORE their shorter generalizations (e.g. `sk-ant-` before
 * `sk-`, `github_pat_` before `ghp_` only because ghp_ is a distinct
 * shape — both are checked) so the first match short-circuits cleanly.
 */
const PLAINTEXT_SECRET_PREFIXES: readonly string[] = [
  "ghp_",         // GitHub personal access token
  "github_pat_",  // GitHub fine-grained PAT
  "sk-ant-",      // Anthropic API key (check BEFORE sk- to avoid double-match)
  "sk-",          // OpenAI API key
  "xoxb-",        // Slack bot token
  "xoxp-",        // Slack user token
  "AKIA",         // AWS access key ID
  "secret_",      // Notion internal v1 (legacy, ~162 chars typical)
  "ntn_",         // Notion v2 (>= Sept 2024)
  "glpat-",       // GitLab personal access token
  "sk_live_",     // Stripe live secret key
  "sk_test_",     // Stripe test secret key
];

/**
 * Shannon entropy in bits-per-character. Used as the heuristic backstop
 * for generic high-entropy credentials not matching the curated prefix
 * list. Pure function; no allocations beyond the per-call char map.
 */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const ch of value) {
    counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const len = value.length;
  let entropy = 0;
  for (const ch of Object.keys(counts)) {
    const p = counts[ch]! / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Length floor for the entropy backstop. Tuned to avoid the 40-char
 * OpenAI org-ID false positive. Real tokens are all ≥ 41 chars; setting
 * the floor at 44 retains full real-token rejection while clearing the
 * org-ID FP.
 */
const PLAINTEXT_SECRET_LENGTH_FLOOR = 44;

/** Entropy floor (bits per char) for the heuristic backstop. */
const PLAINTEXT_SECRET_ENTROPY_FLOOR = 3.5;

/**
 * Reject the entropy-backstop on ALL values containing URL- / path- /
 * sentence-delimiter characters. Real credential bodies are URL-safe
 * base64 / base32 / hex / alphanumeric + `_ - . +`. None of the curated-prefix
 * tokens (ghp_, sk-, AKIA, etc.) contain any of these. Connection strings
 * (`postgres://`, `mongodb+srv://`), filesystem paths (`/usr/...`), URLs
 * (`https://...`), comma-separated region lists (`us-east-1,us-east-2,...`),
 * and sentence-like config values (`"this is a 50 character ..."`) all
 * contain at least one of these chars and are reliably non-secret
 * operator-config shapes.
 *
 * Predicate: contains ANY of whitespace, `:`, `/`, `?`, `&`, `=`, `@`,
 * `,`. If any of these are present the backstop short-circuits to
 * "not a secret" without consulting entropy. The curated prefix list
 * still matches its real-token positive cases first.
 */
const NON_CREDENTIAL_DELIMITER_RE = /[\s:/?&=@,]/;

/**
 * Detect whether a string looks like a real-world plaintext secret.
 * Returns true for:
 *   - Any value with a known credential prefix (ghp_, sk-, AKIA, etc.).
 *   - OR (Shannon entropy > 3.5 AND length >= 44 AND no
 *     URL-/path-/sentence-delimiter chars) — backstop for generic
 *     high-entropy keys not matching the curated prefix list. The
 *     delimiter-char predicate excludes URLs, connection strings,
 *     filesystem paths, comma-separated lists, and sentence-shaped
 *     operator-config values, all of which had FPs under the entropy-only
 *     backstop.
 *
 * NON-secrets that PASS (verified by the architecture-tier
 * mcp-plaintext-secret-false-positives.test.ts negative-control table):
 *   - Notion DB UUIDs (36 chars, entropy ~3.99, no prefix)
 *   - Linear team UUIDs (36 chars)
 *   - Stripe customer IDs `cus_*` (15-25 chars; `cus_` is NOT in the
 *     prefix list — `sk_` is, but `cus_` is an ID not a key)
 *   - OpenAI org IDs (28 chars; entropy ~4.5; length < 44)
 *   - Filesystem PATH values (44+ chars; contains `:` `/`)
 *   - URLs, connection strings, webhook endpoints (contain `://`)
 *   - Comma-separated region lists (contain `,`)
 *   - Sentence-shaped config values (contain whitespace)
 *   - Unresolved env-ref placeholders `${KEY}` (handled separately by
 *     findUnresolvedEnvRefs at the same handler boundary)
 *
 * Exported so the architecture-tier
 * `test/architecture/mcp-plaintext-secret-false-positives.test.ts`
 * negative + positive control table can re-use the helper via the
 * `@comis/daemon` barrel without duplicating the heuristic.
 */
export function looksLikePlaintextSecret(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  // Skip unresolved env-ref placeholders — handled separately by
  // findUnresolvedEnvRefs at the same RPC handler boundary.
  if (value.startsWith("${") && value.endsWith("}")) return false;
  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  // Entropy backstop only applies to credential-shaped values
  // (no URL/path/sentence delimiter chars). This eliminates the
  // false-positive class around connection strings, file paths, URLs,
  // comma-lists, and sentence-shaped operator config values.
  if (NON_CREDENTIAL_DELIMITER_RE.test(value)) return false;
  return (
    value.length >= PLAINTEXT_SECRET_LENGTH_FLOOR &&
    shannonEntropy(value) > PLAINTEXT_SECRET_ENTROPY_FLOOR
  );
}
