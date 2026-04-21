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
  { name: "bearer_token", regex: BEARER_TOKEN, severity: "warning" },
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

/**
 * Create an OutputGuard adapter that scans LLM responses.
 *
 * Checks for:
 * 1. Secret patterns (API keys, tokens, private keys)
 * 2. Canary token leakage (if canaryToken provided in context)
 * 3. System prompt extraction attempts
 *
 * Critical findings (severity: "critical") are blocked and redacted in the
 * `sanitized` field using `[REDACTED:{pattern_name}]` format. Warning-level
 * findings (bearer_token, prompt_extraction) remain detect-only -- they are
 * reported in `findings` but the `sanitized` text is left unchanged.
 *
 * Uses Result<T,E> pattern.
 */
export function createOutputGuard(): OutputGuardPort {
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

      // 2. Check canary token leakage -- always critical, redact in sanitized
      if (context?.canaryToken && response.includes(context.canaryToken)) {
        sanitized = sanitized.replaceAll(context.canaryToken, "[REDACTED:canary]");
        findings.push({
          type: "canary_leak",
          pattern: "canary_token",
          position: response.indexOf(context.canaryToken),
          severity: "critical",
        });
      }

      // 3. Check prompt extraction patterns -- warning severity, detect-only
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
