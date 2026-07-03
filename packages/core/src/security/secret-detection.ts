// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-detection keystone — the single authoritative secret firewall.
 *
 * One shared implementation, deliberately NOT split per call-site: fragmented
 * per-surface detectors diverge, and each divergence is a leak class — a value
 * heuristic where a space defeats the delimiter gate misses `Bearer <token>`
 * (that exact miss once leaked a live provider token), and a field-name
 * pattern alone misses `authorization`/`cookie`/header field names. Both
 * classes are covered here.
 *
 * The keystone ships path-independent primitives only — consumers (the
 * write/persist path, last-good snapshot, mcp.connect firewall) are wired
 * separately.
 *
 * `looksLikeSecretValue` strips surrounding quotes + a leading auth scheme
 * (Bearer/Basic/Token/Digest, case-insensitive) BEFORE the curated-prefix
 * scan / delimiter gate / entropy backstop, so a quoted or schemed credential
 * cannot slip past the gates. The entropy backstop is length>=44 &&
 * entropy>3.5, pinned by a full false-positive negative-control test set.
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

// ── Value heuristic (quote/scheme-stripped prefix scan + entropy backstop) ──

/**
 * Real-world credential prefixes that almost-certainly indicate a raw secret.
 * Order matters for the early-return scan: list longer / more-specific
 * prefixes BEFORE their shorter generalizations (e.g. `sk-ant-` before `sk-`).
 *
 * Used ONLY as keys for `PREFIX_MIN_BODY_LENGTHS` below — do not iterate this
 * array directly for detection; `looksLikeSecretValue` uses the gated map.
 */
export const PLAINTEXT_SECRET_PREFIXES: readonly string[] = [
  "ghp_", // GitHub personal access token
  "github_pat_", // GitHub fine-grained PAT
  "sk-ant-", // Anthropic API key (check BEFORE sk-)
  "sk-", // OpenAI API key
  "xoxb-", // Slack bot token
  "xoxp-", // Slack user token
  "xapp-", // Slack app-level token (gap vs patterns.ts slack-app-token)
  "AKIA", // AWS access key ID (canonical prefix)
  "secret_", // Notion internal v1 (legacy)
  "ntn_", // Notion v2 (>= Sept 2024)
  "glpat-", // GitLab personal access token
  "sk_live_", // Stripe live secret key
  "sk_test_", // Stripe test secret key
  // Prefixes required for parity with @comis/observability patterns.ts:
  "hf_", // HuggingFace access token (Higgsfield + HuggingFace Hub)
  "hfr_", // HuggingFace OAuth refresh token
  "r8_", // Replicate token (gap vs patterns.ts:143)
  "gsk_", // Groq API key (gap vs patterns.ts groq-key)
  "npm_", // npm automation/publish token (gap vs patterns.ts npm-token)
  "AKID", // AWS access-key-ID alternative prefix (gap vs patterns.ts aws-access-key-id)
  "LTAI", // Alibaba Cloud access key ID (gap vs patterns.ts alibaba-key)
  "AIza", // Google API key — AIzaSy + 33 chars canonical shape (gap vs patterns.ts google-api-key)
  "ya29.", // Google OAuth bearer token (gap vs patterns.ts google-oauth-bearer)
  "pplx-", // Perplexity API key (gap vs patterns.ts perplexity-key)
  "comis_", // Comis platform token (gap vs patterns.ts comis-prefix-token)
];

/**
 * Minimum number of body characters AFTER the prefix required before flagging.
 * Mirrors the `{N,}` quantifiers in `@comis/observability`'s `patterns.ts` so
 * the keystone's false-positive rate matches the observability scanner.
 *
 * Prefixes NOT in this map have `minBody = 0` (no length gate — they are
 * high-specificity enough that even a short occurrence is meaningful, e.g.
 * `ghp_`, `github_pat_`, `sk-ant-`, `glpat-`, `sk_live_`, `sk_test_`,
 * `xoxb-`, `xoxp-`, `secret_`, `ntn_`, `AKIA`).
 *
 * Short/ambiguous prefixes (hf_, r8_, gsk_, npm_, AKID, LTAI, …) without a
 * length gate would trigger on any value that starts with the prefix, falsely
 * flagging npm_config_cache, AKIDNEYBEAN, hf_model_config, etc. The gate
 * values below are derived from patterns.ts: each is the {N,} minimum from
 * the corresponding pattern's regex body.
 */
export const PREFIX_MIN_BODY_LENGTHS: ReadonlyMap<string, number> = new Map([
  // patterns.ts minimum body lengths (after the prefix):
  ["sk-", 16], // sk-[A-Za-z0-9_-]{16,}
  ["xapp-", 18], // xapp-[A-Za-z0-9_-]{18,}
  ["gsk_", 18], // gsk_[A-Za-z0-9_]{18,}
  ["AIza", 20], // AIza[A-Za-z0-9_-]{20,}
  ["ya29.", 20], // ya29.[A-Za-z0-9_-]{20,}
  ["pplx-", 20], // pplx-[A-Za-z0-9_-]{20,}
  ["npm_", 20], // npm_[A-Za-z0-9_]{20,}
  ["AKID", 14], // AKID[A-Z0-9]{14,}  (total 18 chars)
  ["LTAI", 16], // LTAI[A-Za-z0-9]{16,}
  ["hf_", 18], // hf_[A-Za-z0-9_]{18,}
  ["hfr_", 18], // hfr_ — same class as hf_, mirror the minimum
  ["r8_", 18], // r8_[A-Za-z0-9_]{18,}
  ["comis_", 16], // comis_[A-Za-z0-9_-]{16,}
]);

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
 * Pre-steps applied before any gate (so a quoted/schemed credential still flags):
 *   1. strip surrounding quotes
 *   2. strip a leading case-insensitive auth scheme (Bearer/Basic/Token/Digest)
 *   3. skip unresolved env-ref placeholders on the remainder
 * then run the gated-prefix scan, then the entropy backstop:
 *   - curated-prefix scan with per-prefix minimum body length:
 *     short-ambiguous prefixes (hf_, gsk_, npm_, AKID, LTAI, …) require a
 *     minimum body length matching patterns.ts to avoid false-positives on
 *     config keys like npm_config_cache or words like AKIDNEYBEAN.
 *   - delimiter-char short-circuit to false
 *   - entropy backstop (length >= 44 AND entropy > 3.5)
 */
export function looksLikeSecretValue(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;

  const unquoted = stripSurroundingQuotes(value);
  const remainder = unquoted.replace(AUTH_SCHEME_RE, "");

  // Skip unresolved env-ref placeholders on the remainder (handled by the
  // ref-exemption path in scanForSecrets; mirrored here for direct callers).
  if (remainder.startsWith("${") && remainder.endsWith("}")) return false;

  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (remainder.startsWith(prefix)) {
      // Apply minimum body-length gate for ambiguous/short prefixes.
      // High-specificity prefixes (ghp_, glpat-, sk-ant-, etc.) have no entry
      // in PREFIX_MIN_BODY_LENGTHS so minBody is 0 — they match unconditionally.
      const minBody = PREFIX_MIN_BODY_LENGTHS.get(prefix) ?? 0;
      const bodyLength = remainder.length - prefix.length;
      if (bodyLength >= minBody) return true;
    }
  }

  // Entropy backstop only applies to credential-shaped values (no URL/path/
  // sentence delimiter chars).
  if (NON_CREDENTIAL_DELIMITER_RE.test(remainder)) return false;
  return (
    remainder.length >= PLAINTEXT_SECRET_LENGTH_FLOOR &&
    shannonEntropy(remainder) > PLAINTEXT_SECRET_ENTROPY_FLOOR
  );
}

// ── Field-name superset (pattern + exact header-name set) ──

/**
 * Pattern matching field names that contain secrets.
 */
const SECRET_FIELD_PATTERN =
  /^(.*token|.*secret|.*password|.*apiKey|.*api_key|.*credential|.*private_key|botToken|appSecret|hmacSecret|webhookSecret)$/i;

/**
 * Exact (lowercased) field names that imply a secret but are NOT matched by
 * `SECRET_FIELD_PATTERN` — header-style names the pattern alone misses.
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
 * True if a FIELD NAME implies a secret:
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
 *
 * Exported so that `credential-classify.ts` can share the single authoritative
 * implementation instead of maintaining a divergent trim-only copy.
 */
export function isEnvRefString(value: string): boolean {
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
      // Preserve fieldName so a secret-named array (e.g. headers.Authorization: [...])
      // still triggers the secret-field rule on each element.
      walkScan(value[i], `${path}[${i}]`, fieldName, findings);
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

// ── Redaction for display ───────────────────────────────────────────

/**
 * Deep-clone an object and replace every string field whose NAME is a secret
 * field name with `[REDACTED]`, using the superset `isSecretFieldName`.
 * The input is never mutated.
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
    if (isSecretFieldName(key)) {
      // Redact every nested string regardless of depth (string, array-of-strings,
      // or nested objects) so arrays like Authorization: ["Bearer x", "Bearer y"]
      // are fully redacted.
      record[key] = redactSubtreeStrings(record[key]);
    } else {
      walkRedact(record[key]);
    }
  }
}

/**
 * Recursively replace every string value in `value` with `[REDACTED]`.
 * Used when the parent field name is a secret-bearing name, so ALL nested
 * string content must be redacted regardless of structure.
 */
function redactSubtreeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    // eslint-disable-next-line no-restricted-syntax -- secret-detection sentinel for serialized config output (not the Pino censor literal)
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map(redactSubtreeStrings);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSubtreeStrings(v);
    }
    return out;
  }
  return value;
}
