// SPDX-License-Identifier: Apache-2.0
/**
 * Credential log sanitization patterns.
 *
 * Detects API keys, tokens, and secrets in log output to prevent
 * accidental credential exposure through structured logging.
 * Originally from log-sanitizer.ts.
 *
 * @module credential-log
 */

/** OpenAI/Anthropic API key: sk-... */
export const SK_API_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;

/** Bearer token in log text */
export const BEARER_TOKEN_LOG = /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;

/** Telegram bot token: digits:alphanumeric */
export const TELEGRAM_BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;

/** AWS access key ID (word-bounded) */
export const AWS_KEY_ID_BOUNDED = /\bAKIA[A-Z0-9]{16}\b/g;

/** AWS secret access key (capturing group, no lookbehind for ReDoS safety) */
export const AWS_SECRET_KEY = /(aws_secret_access_key[\s=:]{1,10})[A-Za-z0-9/+=]{40}\b/gi;

/** Stripe secret key */
export const STRIPE_KEY = /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g;

/** Google API key */
export const GOOGLE_API_KEY = /\bAIzaSy[A-Za-z0-9_-]{33}\b/g;

/** Slack app-level token (bounded {1,200} for ReDoS safety -- was + in original) */
export const SLACK_APP_TOKEN = /\bxapp-[A-Za-z0-9-]{1,200}\b/g;

/** SendGrid API key */
export const SENDGRID_KEY = /\bSG\.[A-Za-z0-9_-]{20,}/g;

/** JWT pattern (three base64url segments) */
export const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** URL-embedded password: ://user:password@host */
export const URL_PASSWORD = /:\/\/([^:]+):([^@]{3,})@/g;

/** Generic hex secret (40+ chars) */
export const HEX_SECRET_LONG = /\b[0-9a-f]{40,}\b/gi;

/**
 * FAL API key: `<uuid-or-token>:<24+ hex>` (CR-01, Phase 192). A FAL `FAL_KEY`
 * is a uuid-shaped id joined by `:` to a long hex secret half — caught by NEITHER
 * `HEX_SECRET_LONG` (the uuid half has hyphens; the hex half is ~32 < 40 chars)
 * NOR the digit-prefixed `TELEGRAM_BOT_TOKEN`. The 24-char-hex floor on the tail
 * is what keeps ordinary `host:8080` / `key:value` prose from matching (a colon
 * alone is not enough — the high-entropy hex tail is the discriminator). The head
 * is hex + hyphens (a uuid) so a plain word before the colon does not match. */
export const FAL_KEY = /\b[0-9a-fA-F][0-9a-fA-F-]{7,}:[0-9a-fA-F]{24,}\b/g;

/** GitHub token (all prefixes: ghp, gho, ghu, ghs, ghr) */
export const GITHUB_TOKEN_FULL = /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g;

/** All credential log patterns. */
export const CREDENTIAL_LOG_PATTERNS: readonly RegExp[] = [
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
  FAL_KEY,
  GITHUB_TOKEN_FULL,
];
