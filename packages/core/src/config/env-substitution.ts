import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { ConfigError } from "./types.js";

/**
 * Pattern for suspicious literal values that look like they should be env var references.
 * Matches common placeholder patterns and bare $VAR without braces.
 */
const SUSPICIOUS_LITERAL_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /^\$([A-Z_][A-Z0-9_]*)$/, hint: "bare $VAR — use ${$1} syntax" },
  { pattern: /^\[REDACTED\]$/i, hint: "literal placeholder — use ${VAR_NAME} to reference a secret" },
  { pattern: /^<[A-Z_]+>$/i, hint: "placeholder tag — use ${VAR_NAME} to reference a secret" },
  { pattern: /^(sk-|AIza|xoxb-|xoxp-)/, hint: "looks like a raw API key — use ${VAR_NAME} and store the key via env_set" },
];

/**
 * Pattern for environment variable references: ${VAR_NAME}
 * Matches uppercase letters, digits, and underscores (must start with letter or underscore).
 */
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Pattern for escaped variable references: $${VAR_NAME}
 * The double-$ prefix means "produce literal ${VAR_NAME} without substitution".
 */
const ESCAPED_VAR_PATTERN = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Pattern for bare variable references: $VAR_NAME (without braces).
 * Only matches when the entire string is a single bare reference (no mixed content).
 * This catches the common agent mistake of writing `$GEMINI_API_KEY` instead of `${GEMINI_API_KEY}`.
 */
const BARE_VAR_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Substitute `${VAR_NAME}` references in all string values of an object tree.
 *
 * Processing rules:
 * - Only string values are processed; numbers, booleans, null pass through unchanged
 * - `${VAR_NAME}` is replaced with the value from `getSecret(VAR_NAME)`
 * - `$${VAR_NAME}` (escape syntax) produces literal `${VAR_NAME}` in the output
 * - Missing variables (getSecret returns undefined) produce an ENV_VAR_ERROR
 * - Empty string from getSecret is a valid value (not an error)
 * - The input object is never mutated; a new object tree is returned
 *
 * @param obj - The object tree to process
 * @param getSecret - Function to look up secret values by name
 * @param configPath - Optional config file path for error context
 * @returns A new object tree with all variables substituted
 */
export function substituteEnvVars(
  obj: unknown,
  getSecret: (key: string) => string | undefined,
  configPath?: string,
): Result<unknown, ConfigError> {
  return substituteRecursive(obj, getSecret, configPath ?? "");
}

/**
 * Recursively walk and substitute strings in the object tree.
 */
function substituteRecursive(
  value: unknown,
  getSecret: (key: string) => string | undefined,
  configPath: string,
): Result<unknown, ConfigError> {
  // Null / undefined / non-object primitives pass through
  if (value === null || value === undefined) {
    return ok(value);
  }

  if (typeof value === "string") {
    return substituteString(value, getSecret, configPath);
  }

  if (typeof value !== "object") {
    // number, boolean, etc.
    return ok(value);
  }

  // Array: recurse into each element
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const element of value) {
      const substituted = substituteRecursive(element, getSecret, configPath);
      if (!substituted.ok) {
        return substituted;
      }
      result.push(substituted.value);
    }
    return ok(result);
  }

  // Plain object: recurse into each value
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const substituted = substituteRecursive(record[key], getSecret, configPath);
    if (!substituted.ok) {
      return substituted;
    }
    result[key] = substituted.value;
  }
  return ok(result);
}

/**
 * Substitute environment variable references in a single string.
 *
 * Handles escape sequences first ($${VAR} -> placeholder), then substitutes
 * real references (${VAR} -> value), then restores escaped placeholders.
 */
function substituteString(
  input: string,
  getSecret: (key: string) => string | undefined,
  configPath: string,
): Result<string, ConfigError> {
  // Step 0: Auto-correct bare $VAR references (without braces).
  // Agents commonly write `$GEMINI_API_KEY` instead of `${GEMINI_API_KEY}`.
  // Only matches whole-string bare refs to avoid false positives on paths like $HOME/dir.
  const bareMatch = input.match(BARE_VAR_PATTERN);
  if (bareMatch) {
    const varName = bareMatch[1]!;
    const value = getSecret(varName);
    if (value === undefined) {
      const context = configPath ? ` in config at ${configPath}` : "";
      return err({
        code: "ENV_VAR_ERROR",
        message: `Missing env var ${varName}${context} (bare $$${varName} auto-corrected to \${${varName}})`,
        path: configPath || undefined,
      });
    }
    return ok(value);
  }

  // Step 1: Replace escape sequences $${VAR} with a placeholder
  // Use a sentinel that cannot appear in normal config values
  const SENTINEL = "\x00ESC_VAR\x00";
  const escapes: string[] = [];

  let working = input.replace(ESCAPED_VAR_PATTERN, (_match, varName: string) => {
    escapes.push(varName);
    return `${SENTINEL}${escapes.length - 1}${SENTINEL}`;
  });

  // Step 2: Check for missing variables before substitution
  // We need to collect errors before replacing
  const missing: string[] = [];
  working.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const value = getSecret(varName);
    if (value === undefined) {
      missing.push(varName);
    }
    return ""; // not used, just scanning
  });

  if (missing.length > 0) {
    const context = configPath ? ` in config at ${configPath}` : "";
    return err({
      code: "ENV_VAR_ERROR",
      message: `Missing env var ${missing[0]}${context}`,
      path: configPath || undefined,
    });
  }

  // Step 3: Perform actual substitution
  working = working.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    // We already verified all vars exist above, so this is safe
    return getSecret(varName)!;
  });

  // Step 4: Restore escaped sequences as literal ${VAR}
  for (let i = 0; i < escapes.length; i++) {
    working = working.replace(`${SENTINEL}${i}${SENTINEL}`, `\${${escapes[i]}}`);
  }

  return ok(working);
}

/** A warning about a suspicious env value found during config validation. */
export interface EnvValueWarning {
  /** Dot-notation path to the suspicious value (e.g., "integrations.mcp.servers[1].env.TAVILY_API_KEY"). */
  readonly path: string;
  /** The suspicious value. */
  readonly value: string;
  /** Human-readable hint about what's wrong. */
  readonly hint: string;
}

/**
 * Scan an object tree for env-like string values that look suspicious —
 * bare `$VAR` references, placeholder strings like "[REDACTED]", or raw API keys.
 *
 * Intended for use in config write paths (config.patch, config.apply) to warn
 * the agent before persisting bad values. Only scans keys that look like env
 * variable containers (keys named "env" with Record<string, string> values).
 *
 * @param obj - The config object tree to scan
 * @param basePath - Optional path prefix for warning messages
 * @returns Array of warnings (empty = no issues found)
 */
export function warnSuspiciousEnvValues(
  obj: unknown,
  basePath = "",
): EnvValueWarning[] {
  const warnings: EnvValueWarning[] = [];
  scanRecursive(obj, basePath, warnings);
  return warnings;
}

function scanRecursive(
  value: unknown,
  path: string,
  warnings: EnvValueWarning[],
): void {
  if (value === null || value === undefined || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanRecursive(value[i], `${path}[${i}]`, warnings);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const childPath = path ? `${path}.${key}` : key;
    const child = record[key];

    // Only validate string values inside "env" record keys
    if (key === "env" && child !== null && typeof child === "object" && !Array.isArray(child)) {
      const envRecord = child as Record<string, unknown>;
      for (const envKey of Object.keys(envRecord)) {
        const envValue = envRecord[envKey];
        if (typeof envValue !== "string") continue;
        for (const { pattern, hint } of SUSPICIOUS_LITERAL_PATTERNS) {
          if (pattern.test(envValue)) {
            warnings.push({
              path: `${childPath}.${envKey}`,
              value: envValue,
              hint: hint.replace("$1", envValue.replace(/^\$/, "")),
            });
            break;
          }
        }
      }
    }

    // Continue recursing into nested objects
    scanRecursive(child, childPath, warnings);
  }
}
