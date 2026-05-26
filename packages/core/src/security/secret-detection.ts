// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-detection keystone — the single authoritative secret firewall.
 *
 * Replaces two fragmented predecessors:
 *   - `daemon/api/mcp-plaintext-secret.ts` (`looksLikePlaintextSecret`) —
 *     applied only to `mcp.connect`/`mcp.test` env, and `looksLikePlaintextSecret`
 *     returned `false` for `Bearer <token>` (the space tripped the delimiter
 *     gate; the bug that leaked the Higgsfield token).
 *   - `core/security/config-redaction.ts` (`redactConfigSecrets` /
 *     `SECRET_FIELD_PATTERN`) — applied only to `config.read` and the pattern
 *     missed `authorization`/`cookie`/header field names.
 *
 * The keystone ships path-independent primitives only — consumers (the
 * write/persist path, last-good snapshot, mcp.connect firewall) are wired in
 * Phase 3 (CRED).
 *
 * Hardening of `looksLikeSecretValue` over `looksLikePlaintextSecret`: strip
 * surrounding quotes + a leading auth scheme (Bearer/Basic/Token/Digest,
 * case-insensitive) BEFORE the curated-prefix scan / delimiter gate / entropy
 * backstop. The curated prefix list, length>=44 && entropy>3.5 backstop, and
 * the full false-positive negative-control set are preserved.
 *
 * @module
 */

import { isSecretRef } from "../domain/secret-ref.js";
import {
  ENV_VAR_PATTERN,
  ESCAPED_VAR_PATTERN,
  BARE_VAR_PATTERN,
} from "../config/env-substitution.js";

// ── Finding type ────────────────────────────────────────────────────

/** A single secret-detection finding from `scanForSecrets`. */
export interface SecretFinding {
  /** dot/bracket path, e.g. "integrations.mcp.servers[0].headers.Authorization" */
  readonly path: string;
  /** Why it was flagged: secret-bearing field name, or secret-looking value. */
  readonly reason: "secret-field" | "secret-value";
}

// ── Value heuristic (relocated + hardened from mcp-plaintext-secret.ts) ──

/**
 * Real-world credential prefixes that almost-certainly indicate a raw secret.
 * Order matters for the early-return scan: list longer / more-specific
 * prefixes BEFORE their shorter generalizations (e.g. `sk-ant-` before `sk-`).
 */
const PLAINTEXT_SECRET_PREFIXES: readonly string[] = [
  "ghp_", // GitHub personal access token
  "github_pat_", // GitHub fine-grained PAT
  "sk-ant-", // Anthropic API key (check BEFORE sk-)
  "sk-", // OpenAI API key
  "xoxb-", // Slack bot token
  "xoxp-", // Slack user token
  "AKIA", // AWS access key ID
  "secret_", // Notion internal v1 (legacy)
  "ntn_", // Notion v2 (>= Sept 2024)
  "glpat-", // GitLab personal access token
  "sk_live_", // Stripe live secret key
  "sk_test_", // Stripe test secret key
];

/** Shannon entropy in bits-per-character. Pure function. */
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
 * Length floor for the entropy backstop. Real tokens are all >= 41 chars;
 * a floor of 44 retains full real-token rejection while clearing the 40-char
 * OpenAI org-ID false positive.
 */
const PLAINTEXT_SECRET_LENGTH_FLOOR = 44;

/** Entropy floor (bits per char) for the heuristic backstop. */
const PLAINTEXT_SECRET_ENTROPY_FLOOR = 3.5;

/**
 * Reject the entropy backstop on values containing URL-/path-/sentence-
 * delimiter characters. Real credential bodies are URL-safe base64 / base32 /
 * hex / alphanumeric + `_ - . +`. Connection strings, paths, URLs, comma-lists,
 * and sentence-shaped config all contain at least one of these chars.
 */
const NON_CREDENTIAL_DELIMITER_RE = /[\s:/?&=@,]/;

/** Leading auth-scheme prefix (case-insensitive), stripped before the gate. */
const AUTH_SCHEME_RE = /^(?:Bearer|Basic|Token|Digest)\s+/i;

/**
 * Strip a single pair of matching surrounding quotes (`"…"` or `'…'`).
 * The value is trimmed first so `  "x"  ` unwraps cleanly.
 */
function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * True if a value looks like a raw credential.
 *
 * Hardened pre-step (vs the old `looksLikePlaintextSecret`):
 *   1. strip surrounding quotes
 *   2. strip a leading case-insensitive auth scheme (Bearer/Basic/Token/Digest)
 *   3. skip unresolved env-ref placeholders on the remainder
 * then run the unchanged legacy logic on the remainder:
 *   - curated-prefix scan (early-return true)
 *   - delimiter-char short-circuit to false
 *   - entropy backstop (length >= 44 AND entropy > 3.5)
 *
 * So `Bearer hf_<44+>` → `hf_<44+>` → entropy path catches it.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;

  const unquoted = stripSurroundingQuotes(value);
  const remainder = unquoted.replace(AUTH_SCHEME_RE, "");

  // Skip unresolved env-ref placeholders on the remainder (handled by the
  // ref-exemption path in scanForSecrets; mirrored here for direct callers).
  if (remainder.startsWith("${") && remainder.endsWith("}")) return false;

  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (remainder.startsWith(prefix)) return true;
  }

  // Entropy backstop only applies to credential-shaped values (no URL/path/
  // sentence delimiter chars).
  if (NON_CREDENTIAL_DELIMITER_RE.test(remainder)) return false;
  return (
    remainder.length >= PLAINTEXT_SECRET_LENGTH_FLOOR &&
    shannonEntropy(remainder) > PLAINTEXT_SECRET_ENTROPY_FLOOR
  );
}

// ── Field-name superset (relocated from config-redaction.ts + extended) ──

/**
 * Pattern matching field names that contain secrets. Relocated verbatim from
 * the deleted `config-redaction.ts` `SECRET_FIELD_PATTERN`.
 */
const SECRET_FIELD_PATTERN =
  /^(.*token|.*secret|.*password|.*apiKey|.*api_key|.*credential|.*private_key|botToken|appSecret|hmacSecret|webhookSecret)$/i;

/**
 * Exact (lowercased) field names that imply a secret but are NOT matched by
 * `SECRET_FIELD_PATTERN` — the header superset closing the config-redaction gap.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "api-key",
]);

/**
 * True if a FIELD NAME implies a secret. Superset of the old
 * `SECRET_FIELD_PATTERN` ∪ the header set above, case-insensitive.
 */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_PATTERN.test(name) || SECRET_FIELD_NAMES.has(name.toLowerCase());
}

// ── Env-ref exemption (reuses the EXPORTED env-substitution patterns) ──

// Build non-global, whole-string testers from the canonical patterns' `.source`
// so we never re-author the env-ref regexes AND never inherit the stateful
// `lastIndex` of the global-flagged ENV_VAR_PATTERN / ESCAPED_VAR_PATTERN.
const WHOLE_ENV_VAR_RE = new RegExp(`^${ENV_VAR_PATTERN.source}$`);
const WHOLE_ESCAPED_VAR_RE = new RegExp(`^${ESCAPED_VAR_PATTERN.source}$`);
// BARE_VAR_PATTERN is already anchored and non-global — reuse directly.

/**
 * True if the string is a single env-ref token: `${VAR}` / `$${VAR}` / `$VAR`,
 * optionally wrapped in surrounding quotes and/or a leading auth scheme
 * (`Bearer ${TOK}` is an env-ref credential, not a plaintext secret). Reuses
 * the canonical env-substitution patterns — no re-authored ref regexes.
 */
function isEnvRefString(value: string): boolean {
  const remainder = stripSurroundingQuotes(value).replace(AUTH_SCHEME_RE, "");
  return (
    WHOLE_ESCAPED_VAR_RE.test(remainder) ||
    WHOLE_ENV_VAR_RE.test(remainder) ||
    BARE_VAR_PATTERN.test(remainder)
  );
}

// ── Deep scan ───────────────────────────────────────────────────────

/**
 * Deep-walk an object tree and report findings for:
 *   (a) secret-named fields holding a non-ref string, or
 *   (b) any secret-LOOKING value.
 * EXEMPTS `${VAR}`/`$VAR`/`$${VAR}` strings AND `isSecretRef` objects.
 */
export function scanForSecrets(obj: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  walkScan(obj, "", undefined, findings);
  return findings;
}

function walkScan(
  value: unknown,
  path: string,
  fieldName: string | undefined,
  findings: SecretFinding[],
): void {
  // SecretRef objects are store-backed — exempt, do not recurse.
  if (isSecretRef(value)) return;

  if (typeof value === "string") {
    if (value.length === 0) return;
    // Env-ref strings are store-backed — exempt.
    if (isEnvRefString(value)) return;
    if (fieldName !== undefined && isSecretFieldName(fieldName)) {
      findings.push({ path, reason: "secret-field" });
      return;
    }
    if (looksLikeSecretValue(value)) {
      findings.push({ path, reason: "secret-value" });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkScan(value[i], `${path}[${i}]`, undefined, findings);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      walkScan(child, childPath, key, findings);
    }
  }
}

// ── Redaction (replaces redactConfigSecrets) ────────────────────────

/**
 * Deep-clone an object and replace every string field whose NAME is a secret
 * field name with `[REDACTED]`. Replaces `redactConfigSecrets`, using the
 * superset `isSecretFieldName`. The input is never mutated.
 */
export function redactForDisplay<T>(obj: T): T {
  const cloned = structuredClone(obj);
  walkRedact(cloned);
  return cloned;
}

function walkRedact(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkRedact(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isSecretFieldName(key) && typeof record[key] === "string") {
      // eslint-disable-next-line no-restricted-syntax -- secret-detection sentinel for serialized config output (not the Pino censor literal)
      record[key] = "[REDACTED]";
    } else {
      walkRedact(record[key]);
    }
  }
}
