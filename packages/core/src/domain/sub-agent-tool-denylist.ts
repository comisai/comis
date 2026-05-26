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
]);

/**
 * Minimal copy of TOOL_PROFILES from @comis/skills/tool-policy.ts.
 *
 * Used by @comis/agent (pi-event-bridge, sub-agent-runner) to classify
 * "Tool X not found" errors without importing @comis/skills (which would
 * violate the architecture closed-set: agent has no skills edge).
 *
 * DRIFT GUARD: packages/skills/src/skills/policy/tool-policy.test.ts
 * asserts this copy is consistent with the canonical TOOL_PROFILES.
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
    if ((tools as ReadonlyArray<string>).includes(toolName)) {
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
