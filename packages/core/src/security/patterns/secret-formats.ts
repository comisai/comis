/**
 * Secret format detection patterns.
 *
 * Detects API keys, tokens, private keys, and connection strings
 * in LLM output to prevent accidental secret leakage.
 * Originally from output-guard.ts.
 *
 * @module secret-formats
 */

/** AWS access key ID */
export const AWS_KEY_ID = /AKIA[A-Z0-9]{16}/g;

/** Bearer token */
export const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;

/** Hex secret (32+ chars) with keyword prefix */
export const HEX_SECRET_32 = /(?:secret|key|token|password)\s*[:=]\s*["']?[a-f0-9]{32,}/gi;

/** Base64 secret (40+ chars) with keyword prefix */
export const BASE64_SECRET = /(?:secret|key|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/]{40,}={0,2}/gi;

/** PEM private key header (no optional quantifier group for ReDoS safety) */
export const PRIVATE_KEY_HEADER = /-----BEGIN\s{1,5}(?:RSA )?PRIVATE\s{1,5}KEY-----/g;

/** GitHub personal/server token (ghp_/ghs_) */
export const GITHUB_TOKEN = /gh[ps]_[A-Za-z0-9_]{36,}/g;

/** Slack bot/app/user token (xox*) */
export const SLACK_TOKEN = /xox[baprs]-[A-Za-z0-9-]+/g;

// ---------------------------------------------------------------------------
// Expanded Secret Format Patterns
// ---------------------------------------------------------------------------

/** Anthropic API key: sk-ant-api03-... or sk-ant-admin-... */
export const ANTHROPIC_API_KEY = /\bsk-ant-(?:api03|admin)[A-Za-z0-9_-]{20,}/g;

/** OpenAI project key: sk-proj-... */
export const OPENAI_PROJECT_KEY = /\bsk-proj-[A-Za-z0-9_-]{20,}/g;

/** Discord bot token: three dot-separated segments, first starts with M/N */
export const DISCORD_BOT_TOKEN = /\b[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g;

/** Database connection string: postgres/mysql/mongodb/redis/mssql://... */
export const DB_CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql):\/\/[^\s]{10,200}/gi;

/** Generic API key assignment: api_key = "..." or apikey: "..." */
export const GENERIC_API_KEY_ASSIGN = /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/gi;

/** All secret format patterns. */
export const SECRET_FORMAT_PATTERNS: readonly RegExp[] = [
  AWS_KEY_ID,
  BEARER_TOKEN,
  HEX_SECRET_32,
  BASE64_SECRET,
  PRIVATE_KEY_HEADER,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  ANTHROPIC_API_KEY,
  OPENAI_PROJECT_KEY,
  DISCORD_BOT_TOKEN,
  DB_CONNECTION_STRING,
  GENERIC_API_KEY_ASSIGN,
];
