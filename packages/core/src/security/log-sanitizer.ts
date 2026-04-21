// SPDX-License-Identifier: Apache-2.0
/**
 * Log sanitizer — defense-in-depth regex-based credential scrubbing.
 *
 * Even if Pino redaction misses a credential (e.g., credentials
 * embedded in free-text strings), this sanitizer catches them before
 * they hit persistent storage or external log aggregators.
 *
 * This is a SECOND line of defense. Pino's fast-redact handles structured
 * fields; this handles unstructured string content.
 */

import {
  SK_API_KEY,
  BEARER_TOKEN_LOG,
  TELEGRAM_BOT_TOKEN,
  AWS_KEY_ID_BOUNDED,
  AWS_SECRET_KEY,
  STRIPE_KEY,
  GOOGLE_API_KEY,
  SLACK_APP_TOKEN,
  SENDGRID_KEY,
  JWT_PATTERN,
  URL_PASSWORD,
  HEX_SECRET_LONG,
  GITHUB_TOKEN_FULL,
  ANTHROPIC_API_KEY,
  OPENAI_PROJECT_KEY,
  DISCORD_BOT_TOKEN,
  DB_CONNECTION_STRING,
} from "./injection-patterns.js";

/**
 * Credential patterns to detect and redact in log strings.
 *
 * Each pattern pairs an imported regex constant with its replacement string.
 * Order matters: more specific patterns should come first.
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic API keys: sk-ant-... (must come before generic sk- pattern)
  { pattern: ANTHROPIC_API_KEY, replacement: "sk-ant-[REDACTED]" },
  // OpenAI project keys: sk-proj-... (must come before generic sk- pattern)
  { pattern: OPENAI_PROJECT_KEY, replacement: "sk-proj-[REDACTED]" },
  // OpenAI / Anthropic style API keys: sk-... (at least 20 chars after prefix)
  { pattern: SK_API_KEY, replacement: "sk-[REDACTED]" },
  // Bearer tokens in text
  { pattern: BEARER_TOKEN_LOG, replacement: "Bearer [REDACTED]" },
  // Telegram bot tokens: digits:alphanumeric (e.g., 123456:ABC-DEF...)
  { pattern: TELEGRAM_BOT_TOKEN, replacement: "[REDACTED_BOT_TOKEN]" },
  // AWS access key IDs: AKIA followed by 16 uppercase alphanumeric
  { pattern: AWS_KEY_ID_BOUNDED, replacement: "AKIA[REDACTED]" },
  // AWS secret access keys: 40 chars base64-like after common prefixes
  { pattern: AWS_SECRET_KEY, replacement: "$1[REDACTED_AWS_SECRET]" },
  // Stripe secret keys: sk_live_ or sk_test_ followed by 24+ alphanumeric chars
  { pattern: STRIPE_KEY, replacement: "sk_[REDACTED]" },
  // Google API keys: AIzaSy followed by exactly 33 chars
  { pattern: GOOGLE_API_KEY, replacement: "AIza[REDACTED]" },
  // Slack app-level tokens: xapp- followed by alphanumeric and hyphens
  { pattern: SLACK_APP_TOKEN, replacement: "xapp-[REDACTED]" },
  // SendGrid API keys: SG. followed by 20+ base64url chars
  { pattern: SENDGRID_KEY, replacement: "SG.[REDACTED]" },
  // Generic JWT: three base64url-encoded segments separated by dots
  { pattern: JWT_PATTERN, replacement: "[REDACTED_JWT]" },
  // Database connection strings: postgres://, mysql://, etc. (must come before URL_PASSWORD)
  { pattern: DB_CONNECTION_STRING, replacement: "[REDACTED_CONN_STRING]" },
  // URL-embedded passwords: ://user:password@host (non-DB URLs like https://user:pass@host)
  { pattern: URL_PASSWORD, replacement: "://$1:[REDACTED]@" },
  // Discord bot tokens: M/N prefix, three dot-separated segments
  { pattern: DISCORD_BOT_TOKEN, replacement: "[REDACTED_DISCORD_TOKEN]" },
  // Generic hex secrets (40+ chars of hex, commonly git tokens, etc.)
  { pattern: HEX_SECRET_LONG, replacement: "[REDACTED_HEX]" },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ followed by 36+ chars
  { pattern: GITHUB_TOKEN_FULL, replacement: "gh[REDACTED]" },
];

/** Maximum input length for regex-based sanitization (1MB). Inputs exceeding this are returned as-is to prevent ReDoS. */
const MAX_SANITIZE_LENGTH = 1_048_576;

/**
 * Sanitize a log string by replacing detected credential patterns.
 *
 * This is defense-in-depth: use alongside Pino's structured redaction.
 * Handles credentials that appear in free-text log messages where
 * Pino's path-based redaction cannot reach.
 *
 * @param input - The raw log string to sanitize
 * @returns The sanitized string with credentials replaced
 */
export function sanitizeLogString(input: string): string {
  if (!input) {
    return input;
  }

  // Skip regex processing on oversized inputs to prevent ReDoS.
  // Inputs exceeding 1MB are returned as-is — legitimate log lines are far smaller.
  if (input.length > MAX_SANITIZE_LENGTH) {
    return input;
  }

  let result = input;
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global regexes (they're stateful)
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  return result;
}
