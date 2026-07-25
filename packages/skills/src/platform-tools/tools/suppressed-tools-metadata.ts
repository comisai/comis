// SPDX-License-Identifier: Apache-2.0
/**
 * Activity-suppression metadata for the platform tools that are NOT in the
 * §17.6 user-meaningful set.
 *
 * These tools are internal orchestration, read-only context/session lookups,
 * MCP capability-discovery utilities, or cross-session plumbing — none surface
 * a user-meaningful action worth a per-tool activity label. The coverage
 * gate (`pnpm test:transparency`) requires EVERY emitted tool name to be
 * explicitly classified: either a registered LabelSpec OR `suppressActivity:true`.
 * This module supplies the suppress side of that contract, keyed on the EMITTED
 * `AgentTool.name` (which equals the descriptor name for every tool listed here —
 * the three descriptor≠emitted mismatches, `notify`/`image`/`tts`, all live in
 * the §17.6 set and get a spec instead).
 *
 * Imported for its side-effects by `registry.ts` so the metadata is registered
 * at module load, before any registry walk (the gate, or the daemon's tool
 * assembly). Each suppress decision is reviewable here; the gate forces an
 * explicit choice for any future tool (no silent default).
 *
 * `message` (endpoint-scoped send/reply/react/edit/delete/fetch/attach) is
 * suppressed here rather than given a spec: it is the agent-to-channel plumbing
 * tool, distinct from the user-facing chat reply path, and is NOT in the §17.6
 * table. If a later phase decides its mutations are operator-meaningful, replace
 * its entry here with a co-located LabelSpec in message-tool.ts.
 *
 * @module
 */
import { registerToolMetadata } from "@comis/core";

/**
 * Emitted tool names with no user-meaningful activity. Internal/read-only/poll
 * tools + MCP discovery utilities + cross-session plumbing. NOT the §17.6 set.
 */
const SUPPRESSED_TOOL_NAMES: readonly string[] = [
  // agent orchestration (internal)
  "pipeline",
  "subagents",
  "background_tasks",
  // gateway / observability (internal query surfaces)
  "gateway",
  "obs_query",
  // MCP capability-discovery utilities (read-only prompt/resource listing)
  "get_prompt",
  "list_prompts",
  "list_resources",
  "read_resource",
  // endpoint-scoped messaging plumbing (NOT the user-facing reply path)
  "message",
  // scheduling (poll/registration, not user-meaningful per spec §10.3)
  "cron",
  // session read/list/plumbing tools (the mutating `sessions_manage` IS labelled)
  "session_search",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
];

for (const name of SUPPRESSED_TOOL_NAMES) {
  registerToolMetadata(name, { suppressActivity: true });
}
