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
  // Deliberately NO "agents.*.persona" entry. PerAgentConfigSchema
  // is z.strictObject and has no `persona` field, so such an override could never
  // produce a successful patch -- it would only leak a misleading capability hint
  // to LLMs (formatRedirectHint would emit "you can also patch agents.<id>.persona")
  // which the LLM echoes back as `persona:` in agents_manage.create config,
  // triggering Zod unrecognized_keys rejection.
  "agents.*.promptTimeout.promptTimeoutMs",      // Allow runtime tuning
  "agents.*.promptTimeout.retryPromptTimeoutMs",  // Allow runtime tuning
  "agents.*.promptTimeout.stallCeilingMultiplier", // Allow runtime tuning (same family as the two keys above)
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
  "browser.allowLoopbackNavigation", // Relaxes the SSRF loopback block for browser navigation

  // Logging rotation config requires daemon restart
  "daemon.logging",         // File transport config requires daemon restart

  // Capability layer -- operator-only; agents must not self-configure
  // capability map or detour policy.
  "tooling",

  // Authenticated platform-subject mappings define storage authority.
  "identity",

  // Linked contribution selection and instance activation are boot topology.
  "contributions",
  // Existing plugin activation is the current linked-extension topology.
  "plugins",

  // Broker anti-exfiltration guard — executor section is
  // operator-only. An agent must NOT be able to self-configure
  // executor.broker.bindings to route credentials to an attacker-controlled
  // host. "executor" as the prefix catches all three write paths:
  // config.patch{key:"broker.bindings"}, config.patch{whole-section}, config.apply.
  "executor",
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
    .map(p => keySegment ? p.replaceAll("*", keySegment) : p);
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

/**
 * Security-posture sub-paths WITHIN a single agent's config that are
 * OPERATOR-ONLY: no runtime RPC may set them — not `config.patch`, and not
 * `agents_manage` / `agents.create` / `agents.update`. They gate sandbox and
 * bwrap-jail escape and terminal command allowlisting, and can only change by
 * editing the config file directly.
 *
 * WHY a SEPARATE list from {@link IMMUTABLE_CONFIG_PREFIXES}: the whole
 * `agents` section is immutable to `config.patch` (which STEERS callers to the
 * dedicated `agents_manage` tool via the redirect hint), but `agents_manage`
 * LEGITIMATELY writes agent config — name, provider, model, budgets, autonomy
 * tuning, tool toggles, … That asymmetry is intentional for those fields; it is
 * NOT intentional for the sandbox/jail escape switches. An admin-trust agent
 * must never be able to flip its own `skills.execSandbox.enabled` from `never`
 * to `always` through `agents.update`. These sub-paths are the narrow deny-list
 * that `agents_manage` must also refuse.
 *
 * Paths are AGENT-RELATIVE (no `agents.<id>` prefix) so they apply to every
 * agent id. A match is exact-or-child: listing `skills.terminal.allow` also
 * blocks `skills.terminal.allow.0.match.path`.
 */
export const OPERATOR_ONLY_AGENT_SUBPATHS: readonly string[] = [
  "skills.execSandbox",                    // exec OS-level sandbox switch (enabled: always|never) + its scope
  "skills.terminal.unsafeDisableSandbox",  // bwrap-jail bypass for the terminal driver
  "skills.terminal.allow",                 // terminal command allowlist — operator config only, never agent-extensible
] as const;

/**
 * Return whether a dot-separated path is PRESENT (as a set key) in a nested
 * object, regardless of the leaf value. Presence — not truthiness — is the
 * signal: sending an operator-only key at all in a runtime patch is the
 * operator-only action, so `{ skills: { execSandbox: {} } }` still matches
 * (fail-closed on presence).
 */
function objectPathIsPresent(obj: Record<string, unknown>, segments: string[]): boolean {
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    // eslint-disable-next-line security/detect-object-injection -- seg is a literal from OPERATOR_ONLY_AGENT_SUBPATHS, not user-controlled
    if (!(seg in (cursor as Record<string, unknown>))) return false;
    // eslint-disable-next-line security/detect-object-injection -- same
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return true;
}

/**
 * Walk a PARTIAL per-agent config object (the user's supplied `config`, before
 * schema defaults are applied) and return the {@link OPERATOR_ONLY_AGENT_SUBPATHS}
 * it would SET. Empty for the common case (name/model/budget/tool-toggle
 * updates touch none). The `agents.create` / `agents.update` handlers reject a
 * non-empty result as a runtime attempt to set an operator-only field.
 *
 * Checks the RAW user input, not the defaulted config — every parsed agent
 * carries a defaulted `skills.execSandbox`, so scanning the post-parse config
 * would flag every create.
 */
export function findOperatorOnlyAgentPaths(agentConfig: unknown): string[] {
  if (agentConfig === null || typeof agentConfig !== "object" || Array.isArray(agentConfig)) {
    return [];
  }
  const obj = agentConfig as Record<string, unknown>;
  return OPERATOR_ONLY_AGENT_SUBPATHS.filter((subpath) => objectPathIsPresent(obj, subpath.split(".")));
}
