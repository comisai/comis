// SPDX-License-Identifier: Apache-2.0
import { ok, type Result } from "@comis/shared";
import type { OutputGuardPort, OutputGuardFinding, OutputGuardResult } from "../ports/output-guard.js";
import {
  AWS_KEY_ID,
  BEARER_TOKEN,
  HEX_SECRET_32,
  BASE64_SECRET,
  PRIVATE_KEY_HEADER,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  ANTHROPIC_API_KEY,
  OPENAI_PROJECT_KEY,
  TELEGRAM_BOT_TOKEN,
  DISCORD_BOT_TOKEN,
  GOOGLE_API_KEY,
  JWT_PATTERN,
  DB_CONNECTION_STRING,
  GENERIC_API_KEY_ASSIGN,
  SYSTEM_PROMPT_LABEL,
  INSTRUCTIONS_LABEL,
} from "./injection-patterns.js";

/** Common secret patterns to detect in LLM output. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp; severity: "critical" | "warning" }> = [
  { name: "aws_key", regex: AWS_KEY_ID, severity: "critical" },
  { name: "bearer_token", regex: BEARER_TOKEN, severity: "critical" },   // REDACTS
  { name: "hf_token", regex: /\bhf_[A-Za-z0-9_]{18,}\b/g, severity: "critical" },  // bare hf_ (keystone PREFIX_MIN_BODY_LENGTHS["hf_"] = 18)
  { name: "hex_secret_32", regex: HEX_SECRET_32, severity: "critical" },
  { name: "base64_secret", regex: BASE64_SECRET, severity: "critical" },
  { name: "private_key_header", regex: PRIVATE_KEY_HEADER, severity: "critical" },
  { name: "github_token", regex: GITHUB_TOKEN, severity: "critical" },
  { name: "slack_token", regex: SLACK_TOKEN, severity: "critical" },
  { name: "anthropic_key", regex: ANTHROPIC_API_KEY, severity: "critical" },
  { name: "openai_project_key", regex: OPENAI_PROJECT_KEY, severity: "critical" },
  { name: "telegram_bot_token", regex: TELEGRAM_BOT_TOKEN, severity: "critical" },
  { name: "discord_bot_token", regex: DISCORD_BOT_TOKEN, severity: "critical" },
  { name: "google_api_key", regex: GOOGLE_API_KEY, severity: "critical" },
  { name: "jwt_token", regex: JWT_PATTERN, severity: "warning" },
  { name: "db_connection_string", regex: DB_CONNECTION_STRING, severity: "critical" },
  { name: "generic_api_key", regex: GENERIC_API_KEY_ASSIGN, severity: "critical" },
];

/** Patterns indicating system prompt extraction. */
const PROMPT_EXTRACTION_PATTERNS_LOCAL: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "system_prompt_label", regex: SYSTEM_PROMPT_LABEL },
  { name: "instructions_label", regex: INSTRUCTIONS_LABEL },
];

/** Minimum length for a bound known-secret to be eligible for exact-match
 *  redaction — guards against a short/empty value redacting ordinary text. */
const KNOWN_SECRET_MIN_LENGTH = 8;

/**
 * Create an OutputGuard adapter that scans LLM responses.
 *
 * Checks for:
 * 1. Secret patterns (API keys, tokens, private keys)
 * 2. Bound known-secret values (exact-match — the daemon's own credentials)
 * 3. Canary token leakage (if canaryToken provided in context)
 * 4. System prompt extraction attempts
 *
 * Critical findings (severity: "critical") are blocked and redacted in the
 * `sanitized` field using `[REDACTED:{pattern_name}]` format.
 *
 * @param opts.knownSecrets - Exact secret VALUES the daemon knows must never
 *   appear in output (e.g. resolved gateway tokens, the master key). Redacted by
 *   EXACT MATCH regardless of surrounding context — this closes the bare-secret
 *   gap (a high-entropy token with no `key=`/`token:` prefix that the regex
 *   patterns miss) with ZERO false-positive risk (no entropy heuristic that would
 *   over-redact git SHAs / hashes). Empty or sub-`KNOWN_SECRET_MIN_LENGTH` values
 *   are ignored so a misconfigured short value can never redact ordinary text.
 *
 * Uses Result<T,E> pattern.
 */
export function createOutputGuard(opts?: { knownSecrets?: readonly string[] }): OutputGuardPort {
  // Bind + dedupe the eligible known secrets ONCE at creation (longest-first so a
  // secret that is a substring of another is handled deterministically).
  const boundKnownSecrets = Array.from(
    new Set((opts?.knownSecrets ?? []).filter((s) => typeof s === "string" && s.trim().length >= KNOWN_SECRET_MIN_LENGTH)),
  ).sort((a, b) => b.length - a.length);

  return {
    scan(response: string, context?: { canaryToken?: string }): Result<OutputGuardResult, Error> {
      const findings: OutputGuardFinding[] = [];
      let sanitized = response;

      // 1. Check secret patterns -- redact critical, detect-only for warnings
      for (const pattern of SECRET_PATTERNS) {
        // Redact critical patterns in sanitized string
        if (pattern.severity === "critical") {
          pattern.regex.lastIndex = 0;
          sanitized = sanitized.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
        }

        // Record findings from ORIGINAL response (positions reference original text)
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(response)) !== null) {
          findings.push({
            type: "secret_leak",
            pattern: pattern.name,
            position: match.index,
            severity: pattern.severity,
          });
        }
      }

      // 2. Bound known-secret values -- exact-match redaction (the daemon's own
      // credentials). Catches BARE high-entropy secrets the prefix-gated regex
      // patterns miss, with zero false-positive risk. Position references the
      // ORIGINAL response.
      for (const secret of boundKnownSecrets) {
        if (response.includes(secret)) {
          sanitized = sanitized.replaceAll(secret, "[REDACTED:known_secret]");
          findings.push({
            type: "secret_leak",
            pattern: "known_secret",
            position: response.indexOf(secret),
            severity: "critical",
          });
        }
      }

      // 3. Check canary token leakage -- always critical, redact in sanitized
      if (context?.canaryToken && response.includes(context.canaryToken)) {
        sanitized = sanitized.replaceAll(context.canaryToken, "[REDACTED:canary]");
        findings.push({
          type: "canary_leak",
          pattern: "canary_token",
          position: response.indexOf(context.canaryToken),
          severity: "critical",
        });
      }

      // 4. Check prompt extraction patterns -- warning severity, detect-only
      for (const pattern of PROMPT_EXTRACTION_PATTERNS_LOCAL) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(response)) !== null) {
          findings.push({
            type: "prompt_extraction",
            pattern: pattern.name,
            position: match.index,
            severity: "warning",
          });
        }
      }

      const safe = findings.length === 0;
      const blocked = findings.some(f => f.severity === "critical");
      return ok({ safe, blocked, findings, sanitized });
    },
  };
}
