// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent tool governance: denylist, classification data, and spawn-time error class.
 *
 * SUB_AGENT_TOOL_DENYLIST: tools that can NEVER be delegated to a sub-agent.
 * SUB_AGENT_TOOL_PROFILES: minimal copy of the profile→tool mapping needed to
 *   classify a "Tool X not found" error as "outside-profile" vs "denylisted".
 *   Canonical source: packages/skills/src/skills/policy/tool-policy.ts TOOL_PROFILES.
 *   DRIFT GUARD: packages/skills/src/skills/policy/tool-policy.test.ts asserts
 *   consistency between this copy and the canonical source.
 * toolReachableGroups: pure helper returning which profile names contain a tool.
 * RequiredToolsUnreachableError: thrown by spawn() when required_tools are unreachable.
 *
 * Defined in @comis/core so both @comis/agent and @comis/daemon can import it
 * without creating a package cycle. NO imports from @comis/skills, @comis/agent,
 * or @comis/daemon — this file is a pure static data module.
 * @module
 */

/** Tools denied to ALL sub-agents — management operations that trigger
 *  SIGUSR2 daemon restart, destructive config mutations, or session purge. */
export const SUB_AGENT_TOOL_DENYLIST: ReadonlySet<string> = new Set([
  "gateway",          // config.patch, gateway.restart, config.rollback, env.set -> SIGUSR2
  "channels_manage",  // channels.restart, config.patch -> SIGUSR2
  "agents_manage",    // agent create/delete -> config persistence -> SIGUSR2
  "models_manage",    // model config changes -> config persistence -> SIGUSR2
  "providers_manage", // provider CRUD -> config persistence -> SIGUSR2
  "tokens_manage",    // token CRUD -> config persistence -> SIGUSR2
  "skills_manage",    // skill config changes -> config persistence -> potential SIGUSR2
  "sessions_manage",  // session purge is destructive
  "memory_manage",    // memory purge is destructive
  "heartbeat_manage", // heartbeat config -> config persistence -> potential SIGUSR2
  "mcp_manage",       // mcp connect/disconnect/reconnect -> MCP server config persistence (persistToConfig)
  "mcp_login",        // mcp.oauth_login -> control-plane credential flow; never delegatable / never on the cap surface
]);

/**
 * Minimal copy of TOOL_PROFILES from @comis/skills/tool-policy.ts.
 *
 * Used by @comis/agent (pi-event-bridge, sub-agent-runner) to classify
 * "Tool X not found" errors without importing @comis/skills (which would
 * violate the architecture closed-set: agent has no skills edge).
 *
 * DRIFT GUARD: packages/skills/src/skills/policy/tool-policy.test.ts
 * asserts this copy is consistent with the canonical TOOL_PROFILES (bidirectional).
 * Update BOTH files when TOOL_PROFILES changes.
 *
 * "full" profile is intentionally omitted: it means "all tools allowed"
 * (empty array in skills) and requires no classification logic.
 */
export const SUB_AGENT_TOOL_PROFILES: Readonly<Record<string, ReadonlyArray<string>>> = {
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
  "cron-minimal": [
    "web_search",
    "message",
    "read",
    "write",
    "ls",
    "memory_store",
    "memory_search",
    "cron",
    "discover_tools",
  ],
  "heartbeat-minimal": [
    "message",
    "memory_store",
    "memory_search",
    "discover_tools",
  ],
};

/**
 * Copy of TOOL_GROUPS from @comis/skills/tool-policy.ts.
 *
 * Used by computeReachableToolNames() to expand "group:xxx" and bare group
 * names exactly as setup-tools.ts:588-607 does — giving the spawn gate
 * true parity with the runtime ceiling.
 *
 * DRIFT GUARD: packages/skills/src/skills/policy/tool-policy.test.ts
 * asserts bidirectional consistency between this copy and the canonical TOOL_GROUPS.
 * Update BOTH files when TOOL_GROUPS changes.
 */
export const SUB_AGENT_TOOL_GROUPS: Readonly<Record<string, ReadonlyArray<string>>> = {
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
};

/**
 * Compute the reachable tool set for the given effective tool groups,
 * expanding both SUB_AGENT_TOOL_PROFILES (profile names) and SUB_AGENT_TOOL_GROUPS
 * ("group:xxx" and bare group names) — exactly as setup-tools.ts:588-607 does.
 *
 * Returns null when toolGroups includes "full" (unconstrained — no ceiling to
 * check; the denylist is still applied separately at runtime).
 *
 * @param toolGroups - Effective tool group names (config default already applied by caller)
 * @returns Set of reachable tool names, or null for unconstrained "full"
 */
export function computeReachableToolNames(toolGroups: string[]): Set<string> | null {
  if (toolGroups.length === 0) return null;
  if (toolGroups.includes("full")) return null;
  const allowed = new Set<string>();
  for (const group of toolGroups) {
    // Expand profile names (TOOL_PROFILES equivalent)
    const profileTools = SUB_AGENT_TOOL_PROFILES[group];
    if (profileTools) {
      for (const t of profileTools) allowed.add(t);
    }
    // Expand group: names (TOOL_GROUPS equivalent) — both "group:xxx" and bare "xxx" forms
    const groupKey = group.startsWith("group:") ? group : `group:${group}`;
    const groupTools = SUB_AGENT_TOOL_GROUPS[groupKey];
    if (groupTools) {
      for (const t of groupTools) allowed.add(t);
    }
  }
  // Remove denylisted tools (defense-in-depth: denylist always wins)
  for (const denied of SUB_AGENT_TOOL_DENYLIST) {
    allowed.delete(denied);
  }
  return allowed;
}

/**
 * Returns the profile names (from SUB_AGENT_TOOL_PROFILES) that contain
 * the given tool. Used by classifiers to build "Re-spawn with tool_groups:[...]"
 * hints without importing @comis/skills.
 *
 * @param toolName - The tool to look up
 * @returns Array of profile names that include this tool (empty if none or denylisted)
 */
export function toolReachableGroups(toolName: string): string[] {
  const result: string[] = [];
  for (const [profileName, tools] of Object.entries(SUB_AGENT_TOOL_PROFILES)) {
    if (tools.includes(toolName)) {
      result.push(profileName);
    }
  }
  return result;
}

/**
 * Classification for a single tool that is unreachable by the sub-agent's
 * profile/group ceiling at spawn time.
 */
export interface UnreachableToolEntry {
  toolName: string;
  /** "denylist": tool is in SUB_AGENT_TOOL_DENYLIST — never delegatable to any sub-agent.
   *  "outside_profile": tool exists but is not in the active profile/group ceiling. */
  reason: "denylist" | "outside_profile";
  /** Human-readable hint for the caller: how to fix the spawn or why it cannot be fixed. */
  hint: string;
}

/**
 * Thrown by spawn() when one or more required_tools entries are absent from
 * the sub-agent's post-ceiling reachable tool set.
 *
 * @allow-throw: spawn() is consumed exclusively by daemon RPC handlers
 * (@allow-throw boundary in sub-agent-runner.ts). rpc-dispatch.ts converts
 * this to a JSON-RPC error response.
 */
export class RequiredToolsUnreachableError extends Error {
  readonly kind = "required_tools_unreachable" as const;
  readonly unreachableTools: UnreachableToolEntry[];

  constructor(tools: UnreachableToolEntry[]) {
    super(
      `Required tools unreachable: ${tools.map((t) => t.toolName).join(", ")}. ` +
        tools.map((t) => t.hint).join(" "),
    );
    this.unreachableTools = tools;
    this.name = "RequiredToolsUnreachableError";
  }
}
