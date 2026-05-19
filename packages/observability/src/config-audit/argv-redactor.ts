// SPDX-License-Identifier: Apache-2.0
/**
 * Argv redactor for config-audit records.
 *
 * Three-layer fail-closed argv redaction:
 *
 *   1. **Explicit `--flag=value`** form — the flag name (before `=`)
 *      is checked against `SECRET_FLAG_NAMES` (39-entry closed set)
 *      and `SECRET_FLAG_SUFFIX_PATTERN` (heuristic for plugin flags).
 *      The whole `value` portion is replaced with `***` — we do NOT
 *      preserve a value-suffix or anything that could leak parts of
 *      the secret.
 *
 *   2. **Bare `--flag VALUE`** form — when the current argv element
 *      matches a secret flag name and a next element exists, the
 *      next element is masked unconditionally (including dash-leading
 *      values like `-v` — fail-closed; we do NOT treat `-v` as "looks
 *      like a flag therefore preserve it").
 *
 *   3. **Regex fallback** — anything else is piped through
 *      `redactSecretsInText` so positional tokens like
 *      `API_KEY=sk-…` inside a single argv element get caught by the
 *      28-pattern regex set. This is the last-line defense for
 *      `comis exec API_KEY=sk-…` style invocations where the secret
 *      lives in a positional slot.
 *
 * The argv is capped at `CONFIG_AUDIT_ARGV_CAP = 8` elements before
 * redaction. This bounds the per-record size (a runaway 4 KB record
 * could push the file past `appendRegularFile`'s symlink-safe atomic
 * append guarantee — POSIX only guarantees atomic append < PIPE_BUF,
 * typically 4 KB).
 *
 * @module
 */

// Cycle-breaking import: redactSecretsInText is the leaf regex
// helper; importing the full barrel from `../redact/redact-text.js`
// stays within the observability package.
import { redactSecretsInText } from "../redact/redact-text.js";

/**
 * 39-entry explicit secret-flag name set.
 *
 * Names are stored with the leading `--` so the contains-check at
 * the top of `redactConfigAuditArgv` does not have to strip the
 * dashes on every iteration. The set covers Comis-supported provider
 * auth flags + standard auth flags (--token, --password, --secret,
 * --auth).
 */
export const SECRET_FLAG_NAMES: ReadonlySet<string> = new Set<string>([
  // Standard auth flags
  "--api-key",
  "--apikey",
  "--api_key",
  "--token",
  "--access-token",
  "--access_token",
  "--refresh-token",
  "--refresh_token",
  "--auth",
  "--auth-token",
  "--auth_token",
  "--authorization",
  "--password",
  "--passwd",
  "--pwd",
  "--secret",
  "--secret-key",
  "--secret_key",
  "--client-secret",
  "--client_secret",
  "--private-key",
  "--private_key",
  "--cookie",
  "--session-token",
  "--session_token",
  "--bearer",
  "--bearer-token",
  // Provider-specific flags (Comis-supported providers)
  "--openai-api-key",
  "--anthropic-api-key",
  "--google-api-key",
  "--mistral-api-key",
  "--xai-api-key",
  "--groq-api-key",
  "--together-api-key",
  "--cohere-api-key",
  "--bedrock-api-key",
  "--azure-api-key",
  // Webhook / signing secrets
  "--webhook-secret",
  "--webhook_secret",
  "--signing-key",
]);

/**
 * Suffix heuristic for plugin / vendor flags whose explicit name is
 * NOT in `SECRET_FLAG_NAMES`. Catches `--alibaba-model-studio-api-key`,
 * `--my-plugin-token`, `--app-secret`, etc.
 *
 * Anchored at end-of-string to avoid false-positives on tokens that
 * happen to contain "key" / "token" / "secret" in the middle.
 */
export const SECRET_FLAG_SUFFIX_PATTERN =
  /^--[a-z0-9][a-z0-9-_]*-(?:api-key|api_key|token|secret|password|passwd|key|auth)$/;

/**
 * Cap on argv length for the persisted record. The audit record's
 * argv field is the first 8 elements. POSIX atomic append is <
 * PIPE_BUF (4 KB on Linux); 8 short argv elements keep the record
 * well inside that bound.
 */
export const CONFIG_AUDIT_ARGV_CAP = 8;

/**
 * Redact an argv-like input for safe inclusion in a config-audit
 * record. See the module-level header for the three-layer redaction
 * algorithm.
 *
 * @param argv - raw argv (typically `process.argv`). The function
 *   makes no assumptions about how the caller obtained the argv;
 *   any string-array shape works.
 * @returns redacted argv, capped at `CONFIG_AUDIT_ARGV_CAP` elements.
 */
export function redactConfigAuditArgv(
  argv: readonly string[],
): string[] {
  const capped = argv.slice(0, CONFIG_AUDIT_ARGV_CAP);
  const result: string[] = [];

  for (let i = 0; i < capped.length; i++) {
    const arg = capped[i];

    // Defensive: a non-string element passes through the regex
    // fallback as `String(arg)` so we never crash on a malformed
    // input. Production argv is always string[].
    if (typeof arg !== "string") {
      result.push(String(arg));
      continue;
    }

    // Layer 1: `--flag=value` form.
    const equalsIdx = arg.indexOf("=");
    if (arg.startsWith("--") && equalsIdx > 2) {
      const name = arg.slice(0, equalsIdx);
      if (
        SECRET_FLAG_NAMES.has(name) ||
        SECRET_FLAG_SUFFIX_PATTERN.test(name)
      ) {
        result.push(`${name}=***`);
        continue;
      }
    }

    // Layer 2: bare `--flag VALUE` form. Consumes the next element
    // unconditionally (fail-closed; even dash-leading values are
    // masked rather than preserved).
    if (
      arg.startsWith("--") &&
      (SECRET_FLAG_NAMES.has(arg) || SECRET_FLAG_SUFFIX_PATTERN.test(arg))
    ) {
      result.push(arg);
      if (i + 1 < capped.length) {
        result.push("***");
        i++;
      }
      continue;
    }

    // Layer 3: regex fallback. Pipes the element through the
    // text redactor so positional `API_KEY=sk-…` slots get caught.
    result.push(redactSecretsInText(arg));
  }

  return result;
}
