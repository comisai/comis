// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tool source profiles: defaults, overrides, and hard-ceiling clamping.
 *
 * Each built-in tool that ingests external content has a source profile
 * controlling byte/char limits, extraction strategy, and visibility stripping.
 * Operators can override defaults per-agent in YAML config, but values are
 * clamped to hard ceilings to prevent runaway context injection.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source profile controlling how a tool ingests and caps external content. */
export interface ToolSourceProfile {
  /** Maximum response bytes to read from HTTP (only relevant for HTTP tools). */
  maxResponseBytes: number;
  /** Maximum chars after extraction. */
  maxChars: number;
  /** Extraction strategy hint. */
  extractionStrategy: "readability" | "raw" | "tail" | "structured";
  /** Whether to strip HTML visibility before extraction. */
  stripHidden: boolean;
}

// ---------------------------------------------------------------------------
// Hard ceilings (absolute maximums -- operators cannot exceed)
// ---------------------------------------------------------------------------

/** Absolute ceiling for maxResponseBytes (5 MB). */
export const HARD_CEILING_MAX_RESPONSE_BYTES = 5_000_000;

/** Absolute ceiling for maxChars (500K chars). */
export const HARD_CEILING_MAX_CHARS = 500_000;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default source profiles per tool name. */
export const DEFAULT_SOURCE_PROFILES: Record<string, ToolSourceProfile> = {
  web_fetch: {
    maxResponseBytes: 2_000_000,
    maxChars: 50_000,
    extractionStrategy: "readability",
    stripHidden: true,
  },
  web_search: {
    maxResponseBytes: 500_000,
    maxChars: 40_000,
    extractionStrategy: "structured",
    stripHidden: false,
  },
  bash: {
    maxResponseBytes: 500_000,
    maxChars: 50_000,
    extractionStrategy: "tail",
    stripHidden: false,
  },
  file_read: {
    maxResponseBytes: 1_000_000,
    maxChars: 100_000,
    extractionStrategy: "raw",
    stripHidden: false,
  },
  mcp_default: {
    maxResponseBytes: 2_000_000,
    maxChars: 50_000,
    extractionStrategy: "raw",
    stripHidden: false,
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a source profile for a tool, merging optional overrides with
 * defaults and clamping to hard ceilings.
 *
 * Resolution order:
 * 1. Exact match in DEFAULT_SOURCE_PROFILES (e.g. "web_fetch", "mcp_default")
 * 2. MCP tool names (starting with "mcp__") fall back to `mcp_default`
 * 3. All other unknown tools fall back to `web_fetch`
 *
 * @param toolName - Tool name (e.g. "web_fetch", "bash", "mcp__server--tool")
 * @param overrides - Optional partial overrides from per-agent config
 * @returns Fully resolved and clamped profile
 */
export function resolveSourceProfile(
  toolName: string,
  overrides?: Partial<ToolSourceProfile>,
): ToolSourceProfile {
  const base =
    DEFAULT_SOURCE_PROFILES[toolName] ??
    (toolName.startsWith("mcp__") ? DEFAULT_SOURCE_PROFILES.mcp_default : DEFAULT_SOURCE_PROFILES.web_fetch);
  const merged = { ...base, ...overrides };

  // Clamp to hard ceilings
  merged.maxResponseBytes = Math.min(merged.maxResponseBytes, HARD_CEILING_MAX_RESPONSE_BYTES);
  merged.maxChars = Math.min(merged.maxChars, HARD_CEILING_MAX_CHARS);

  // Enforce minimums
  merged.maxResponseBytes = Math.max(merged.maxResponseBytes, 32_000);
  merged.maxChars = Math.max(merged.maxChars, 100);

  return merged;
}

/**
 * Resolve profiles for all known tools plus any custom tool names from overrides.
 *
 * @param overridesMap - Optional map of `toolName -> Partial<ToolSourceProfile>`
 * @returns Map of tool name to fully resolved profile
 */
export function resolveAllProfiles(
  overridesMap?: Record<string, Partial<ToolSourceProfile>>,
): Record<string, ToolSourceProfile> {
  const result: Record<string, ToolSourceProfile> = {};

  for (const [name, _profile] of Object.entries(DEFAULT_SOURCE_PROFILES)) {
    result[name] = resolveSourceProfile(name, overridesMap?.[name]);
  }

  // Add any custom tool names from overrides that aren't in defaults
  if (overridesMap) {
    for (const [name, overrides] of Object.entries(overridesMap)) {
      if (!result[name]) {
        result[name] = resolveSourceProfile(name, overrides);
      }
    }
  }

  return result;
}
