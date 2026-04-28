// SPDX-License-Identifier: Apache-2.0
/**
 * Immutable config key guard: prevents agent modification of sensitive config paths.
 *
 * Security-critical config sections are protected from runtime mutation by the agent.
 * The guard is used by the config patch handler to reject writes to these paths.
 *
 * @module
 */

/**
 * Mutable override patterns within otherwise-immutable config sections.
 *
 * These dot-notation patterns use `*` as a single-segment wildcard (matches
 * any one path segment, e.g. an agentId). A pattern matches the exact path
 * and any child paths beneath it.
 *
 * Paths matching an override are allowed through even if they fall under an
 * immutable prefix. The override check runs BEFORE the immutable prefix check.
 */
export const MUTABLE_CONFIG_OVERRIDES: readonly string[] = [
  "agents.*.skills.watchEnabled",
  "agents.*.skills.watchDebounceMs",
  "agents.*.skills.discoveryPaths",
  "agents.*.maxSteps",
  // 260428-rrr Bug A: removed dead "agents.*.persona" entry. PerAgentConfigSchema
  // is z.strictObject and has no `persona` field, so the override could never
  // produce a successful patch -- it only leaked a misleading capability hint
  // to LLMs (formatRedirectHint emitted "you can also patch agents.<id>.persona")
  // which the LLM echoed back as `persona:` in agents_manage.create config,
  // triggering Zod unrecognized_keys rejection.
  "agents.*.promptTimeout.promptTimeoutMs",      // Allow runtime tuning
  "agents.*.promptTimeout.retryPromptTimeoutMs",  // Allow runtime tuning
  "agents.*.operationModels",                     // Allow runtime model tiering tuning
  "agents.*.model",                               // Allow runtime model switching
  "agents.*.provider",                            // Allow runtime provider switching
  "channels.*.mediaProcessing",
  "integrations.mcp.servers",
] as const;

/**
 * Check whether a full dot-notation path matches an override pattern.
 *
 * The pattern uses `*` to match exactly one dot-separated segment.
 * The match is prefix-based: if all pattern segments match the corresponding
 * path segments, the path is considered a match (equal to or a child of the
 * pattern).
 *
 * @param fullPath - Full dot-notation config path (e.g., "agents.default.maxSteps")
 * @param pattern - Override pattern with `*` wildcards (e.g., "agents.*.maxSteps")
 * @returns true if the path matches or is a child of the pattern
 */
export function matchesOverridePattern(fullPath: string, pattern: string): boolean {
  const pathParts = fullPath.split(".");
  const patternParts = pattern.split(".");

  // Path must have at least as many segments as the pattern
  if (pathParts.length < patternParts.length) return false;

  // Check each pattern segment against the corresponding path segment
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") continue; // wildcard matches any single segment
    if (patternParts[i] !== pathParts[i]) return false;
  }

  // All pattern segments matched — path equals or is a child of the pattern
  return true;
}

/**
 * Config path prefixes that are immutable at runtime.
 *
 * These paths cannot be modified by agents via the config.patch RPC method.
 * They represent security-critical configuration that should only be changed
 * via config files or environment variables.
 *
 * Groups:
 * - security.*: All security settings (audit, secrets, classification)
 * - gateway.tls/tokens/host/port: Network exposure and auth credentials
 * - agents: Per-agent config (models, budgets, cost controls)
 * - channels: Channel adapter credentials (bot tokens, API keys)
 * - integrations: External service credentials and configuration
 */
export const IMMUTABLE_CONFIG_PREFIXES: readonly string[] = [
  "security",
  "gateway.tls",
  "gateway.tokens",

  // Expanded immutable prefixes
  "agents",               // Per-agent config: models, budgets, cost controls
  "channels",             // Channel credentials are secrets
  "gateway.host",         // Gateway binding affects network exposure
  "gateway.port",         // Gateway port affects network exposure
  "integrations",         // Integration configs contain secrets/credentials

  // New config section immutable classifications
  "providers",            // Provider configs contain API keys and credentials
  "approvals",            // Approval rules are security-critical policy
  "browser.noSandbox",    // Sandbox bypass is security-sensitive

  // Logging rotation config requires daemon restart
  "daemon.logging",         // File transport config requires daemon restart
] as const;

/**
 * Check whether a config path is immutable (cannot be modified at runtime).
 *
 * Builds the full dot-notation path from section and optional key, then checks
 * if it matches or is a child of any immutable prefix.
 *
 * @param section - Top-level config section (e.g., "security", "gateway")
 * @param key - Optional dot-notation key within the section (e.g., "tls.certPath")
 * @returns true if the path is immutable and should be rejected
 *
 * @example
 * isImmutableConfigPath("security") // true
 * isImmutableConfigPath("security", "audit.enabled") // true
 * isImmutableConfigPath("gateway", "tls.certPath") // true
 * isImmutableConfigPath("gateway", "host") // true
 * isImmutableConfigPath("channels", "slack.botToken") // true
 * isImmutableConfigPath("agent", "maxSteps") // false
 * isImmutableConfigPath("memory", "maxEntries") // false
 */
/**
 * Return concrete mutable override paths under a given section, for error message enrichment.
 *
 * Resolves `*` wildcards in MUTABLE_CONFIG_OVERRIDES using the optional key segment
 * (e.g., "default" from "default.budgets.maxDailyUsd"). When no key is provided,
 * the `*` wildcard is preserved.
 *
 * @param section - Top-level config section (e.g., "agents", "channels")
 * @param key - Optional dot-notation key; the first segment replaces `*` wildcards
 * @returns Concrete dot-notation paths that are mutable under this section
 */
export function getMutableOverridesForSection(section: string, key?: string): string[] {
  const keySegment = key?.split(".")[0]; // Extract first segment (e.g., "default" from "default.budgets.maxDailyUsd")
  return MUTABLE_CONFIG_OVERRIDES
    .filter(p => p.startsWith(section + "."))
    .map(p => keySegment ? p.replace("*", keySegment) : p);
}

export function isImmutableConfigPath(section: string, key?: string): boolean {
  if (!section) return true; // Missing section is treated as immutable (fail-closed)
  const fullPath = key ? `${section}.${key}` : section;

  // Check mutable overrides first (fail-open for listed paths)
  const isOverridden = MUTABLE_CONFIG_OVERRIDES.some(
    (pattern) => matchesOverridePattern(fullPath, pattern),
  );
  if (isOverridden) return false;

  // Then check immutable prefixes (fail-closed for everything else)
  return IMMUTABLE_CONFIG_PREFIXES.some(
    (prefix) => fullPath === prefix || fullPath.startsWith(prefix + "."),
  );
}
