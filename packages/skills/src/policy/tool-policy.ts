// SPDX-License-Identifier: Apache-2.0
/**
 * Config-driven tool policy filter.
 *
 * Controls which tools are available to an agent based on named profiles
 * with allow/deny overrides. Supports group expansion for convenient
 * bulk operations on related tool sets.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * Structured reason why a tool was filtered by policy.
 *
 * - `not_in_profile`: Tool was not in the combined profile + allow set.
 * - `explicit_deny`: Tool was removed by the deny list (direct name or group expansion).
 */
export type ToolFilterReason =
  | { kind: "not_in_profile"; profile: string; toolName: string }
  | { kind: "explicit_deny"; toolName: string; denyEntry: string };

/**
 * Result of applying a tool policy, including both allowed tools and denial reasons.
 */
export type ToolPolicyResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  tools: AgentTool<any>[];
  filtered: Array<{ toolName: string; reason: ToolFilterReason }>;
};

/**
 * Named profiles defining baseline tool sets.
 *
 * Each profile maps to an array of tool names that are allowed.
 * The "full" profile uses an empty array to indicate ALL tools are allowed.
 */
export const TOOL_PROFILES: Record<string, string[]> = {
  minimal: ["read", "write"],
  coding: [
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "apply_patch",
    "exec",
    "process",
  ],
  messaging: ["message", "session_status"],
  supervisor: [
    "agents_manage",
    "obs_query",
    "sessions_manage",
    "memory_manage",
    "channels_manage",
    "tokens_manage",
    "models_manage",
    "skills_manage",
    "mcp_manage",
    "heartbeat_manage",
  ],
  /**
   * Conservative presets for non-interactive operations.
   *
   * Opt-in via `toolPolicy: { profile: "cron-minimal" }` on a `CronJob` or
   * `toolPolicy: { profile: "heartbeat-minimal" }` on heartbeat config. The
   * `*-minimal` suffix signals "opinionated narrow default, expect to `allow`
   * extras per job" -- never applied as a silent default at the call site.
   */
  "cron-minimal": [
    "web_search",
    "message",
    "read_file",
    "write_file",
    "list_dir",
    "memory_store",
    "memory_search",
    "cron",
    "discover",
  ],
  "heartbeat-minimal": [
    "message",
    "memory_store",
    "memory_search",
    "discover",
  ],
  full: [], // empty = all tools allowed
};

/**
 * Tool groups for convenient bulk allow/deny operations.
 *
 * Use "group:xxx" syntax in allow/deny arrays to reference these groups.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  "group:coding": [
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "apply_patch",
    "exec",
    "process",
  ],
  "group:web": ["web_fetch", "web_search", "browser"],
  "group:browser": ["browser"],
  "group:memory": ["memory_search", "memory_get", "memory_store"],
  "group:scheduling": ["cron"],
  "group:messaging": ["message"],
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "session_search",
    "subagents",
    "agents_list",
    "pipeline",
  ],
  "group:platform_actions": [
    "discord_action",
    "telegram_action",
    "slack_action",
    "whatsapp_action",
  ],
  "group:supervisor": [
    "agents_manage",
    "obs_query",
    "sessions_manage",
    "memory_manage",
    "channels_manage",
    "tokens_manage",
    "models_manage",
    "skills_manage",
    "mcp_manage",
    "heartbeat_manage",
  ],
  "group:context": [
    "ctx_search",
    "ctx_inspect",
    "ctx_recall",
  ],
  "group:context_expand": [
    "ctx_expand",
    "ctx_inspect",
  ],
};

/**
 * Expand group references in a list of tool names.
 *
 * For each name that starts with "group:" and exists in TOOL_GROUPS,
 * expand it to the group's tool names. Otherwise keep as-is.
 *
 * @param names - Array of tool names, possibly including group references
 * @returns Deduplicated flat array of tool names
 */
export function expandGroups(names: string[]): string[] {
  const result = new Set<string>();
  for (const name of names) {
    const group = TOOL_GROUPS[name];
    if (name.startsWith("group:") && group) {
      for (const tool of group) {
        result.add(tool);
      }
    } else {
      result.add(name);
    }
  }
  return [...result];
}

/**
 * Apply a tool policy to filter a list of tools.
 *
 * Uses the profile as a baseline, adds tools from the allow list,
 * then removes tools from the deny list. Group references are expanded.
 * Returns both the filtered tool set and structured denial reasons.
 *
 * @param tools - The full list of available AgentTools
 * @param policy - The policy configuration with profile, allow, and deny
 * @returns ToolPolicyResult with allowed tools and denial reasons for filtered tools
 */
export function applyToolPolicy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  tools: AgentTool<any>[],
  policy: { profile: string; allow: string[]; deny: string[] },
): ToolPolicyResult {
  const expandedDeny = expandGroups(policy.deny);

  // Fast path: full profile with no deny list
  if (policy.profile === "full" && expandedDeny.length === 0) {
    return { tools, filtered: [] };
  }

  // Build reverse map from expanded deny tool names to original deny entries.
  // Direct deny entries map to themselves; group entries map to the group name.
  const denyOrigin = new Map<string, string>();
  for (const entry of policy.deny) {
    const group = TOOL_GROUPS[entry];
    if (entry.startsWith("group:") && group) {
      for (const tool of group) {
        denyOrigin.set(tool, entry);
      }
    } else {
      denyOrigin.set(entry, entry);
    }
  }

  const expandedAllow = expandGroups(policy.allow);

  // Build the allowed set
  const profileTools = TOOL_PROFILES[policy.profile];

  let allowedSet: Set<string>;

  if (policy.profile === "full") {
    // Full profile: start with all tool names, add expanded allow
    allowedSet = new Set(tools.map((t) => t.name));
    for (const name of expandedAllow) {
      allowedSet.add(name);
    }
  } else if (profileTools) {
    // Known profile: start with profile tools, add expanded allow
    allowedSet = new Set([...profileTools, ...expandedAllow]);
  } else {
    // Unknown profile: only allow explicitly listed tools
    allowedSet = new Set(expandedAllow);
  }

  // Remove denied tools
  for (const name of expandedDeny) {
    allowedSet.delete(name);
  }

  // Build denial report for tools not in allowed set
  const expandedDenySet = new Set(expandedDeny);
  const filtered: Array<{ toolName: string; reason: ToolFilterReason }> = [];

  for (const tool of tools) {
    if (!allowedSet.has(tool.name)) {
      if (expandedDenySet.has(tool.name)) {
        // Tool was explicitly denied
        filtered.push({
          toolName: tool.name,
          reason: {
            kind: "explicit_deny",
            toolName: tool.name,
            denyEntry: denyOrigin.get(tool.name) ?? tool.name,
          },
        });
      } else {
        // Tool not in profile + allow set
        filtered.push({
          toolName: tool.name,
          reason: {
            kind: "not_in_profile",
            profile: policy.profile,
            toolName: tool.name,
          },
        });
      }
    }
  }

  // Filter tools by allowed set
  return {
    tools: tools.filter((tool) => allowedSet.has(tool.name)),
    filtered,
  };
}
