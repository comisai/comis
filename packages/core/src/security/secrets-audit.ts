// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets audit scanner -- detects plaintext secrets in config YAML files
 * and known provider env vars in .env files.
 *
 * Produces structured findings with code, severity, file, jsonPath, and
 * message fields suitable for CLI table display and JSON output.
 *
 * Config field scanning using isSecretFieldName
 * .env scanning using KNOWN_PROVIDER_PATTERNS
 * SecretRef detection (properly configured refs are not flagged)
 * Convenience wrapper with file loading
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { isSecretFieldName } from "./secret-detection.js";
import { isSecretRef } from "../domain/secret-ref.js";

// ── Finding types ──────────────────────────────────────────────────

/** Severity levels for audit findings. */
export type AuditSeverity = "error" | "warn" | "info";

/** A single audit finding. */
export interface AuditFinding {
  /** Finding code (machine-readable identifier) */
  code: "PLAINTEXT_SECRET" | "KNOWN_PROVIDER_ENV" | "HIGH_ENTROPY_VALUE";
  /** Severity level */
  severity: AuditSeverity;
  /** File path where the finding was detected */
  file: string;
  /** JSON path to the field (dot-notation for config, key name for .env) */
  jsonPath: string;
  /** Human-readable description of the finding */
  message: string;
}

/** Options for the convenience audit wrapper. */
export interface AuditOptions {
  /** Config file paths to scan (YAML/JSON) */
  configPaths: string[];
  /** .env file path to scan (optional) */
  envPath?: string;
}

// ── Known provider patterns for .env scanning ──────────────────────

const KNOWN_PROVIDER_PATTERNS: ReadonlyArray<{ pattern: RegExp; provider: string }> = [
  { pattern: /^ANTHROPIC_API_KEY$/, provider: "anthropic" },
  { pattern: /^OPENAI_API_KEY$/, provider: "openai" },
  { pattern: /^TELEGRAM_BOT_TOKEN$/, provider: "telegram" },
  { pattern: /^DISCORD_BOT_TOKEN$/, provider: "discord" },
  { pattern: /^SLACK_BOT_TOKEN$/, provider: "slack" },
  { pattern: /^SLACK_SIGNING_SECRET$/, provider: "slack" },
  { pattern: /^MSTEAMS_APP_PASSWORD$/, provider: "msteams" },
  { pattern: /^MATRIX_ACCESS_TOKEN$/, provider: "matrix" },
  { pattern: /^MATRIX_PASSWORD$/, provider: "matrix" },
  { pattern: /^MATRIX_RECOVERY_KEY$/, provider: "matrix" },
  { pattern: /^GROQ_API_KEY$/, provider: "groq" },
  { pattern: /^DEEPGRAM_API_KEY$/, provider: "deepgram" },
  { pattern: /^ELEVENLABS_API_KEY$/, provider: "elevenlabs" },
  { pattern: /^BRAVE_API_KEY$/, provider: "brave" },
  { pattern: /^GOOGLE_API_KEY$/, provider: "google" },
  { pattern: /^SECRETS_MASTER_KEY$/, provider: "comis" },
  { pattern: /_API_KEY$/, provider: "unknown" },
  { pattern: /_SECRET$/, provider: "unknown" },
  { pattern: /_TOKEN$/, provider: "unknown" },
  { pattern: /_PASSWORD$/, provider: "unknown" },
];

/**
 * Prefixes and exact names to skip during .env scanning.
 * These are operational/system variables, not secrets.
 * Matches the SKIP_PREFIXES and SKIP_EXACT from the CLI secrets import command.
 */
const SKIP_PREFIXES = ["COMIS_", "NODE_"];
const SKIP_EXACT = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TERM",
  "LANG",
  "TZ",
  "EDITOR",
  "VISUAL",
]);

/** Check if a key should be skipped during env scanning. */
function shouldSkipEnvKey(key: string): boolean {
  if (SKIP_EXACT.has(key)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ── Config scanner ─────────────────────────────────────────────────

/**
 * A full-string `${VAR}` env-substitution reference. Values of this exact shape
 * are resolved by `config/env-substitution.ts` (via `getSecret`) before any
 * adapter runs, so a secret-named field holding one is a *properly configured
 * reference*, NOT a plaintext secret — exactly like a structured `SecretRef`
 * object. Anchored to the WHOLE value (mirrors `ENV_VAR_PATTERN`'s grammar): a
 * partial/templated value like `prefix-${VAR}` or a raw secret that merely
 * contains a `$` still flags. (Surfaced validating the `comis doctor` ops
 * surface: `secret: ${COMIS_GATEWAY_TOKEN}` was mis-flagged PLAINTEXT_SECRET.)
 */
const FULL_ENV_VAR_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

/**
 * Scan a parsed config object for plaintext secrets.
 *
 * Walks the raw parsed config recursively. For each leaf string value whose
 * field name matches isSecretFieldName, emits a PLAINTEXT_SECRET finding
 * unless the value is a SecretRef object or empty.
 *
 * @param filePath - Path to the config file (for finding metadata)
 * @param raw - Raw parsed config object (before Zod validation)
 * @returns Array of audit findings
 */
export function scanConfigForSecrets(
  filePath: string,
  raw: Record<string, unknown>,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  walkConfig(raw, [], filePath, findings);
  return findings;
}

/**
 * Recursively walk config object, building JSON path and checking leaf values.
 */
function walkConfig(
  obj: unknown,
  pathParts: string[],
  filePath: string,
  findings: AuditFinding[],
): void {
  if (obj === null || obj === undefined || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i];
      const arrayPath = [...pathParts.slice(0, -1), `${pathParts[pathParts.length - 1]}[${i}]`];
      if (typeof item === "object" && item !== null) {
        walkConfig(item, arrayPath, filePath, findings);
      }
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    const currentPath = [...pathParts, key];

    if (isSecretFieldName(key)) {
      // Check if value is a SecretRef (properly configured -- skip)
      if (isSecretRef(value)) {
        continue;
      }

      // A full-string ${VAR} env-substitution reference is a properly configured
      // reference (resolved at load), not a plaintext secret -- skip like SecretRef.
      if (typeof value === "string" && FULL_ENV_VAR_REFERENCE.test(value.trim())) {
        continue;
      }

      // Check if value is a non-empty string (plaintext secret)
      if (typeof value === "string" && value.length > 0) {
        findings.push({
          code: "PLAINTEXT_SECRET",
          severity: "error",
          file: filePath,
          jsonPath: currentPath.join("."),
          message: `Plaintext secret detected in field '${key}' -- consider using a SecretRef or environment variable`,
        });
        continue;
      }

      // Empty string or undefined -- skip
      continue;
    }

    // Recurse into nested objects/arrays
    if (typeof value === "object" && value !== null) {
      walkConfig(value, currentPath, filePath, findings);
    }
  }
}

// ── Env scanner ────────────────────────────────────────────────────

/**
 * Scan an env record for known provider secrets.
 *
 * For each env var matching a known provider pattern with a non-empty value,
 * emits a KNOWN_PROVIDER_ENV finding. Skips operational/system variables.
 *
 * @param filePath - Path to the .env file (for finding metadata)
 * @param envRecord - Parsed env record (key-value pairs)
 * @returns Array of audit findings
 */
export function scanEnvForSecrets(
  filePath: string,
  envRecord: Record<string, string | undefined>,
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const [key, value] of Object.entries(envRecord)) {
    if (value === undefined || value.length === 0) continue;
    if (shouldSkipEnvKey(key)) continue;

    for (const { pattern, provider } of KNOWN_PROVIDER_PATTERNS) {
      if (pattern.test(key)) {
        findings.push({
          code: "KNOWN_PROVIDER_ENV",
          severity: "warn",
          file: filePath,
          jsonPath: key,
          message: `Known ${provider} secret '${key}' found in .env file -- consider migrating to encrypted secrets store`,
        });
        break; // Only emit one finding per key (first matching pattern)
      }
    }
  }

  return findings;
}

// ── Convenience wrapper ────────────────────────────────────────────

/** Severity sort order: error first, then warn, then info. */
const SEVERITY_ORDER: Record<AuditSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/**
 * Run a full secrets audit across config files and optional .env file.
 *
 * For each config path: loads with readFileSync + yaml.parse, calls scanConfigForSecrets().
 * For envPath: loads with the same KEY=VALUE parser as loadEnvFile, calls scanEnvForSecrets().
 *
 * Returns all findings sorted by severity (error first, then warn, then info).
 *
 * @param options - Audit options specifying config paths and optional env path
 * @returns Sorted array of all audit findings
 */
export function auditSecrets(options: AuditOptions): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // Scan config files
  for (const configPath of options.configPaths) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        findings.push(...scanConfigForSecrets(configPath, parsed));
      }
    } catch {
      // File not found or parse error -- skip gracefully
    }
  }

  // Scan .env file
  if (options.envPath) {
    try {
      const content = readFileSync(options.envPath, "utf-8");
      const envRecord: Record<string, string | undefined> = {};

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;

        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();

        // Strip surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (key) {
          envRecord[key] = value;
        }
      }

      findings.push(...scanEnvForSecrets(options.envPath, envRecord));
    } catch {
      // File not found -- skip gracefully
    }
  }

  // Sort by severity (error first, then warn, then info)
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return findings;
}
