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

/** Tools denied to ALL sub-agents because they expose control-plane changes,
 * destructive mutations, credential flows, or data purges. */
export const SUB_AGENT_TOOL_DENYLIST: ReadonlySet<string> = new Set([
  "gateway",          // config changes, restart, rollback, and secret writes
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
 * Profile names that reach EVERY named tool — the groups a single re-spawn
 * could actually use.
 *
 * A per-tool answer is not composable: recommending the groups for each tool
 * separately produces a set of directives that contradict each other whenever
 * the tools do not share a profile, and a caller can only pass one group list.
 * `'full'` is not a profile key (it is the "no ceiling" sentinel), so it is
 * never returned here; callers fall back to it when this returns empty.
 *
 * @param toolNames - Tools that must all be reachable from the same group
 * @returns Profile names containing every tool (empty if no single profile does)
 */
export function groupsReachingAll(toolNames: readonly string[]): string[] {
  if (toolNames.length === 0) return [];
  return Object.entries(SUB_AGENT_TOOL_PROFILES)
    .filter(([, tools]) => toolNames.every((name) => tools.includes(name)))
    .map(([profileName]) => profileName);
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
/**
 * Render the rejection as ONE coherent instruction.
 *
 * Per-tool hints are computed per tool and cannot see each other, so joining
 * them emits a separate `Re-spawn with tool_groups:[…]` directive for every
 * tool. A caller passes one group list, so two directives are a contradiction,
 * and obeying either fails again on the other tool. This is the only place that
 * sees the whole set, so the combined directive is derived here.
 *
 * A denylisted requirement is unfixable by any group, so when one is present no
 * re-spawn directive is emitted at all — telling a caller to retry a spawn that
 * cannot succeed is worse than telling it to change the request.
 */
function buildUnreachableToolsMessage(tools: readonly UnreachableToolEntry[]): string {
  const named = tools.map((t) => t.toolName).join(", ");
  const denied = tools.filter((t) => t.reason === "denylist");
  const outside = tools.filter((t) => t.reason === "outside_profile");
  const parts = [`Required tools unreachable: ${named}.`];

  if (denied.length > 0) {
    parts.push(denied.map((t) => t.hint).join(" "));
    if (outside.length > 0) {
      parts.push(
        `No re-spawn can satisfy this request while ${denied.map((t) => `'${t.toolName}'`).join(", ")} `
        + `${denied.length === 1 ? "is" : "are"} required — drop `
        + `${denied.length === 1 ? "it" : "them"} or perform that step in the parent.`,
      );
    }
    return parts.join(" ");
  }

  const outsideNames = outside.map((t) => t.toolName);
  const shared = groupsReachingAll(outsideNames);
  // 'full' is the only ceiling that reaches a tool no profile lists (MCP tools,
  // and generic tools absent from every profile), so it is the fallback.
  const suggestion = shared.length > 0 ? shared.join("' | '") : "full";
  const validGroups = [...Object.keys(SUB_AGENT_TOOL_PROFILES), "full"].join("' | '");
  parts.push(
    outsideNames.length === 1
      ? `Tool '${outsideNames[0]}' is outside this sub-agent's profile.`
      : `Tools ${outsideNames.map((n) => `'${n}'`).join(", ")} are outside this sub-agent's profile; `
        + `one re-spawn must reach all of them.`,
  );
  parts.push(`Re-spawn with tool_groups:['${suggestion}'].`);
  parts.push(`Valid groups are '${validGroups}' — any other value is ignored.`);
  if (outsideNames.some((n) => n.startsWith("mcp__"))) {
    parts.push(
      "MCP tool names are resolved from connected servers at runtime, so no narrow profile "
      + "lists them and 'full' is the only group that reaches them.",
    );
  }
  return parts.join(" ");
}

export class RequiredToolsUnreachableError extends Error {
  readonly kind = "required_tools_unreachable" as const;
  readonly unreachableTools: UnreachableToolEntry[];

  constructor(tools: UnreachableToolEntry[]) {
    super(buildUnreachableToolsMessage(tools));
    this.unreachableTools = tools;
    this.name = "RequiredToolsUnreachableError";
  }
}
