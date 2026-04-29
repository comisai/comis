// SPDX-License-Identifier: Apache-2.0
/**
 * Tooling section builders: tool listing, tool call style, self-update gating,
 * and compacted output recovery.
 */

import { TOOL_SUMMARIES, TOOL_ORDER } from "./tool-descriptions.js";

// ---------------------------------------------------------------------------
// 3. Tooling (include in minimal)
// ---------------------------------------------------------------------------

/** Model size tier — determines prompt verbosity for tool descriptions. */
export type ModelTier = "small" | "medium" | "large";

export function buildToolingSection(
  toolNames: string[],
  _modelTier: ModelTier,
  toolSummaries?: Record<string, string>,
): string[] {
  if (toolNames.length === 0) return [];

  const summaries = { ...TOOL_SUMMARIES, ...toolSummaries };

  const ordered = TOOL_ORDER.filter((t) => toolNames.includes(t));
  const extras = toolNames.filter((t) => !TOOL_ORDER.includes(t)).sort();
  const allTools = [...ordered, ...extras];

  const lines: string[] = ["## Available Tools"];
  for (const name of allTools) {
    const desc = summaries[name];
    lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
  }

  lines.push(
    "",
    "Always use tools to gather real data before answering. Never guess or fabricate tool results.",
    "Refer to each tool's schema for full parameter details.",
  );

  return lines;
}

// ---------------------------------------------------------------------------
// 4. Tool Call Style (skip if minimal)
// ---------------------------------------------------------------------------

export function buildToolCallStyleSection(isMinimal: boolean, toolNames: string[] = []): string[] {
  if (isMinimal) return [];

  const lines = [
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "",
    "- Prefer parallel tool calls when independent (see below)",
    "- Read files before writing to verify current state",
    "- Chain dependent calls sequentially (e.g., find → read → edit)",
    "- On tool failure: check the error, fix parameters, and retry once. If it fails again, try an alternative approach or report the error to the user.",
    "- Do not retry the same failing call repeatedly.",
  ];

  // Conditional coding guidelines based on available tools
  const has = (name: string) => toolNames.includes(name);
  const hasAny = (names: string[]) => names.some((n) => toolNames.includes(n));

  const guidelines: string[] = [];

  if (has("exec") && hasAny(["grep", "find", "ls"])) {
    guidelines.push("- Prefer grep/find/ls tools over exec for file exploration (faster, respects .gitignore)");
  }
  if (has("read") && has("edit")) {
    guidelines.push("- Use read to examine files before editing. Use the read tool instead of cat or sed via exec.");
  }
  if (has("read")) {
    guidelines.push(
      "- After reading a file, proceed directly to the task. Do NOT summarize file contents back to the user unless asked."
    );
  }
  if (has("edit")) {
    guidelines.push("- Use edit for precise changes -- the old_text must match the file contents exactly.");
  }
  if (has("write")) {
    guidelines.push("- Use write only for new files or complete rewrites, not for small edits.");
  }
  if (has("edit") || has("write")) {
    guidelines.push("- When summarizing your actions, output plain text directly -- do not use exec to display what you did.");
  }
  if (hasAny(["read", "edit", "write", "grep", "find", "ls"])) {
    guidelines.push("- Show file paths clearly when working with files.");
  }
  if (has("exec")) {
    guidelines.push(
      "- **Python projects:** Always create a virtualenv per project (`python3 -m venv .venv`). "
      + "Install packages into the project venv (`source .venv/bin/activate && pip install ...`). "
      + "Never use `--break-system-packages` — it pollutes the system Python. "
      + "Each project directory should have its own `.venv`.",
    );
  }

  if (guidelines.length > 0) {
    lines.push("", "### Coding Guidelines", ...guidelines);
  }

  lines.push(
    "",
    "### Parallel vs Sequential",
    "Call independent tools in parallel to reduce round-trips:",
    "- **Parallel**: memory_search + web_search (independent data sources)",
    "- **Parallel**: Multiple read calls for different files -- ALWAYS read in parallel when examining 2+ files",
    "- **Parallel**: grep + find when searching for different things",
    "- **Sequential**: find -> read (need file path before reading)",
    "- **Sequential**: read -> edit (need current content before editing)",
    "- **Sequential**: memory_search -> memory_store (need results before deciding what to store)",
  );

  return lines;
}

// ---------------------------------------------------------------------------
// 4b. Self-Update Gating (skip if minimal or no admin tools)
// ---------------------------------------------------------------------------

/** Tool names that trigger the confirmation flow / self-update gating section. */
export const CONFIRMATION_TOOL_NAMES = ["gateway", "pipeline", "cron", "message", "discord_action", "telegram_action", "slack_action", "whatsapp_action", "subagents"];

/**
 * Build the Self-Update & Configuration section.
 *
 * Contains Self-Update preamble + Confirmation Protocol. Config/Secret
 * integrity content is extracted into buildConfigSecretIntegritySection.
 *
 * @param deferred - When true, returns empty (content delivered via JIT tool result injection).
 */
export function buildSelfUpdateGatingSection(
  toolNames: string[],
  isMinimal: boolean,
  deferred?: boolean,
): string[] {
  if (isMinimal) return [];
  if (deferred) return [];
  const hasAdminTools = toolNames.some((t) => CONFIRMATION_TOOL_NAMES.includes(t));
  if (!hasAdminTools) return [];

  return [
    "## Self-Update & Configuration",
    "System updates and configuration changes are ONLY allowed when the user explicitly asks.",
    "Do not run update, restart, or config-change operations unless the user explicitly requests them.",
    "If the request is ambiguous, ask the user for confirmation first.",
    "After any restart, the system will automatically reconnect to the last active session.",
    "",
    "### Confirmation Protocol for Destructive Actions",
    "When ANY tool action returns `requiresConfirmation: true` (gateway, pipeline, cron, message, discord_action, telegram_action, slack_action, whatsapp_action, subagents):",
    "1. Read the `hint` field in the response for specific guidance.",
    "2. Present the pending action to the user and ask them to confirm.",
    "3. After the user approves, call the SAME tool and action again with `_confirmed: true` added to the parameters.",
    "4. Do NOT claim the action succeeded until you receive a success response from the tool.",
    "If the user declines, inform them the action was not performed.",
  ];
}

/**
 * Build the Config & Secret File Integrity section.
 *
 * Always-present (no deferred parameter). Extracted from buildSelfUpdateGatingSection
 * so that integrity rules remain in the system prompt even when the Self-Update &
 * Confirmation Protocol sections are deferred to JIT injection.
 */
export function buildConfigSecretIntegritySection(
  toolNames: string[],
  isMinimal: boolean,
): string[] {
  if (isMinimal) return [];
  const hasAdminTools = toolNames.some((t) => CONFIRMATION_TOOL_NAMES.includes(t));
  if (!hasAdminTools) return [];

  return [
    "## Config & Secret File Integrity",
    "",
    "### Config File Integrity",
    "Never modify config YAML files directly -- not via read/edit/write tools, and not via exec (sed, awk, tee, etc.).",
    "All config changes MUST go through the gateway tool's patch/apply actions, which provide:",
    "- Schema validation before write",
    "- Git-backed version history and rollback",
    "- Audit event logging",
    "- Automatic daemon restart",
    "Direct file edits bypass all of these safeguards and can corrupt YAML structure.",
    "",
    "### Secret File Integrity",
    "Never modify .env files directly -- not via read/edit/write tools, and not via exec (sed, awk, tee, etc.).",
    "The .env file at ~/.comis/.env contains credentials managed by SecretManager.",
    "Direct edits bypass secret redaction, audit logging, and can leak credentials into chat history.",
  ];
}

// ---------------------------------------------------------------------------
// 4c. Compacted Output Recovery (skip if minimal)
// ---------------------------------------------------------------------------

export function buildCompactedOutputRecoverySection(
  isMinimal: boolean,
): string[] {
  if (isMinimal) return [];
  return [
    "## Handling Compacted Output",
    "If you see `[compacted]` or `[truncated]` markers in tool output or conversation history:",
    "- The original content was reduced to free context space.",
    "- Do NOT request the full content again with the same parameters.",
    "- Re-read only what you need using smaller chunks: use `read` with offset/limit, or targeted `grep` searches.",
    "- Assume prior output was valid; work with the remaining context.",
  ];
}

// ---------------------------------------------------------------------------
// 5b. Privileged Tools & Approval Gate (skip if minimal or no privileged tools)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5c. Coding & Execution Fallback (skip if minimal or no exec tool)
// ---------------------------------------------------------------------------

/**
 * Build the Coding & Execution Fallback section.
 *
 * @param deferred - When true, returns empty (content delivered via JIT tool result injection).
 */
export function buildCodingFallbackSection(
  toolNames: string[],
  isMinimal: boolean,
  deferred?: boolean,
): string[] {
  if (isMinimal) return [];
  if (deferred) return [];
  if (!toolNames.includes("exec")) return [];

  const lines: string[] = [
    "## Coding & Execution Fallback",
    "",
    "When no existing tool or skill directly addresses the user's request, use the `exec` tool",
    "to write and run code that solves the problem. This is your general-purpose fallback capability.",
    "",
    "### When to use exec as fallback",
    "- Data processing, calculations, or transformations the user needs",
    "- File format conversions, text parsing, or data extraction",
    "- Generating or manipulating content programmatically",
    "- Any task where a short script can produce the answer",
    "- Quick prototyping or testing ideas",
    "",
    "### Guidelines",
    "- Prefer Python 3 for one-off scripts (broadly capable, good stdlib)",
    "- For simple shell tasks, use bash directly",
    "- Always capture and return output to the user",
    "- Clean up temporary files when done",
    "- The execution environment is headless (no display server). Do not use interactive GUIs (plt.show(), cv2.imshow(), tkinter). Save visual output to files instead (e.g., plt.savefig()).",
  ];

  return lines;
}

// ---------------------------------------------------------------------------
// 5b. Privileged Tools & Approval Gate (skip if minimal or no privileged tools)
// ---------------------------------------------------------------------------

/** The 11 privileged/supervisor tool names. */
export const PRIVILEGED_TOOL_NAMES = [
  "agents_manage", "obs_query", "sessions_manage", "memory_manage",
  "channels_manage", "tokens_manage", "models_manage", "providers_manage",
  "skills_manage", "mcp_manage", "heartbeat_manage",
];

/**
 * Build the Privileged Tools & Approval Gate section.
 *
 * Included only when at least one privileged tool is present in toolNames
 * and mode is not minimal. Covers overview, approval gate behavior, and
 * fleet management patterns.
 */
// ---------------------------------------------------------------------------
// 5a. Task Delegation (skip if minimal or no sessions_spawn)
// ---------------------------------------------------------------------------

/**
 * Build the Task Delegation section.
 *
 * Top-level section with concrete heuristics for when to delegate work
 * to a sub-agent. Task-type-agnostic -- covers coding, research, media,
 * data processing, and any other long-running work.
 */
/**
 * Build the Task Delegation section.
 *
 * @param deferred - When true, returns empty (content delivered via JIT tool result injection).
 */
export function buildTaskDelegationSection(
  toolNames: string[],
  isMinimal: boolean,
  subAgentToolNames?: string[],
  mcpToolsInherited?: boolean,
  deferred?: boolean,
): string[] {
  if (isMinimal) return [];
  if (deferred) return [];
  if (!toolNames.includes("sessions_spawn")) return [];

  const lines: string[] = [
    "## Task Delegation",
    "",
    "You MUST delegate tasks to a sub-agent when the work matches ANY of these criteria:",
    "",
    "### Delegation Criteria (ANY match = delegate)",
    "- **Image/media generation**: ALL image generation, video, TTS, or media creation tasks — these take 15-120+ seconds and MUST be delegated",
    "- **Multi-file creation**: Writing 3 or more files (code projects, configs, templates)",
    "- **Build/install/compile steps**: Tasks requiring package installs, compilation, or build pipelines",
    "- **Deep research**: Multi-source investigation, comparison analysis, or literature review",
    "- **Iterative trial-and-error**: Tasks likely to need multiple attempts (debugging, optimization, tuning)",
    "- **Large content generation**: Long documents, translations, data processing over ~1KB output",
    "- **Multi-step workflows**: Tasks with 4+ sequential steps where each depends on the prior result",
    "- **Time-intensive operations**: Any task where tool execution alone will take >30 seconds",
    "",
    "### How to Delegate",
    "1. Use `sessions_spawn` with `async=true` and a **goal-oriented** task description",
    "2. Describe WHAT to accomplish, not HOW -- the sub-agent has its own skills and will read SKILL.md itself",
    "3. Do NOT copy-paste skill instructions, shell commands, or step-by-step procedures into the task",
    "4. Include user context the sub-agent needs (e.g., desired style, dimensions, topic) but not tool instructions",
    "5. Set `announce_channel_type` and `announce_channel_id` for result delivery",
    "6. Tell the user the task is delegated and give them the runId",
    "7. Continue the conversation -- the result will be announced automatically when done",
    "",
    "**Example (GOOD):** `\"Generate a majestic lobster at sunset, cinematic golden hour lighting, 1280x720\"`",
    "**Example (BAD):** `\"Run gemini extensions list | grep nanobanana, then if missing install it with...\"`",
    "",
    "### Parallel Sub-Agents",
    "When a task has independent subtasks, spawn multiple sub-agents in parallel:",
    "- Call `sessions_spawn` multiple times in the SAME response (parallel tool calls)",
    "- Each sub-agent gets a focused, self-contained task description",
    "- All sub-agents run concurrently and announce results independently",
    "- Examples: research topic A + topic B simultaneously, build frontend + backend in parallel,",
    "  generate report + create visualization at the same time",
    "- Use `subagents` (action=\"list\") to check progress of all running sub-agents",
    "",
    "### Do NOT Delegate",
    "- Quick lookups, single-file reads, simple questions, status checks",
    "- Single-file edits or small writes (<50 lines)",
    "- Tasks the user wants answered immediately in-conversation",
  ];

  // Sub-agent tool awareness: inform parent about sub-agent capabilities
  if (subAgentToolNames && subAgentToolNames.length > 0) {
    // MCP tools (mcp__*) are inherited by sub-agents when mcpToolsInherited is true,
    // so exclude them from the "do NOT have" list to avoid false negatives.
    const parentOnly = toolNames.filter(t => {
      if (subAgentToolNames.includes(t)) return false;
      if (mcpToolsInherited && t.startsWith("mcp__")) return false;
      return true;
    });
    lines.push(
      "",
      "### Sub-Agent Tool Awareness",
      "",
      `Sub-agents have these tools: ${subAgentToolNames.join(", ")}`,
    );
    if (mcpToolsInherited) {
      lines.push(
        "Sub-agents also inherit ALL MCP tools (mcp__*) from your tool set.",
      );
    }
    if (parentOnly.length > 0) {
      lines.push(
        "",
        `Sub-agents do NOT have: ${parentOnly.join(", ")}`,
        "",
        "**CRITICAL:** Do NOT instruct sub-agents to use tools they don't have.",
        "If a task requires a tool only you have (e.g., `message` for sending results),",
        "handle that step yourself after the sub-agent completes its work.",
        "For example: delegate image generation, then send the result yourself using `message`.",
      );
    }
  }

  lines.push(
    "",
    "When in doubt, delegate. A responsive conversation with background work is always better than",
    "a blocked conversation that makes the user wait.",
  );

  return lines;
}

// ---------------------------------------------------------------------------
// 5b. Privileged Tools & Approval Gate (skip if minimal or no privileged tools)
// ---------------------------------------------------------------------------

/**
 * Build the Privileged Tools & Approval Gate section.
 *
 * @param deferred - When true, returns empty (content delivered via JIT tool result injection).
 */
export function buildPrivilegedToolsSection(
  toolNames: string[],
  isMinimal: boolean,
  deferred?: boolean,
): string[] {
  if (isMinimal) return [];
  if (deferred) return [];
  const present = PRIVILEGED_TOOL_NAMES.filter((t) => toolNames.includes(t));
  if (present.length === 0) return [];

  const lines: string[] = [
    "## Privileged Tools & Approval Gate",
    "",
    "These tools require admin trust level. Some actions are gated by the approval system --",
    "calling a gated action will pause execution until the operator approves or denies it.",
    "",
    "### Gated vs Read-Only Actions",
    "",
    "**Gated (destructive/mutating) -- execution pauses for approval:**",
    "- agents_manage: create, delete",
    "- sessions_manage: delete, reset",
    "- memory_manage: delete, flush",
    "- channels_manage: enable, disable, restart",
    "- tokens_manage: create, revoke, rotate",
    "- providers_manage: create, delete",
    "",
    "**Read-only (no approval needed):**",
    "- obs_query: all actions (diagnostics, billing, traces, activity)",
    "- models_manage: all actions (list models, test availability)",
    "- agents_manage: get, update, suspend, resume",
    "- sessions_manage: export, compact",
    "- memory_manage: stats, browse, export",
    "- channels_manage: list, get",
    "- tokens_manage: list",
    "- providers_manage: list, get, update, enable, disable",
    "",
    "### Approval Gate Behavior",
    "",
    "When you call a gated action, the following happens automatically:",
    "1. Execution pauses -- you do not need to do anything special.",
    "2. The operator receives a notification with the action details.",
    "3. The operator approves or denies the request (or it times out and auto-denies).",
    "4. If approved: the action completes and you receive the result normally.",
    "5. If denied: you receive an error with the denial reason. Inform the user and do not retry the same action unless the user explicitly asks.",
    "6. If timed out: treat as denial -- the operator was not available.",
    "",
    "Do not ask the user for permission before calling a gated action -- the approval gate handles that. Just call the tool and the system manages the rest.",
    "",
    "### Fleet Management Patterns",
    "",
    "- **Create vs reuse**: Before creating a new agent, check if one with the right configuration already exists (agents_manage get). Reuse when possible.",
    "- **Workspace files**: After creating a new agent, customize its workspace files — ROLE.md (role/behavior), TOOLS.md (tool notes), IDENTITY.md (name/vibe). AGENTS.md and SOUL.md are read-only platform files.",
    "- **Suspend vs delete**: Suspend pauses an agent temporarily (reversible, config preserved). Delete removes the agent entirely (irreversible, requires approval). Use suspend for temporary situations; delete only when the agent is no longer needed.",
    "- **Reset vs delete session**: Reset clears messages but keeps the session identity (good for \"start fresh\"). Delete archives the transcript and removes the session entirely.",
    "- **Memory delete vs flush**: Delete removes specific entries by ID (surgical). Flush removes all entries for a scope (nuclear -- use with caution, requires approval).",
    "- **Token rotation**: Prefer rotate over revoke+create -- rotation is atomic and prevents downtime.",
    "- **Provider then agent**: When adding any custom provider (cloud, local, or self-hosted), first create the provider entry (providers_manage create), store the API key if needed (gateway env_set -- skip for keyless providers like Ollama), then switch the agent (agents_manage update). Never set an agent's model to a name that has no matching provider.",
    "- **Failover chain**: After creating multiple providers, configure automatic model failover on the agent (agents_manage update with modelFailover.fallbackModels). Each fallback entry is a {provider, modelId} pair referencing a configured provider. Failover order: primary > cache-aware retry > auth key rotation > fallback models in order. Never add a fallback model whose provider does not exist.",
    "- **Add vs replace fallback**: modelFailover.fallbackModels and authProfiles are REPLACED wholesale on update (scalar fields deep-merge; arrays do not). When the user says 'add' / 'also' / 'in addition', call agents_manage get FIRST to read the current array, append, then update with the full list. When the user says 'set' / 'use' / 'switch to', overwrite directly.",
    "- **Fleet-wide changes**: providers_manage and agents_manage operate on one entity at a time. For fleet-wide provider/model/failover changes: (1) create new provider(s) first, (2) agents_manage list to discover agents, (3) agents_manage update x N in parallel (one call per agent in the same turn). Group agents by model tier for tiered failover (e.g. opus agents get different fallbacks than sonnet agents).",
  ];

  return lines;
}
