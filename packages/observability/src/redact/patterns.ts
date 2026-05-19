// SPDX-License-Identifier: Apache-2.0
/**
 * Default redact-pattern set.
 *
 * 28 default token-shape patterns + 4 Comis-specific additions cover the
 * common credential surfaces seen in Comis logs:
 *
 *   - Prefix tokens (sk-, ghp_, xox[abprs]-, xapp-, gsk_, AIza, ya29.,
 *     1//0, JWT eyJ.., pplx-, npm_, AKID, LTAI, hf_, r8_, Telegram
 *     `<digits>:<base64>`, Apple xxxx-xxxx-xxxx-xxxx with benign-
 *     word allowlist)
 *   - Structural patterns (ENV-style `NAME=value`, URL `?api_key=…`,
 *     `Authorization:` header, `Cookie:` header, JSON `"apiKey":"…"`,
 *     CLI `--api-key=…`, bare `Bearer …`, PEM block)
 *   - Comis additions (`comis_*` prefix, Slack webhook URL,
 *     Discord bot-token 3-segment, generic HMAC signature)
 *
 * **Pure data**: each pattern is a `RegExp` with the `/g` flag set so
 * `replacePatternBounded(text, p.regex, …)` works correctly. Patterns
 * are compiled directly via `new RegExp(...)` — no `safe-regex` helper
 * is involved; ReDoS protection comes from the chunked replace in
 * `replacePatternBounded`.
 *
 * **Case-sensitivity:** the ENV-style pattern uses `[A-Z][A-Z0-9_]+` with
 * NO `/i` flag so lowercase strings like `Unrecognized key: "llm"`
 * (a diagnostic message, not a credential) pass through unchanged.
 *
 * **MIN_LENGTH ≥ 18:** every bare-token / prefix pattern requires at
 * least 16-18 chars of body (matches the edge-keeping mask's threshold)
 * so short labels (`sk-`, `ghp_`, `comis_`) and benign mentions of the
 * token prefix do not get falsely matched.
 *
 * @module
 */

/** Kind tag used by callers to route the matched substring to a mask. */
export type RedactPatternKind =
  | "prefix"
  | "bare"
  | "env"
  | "url-query"
  | "header"
  | "json"
  | "cli"
  | "pem"
  | "platform";

/** Default-pattern descriptor. */
export interface RedactPattern {
  /** Stable identifier (used by tests and operator-side allowlists). */
  readonly name: string;
  /** Match regex; carries the `/g` flag. */
  readonly regex: RegExp;
  /** Match kind — informs caller how to mask the captured substring. */
  readonly kind: RedactPatternKind;
}

/** ---- Prefix-shape token patterns (provider-specific) ---- */

const PREFIX_PATTERNS: RedactPattern[] = [
  {
    name: "sk-prefix",
    // sk- + 16+ token-body chars. Common for OpenAI/Anthropic-style keys.
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    kind: "prefix",
  },
  {
    name: "github-token",
    // GitHub Personal Access Token: ghp_ + 20+ alphanumerics.
    regex: /\bghp_[A-Za-z0-9_]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "slack-legacy-token",
    // Slack xox{a,b,p,r,s}- legacy tokens; require 18+ body chars
    // (dashes allowed) so the literal "xoxb-" string does not match.
    regex: /\bxox[abprs]-[A-Za-z0-9_-]{18,}\b/g,
    kind: "prefix",
  },
  {
    name: "slack-app-token",
    regex: /\bxapp-[A-Za-z0-9_-]{18,}\b/g,
    kind: "prefix",
  },
  {
    name: "groq-key",
    regex: /\bgsk_[A-Za-z0-9_]{18,}\b/g,
    kind: "prefix",
  },
  {
    name: "google-api-key",
    // AIzaSy + 33 chars is the canonical shape; allow >=20 body for
    // tolerance against shape drift.
    regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "google-oauth-bearer",
    regex: /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "google-refresh-token",
    regex: /\b1\/\/0[A-Za-z0-9_-]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "jwt-token",
    // 3-segment dotted base64-url, each segment ≥ 8 chars; first segment
    // anchored to the typical JWT header prefix "eyJ".
    regex: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    kind: "prefix",
  },
  {
    name: "perplexity-key",
    regex: /\bpplx-[A-Za-z0-9_-]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "npm-token",
    regex: /\bnpm_[A-Za-z0-9_]{20,}\b/g,
    kind: "prefix",
  },
  {
    name: "aws-access-key-id",
    // AWS access-key-id is 20 chars total: 4-char prefix (AKID or AKIA)
    // + 16 alphanumerics. We anchor on AKID-prefix shape.
    regex: /\bAKID[A-Z0-9]{14,}\b/g,
    kind: "prefix",
  },
  {
    name: "alibaba-key",
    regex: /\bLTAI[A-Za-z0-9]{16,}\b/g,
    kind: "prefix",
  },
  {
    name: "huggingface-token",
    regex: /\bhf_[A-Za-z0-9_]{18,}\b/g,
    kind: "prefix",
  },
  {
    name: "replicate-token",
    regex: /\br8_[A-Za-z0-9_]{18,}\b/g,
    kind: "prefix",
  },
  {
    name: "telegram-bot-token",
    // <numeric id>:<35+ alphanumeric+underscore+dash>. Anchored on the
    // 8+ digit prefix to avoid catching arbitrary "12:foo" forms.
    regex: /\b\d{8,}:[A-Za-z0-9_-]{35,}\b/g,
    kind: "prefix",
  },
  {
    name: "apple-app-password",
    // xxxx-xxxx-xxxx-xxxx — 16 lowercase letters in 4-char groups joined
    // by hyphens. Benign-word allowlist excludes obvious English words
    // that happen to fit the shape (`sign-in-and-go-now`).
    regex: /(?!sign-in-and-go-now\b)\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/g,
    kind: "prefix",
  },
];

/** ---- Structural patterns (context-shape rather than provider-shape) ---- */

const STRUCTURAL_PATTERNS: RedactPattern[] = [
  {
    name: "env-uppercase-credential",
    // UPPERCASE_IDENTIFIER=value where the identifier name CONTAINS a
    // credential keyword. The `[A-Z][A-Z0-9_]+` head is case-sensitive
    // (NO /i flag) so lowercase diagnostic strings pass through.
    regex: /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*=\S+/g,
    kind: "env",
  },
  {
    name: "url-query-credential",
    // Query-string assignment for typical credential-name keys.
    regex: /[?&](?:api_key|apikey|access_token|token|secret|password|auth|key)=[^&\s]+/gi,
    kind: "url-query",
  },
  {
    name: "authorization-header",
    // Authorization: Bearer/Basic/Digest/Token <value-with-18+-chars>.
    regex: /Authorization:\s*(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._/+=:-]{18,}/gi,
    kind: "header",
  },
  {
    name: "cookie-header",
    // Cookie: <name>=<value> (everything up to space or end-of-line).
    regex: /(?:Set-)?Cookie:\s*\S{4,}/gi,
    kind: "header",
  },
  {
    name: "json-field-credential",
    // JSON key/value where the key is a credential name and the value
    // is a non-empty quoted string of >=4 chars.
    regex: /"(?:api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token|bot[_-]?token|private[_-]?key)"\s*:\s*"[^"]{4,}"/gi,
    kind: "json",
  },
  {
    name: "cli-flag-credential",
    // --flag=value or -flag=value where flag matches a credential keyword.
    regex: /--?(?:api[_-]?key|token|secret|password|key|auth|access[_-]?token)=\S+/gi,
    kind: "cli",
  },
  {
    name: "bare-bearer-token",
    // "Bearer <18+-char-token>" — case-sensitive on Bearer to avoid
    // catching English-prose mentions like "the bearer of the news".
    regex: /\bBearer\s+[A-Za-z0-9._/+=:-]{18,}\b/g,
    kind: "bare",
  },
  {
    name: "pem-block",
    // -----BEGIN <LABEL>-----...-----END <LABEL>-----, label is a
    // capitalized word possibly with spaces (PRIVATE KEY, RSA PRIVATE
    // KEY, CERTIFICATE, etc.). Multiline.
    regex: /-----BEGIN [A-Z][A-Z 0-9]+-----[\s\S]+?-----END [A-Z][A-Z 0-9]+-----/g,
    kind: "pem",
  },
];

/** ---- Comis-specific additions ---- */

const COMIS_PATTERNS: RedactPattern[] = [
  {
    name: "comis-prefix-token",
    // comis_ + 16+ token-body chars. This is the canonical shape for
    // Comis-issued credentials.
    regex: /\bcomis_[A-Za-z0-9_-]{16,}\b/g,
    kind: "platform",
  },
  {
    name: "slack-webhook-url",
    // https://hooks.slack.com/services/T.../B.../<token>
    regex: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{18,}\b/g,
    kind: "platform",
  },
  {
    name: "discord-bot-token",
    // <base64 user-id>.<base64 timestamp>.<base64 HMAC>; three dotted
    // segments, total length ≥ 50 chars to avoid catching short dotted
    // text like "ab.cd.ef".
    regex: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g,
    kind: "platform",
  },
  {
    name: "hmac-signature",
    // X-Signature / X-Hub-Signature with sha1|sha256= prefix + 40+ hex.
    regex: /\bX-(?:Hub-)?Signature(?:-256)?:\s*sha(?:1|256|512)=[A-Fa-f0-9]{40,}\b/g,
    kind: "header",
  },
];

const DEFAULT_PATTERNS: ReadonlyArray<RedactPattern> = Object.freeze([
  ...PREFIX_PATTERNS,
  ...STRUCTURAL_PATTERNS,
  ...COMIS_PATTERNS,
]);

/**
 * Returns the canonical default-pattern set (frozen, ordered).
 *
 * Callers typically iterate the array and apply each pattern via
 * `replacePatternBounded(text, p.regex, mask)`. The array is frozen so
 * callers cannot mutate the canonical set — pass a *copy* if you need
 * to extend it for a specific call site.
 */
export function getDefaultRedactPatterns(): ReadonlyArray<RedactPattern> {
  return DEFAULT_PATTERNS;
}
