/**
 * Lean tool descriptions (LEAN_TOOL_DESCRIPTIONS) and summaries (TOOL_SUMMARIES)
 * for the dual-summary description layer.
 *
 * LEAN_TOOL_DESCRIPTIONS: <=300 chars each, unix man-page voice, sent in API
 * tool definitions. Static strings or dynamic builders (channel-type, trust-level).
 *
 * TOOL_SUMMARIES: 5-8 word terse summaries for system prompt orientation.
 *
 * TOOL_ORDER: Attention-aware ordering per "Lost in the Middle" U-shaped bias.
 *
 * resolveDescription(): Fallback chain: dynamic builder -> static lean -> tool name.
 *
 * Build-time assertion ensures LEAN keys are a subset of SUMMARY keys, with
 * NATIVE_TOOLS allowlist for self-describing native file tools.
 *
 * @module
 */

import type { ModelTier } from "./tooling-sections.js";
import { getToolMetadata } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for dynamic tool description builders. */
export interface ToolDescriptionContext {
  channelType?: string;
  trustLevel?: string;
  modelTier: ModelTier;
}

// ---------------------------------------------------------------------------
// TOOL_SUMMARIES: 5-8 word terse summaries (system prompt orientation)
// ---------------------------------------------------------------------------

/** Terse 5-8 word summaries for system prompt "Available Tools" listing. */
export const TOOL_SUMMARIES: Record<string, string> = {
  // File tools
  read: "Read files, images, and PDFs with pagination",
  edit: "Batch edit files via text matching",
  notebook_edit: "Edit Jupyter notebook cells by ID/index",
  write: "Create or overwrite files completely",
  grep: "Search by regex with glob/context/limit",
  find: "Find files by glob (limit 1000)",
  ls: "List directory contents (limit 500)",
  apply_patch: "Apply multi-file patches (3+ file edits)",
  // Exec / Process
  exec: "Run commands/scripts (bash, Python, Node.js)",
  process: "Manage long-running background exec sessions",
  // Web
  web_search: "Search the web for information",
  web_fetch: "Fetch URL content (HTML/PDF/JSON extracted)",
  // Memory
  memory_search: "Search stored facts and preferences",
  memory_store: "Save facts for future recall",
  memory_get: "Read workspace configuration files directly",
  // Channel
  message: "Send, reply, react in chat",
  // Sessions
  sessions_list: "List active sessions with filters",
  sessions_history: "Fetch another session's conversation history",
  sessions_send: "Send message to another session",
  sessions_spawn: "Spawn sub-agent for background work",
  subagents: "List, steer, or kill sub-agents",
  pipeline: "Execute multi-node DAG workflow pipelines",
  session_status: "Show agent status and usage",
  session_search: "Search full session transcript history",
  agents_list: "List all available agent IDs",
  // Platform
  cron: "Manage cron jobs and reminders",
  gateway: "Read or patch system config",
  image_analyze: "Analyze images with vision model",
  tts_synthesize: "Synthesize speech from text input",
  transcribe_audio: "Transcribe audio recordings to text",
  describe_video: "Describe video content as text",
  extract_document: "Extract readable text from documents",
  browser: "Headless browser (interactive pages only)",
  // Platform actions
  discord_action: "Perform actions on Discord platform",
  telegram_action: "Perform actions on Telegram platform",
  slack_action: "Perform actions on Slack platform",
  whatsapp_action: "Perform actions on WhatsApp platform",
  // Context
  ctx_search: "Search current context window entries",
  ctx_inspect: "Inspect individual context entry details",
  ctx_expand: "Expand compressed or summarized entries",
  ctx_recall: "Recall evicted context by query",
  // Privileged / Supervisor
  agents_manage: "Manage full agent fleet (admin)",
  obs_query: "Query platform diagnostics data (admin)",
  sessions_manage: "Manage session lifecycle operations (admin)",
  memory_manage: "Admin memory CRUD operations (admin)",
  channels_manage: "Manage channel adapter status (admin)",
  tokens_manage: "Manage gateway API tokens (admin)",
  models_manage: "List models and test availability",
  skills_manage: "Manage skill registry entries (admin)",
  mcp_manage: "Manage MCP server connections (admin)",
  heartbeat_manage: "Manage agent heartbeat schedules (admin)",
  // Discovery
  discover_tools: "Find MCP/deferred tools by keyword",
};

// ---------------------------------------------------------------------------
// LEAN_TOOL_DESCRIPTIONS: <=300 chars, unix man-page voice (API tool defs)
// ---------------------------------------------------------------------------

/**
 * Lean descriptions for API tool definitions. Each entry <=300 chars when resolved.
 * Function entries produce dynamic descriptions based on channel type or trust level.
 *
 * Confusable pairs have explicit disambiguation suffixes pointing to the correct
 * alternative tool.
 */
export const LEAN_TOOL_DESCRIPTIONS: Record<string, string | ((ctx: ToolDescriptionContext) => string)> = {
  // ----- File tools (notebook_edit + apply_patch only; read/edit/write/grep/find/ls are Comis-native with self-contained descriptions) -----
  notebook_edit: "Cell-level notebook editing: replace, insert, delete cells by ID or cell-N index. Clears code outputs on replace. Not for .py/.txt -- use edit.",
  apply_patch: "Apply multi-file patches atomically in Begin Patch format. Preferred for 3+ file edits. For 1-2 files use edit instead.",

  // ----- Exec / Process -----
  exec: "Run shell commands and scripts (bash, Python, Node.js). Use as general-purpose fallback for tasks no other tool handles (data processing, charts, conversions). Do NOT use for: file read (use read), grep (use grep), find (use find), curl (use web_fetch).",
  process: "Manage background exec sessions: list, kill, status, read logs.",

  // ----- Web -----
  web_search: "Search the web for current information. May return partial results — retry with refined query if needed.",
  web_fetch: "Fetch content from URL (HTML, PDF, JSON auto-detected). Readable extraction. Use this, not exec curl/wget.",

  // ----- Memory (confusable pair: memory_search / session_search) -----
  memory_search: "Search stored facts and preferences. Returns empty if no match — not an error. For session history, use session_search.",
  memory_store: "Save facts, preferences, decisions, and context for future recall.",
  memory_get: "Read workspace files (SOUL.md, TOOLS.md, etc.).",

  // ----- Channel (confusable pair: message / sessions_send) -----
  message: (ctx: ToolDescriptionContext): string => {
    const ch = ctx.channelType ?? "chat";
    return `Send, reply, react, edit, delete, fetch messages on ${ch}. For inter-session messaging, use sessions_send.`;
  },

  // ----- Sessions -----
  // Confusable pair: sessions_list / agents_list
  sessions_list: "List active sessions with filters. For available agent IDs, use agents_list.",
  sessions_history: "Fetch conversation history for another session or sub-agent.",
  // Confusable pair: sessions_send / message
  sessions_send: "Send message to another session. For chat channel messages, use message.",
  sessions_spawn: "Spawn a sub-agent session for background work (sync or async).",
  subagents: "List, steer, or kill sub-agent runs for this session.",
  pipeline: "Define, execute, monitor, and cancel multi-node DAG execution graphs.",
  session_status: "Show agent status card: usage, model, steps. Optional per-session model override.",
  // Confusable pair: session_search / memory_search
  session_search: "Search full session transcript including evicted content. For stored facts, use memory_search.",
  // Confusable pair: agents_list / sessions_list
  agents_list: "List available agent IDs for spawning. For active sessions, use sessions_list.",

  // ----- Platform -----
  cron: "Manage cron jobs, scheduled tasks, and reminders.",
  gateway: "Read/patch config, restart gateway, check status.",
  image_analyze: "Analyze images (PNG, JPG, GIF, WebP) via vision model. Accepts file paths, URLs, base64, or attachment_url.",
  tts_synthesize: "Text-to-speech synthesis with configurable voice and format.",
  transcribe_audio: "Transcribe audio (MP3, OGG, WAV, M4A) to text. Pass attachment_url from message hint.",
  describe_video: "Describe video content (MP4, MOV, WebM) as text. Pass attachment_url from message hint.",
  extract_document: "Extract text from PDF, CSV, TXT, DOCX, XLSX. Pass attachment_url from message hint or file path.",
  browser: "Headless browser: navigate, screenshot, click, fill forms, extract. For simple fetch, use web_fetch.",

  // ----- Platform actions -----
  discord_action: "Discord actions: pin, kick, ban, roles, threads, channels, presence.",
  telegram_action: "Telegram actions: pin, poll, sticker, chat info, admin, topics.",
  slack_action: "Slack actions: pin, topic, archive, channels, invites.",
  whatsapp_action: "WhatsApp actions: group management, participants, settings.",

  // ----- Context -----
  ctx_search: "Search context window for matching entries by query.",
  ctx_inspect: "Inspect detailed metadata of a context entry by ID.",
  ctx_expand: "Expand a compressed or summarized context entry to full content.",
  ctx_recall: "Recall evicted context entries by semantic query.",

  // ----- Privileged / Supervisor (dynamic: admin suffix) -----
  agents_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage agent fleet: create, get, update, delete, suspend, resume.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  obs_query: (ctx: ToolDescriptionContext): string => {
    const base = "Query platform diagnostics, billing data, delivery traces, and channel activity.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  // Confusable pair: sessions_manage / sessions_list
  sessions_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Admin lifecycle: delete, reset, export, compact sessions. For read-only listing, use sessions_list.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  // Confusable pair: memory_manage / memory_search
  memory_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Admin memory CRUD: stats, browse, delete, flush, export. For search queries, use memory_search.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  channels_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage channel adapters: list, status, enable, disable, restart.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  tokens_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage gateway tokens: list, create, revoke, rotate.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  models_manage: "List available models and test provider availability.",
  skills_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage skill registry: list, reload, enable, disable skills.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  mcp_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage MCP server connections: list, connect, disconnect, status.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },
  heartbeat_manage: (ctx: ToolDescriptionContext): string => {
    const base = "Manage heartbeat schedules: list, create, update, delete, trigger.";
    return ctx.trustLevel === "admin" ? base : base + " Admin required.";
  },

  // ----- Discovery -----
  discover_tools: "Search deferred tools by keyword or description. Returns ranked matches with name, description, and parameter schema. NOT memory_search.",
};

// ---------------------------------------------------------------------------
// TOOL_ORDER: Attention-aware ordering (U-shaped bias: "Lost in the Middle")
// ---------------------------------------------------------------------------

/**
 * Preferred display order for tools. High-frequency tools at start and end,
 * low-frequency tools in the middle, following the U-shaped attention pattern
 * from "Lost in the Middle" (Liu et al., 2023).
 */
export const TOOL_ORDER: string[] = [
  // Start (high-frequency): file ops, messaging, memory, web
  "read", "edit", "notebook_edit", "write", "exec", "message", "memory_search", "web_search",
  // Middle (low-frequency): platform actions, privileged, context, media
  "discord_action", "telegram_action", "slack_action", "whatsapp_action",
  "agents_manage", "obs_query", "sessions_manage", "memory_manage",
  "channels_manage", "tokens_manage", "models_manage", "skills_manage", "mcp_manage", "heartbeat_manage",
  "ctx_search", "ctx_inspect", "ctx_expand", "ctx_recall",
  "image_analyze", "tts_synthesize", "transcribe_audio", "describe_video", "extract_document",
  "browser", "gateway",
  // End (medium-frequency): file nav, sessions, process, cron
  "grep", "find", "ls", "apply_patch",
  "memory_store", "memory_get",
  "web_fetch",
  "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
  "subagents", "pipeline", "session_status", "session_search", "agents_list",
  "cron", "process",
  "discover_tools",
];

// ---------------------------------------------------------------------------
// TOOL_GUIDES: Verbose operational guidance injected on first tool use
// ---------------------------------------------------------------------------

/**
 * Verbose operational guides for complex tools. Delivered via JIT injection
 * (appended to tool result content) on first use within a session.
 *
 * Only tools that require multi-paragraph operational context are listed here.
 * Not all tools need guides -- most are self-explanatory from their lean description.
 */
export const TOOL_GUIDES: Record<string, string> = {
  agents_manage: `## Workspace Customization Guide
Each agent gets a workspace at ~/.comis/workspace-{agentId}/ with these files:
IDENTITY.md (CRITICAL): Set Name, Creature, Vibe, Emoji. A filled Name auto-skips onboarding.
ROLE.md (CRITICAL): Agent role, behavioral guidelines, domain conventions.
USER.md: Pre-fill with known user info (name, timezone, language).
TOOLS.md: Replace defaults with actual tool notes, or clear.
BOOTSTRAP.md: Write empty string to skip interactive onboarding.
AGENTS.md: DO NOT MODIFY (read-only platform instructions).
SOUL.md: DO NOT MODIFY (read-only core personality).
## Workspace Profile
workspace_profile: 'specialist' (~800 tokens) for task workers and fleet sub-agents.
workspace_profile: 'full' (~9K tokens) for user-facing agents on channels.
## Tool Defaults
All built-in tools ENABLED by default (except browser). Do NOT disable tools unless explicitly requested.
maxSteps default: 50. Do NOT set below 20.
## Batch Creation
Present a plan to the user before creating agents in batch.
Multiple agents can be created in one turn. Customize ALL workspace files for each agent after creation.`,

  pipeline: `## Pipeline Usage Guide
Use 'define' action first to validate graph structure before save/execute.
CRITICAL: A node receives ONLY the outputs from nodes listed in its depends_on. This is the sole data flow mechanism -- there is no shared state. For fan-in, list ALL required upstream sources in each consumer's depends_on. If node C needs outputs from both A and B, set depends_on: ["A", "B"] -- depending only on an intermediate node that consumed A and B does NOT propagate their outputs.
Use {{nodeId.result}} to inline specific upstream output. Use \${VARIABLE_NAME} for user-provided inputs.
Set retries (0-3) for auto-retry with exponential backoff.
Most nodes need NO type_id/type_config -- omit both for regular single-agent nodes.
For multi-agent node types (debate, vote, refine, collaborate, approval-gate, map-reduce): set BOTH type_id AND type_config together. Never set one without the other.
Required type_config fields: debate requires agents (2+ strings) + optional rounds/synthesizer; vote requires voters (2+ strings); refine requires reviewers (2+ strings); map-reduce requires mappers + reducer.
Set context_mode to 'summary' or 'none' on fan-in nodes.
Action requirements: define requires nodes; execute requires nodes OR saved pipeline id; save requires label + nodes (or uses cached graph); load/delete requires id; status optional graph_id or recent_minutes; cancel/outputs requires graph_id.`,

  sessions_spawn: `## Sub-Agent Workspace Isolation
Each sub-agent has an isolated workspace at ~/.comis/workspace-{agentId}/. Do NOT instruct sub-agents to write to your workspace -- path security blocks it. Have them write to their own workspace; retrieve from spawn response.`,

  gateway: `## Gateway Security
CRITICAL: Security-sensitive paths (security, gateway.tls, gateway.tokens) CANNOT be patched -- attempts will be rejected. Restart, patch, apply, rollback, and env_set require confirmation. Config changes go through schema validation, git-backed versioning, and audit logging.
IMPORTANT: Never modify config YAML files directly -- always use gateway tool actions.`,

  channels_manage: `## Channel Management Side Effects
Enable, disable, and configure actions persist to config.yaml and trigger daemon restart. Current execution terminates after the tool returns. Batch changes together and warn the user before proceeding.`,

  exec: `## Exec Guide
IMPORTANT: Do NOT use exec for operations that have dedicated tools:
- File reading -> use read tool (not cat/head/tail/less)
- File editing -> use edit tool (not sed/awk/perl -pi)
- File writing -> use write tool (not echo/cat redirect)
- File search -> use grep tool (not grep/rg/ag)
- File finding -> use find tool (not find/fd/locate)
- URL fetching -> use web_fetch tool (not curl/wget/httpie)
- Multi-file patches -> use apply_patch tool (not manual edits)
Dedicated tools provide security sandboxing, consistent output formatting, and better error messages.
Use exec only for: package management (npm/pip/apt), build commands, git operations, system admin, custom scripts, and tasks with no dedicated tool.
Always pass a short \`description\` (e.g. "Installing npm packages", "Running test suite") so the user sees a meaningful activity label instead of raw command text.
## PTY Mode
Pass \`pty: true\` when running interactive CLI tools that require a terminal (e.g. \`claude -p\`). This allocates a real pseudo-terminal so the child process sees isTTY=true. Do NOT manually wrap commands in \`script\` or \`python3 pty\` — use the \`pty\` parameter instead.
## Destructive Operations
Before running commands that are hard to reverse, explain what will happen and why:
- git reset --hard, git push --force, git clean — prefer non-destructive alternatives first
- rm -rf on directories — confirm scope, prefer trash/backup when possible
- Database mutations (DROP, TRUNCATE, DELETE without WHERE)
- Package removal (npm uninstall, pip uninstall, apt remove)
- Process killing (kill -9, pkill) — prefer graceful SIGTERM first
Do NOT add --force, --no-verify, or -f flags unless the user specifically requests them.
## Sleep & Polling
Do not use standalone \`sleep\` commands to wait for background work. Instead:
- Use \`background: true\` and the \`process\` tool to poll completion
- If polling an external process, check status directly rather than sleeping first
- Keep any necessary sleep to 2 seconds or less
## Exit Codes
These exit codes are NOT errors — do not retry or report failure:
- grep/rg exit 1: No matches found (expected when searching)
- find exit 1: Some directories inaccessible (partial results still valid)
- diff exit 1: Files differ (expected when comparing)
- test/[ exit 1: Condition is false (expected in conditionals)
Only exit code >= 2 for these commands indicates an actual error.`,

  message: `## Message Guide
IMPORTANT: Always include channel_type and channel_id from the conversation context. Do NOT guess or fabricate channel IDs.
For reply: always include message_id of the message being replied to.
For react: use Unicode emoji (e.g., the actual emoji character), not text shortcodes (e.g., ":thumbsup:"). Platform adapters handle conversion.
For delete: requires user confirmation (_confirmed: true). Present the action to the user first and wait for approval.
For attach: attachment_url can be a workspace file path, http(s):// URL, or platform-specific attachment URL.
For fetch: returns most recent messages first. Use before and limit params for pagination.
CRITICAL: Never send messages to channels the user has not explicitly specified or confirmed. Cross-channel messaging is a safety boundary.
### When NOT to send
- Do NOT send status/progress messages ("working...", "scanning...", "one moment").
  The typing indicator already shows the user you're active.
- Do NOT send test/debug messages ("tool test", "testing", "temp").
- Do NOT send placeholder or throwaway text ("(skip)", "(nope)", "(ignore)", " ").
- Do NOT narrate your internal steps to the user. Work silently, deliver the result.
- Every message.send call delivers a real notification to the user's phone.
  Only send when you have substantive, final content worth interrupting them for.`,

  write: `## Write Guide
Do NOT create documentation files (*.md, README, CHANGELOG) or config boilerplate unless the user explicitly requests it. Avoid creating new files when editing an existing file achieves the same goal.
For modifying existing files, prefer the edit tool -- it sends only the diff, preserves encoding, and provides fuzzy matching. Use write only for creating new files or complete rewrites where most of the content changes.
The tool validates JSON, YAML, and JSONC syntax after writing config files. If validation fails, fix the syntax error immediately.`,

  edit: `## Edit Guide
When copying text from read output into oldText, strip the line number prefix. The read tool outputs lines as "lineNumber<tab>content" -- only the content AFTER the tab is actual file text. Never include line numbers in oldText or newText.
Use the smallest unique oldText that identifies the target (typically 2-4 lines of surrounding context). Merge adjacent changes into one edit entry rather than multiple sequential edits to the same region.
When the edit fails with [not_read]: read state resets each message. Read the file in this response before editing, even if you read it in a previous message.
When the edit fails with [text_not_found]: (1) Did you include line numbers? (2) Did indentation change? (3) Is the text stale from a prior read? Re-read the file and retry with fresh content.
When the edit fails with [duplicate_match]: add more surrounding context to make oldText unique, or use replaceAll if all occurrences should change.`,

  read: `## Read Guide
It is safe to read a file that may not exist -- the tool returns a clear error, not a crash. Do NOT pre-check existence with find or ls before reading. Just read it directly.
For large files (>2000 lines), use offset and limit to read specific sections. The first read returns total line count in the output header -- use it to plan subsequent reads. When you only need a specific function or section, grep for it first, then read with a targeted offset.
The output format is "lineNumber<tab>content" per line. When copying text for use in the edit tool, strip the line number prefix -- only the content after the tab is actual file content.`,

  grep: `## Grep Guide
Pattern uses ripgrep regex syntax. Escape special characters with backslash: \\. \\[ \\( \\{ \\* \\+ \\? \\$ \\^ \\|. For text with many specials (e.g., searching for "array[0].value"), use the literal parameter instead.
For open-ended code exploration requiring many search rounds, delegate to a sub-agent rather than running 10+ sequential grep calls.`,

  apply_patch: `## Apply Patch Guide
Use apply_patch when modifying 3 or more files in one logical change. For 1-2 files, prefer individual edit calls (simpler, better error messages).
The patch format uses *** Begin Patch / *** End Patch delimiters with per-file sections:
- *** Add File: path -- followed by the full content for new files
- *** Update File: path -- followed by context lines and +/- diff hunks
- *** Delete File: path -- removes the file
Context lines in Update hunks must match the file exactly (fuzzy matching applies for minor whitespace/encoding diffs, same as edit).
All operations in a patch are atomic -- if any file fails, the entire patch is rejected.`,
};

// ---------------------------------------------------------------------------
// getToolGuideWithSchema: Combined tool guide (prose + output schema)
// ---------------------------------------------------------------------------

/**
 * Get the combined tool guide (prose + output schema) for a tool.
 *
 * Returns undefined when the tool has neither a TOOL_GUIDES entry nor an
 * outputSchema in the metadata registry -- preserving the fast-path in
 * the JIT injector for unguided tools.
 */
export function getToolGuideWithSchema(toolName: string): string | undefined {
  const base = TOOL_GUIDES[toolName];
  const meta = getToolMetadata(toolName);
  if (!base && !meta?.outputSchema) return undefined;

  const schemaText = meta?.outputSchema
    ? `\n## Output Schema\n\`\`\`json\n${JSON.stringify(meta.outputSchema, null, 2)}\n\`\`\``
    : "";
  return (base ?? "") + schemaText;
}

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT_GUIDES: Deferred system prompt sections injected via tool
// result on first trigger tool use
// ---------------------------------------------------------------------------

/**
 * Deferred system prompt section content delivered via JIT injection on first
 * use of the trigger tool. Keyed by tool name (or sentinel key for sections
 * triggered by multiple tools).
 *
 * These sections were previously always-present in the system prompt but are
 * now deferred to save ~2,000 tokens at session start.
 *
 * IMPORTANT: This map must NOT import from tooling-sections.ts to avoid
 * circular dependency. All content is inlined as static strings.
 */
export const SYSTEM_PROMPT_GUIDES: Record<string, string> = {
  // Task Delegation -- triggered by sessions_spawn
  sessions_spawn: `## Task Delegation

You MUST delegate tasks to a sub-agent when the work matches ANY of these criteria:

### Delegation Criteria (ANY match = delegate)
- **Image/media generation**: ALL image generation, video, TTS, or media creation tasks -- these take 15-120+ seconds and MUST be delegated
- **Multi-file creation**: Writing 3 or more files (code projects, configs, templates)
- **Build/install/compile steps**: Tasks requiring package installs, compilation, or build pipelines
- **Deep research**: Multi-source investigation, comparison analysis, or literature review
- **Iterative trial-and-error**: Tasks likely to need multiple attempts (debugging, optimization, tuning)
- **Large content generation**: Long documents, translations, data processing over ~1KB output
- **Multi-step workflows**: Tasks with 4+ sequential steps where each depends on the prior result
- **Time-intensive operations**: Any task where tool execution alone will take >30 seconds

### How to Delegate
1. Use \`sessions_spawn\` with \`async=true\` and a **goal-oriented** task description
2. Describe WHAT to accomplish, not HOW -- the sub-agent has its own skills and will read SKILL.md itself
3. Do NOT copy-paste skill instructions, shell commands, or step-by-step procedures into the task
4. Include user context the sub-agent needs (e.g., desired style, dimensions, topic) but not tool instructions
5. Set \`announce_channel_type\` and \`announce_channel_id\` for result delivery
6. Tell the user the task is delegated and give them the runId
7. Continue the conversation -- the result will be announced automatically when done

### Parallel Sub-Agents
When a task has independent subtasks, spawn multiple sub-agents in parallel:
- Call \`sessions_spawn\` multiple times in the SAME response (parallel tool calls)
- Each sub-agent gets a focused, self-contained task description
- All sub-agents run concurrently and announce results independently
- Use \`subagents\` (action="list") to check progress of all running sub-agents

### Do NOT Delegate
- Quick lookups, single-file reads, simple questions, status checks
- Single-file edits or small writes (<50 lines)
- Tasks the user wants answered immediately in-conversation

When in doubt, delegate. A responsive conversation with background work is always better than a blocked conversation that makes the user wait.`,

  // Self-Update & Confirmation Protocol -- triggered by gateway
  gateway: `## Self-Update & Configuration
System updates and configuration changes are ONLY allowed when the user explicitly asks.
Do not run update, restart, or config-change operations unless the user explicitly requests them.
If the request is ambiguous, ask the user for confirmation first.
After any restart, the system will automatically reconnect to the last active session.

### Confirmation Protocol for Destructive Actions
When ANY tool action returns \`requiresConfirmation: true\` (gateway, pipeline, cron, message, discord_action, telegram_action, slack_action, whatsapp_action, subagents):
1. Read the \`hint\` field in the response for specific guidance.
2. Present the pending action to the user and ask them to confirm.
3. After the user approves, call the SAME tool and action again with \`_confirmed: true\` added to the parameters.
4. Do NOT claim the action succeeded until you receive a success response from the tool.
If the user declines, inform them the action was not performed.`,

  // Coding & Execution Fallback -- triggered by exec
  exec: `## Coding & Execution Fallback

When no existing tool or skill directly addresses the user's request, use the \`exec\` tool
to write and run code that solves the problem. This is your general-purpose fallback capability.

### When to use exec as fallback
- Data processing, calculations, or transformations the user needs
- File format conversions, text parsing, or data extraction
- Generating or manipulating content programmatically
- Any task where a short script can produce the answer
- Quick prototyping or testing ideas

### Guidelines
- Prefer Python 3 for one-off scripts (broadly capable, good stdlib)
- For simple shell tasks, use bash directly
- Always capture and return output to the user
- Clean up temporary files when done
- The execution environment is headless (no display server). Do not use interactive GUIs (plt.show(), cv2.imshow(), tkinter). Save visual output to files instead (e.g., plt.savefig()).

### Git Operations
- Prefer creating new commits over amending — amending after a failed hook destroys the previous commit
- Do not force-push without explicit user request
- Stage specific files by name — avoid \`git add .\` which can capture secrets or binaries
- Check \`git status\` and \`git diff\` before committing to verify what will be included
- Use conventional commit format if the project follows it (check recent git log)`,

  // Privileged Tools & Approval Gate -- sentinel key for all privileged tools
  __privileged_tools__: `## Privileged Tools & Approval Gate

These tools require admin trust level. Some actions are gated by the approval system --
calling a gated action will pause execution until the operator approves or denies it.

### Gated vs Read-Only Actions

**Gated (destructive/mutating) -- execution pauses for approval:**
- agents_manage: create, delete
- sessions_manage: delete, reset
- memory_manage: delete, flush
- channels_manage: enable, disable, restart
- tokens_manage: create, revoke, rotate

**Read-only (no approval needed):**
- obs_query: all actions (diagnostics, billing, traces, activity)
- models_manage: all actions (list models, test availability)
- agents_manage: get, update, suspend, resume
- sessions_manage: export, compact
- memory_manage: stats, browse, export
- channels_manage: list, get
- tokens_manage: list

### Approval Gate Behavior

When you call a gated action, the following happens automatically:
1. Execution pauses -- you do not need to do anything special.
2. The operator receives a notification with the action details.
3. The operator approves or denies the request (or it times out and auto-denies).
4. If approved: the action completes and you receive the result normally.
5. If denied: you receive an error with the denial reason. Inform the user and do not retry the same action unless the user explicitly asks.
6. If timed out: treat as denial -- the operator was not available.

Do not ask the user for permission before calling a gated action -- the approval gate handles that. Just call the tool and the system manages the rest.

### Fleet Management Patterns

- **Create vs reuse**: Before creating a new agent, check if one with the right configuration already exists (agents_manage get). Reuse when possible.
- **Workspace files**: After creating a new agent, customize its workspace files -- ROLE.md (role/behavior), TOOLS.md (tool notes), IDENTITY.md (name/vibe). AGENTS.md and SOUL.md are read-only platform files.
- **Suspend vs delete**: Suspend pauses an agent temporarily (reversible, config preserved). Delete removes the agent entirely (irreversible, requires approval). Use suspend for temporary situations; delete only when the agent is no longer needed.
- **Reset vs delete session**: Reset clears messages but keeps the session identity (good for "start fresh"). Delete archives the transcript and removes the session entirely.
- **Memory delete vs flush**: Delete removes specific entries by ID (surgical). Flush removes all entries for a scope (nuclear -- use with caution, requires approval).
- **Token rotation**: Prefer rotate over revoke+create -- rotation is atomic and prevents downtime.`,
};

// ---------------------------------------------------------------------------
// resolveDescription: dynamic builder -> static lean -> tool name
// ---------------------------------------------------------------------------

/**
 * Resolve a tool's lean description from the descriptions map.
 *
 * Fallback chain:
 *   1. Dynamic builder (function entry) invoked with ctx
 *   2. Static lean description (string entry)
 *   3. tool.name (no description available)
 */
export function resolveDescription(
  tool: { name: string; description?: string },
  leanDescriptions: Record<string, string | ((ctx: ToolDescriptionContext) => string)>,
  ctx?: ToolDescriptionContext,
): string {
  const lean = leanDescriptions[tool.name];
  if (typeof lean === "function" && ctx) return lean(ctx);
  if (typeof lean === "function") return lean({ modelTier: "large" }); // fallback context
  if (typeof lean === "string") return lean;
  return tool.name;
}

// ---------------------------------------------------------------------------
// Build-time assertion: LEAN_TOOL_DESCRIPTIONS keys subset of TOOL_SUMMARIES
// ---------------------------------------------------------------------------

// Native file tools (read, edit, write, grep, find, ls) have self-contained
// API descriptions and do not need LEAN_TOOL_DESCRIPTIONS entries. They DO
// need TOOL_SUMMARIES entries for system prompt orientation.
const NATIVE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

const leanKeys = new Set(Object.keys(LEAN_TOOL_DESCRIPTIONS));
const summaryKeys = new Set(Object.keys(TOOL_SUMMARIES));

for (const key of leanKeys) {
  if (!summaryKeys.has(key)) {
    throw new Error(`LEAN_TOOL_DESCRIPTIONS has key "${key}" missing from TOOL_SUMMARIES`);
  }
}

for (const key of summaryKeys) {
  if (!leanKeys.has(key) && !NATIVE_TOOLS.has(key)) {
    throw new Error(`TOOL_SUMMARIES has key "${key}" missing from both LEAN_TOOL_DESCRIPTIONS and NATIVE_TOOLS allowlist`);
  }
}
