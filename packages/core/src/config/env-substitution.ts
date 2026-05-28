// SPDX-License-Identifier: Apache-2.0
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
export const ENV_VAR_PATTERN = /\$\{(?<varName>[A-Z_][A-Z0-9_]*)\}/g;

/**
 * Pattern for escaped variable references: $${VAR_NAME}
 * The double-$ prefix means "produce literal ${VAR_NAME} without substitution".
 */
export const ESCAPED_VAR_PATTERN = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Pattern for bare variable references: $VAR_NAME (without braces).
 * Only matches when the entire string is a single bare reference (no mixed content).
 * This catches the common agent mistake of writing `$GEMINI_API_KEY` instead of `${GEMINI_API_KEY}`.
 */
export const BARE_VAR_PATTERN = /^\$(?<varName>[A-Z_][A-Z0-9_]*)$/;

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
  if (bareMatch?.groups?.varName) {
    const varName = bareMatch.groups.varName;
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
    // Step 2's missing-var loop above already guarantees presence; this defensive
    // null-coalesce keeps the type system happy without a non-null assertion.
    // The empty-string fallback is unreachable in practice.
    return getSecret(varName) ?? "";
  });

  // Step 4: Restore escaped sequences as literal ${VAR}
  for (let i = 0; i < escapes.length; i++) {
    working = working.replace(`${SENTINEL}${i}${SENTINEL}`, `\${${escapes[i]}}`);
  }

  return ok(working);
}

/**
 * Walk an object tree and return the set of all environment variable names
 * referenced via `${VAR_NAME}` or whole-string bare `$VAR_NAME` syntax.
 *
 * Escaped references (`$${VAR_NAME}`) are NOT included — they are literal
 * strings, not references.
 *
 * Used by the exec tool's `secretRefs` policy: a name that appears in the
 * loaded config is "platform-managed" and exec must not expose it, since
 * agents shouldn't be able to exfiltrate credentials the daemon uses to
 * talk to providers (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, etc.).
 * Everything else — user-stored secrets like CLOUDFLARE_API_TOKEN —
 * is user-task and flows through.
 *
 * @param obj - The object tree to scan (config, subtree, etc.)
 * @returns Set of unique VAR_NAME strings referenced anywhere in the tree
 */
export function extractReferencedSecretNames(obj: unknown): Set<string> {
  const names = new Set<string>();
  walkForRefs(obj, names);
  return names;
}

function walkForRefs(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    collectRefsFromString(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForRefs(item, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkForRefs(v, out);
    }
  }
}

/**
 * Extract VAR_NAME tokens from a single string. Mirrors substituteString's
 * logic: ignore `$${VAR}` escapes, accept `${VAR}` refs, accept whole-string
 * bare `$VAR` refs.
 */
function collectRefsFromString(input: string, out: Set<string>): void {
  // Bare whole-string reference first (mirrors substituteString step 0).
  const bareMatch = input.match(BARE_VAR_PATTERN);
  if (bareMatch?.groups?.varName) {
    out.add(bareMatch.groups.varName);
    return;
  }

  // Mask escapes so they don't match the ENV_VAR_PATTERN below. We use the
  // same sentinel pattern as substituteString for parity.
  const SENTINEL = "\x00ESC_VAR\x00";
  const working = input.replace(ESCAPED_VAR_PATTERN, (_m, _name) => {
    return `${SENTINEL}${SENTINEL}`;
  });

  working.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    out.add(varName);
    return "";
  });
}

/**
 * A single unresolved env-var reference discovered while walking an object tree.
 *
 * `path` is the dot-notation location of the *string value* containing the
 * reference (e.g. `"servers[0].env.FINNHUB_API_KEY"`), matching the path
 * format used by `warnSuspiciousEnvValues`. `varName` is the name being
 * referenced (e.g. `"FINNHUB_API_KEY"`).
 *
 * Two missing vars in the *same* string produce two entries with the *same*
 * `path` but different `varName`s — accepted, deterministic, useful for
 * downstream message formatting.
 */
export interface UnresolvedEnvRef {
  /** Dot-notation path to the string value that contains the reference. */
  readonly path: string;
  /** The referenced env var name (without `${}` braces). */
  readonly varName: string;
}

/**
 * Walk an object tree and return every `${VAR_NAME}` (or whole-string bare
 * `$VAR_NAME`) reference whose name `getSecret` cannot resolve.
 *
 * Complement of `extractReferencedSecretNames`: that function returns *all*
 * referenced names (used by exec's `secretRefs` policy); this function returns
 * only the *unresolved* subset (used by daemon-side config-write validation
 * gates — `config.patch` and `mcp.connect`).
 *
 * Resolution semantics mirror `substituteEnvVars`:
 * - `getSecret` returning `undefined` → ref is missing (included in result).
 * - `getSecret` returning `""` → ref is a valid empty value (NOT included).
 * - `$${VAR}` escapes are literals, never refs (NOT included).
 *
 * Path format mirrors `warnSuspiciousEnvValues`: `parent.child[N].leaf`,
 * with the dot prefix omitted at the root.
 *
 * The env-substitution skip on disabled MCP servers makes the
 * `enabled:false + ${VAR}` placeholder pattern harmless at bootstrap; this
 * helper lets the daemon's config-write paths reject `enabled:true + missing
 * ${VAR}` *at write time* so it never reaches disk.
 *
 * @param obj - Object tree to scan.
 * @param getSecret - Callback that returns the value for a given var name,
 *                    or `undefined` if not in the secrets store.
 * @returns Array of `{ path, varName }` entries for each unresolved ref.
 *          Empty when every ref resolves.
 */
export function findUnresolvedEnvRefs(
  obj: unknown,
  getSecret: (key: string) => string | undefined,
): UnresolvedEnvRef[] {
  const out: UnresolvedEnvRef[] = [];
  scanForUnresolved(obj, "", getSecret, out);
  return out;
}

function scanForUnresolved(
  value: unknown,
  path: string,
  getSecret: (key: string) => string | undefined,
  out: UnresolvedEnvRef[],
): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    collectUnresolvedFromString(value, path, getSecret, out);
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForUnresolved(value[i], `${path}[${i}]`, getSecret, out);
    }
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const childPath = path ? `${path}.${key}` : key;
      scanForUnresolved(record[key], childPath, getSecret, out);
    }
  }
}

/**
 * Extract `${VAR}` and whole-string bare `$VAR` references from a single
 * string and append `{ path, varName }` for each one whose value `getSecret`
 * cannot resolve. Mirrors `collectRefsFromString` exactly so this helper and
 * `extractReferencedSecretNames` agree on what counts as a reference.
 */
function collectUnresolvedFromString(
  input: string,
  path: string,
  getSecret: (key: string) => string | undefined,
  out: UnresolvedEnvRef[],
): void {
  // Whole-string bare reference first (mirrors substituteString step 0).
  const bareMatch = input.match(BARE_VAR_PATTERN);
  if (bareMatch?.groups?.varName) {
    const varName = bareMatch.groups.varName;
    if (getSecret(varName) === undefined) {
      out.push({ path, varName });
    }
    return;
  }

  // Mask escapes so they don't match ENV_VAR_PATTERN. Same SENTINEL pattern
  // as substituteString / collectRefsFromString for parity.
  const SENTINEL = "\x00ESC_VAR\x00";
  const working = input.replace(ESCAPED_VAR_PATTERN, () => `${SENTINEL}${SENTINEL}`);

  working.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    if (getSecret(varName) === undefined) {
      out.push({ path, varName });
    }
    return "";
  });
}

/**
 * Build the structured `[invalid_value]` error string for an enabled MCP
 * server whose `env` block references env vars not in the secrets store.
 *
 * Used identically by `config.patch` and `mcp.connect` to keep the agent-
 * facing message in lockstep across the two RPC surfaces.
 *
 * Behavior:
 * - `missingVarNames` is sorted lexicographically for deterministic output.
 * - First 3 names are listed; if more, ` (+N more)` is appended.
 * - Single-var case uses singular "env var"; multi-var uses plural "env vars".
 * - Recovery option (1) `secrets_manage({action:"set", ...})` always names the
 *   FIRST missing var (alphabetical). Agents fix one at a time, then re-try.
 *
 * @param serverName - The MCP server name (`"<unnamed>"` if absent).
 * @param missingVarNames - Names that `findUnresolvedEnvRefs` reported missing.
 * @returns The exact `[invalid_value] ...` message.
 */
export function formatMissingEnvRefError(
  serverName: string,
  missingVarNames: readonly string[],
): string {
  // Defensive copy + sort for determinism.
  const sorted = [...missingVarNames].sort();
  const visible = sorted.slice(0, 3);
  const overflow = sorted.length - visible.length;
  const overflowSuffix = overflow > 0 ? ` (+${overflow} more)` : "";
  const isPlural = sorted.length > 1;
  const subject = isPlural ? "env vars" : "env var";
  const list = visible.join(", ") + overflowSuffix;
  // Recovery option (1) references the first (alphabetical) missing var only.
  const firstName = sorted[0] ?? "VAR_NAME";
  return (
    `[invalid_value] enabled MCP server "${serverName}" references ${subject} ${list} which is not in the secrets store. Either:\n` +
    `  1) secrets_manage({action:"set", name:"${firstName}", value:"..."})\n` +
    `  2) Drop the env block from this server (omit the env field)\n` +
    `  3) Set enabled:false to defer until the secret is available`
  );
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
