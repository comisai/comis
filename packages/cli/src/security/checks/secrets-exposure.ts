/**
 * Secrets exposure security check.
 *
 * Scans raw config file content for credential patterns that should
 * not appear in config files. Credentials should be stored in .env
 * files and referenced via ${VAR} substitution or SecretManager.
 *
 * Patterns reuse knowledge from output-guard.ts and log-sanitizer.ts.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Secret patterns to detect in config file content. */
const CONFIG_SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp; label: string }> = [
  {
    name: "SK_KEY",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    label: "OpenAI/Anthropic API key (sk-...)",
  },
  {
    name: "AWS_KEY",
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
    label: "AWS access key ID (AKIA...)",
  },
  {
    name: "BOT_TOKEN",
    regex: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
    label: "Telegram bot token (digits:alphanum)",
  },
  {
    name: "GITHUB_TOKEN",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g,
    label: "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)",
  },
  {
    name: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    label: "Slack token (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-)",
  },
  {
    name: "PRIVATE_KEY",
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    label: "Private key header",
  },
  {
    name: "BEARER_TOKEN",
    regex: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    label: "Bearer token",
  },
];

const REMEDIATION =
  "Move credentials to .env file (chmod 600) and reference via ${VAR} substitution or SecretManager";

/**
 * Secrets exposure check.
 *
 * Scans rawConfigContent against known secret patterns.
 * Any match is a critical finding since credentials should never
 * be stored in plain config files.
 */
export const secretsExposureCheck: SecurityCheck = {
  id: "secrets-exposure",
  name: "Secrets Exposure",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.rawConfigContent) {
      return findings;
    }

    for (const pattern of CONFIG_SECRET_PATTERNS) {
      // Reset regex lastIndex before each test (global regexes are stateful)
      pattern.regex.lastIndex = 0;

      if (pattern.regex.test(context.rawConfigContent)) {
        findings.push({
          category: "secrets-exposure",
          severity: "critical",
          message: `Plaintext secret detected: ${pattern.label}`,
          remediation: REMEDIATION,
          code: `SEC-SECRET-${pattern.name}`,
        });
      }
    }

    return findings;
  },
};
