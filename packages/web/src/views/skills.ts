// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";
// Side-effect imports for sub-components
import "../components/nav/ic-tabs.js";
import "../components/form/ic-search-input.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-loading.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-tag.js";

type LoadState = "loading" | "loaded" | "error";

/** Built-in tool descriptions keyed by tool name. */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents with line numbers and pagination",
  write: "Write or overwrite files; auto-creates parent directories",
  edit: "Surgical search-and-replace on files (exact text match)",
  grep: "Regex search across files (ripgrep-based)",
  find: "Find files by glob pattern (fd-based)",
  ls: "List directory contents alphabetically",
  exec: "Shell command execution with foreground/background modes",
  process: "Background process management (list, kill, status, log)",
  webSearch: "Multi-provider web search (Brave, DuckDuckGo, Perplexity, Grok, Tavily, Exa, Jina, SearXNG)",
  webFetch: "Fetch and extract content from URLs (markdown, text, readability modes)",
  browser: "Headless browser control (requires Playwright/Chromium)",
};

/** Parameter hints for tools with notable options (shown in detail view). */
const TOOL_PARAM_HINTS: Record<string, string[]> = {
  webSearch: [
    "freshness: pd (past day), pw (past week), pm (past month), py (past year), or YYYY-MM-DDtoYYYY-MM-DD",
    "deepFetch: 0-5 - auto-fetch full page content for top N results",
    "provider: override search provider per call",
  ],
};

/** Tool categories with their tool names. */
const TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  { label: "File Operations", tools: ["read", "write", "edit", "find", "ls"] },
  { label: "Execution", tools: ["exec", "process"] },
  { label: "Search", tools: ["grep"] },
  { label: "Web", tools: ["webSearch", "webFetch", "browser"] },
];

/** All 11 built-in tool names. */
const ALL_TOOLS = TOOL_CATEGORIES.flatMap((c) => c.tools);

/** Profile to base tool set mapping. */
const PROFILE_TOOLS: Record<string, string[]> = {
  minimal: ["exec"],
  coding: ["read", "write", "edit", "grep", "find", "ls", "exec", "process"],
  messaging: ["exec", "webSearch", "webFetch"],
  supervisor: ["read", "write", "edit", "grep", "find", "ls", "exec", "process", "webSearch", "webFetch"],
  full: [...ALL_TOOLS],
};

/** Shape of the skills section from config.read */
interface SkillsConfig {
  discoveryPaths: string[];
  builtinTools: Record<string, boolean>;
  toolPolicy: {
    profile: string;
    allow: string[];
    deny: string[];
  };
  promptSkills: {
    maxBodyLength: number;
    enableDynamicContext: boolean;
    maxAutoInject: number;
    allowedSkills: string[];
    deniedSkills: string[];
  };
}

/** Shape of a discovered prompt skill from skills.list RPC */
interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
  disableModelInvocation?: boolean;
  source?: "bundled" | "workspace" | "local";
}

/** Shape of a live skill execution/rejection event (SSE in-memory append). */
interface SkillEventRecord {
  skillName: string;
  agentId: string;
  timestamp: number;
  outcome: "executed" | "rejected";
  reason?: string;
}

/**
 * Extract agent ID from a skill's location path.
 * Agent workspace paths follow the pattern: .../workspace-{agentId}/skills/...
 * The default agent uses .../workspace/skills/...
 */
function agentIdFromLocation(location: string): string {
  const match = location.match(/\/workspace-([^/]+)\/skills\//);
  if (match) return match[1]!;
  if (/\/workspace\/skills\//.test(location)) return "default";
  return "";
}

/** Result shape from config.read RPC (wraps full config) */
interface ConfigReadResult {
  config: {
    agents?: Record<string, { skills?: SkillsConfig }>;
  };
  sections: string[];
}

/** Tab definitions for the skills view. */
/** Platform tool descriptions keyed by tool name. */
const PLATFORM_TOOL_DESCRIPTIONS: Record<string, string> = {
  memory_search: "Semantic hybrid search across memory and session transcripts",
  memory_get: "Read specific memory file sections by path with line ranges",
  memory_store: "Store facts, preferences, or context in long-term memory",
  memory_manage: "Stats, browse, delete, flush, and export memory entries",
  session_status: "View current session model, token usage, and duration",
  sessions_list: "List active sessions filtered by kind and recency",
  sessions_history: "View conversation history for a session with pagination",
  sessions_send: "Send a message into another session (fire-and-forget, wait, or ping-pong)",
  sessions_spawn: "Spawn a sub-agent session for background work (sync or async)",
  sessions_manage: "Delete, reset, export, or compact session lifecycles",
  agents_list: "List all configured agent IDs in the system",
  agents_manage: "Create, inspect, update, suspend/resume, and delete agents",
  subagents: "List, kill, or steer running sub-agents",
  message: "Send, reply, react, edit, delete, and fetch messages across all channels",
  discord_action: "Pin/unpin, kick/ban, roles, threads, channels, bot presence",
  telegram_action: "Pin/unpin, polls, stickers, chat info, ban/promote members",
  slack_action: "Pin/unpin, topics, archive, create channels, invite/kick, bookmarks",
  whatsapp_action: "Group info, participants, settings, invite codes, profile status",
  image_analyze: "Analyze images using vision AI from files, URLs, or base64",
  tts_synthesize: "Generate speech audio from text via configured TTS provider",
  transcribe_audio: "Transcribe audio/voice attachments to text with language hints",
  describe_video: "Generate text descriptions of video attachments",
  extract_document: "Extract text from PDF, CSV, TXT, and other document formats",
  cron: "Create, list, update, remove, and trigger scheduled jobs",
  gateway: "Read/patch config, set secrets, restart, rollback, and status",
  browser: "Headless browser: navigate, snapshot, screenshot, click, type, tabs",
  obs_query: "Query diagnostics, billing, delivery traces, and channel activity",
  models_manage: "List available models and test provider availability",
  tokens_manage: "List, create, revoke, and rotate gateway auth tokens",
  channels_manage: "List, enable, disable, and restart channel adapters",
  skills_manage: "List, import from GitHub, and delete prompt skills",
};

/** Platform tools grouped by functional category. */
const PLATFORM_TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  { label: "MEMORY", tools: ["memory_search", "memory_get", "memory_store", "memory_manage"] },
  { label: "SESSIONS", tools: ["session_status", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "sessions_manage"] },
  { label: "AGENTS", tools: ["agents_list", "agents_manage", "subagents"] },
  { label: "MESSAGING", tools: ["message", "discord_action", "telegram_action", "slack_action", "whatsapp_action"] },
  { label: "MEDIA", tools: ["image_analyze", "tts_synthesize", "transcribe_audio", "describe_video", "extract_document"] },
  { label: "INFRASTRUCTURE", tools: ["cron", "gateway", "browser", "obs_query"] },
  { label: "FLEET MANAGEMENT", tools: ["models_manage", "tokens_manage", "channels_manage", "skills_manage"] },
];

const TABS = [
  { id: "tools", label: "Built-in Tools" },
  { id: "skills", label: "Prompt Skills" },
];

/**
 * Skills management view with 3 tabs: Built-in Tools (with Platform Tools
 * and Tool Policy merged in), Prompt Skills, and MCP Servers.
 *
 * Loads configuration via config.read RPC and persists changes
 * via config.patch RPC. Each tab provides viewing and inline editing.
 */
@customElement("ic-skills-view")
export class IcSkillsView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .view-header {
        margin-bottom: var(--ic-space-lg);
      }

      .view-title {
        font-size: 1.125rem;
        font-weight: 600;
      }

      /* Loading & error states */
      .state-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3rem;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
      }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .retry-btn:hover {
        background: var(--ic-border);
      }

      /* Category headers */
      .category-header {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: var(--ic-space-lg);
        margin-bottom: var(--ic-space-sm);
      }

      .category-header:first-of-type {
        margin-top: 0;
      }

      /* Tool cards grid */
      .tool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
        gap: var(--ic-space-md);
      }

      .tool-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .tool-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-sm);
      }

      .tool-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
      }

      .tool-desc {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        line-height: 1.4;
      }

      .tool-params {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
        padding-left: var(--ic-space-sm);
        border-left: 2px solid var(--ic-border);
      }

      .tool-params li {
        list-style: none;
        padding: 1px 0;
        font-family: var(--ic-font-mono, monospace);
        font-size: 0.7rem;
      }

      /* Tool status hint */
      .tool-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-sm);
        font-style: italic;
      }

      /* Prompt skills form */
      .form-section {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
        max-width: 32rem;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .form-input {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .form-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .form-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      /* Skill lists (allowed/denied) */
      .list-section {
        margin-top: var(--ic-space-lg);
      }

      .list-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-sm);
      }

      .list-items {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .list-item {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: 0.25rem 0.5rem;
        font-size: var(--ic-text-xs);
      }

      .list-item-remove {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 0;
        font-size: var(--ic-text-xs);
        line-height: 1;
      }

      .list-item-remove:hover {
        color: var(--ic-error);
      }

      .list-add-row {
        display: flex;
        gap: var(--ic-space-xs);
        max-width: 20rem;
      }

      .list-add-input {
        flex: 1;
        padding: 0.375rem 0.5rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-xs);
      }

      .list-add-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .list-add-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        white-space: nowrap;
      }

      .list-add-btn:hover {
        opacity: 0.9;
      }

      .empty-list {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      /* MCP server cards */
      .server-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
      }

      .server-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .server-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-sm);
      }

      .server-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
      }

      .server-meta {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .server-command {
        font-family: ui-monospace, monospace;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        word-break: break-all;
      }

      .server-remove {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 0.125rem 0.25rem;
        font-size: var(--ic-text-sm);
        line-height: 1;
        border-radius: var(--ic-radius-sm);
      }

      .server-remove:hover {
        color: var(--ic-error);
        background: var(--ic-surface-2);
      }

      .server-test-btn {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
        cursor: pointer;
        padding: 0.125rem 0.5rem;
        font-size: var(--ic-text-xs);
        border-radius: var(--ic-radius-sm);
      }

      .server-test-btn:hover:not(:disabled) {
        background: var(--ic-surface-3, var(--ic-surface));
        color: var(--ic-text);
      }

      .server-test-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .server-test-result {
        font-size: var(--ic-text-xs);
        padding: 0.25rem 0.5rem;
        border-radius: var(--ic-radius-sm);
        margin-top: 0.125rem;
      }

      .server-test-success {
        color: var(--ic-success, #22c55e);
        background: rgba(34, 197, 94, 0.1);
      }

      .server-env-badge {
        display: inline-block;
        font-family: ui-monospace, monospace;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        background: rgba(147, 130, 220, 0.15);
        padding: 1px 6px;
        border-radius: 4px;
        margin-top: 2px;
      }

      .server-test-error {
        color: var(--ic-error, #ef4444);
        background: rgba(239, 68, 68, 0.1);
        word-break: break-word;
      }

      /* Add server form */
      .add-server-form {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-lg);
        max-width: 32rem;
      }

      .add-server-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
      }

      .add-server-row {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
      }

      .add-server-input {
        flex: 1;
        min-width: 10rem;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .add-server-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .add-server-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .add-server-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        white-space: nowrap;
      }

      .add-server-btn:hover {
        opacity: 0.9;
      }

      /* Tool policy */
      .policy-section {
        max-width: 32rem;
      }

      .policy-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-md);
      }

      .policy-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        max-width: 16rem;
      }

      .policy-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      /* Resolved tool set */
      .resolved-section {
        margin-top: var(--ic-space-lg);
      }

      .resolved-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-sm);
      }

      .resolved-tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-xs);
      }

      .resolved-denied {
        opacity: 0.4;
        text-decoration: line-through;
      }

      /* Add Skill panel */
      .add-skill-panel {
        margin-top: var(--ic-space-xl);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
      }

      .add-skill-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
      }

      .install-target {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
      }

      .install-target-label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        white-space: nowrap;
      }

      .install-target-select {
        padding: 0.25rem 0.5rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .install-target-select:focus-visible {
        outline: 2px solid var(--ic-accent);
        outline-offset: 2px;
      }

      .install-target-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .add-skill-methods {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-md);
      }

      @media (max-width: 767px) {
        .add-skill-methods {
          grid-template-columns: 1fr;
        }
      }

      .add-skill-method {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .add-skill-method-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .add-skill-method-body {
        flex: 1;
        display: flex;
        align-items: center;
      }

      .upload-skill-btn {
        display: block;
        width: 100%;
        padding: 0.75rem;
        background: var(--ic-surface);
        border: 2px dashed var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-accent);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        text-align: center;
      }

      .upload-skill-btn:hover {
        border-color: var(--ic-accent);
        background: color-mix(in srgb, var(--ic-accent) 5%, var(--ic-surface));
      }

      .upload-skill-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .upload-skill-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-align: center;
      }

      .import-skill-row {
        display: flex;
        gap: var(--ic-space-sm);
      }

      .import-skill-row input {
        flex: 1;
        min-width: 0;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .import-skill-row input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .import-skill-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        font-family: inherit;
      }

      .import-skill-btn:hover {
        opacity: 0.9;
      }

      .import-skill-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .skill-delete-btn {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 0;
        font-size: var(--ic-text-xs);
        line-height: 1;
      }

      .skill-delete-btn:hover {
        color: var(--ic-error);
      }

      /* Recent activity section (SSE live events) */
      .recent-activity {
        margin-top: var(--ic-space-lg);
        border-top: 1px solid var(--ic-border);
        padding-top: var(--ic-space-lg);
      }

      .recent-activity h3 {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-sm);
      }

      .recent-activity-count {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
      }

      .event-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .event-entry {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-xs) var(--ic-space-sm);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-xs);
      }

      .event-skill {
        font-family: var(--ic-font-mono, monospace);
        font-weight: 500;
        color: var(--ic-text);
      }

      .event-agent {
        color: var(--ic-text-dim);
      }

      .event-outcome--executed {
        color: #22c55e;
        font-weight: 500;
      }

      .event-outcome--rejected {
        color: #ef4444;
        font-weight: 500;
      }

      .event-reason {
        color: var(--ic-text-dim);
        font-style: italic;
      }

      .event-time {
        margin-left: auto;
        color: var(--ic-text-dim);
        white-space: nowrap;
      }
    `,
  ];

  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _recentSkillEvents: SkillEventRecord[] = [];
  @state() private _error = "";
  @state() private _activeTab = "tools";
  @state() private _skillsConfig: SkillsConfig | null = null;
  @state() private _discoveredSkills: DiscoveredSkill[] = [];
  /** Agent ID whose skills config is currently being displayed/edited */
  /** Empty string means "All Agents" (no specific agent selected). */
  @state() private _targetAgentId = "";
  @state() private _agentIds: string[] = [];
  @state() private _skillScope: "all" | "local" | "shared" = "all";
  @state() private _defaultAgentId = "default";
  @state() private _searchQuery = "";

  // Skill management state
  @state() private _importUrl = "";
  @state() private _isImportingSkill = false;
  @state() private _isUploadingSkill = false;
  @state() private _deletingSkill: string | null = null;
  /** Install target: which agent to install to (empty = shared/global) */
  @state() private _installAgent = "";
  /** Install scope: "shared" installs to global skills dir, "agent" to agent workspace */
  @state() private _installScope: "shared" | "agent" = "shared";

  // Add-item input state
  @state() private _newAllowedSkill = "";
  @state() private _newDeniedSkill = "";
  @state() private _newPolicyAllow = "";
  @state() private _newPolicyDeny = "";

  private _rpcStatusUnsub: (() => void) | null = null;
  private _dataLoaded = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _tryLoad() is NOT called here -- rpcClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
    }
    if (changed.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "skill:loaded": () => { this._scheduleReload(); },
      "skill:registry_reset": () => { this._scheduleReload(); },
      "agent:hot_added": () => { this._scheduleReload(); },
      "agent:hot_removed": () => { this._scheduleReload(); },
      "skill:executed": (data) => {
        const d = data as { skillName?: string; agentId?: string; timestamp?: number };
        this._recentSkillEvents = [{
          skillName: d.skillName ?? "unknown",
          agentId: d.agentId ?? "",
          timestamp: d.timestamp ?? Date.now(),
          outcome: "executed" as const,
        }, ...this._recentSkillEvents].slice(0, 50);
      },
      "skill:rejected": (data) => {
        const d = data as { skillName?: string; agentId?: string; timestamp?: number; reason?: string };
        this._recentSkillEvents = [{
          skillName: d.skillName ?? "unknown",
          agentId: d.agentId ?? "",
          timestamp: d.timestamp ?? Date.now(),
          outcome: "rejected" as const,
          reason: d.reason,
        }, ...this._recentSkillEvents].slice(0, 50);
      },
    });
  }

  /** Wait for RPC connection before loading data. */
  private _tryLoad(): void {
    if (!this.rpcClient) return;
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      this._loadData();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected" && !this._dataLoaded) {
          this._loadData();
        }
      });
    }
  }

  private async _loadData(): Promise<void> {
    if (!this.rpcClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      const result = await this.rpcClient.call<ConfigReadResult>("config.read");
      // Skills config is per-agent; pick the first agent's skills as the view target
      const agents = result.config?.agents;
      this._agentIds = agents ? Object.keys(agents) : [];
      const firstAgentId = this._agentIds[0];
      if (this._targetAgentId && firstAgentId && !this._agentIds.includes(this._targetAgentId)) {
        this._targetAgentId = firstAgentId;
      }

      // ConfigReadResult does not declare `routing` in its interface - it returns the full
      // YAML config blob as Record<string, unknown>. Cast is necessary because the gateway
      // schema is intentionally loose for forward-compat. Safe: we null-coalesce the fallback.
      const routing = (result.config as Record<string, unknown>)?.routing as Record<string, unknown> | undefined;
      this._defaultAgentId = (routing?.defaultAgentId as string) ?? "default";

      // "All Agents" mode (empty string) -> no agent-specific config
      this._skillsConfig = this._targetAgentId && this._agentIds.includes(this._targetAgentId)
        ? agents![this._targetAgentId]!.skills ?? null
        : null;
      // Show config-based data immediately
      this._dataLoaded = true;
      this._loadState = "loaded";

      // Fetch discovered prompt skills in the background (non-blocking)
      if (this._targetAgentId) {
        // Single agent mode
        this.rpcClient.call<{ skills: DiscoveredSkill[] }>(
          "skills.list",
          { agentId: this._targetAgentId },
        ).then((skillsResult) => {
          this._discoveredSkills = skillsResult.skills ?? [];
        }).catch(() => {
          this._discoveredSkills = [];
        });
      } else {
        // "All Agents" mode: fetch from every agent and merge, deduplicating shared skills
        const rpc = this.rpcClient;
        Promise.allSettled(
          this._agentIds.map((id) =>
            rpc.call<{ skills: DiscoveredSkill[] }>("skills.list", { agentId: id }),
          ),
        ).then((results) => {
          const seen = new Map<string, DiscoveredSkill>();
          for (const r of results) {
            if (r.status !== "fulfilled") continue;
            for (const skill of r.value.skills ?? []) {
              // Shared skills (source: "local") are the same across agents - deduplicate by name.
              // Agent-specific skills use "name:location" as key to keep distinct per-agent entries.
              const key = skill.source === "local" ? skill.name : `${skill.name}:${skill.location}`;
              if (!seen.has(key)) seen.set(key, skill);
            }
          }
          this._discoveredSkills = [...seen.values()];
        });
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to load skills configuration";
      this._loadState = "error";
    }
  }

  private async _patchConfig(path: string, value: unknown): Promise<boolean> {
    if (!this.rpcClient) return false;

    try {
      // Backend expects { section, key?, value }. Split dot-notation path into section + key.
      const dotIdx = path.indexOf(".");
      const section = dotIdx > 0 ? path.slice(0, dotIdx) : path;
      const key = dotIdx > 0 ? path.slice(dotIdx + 1) : undefined;
      await this.rpcClient.call("config.patch", { section, key, value });
      IcToast.show("Configuration updated", "success");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update configuration";
      IcToast.show(msg, "error");
      return false;
    }
  }

  // --- Built-in Tools tab ---

  private async _onToolToggle(toolName: string, enabled: boolean): Promise<void> {
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      builtinTools: { [toolName]: enabled },
    });
    if (ok && this._skillsConfig) {
      this._skillsConfig = {
        ...this._skillsConfig,
        builtinTools: {
          ...this._skillsConfig.builtinTools,
          [toolName]: enabled,
        },
      };
    }
  }

  private _renderToolsTab() {
    return html`
      ${TOOL_CATEGORIES.map(
        (cat) => html`
          <div class="category-header">${cat.label}</div>
          <div class="tool-grid">
            ${cat.tools.map(
              (name) => html`
                <div class="tool-card">
                  <div class="tool-card-header">
                    <span class="tool-name">${name}</span>
                  </div>
                  <span class="tool-desc">${TOOL_DESCRIPTIONS[name] ?? ""}</span>
                  ${TOOL_PARAM_HINTS[name]
                    ? html`<ul class="tool-params">
                        ${TOOL_PARAM_HINTS[name].map((hint) => html`<li>${hint}</li>`)}
                      </ul>`
                    : nothing}
                </div>
              `,
            )}
          </div>
        `,
      )}
      <p class="tool-hint">Enable or disable tools per agent in the agent editor.</p>

      <hr style="border: none; border-top: 1px solid var(--ic-border); margin: var(--ic-space-xl) 0;" />

      <div class="section-header" style="font-size: var(--ic-text-base); font-weight: 600; color: var(--ic-text); margin-bottom: var(--ic-space-sm);">Platform Tools</div>
      <p class="tool-hint" style="margin-top: 0;">
        Platform tools are always available to agents. They are governed by the tool policy and trust level.
      </p>
      ${PLATFORM_TOOL_CATEGORIES.map(
        (cat) => html`
          <div class="category-header">${cat.label}</div>
          <div class="tool-grid">
            ${cat.tools.map(
              (name) => html`
                <div class="tool-card">
                  <div class="tool-card-header">
                    <span class="tool-name">${name}</span>
                  </div>
                  <span class="tool-desc">${PLATFORM_TOOL_DESCRIPTIONS[name] ?? ""}</span>
                </div>
              `,
            )}
          </div>
        `,
      )}

      <hr style="border: none; border-top: 1px solid var(--ic-border); margin: var(--ic-space-xl) 0;" />

      <div class="section-header" style="font-size: var(--ic-text-base); font-weight: 600; color: var(--ic-text); margin-bottom: var(--ic-space-sm);">Tool Policy</div>
      <div class="policy-section">
        <p class="tool-hint" style="margin-top: 0;">
          Tool policy controls which platform tools an agent can use. Profiles (minimal, coding, messaging, supervisor, full)
          define baseline sets, with allow/deny lists for fine-grained overrides.
        </p>
        <p class="tool-hint">Configure tool policy per agent in the agent editor.</p>
      </div>
    `;
  }

  // --- Prompt Skills tab ---

  private async _onPromptFieldChange(field: string, value: unknown): Promise<void> {
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      promptSkills: { [field]: value },
    });
    if (ok && this._skillsConfig) {
      this._skillsConfig = {
        ...this._skillsConfig,
        promptSkills: {
          ...this._skillsConfig.promptSkills,
          [field]: value,
        },
      };
    }
  }

  private async _addToList(
    section: "promptSkills",
    field: "allowedSkills" | "deniedSkills",
    item: string,
  ): Promise<void> {
    if (!item.trim() || !this._skillsConfig) return;
    const currentList = [...this._skillsConfig.promptSkills[field]];
    if (currentList.includes(item.trim())) return;
    const newList = [...currentList, item.trim()];
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      promptSkills: { [field]: newList },
    });
    if (ok) {
      this._skillsConfig = {
        ...this._skillsConfig,
        promptSkills: {
          ...this._skillsConfig.promptSkills,
          [field]: newList,
        },
      };
    }
  }

  private async _removeFromList(
    section: "promptSkills",
    field: "allowedSkills" | "deniedSkills",
    item: string,
  ): Promise<void> {
    if (!this._skillsConfig) return;
    const newList = this._skillsConfig.promptSkills[field].filter((s) => s !== item);
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      promptSkills: { [field]: newList },
    });
    if (ok) {
      this._skillsConfig = {
        ...this._skillsConfig,
        promptSkills: {
          ...this._skillsConfig.promptSkills,
          [field]: newList,
        },
      };
    }
  }

  private _renderSkillList(
    title: string,
    items: string[],
    field: "allowedSkills" | "deniedSkills",
    inputValue: string,
    onInput: (v: string) => void,
  ) {
    const filteredItems = this._searchQuery
      ? items.filter((s) => s.toLowerCase().includes(this._searchQuery.toLowerCase()))
      : items;

    return html`
      <div class="list-section">
        <div class="list-title">${title}</div>
        ${
          filteredItems.length > 0
            ? html`
                <div class="list-items">
                  ${filteredItems.map(
                    (item) => html`
                      <span class="list-item">
                        ${item}
                        <button
                          class="list-item-remove"
                          aria-label="Remove ${item}"
                          @click=${() => this._removeFromList("promptSkills", field, item)}
                        >\u2715</button>
                      </span>
                    `,
                  )}
                </div>
              `
            : html`<div class="empty-list">No items</div>`
        }
        <div class="list-add-row">
          <input
            class="list-add-input"
            type="text"
            placeholder="Skill name..."
            .value=${inputValue}
            @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                this._addToList("promptSkills", field, inputValue);
                onInput("");
              }
            }}
          />
          <button
            class="list-add-btn"
            @click=${() => {
              this._addToList("promptSkills", field, inputValue);
              onInput("");
            }}
          >Add</button>
        </div>
      </div>
    `;
  }

  // --- Skill management handlers ---

  private _triggerFolderUpload(): void {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("#skill-folder-input");
    input?.click();
  }

  private async _handleFolderSelected(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0 || !this.rpcClient) return;

    const firstPath = fileList[0].webkitRelativePath;
    const folderName = firstPath.split("/")[0];
    if (!folderName) {
      IcToast.show("Could not determine folder name", "error");
      return;
    }

    this._isUploadingSkill = true;
    try {
      const files: Array<{ path: string; content: string }> = [];
      for (const file of Array.from(fileList)) {
        const relativePath = file.webkitRelativePath.split("/").slice(1).join("/");
        if (!relativePath) continue;
        const content = await file.text();
        files.push({ path: relativePath, content });
      }

      if (files.length === 0) {
        IcToast.show("No files found in folder", "error");
        return;
      }

      await this.rpcClient.call("skills.upload", {
        name: folderName,
        files,
        agentId: this._installScope === "agent" ? this._installAgent : this._defaultAgentId,
        scope: this._installScope === "shared" ? "shared" : "local",
      });
      IcToast.show(`Skill "${folderName}" uploaded`, "success");
      await this._refreshSkills();
    } catch (err) {
      IcToast.show(
        `Failed to upload skill: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._isUploadingSkill = false;
      input.value = "";
    }
  }

  private async _handleImportSkill(): Promise<void> {
    const url = this._importUrl.trim();
    if (!url || !this.rpcClient || this._isImportingSkill) return;

    this._isImportingSkill = true;
    try {
      const result = await this.rpcClient.call<{ ok: boolean; name?: string; fileCount?: number }>(
        "skills.import",
        { url, agentId: this._installScope === "agent" ? this._installAgent : this._defaultAgentId, scope: this._installScope === "shared" ? "shared" : "local" },
      );
      IcToast.show(`Skill "${result.name}" imported (${result.fileCount} files)`, "success");
      this._importUrl = "";
      await this._refreshSkills();
    } catch (err) {
      IcToast.show(
        `Failed to import skill: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._isImportingSkill = false;
    }
  }

  private _handleDeleteSkill(name: string): void {
    if (!this.rpcClient || this._deletingSkill) return;
    this._deletingSkill = name;
  }

  private async _confirmDeleteSkill(): Promise<void> {
    if (!this.rpcClient || !this._deletingSkill) return;
    const name = this._deletingSkill;
    try {
      const delAgent = agentIdFromLocation(
        this._discoveredSkills.find((s) => s.name === name)?.location ?? "",
      );
      await this.rpcClient.call("skills.delete", {
        name,
        agentId: delAgent || this._defaultAgentId,
        scope: delAgent ? "local" : "shared",
      });
      IcToast.show(`Skill "${name}" deleted`, "success");
      this._deletingSkill = null;
      await this._refreshSkills();
    } catch (err) {
      IcToast.show(
        `Failed to delete skill: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
      this._deletingSkill = null;
    }
  }

  private async _onAgentChange(agentId: string): Promise<void> {
    this._targetAgentId = agentId;
    this._skillScope = "all";  // Always reset scope when changing agent
    await this._loadData();
  }

  private async _refreshSkills(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call<{ skills: DiscoveredSkill[] }>(
        "skills.list",
        { agentId: this._targetAgentId },
      );
      this._discoveredSkills = result.skills ?? [];
    } catch {
      // Refresh failure is non-fatal
    }
  }

  private _renderDiscoveredSkills() {
    const filtered = this._searchQuery
      ? this._discoveredSkills.filter(
          (s) =>
            s.name.toLowerCase().includes(this._searchQuery.toLowerCase()) ||
            s.description.toLowerCase().includes(this._searchQuery.toLowerCase()),
        )
      : this._discoveredSkills;

    const hasSkills = this._discoveredSkills.length > 0;
    // source mapping from discovery: "bundled" = agent workspace (prepended first),
    // "local" = shared data dir (last path), "workspace" = middle paths.
    const allShared = hasSkills ? filtered.filter((s) => s.source === "local") : [];
    const allAgent = hasSkills ? filtered.filter((s) => s.source !== "local") : [];
    const showShared = this._skillScope === "all" || this._skillScope === "shared";
    const showAgent = this._skillScope === "all" || this._skillScope === "local";
    const shared = showShared ? allShared : [];
    const agent = showAgent ? allAgent : [];
    const nothingToShow = shared.length === 0 && agent.length === 0;

    return html`
      ${!hasSkills || nothingToShow ? html`
        <ic-empty-state
          icon="skills"
          message=${!hasSkills ? "No prompt skills discovered" : "No skills match the current filter"}
          description=${!hasSkills ? "Upload a skill folder or import from GitHub to get started." : "Try changing the scope filter or search query."}
        ></ic-empty-state>
      ` : html`
        ${shared.length > 0 ? html`
          <div class="category-header">Shared Skills (${shared.length})</div>
          <div class="tool-grid">
            ${shared.map(
              (skill) => html`
                <div class="tool-card">
                  <div class="tool-card-header">
                    <span class="tool-name">${skill.name}</span>
                    <div style="display: flex; gap: 0.25rem; align-items: center;">
                      ${skill.disableModelInvocation
                        ? html`<ic-tag variant="warning">manual</ic-tag>`
                        : nothing}
                      <ic-tag variant="info">SHARED</ic-tag>
                      <button
                        class="skill-delete-btn"
                        aria-label="Delete ${skill.name}"
                        @click=${() => this._handleDeleteSkill(skill.name)}
                      >\u2715</button>
                    </div>
                  </div>
                  <span class="tool-desc">${skill.description.length > 150
                    ? skill.description.slice(0, 150) + "..."
                    : skill.description}</span>
                </div>
              `,
            )}
          </div>
        ` : nothing}

        ${showAgent ? html`
          <div class="category-header">Agent Skills (${agent.length})</div>
          ${agent.length > 0 ? html`
            <div class="tool-grid">
              ${agent.map(
                (skill) => {
                  const ownerAgent = agentIdFromLocation(skill.location);
                  return html`
                  <div class="tool-card">
                    <div class="tool-card-header">
                      <span class="tool-name">${skill.name}</span>
                      <div style="display: flex; gap: 0.25rem; align-items: center;">
                        ${skill.disableModelInvocation
                          ? html`<ic-tag variant="warning">manual</ic-tag>`
                          : nothing}
                        ${ownerAgent
                          ? html`<ic-tag variant="accent">${ownerAgent}</ic-tag>`
                          : html`<ic-tag variant="accent">AGENT</ic-tag>`}
                        <button
                          class="skill-delete-btn"
                          aria-label="Delete ${skill.name}"
                          @click=${() => this._handleDeleteSkill(skill.name)}
                        >\u2715</button>
                      </div>
                    </div>
                    <span class="tool-desc">${skill.description.length > 150
                      ? skill.description.slice(0, 150) + "..."
                      : skill.description}</span>
                  </div>
                `;},
              )}
            </div>
          ` : html`
            <p style="font-size: var(--ic-text-sm); color: var(--ic-text-dim); font-style: italic;">
              No agent-specific skills installed. Upload or import skills below.
            </p>
          `}
        ` : nothing}
      `}

      <!-- Add Skill panel -->
      <div class="add-skill-panel">
        <div class="add-skill-title">Add Skill</div>

        <!-- Install target selector -->
        <div class="install-target">
          <span class="install-target-label">Install to:</span>
          <select
            class="install-target-select"
            .value=${this._installScope}
            @change=${(e: Event) => {
              this._installScope = (e.target as HTMLSelectElement).value as "shared" | "agent";
              if (this._installScope === "agent" && !this._installAgent) {
                this._installAgent = this._agentIds[0] ?? this._defaultAgentId;
              }
            }}
          >
            <option value="shared" ?selected=${this._installScope === "shared"}>Shared (all agents)</option>
            <option value="agent" ?selected=${this._installScope === "agent"}>Specific agent</option>
          </select>
          ${this._installScope === "agent" ? html`
            <select
              class="install-target-select"
              .value=${this._installAgent}
              @change=${(e: Event) => { this._installAgent = (e.target as HTMLSelectElement).value; }}
            >
              ${this._agentIds.map((id) => html`
                <option value=${id} ?selected=${id === this._installAgent}>${id}</option>
              `)}
            </select>
          ` : nothing}
          <span class="install-target-hint">
            ${this._installScope === "shared"
              ? "Skill will be available to all agents"
              : `Skill will only be available to ${this._installAgent || "the selected agent"}`}
          </span>
        </div>

        <!-- Two methods side by side -->
        <div class="add-skill-methods">
          <div class="add-skill-method">
            <div class="add-skill-method-title">Upload folder</div>
            <div class="add-skill-method-body">
              <input
                id="skill-folder-input"
                type="file"
                webkitdirectory
                hidden
                @change=${(e: Event) => this._handleFolderSelected(e)}
              />
              <button
                class="upload-skill-btn"
                ?disabled=${this._isUploadingSkill}
                @click=${() => this._triggerFolderUpload()}
              >${this._isUploadingSkill ? "Uploading..." : "+ Select Skill Folder"}</button>
            </div>
            <p class="upload-skill-hint">Folder must contain a SKILL.md file</p>
          </div>

          <div class="add-skill-method">
            <div class="add-skill-method-title">Import from GitHub</div>
            <div class="add-skill-method-body">
              <div class="import-skill-row" style="width: 100%;">
                <input
                  type="text"
                  .value=${this._importUrl}
                  placeholder="https://github.com/owner/repo/tree/main/skills/name"
                  @input=${(e: Event) => { this._importUrl = (e.target as HTMLInputElement).value; }}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); this._handleImportSkill(); } }}
                />
                <button
                  class="import-skill-btn"
                  ?disabled=${this._isImportingSkill || !this._importUrl.trim()}
                  @click=${() => this._handleImportSkill()}
                >${this._isImportingSkill ? "Importing..." : "Import"}</button>
              </div>
            </div>
            <p class="upload-skill-hint">Paste a GitHub URL to a skill folder</p>
          </div>
        </div>
      </div>

      <!-- Delete confirmation dialog -->
      <ic-confirm-dialog
        ?open=${this._deletingSkill !== null}
        title="Delete Skill"
        message=${`Delete skill "${this._deletingSkill}"? This will remove the skill files from disk.`}
        variant="danger"
        confirmLabel="Delete"
        @confirm=${() => this._confirmDeleteSkill()}
        @cancel=${() => { this._deletingSkill = null; }}
      ></ic-confirm-dialog>
    `;
  }

  private _renderSkillsTab() {
    return html`
      <ic-search-input
        placeholder="Filter skill names..."
        @search=${(e: CustomEvent<string>) => { this._searchQuery = e.detail; }}
      ></ic-search-input>

      <div style="margin-top: var(--ic-space-md);">
        ${this._renderDiscoveredSkills()}
      </div>

      <p class="tool-hint">Configure prompt skill settings (max body length, auto-inject, allowed/denied lists) per agent in the agent editor.</p>
    `;
  }

  // --- Tool Policy tab ---
  // --- Tool Policy tab ---

  private async _onProfileChange(profile: string): Promise<void> {
    if (!this._skillsConfig) return;
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      toolPolicy: { ...this._skillsConfig.toolPolicy, profile },
    });
    if (ok) {
      this._skillsConfig = {
        ...this._skillsConfig,
        toolPolicy: { ...this._skillsConfig.toolPolicy, profile },
      };
    }
  }

  private async _addPolicyItem(field: "allow" | "deny", item: string): Promise<void> {
    if (!item.trim() || !this._skillsConfig) return;
    const currentList = [...this._skillsConfig.toolPolicy[field]];
    if (currentList.includes(item.trim())) return;
    const newList = [...currentList, item.trim()];
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      toolPolicy: { ...this._skillsConfig.toolPolicy, [field]: newList },
    });
    if (ok) {
      this._skillsConfig = {
        ...this._skillsConfig,
        toolPolicy: { ...this._skillsConfig.toolPolicy, [field]: newList },
      };
    }
  }

  private async _removePolicyItem(field: "allow" | "deny", item: string): Promise<void> {
    if (!this._skillsConfig) return;
    const newList = this._skillsConfig.toolPolicy[field].filter((s) => s !== item);
    const ok = await this._patchConfig(`agents.${this._targetAgentId}.skills`, {
      toolPolicy: { ...this._skillsConfig.toolPolicy, [field]: newList },
    });
    if (ok) {
      this._skillsConfig = {
        ...this._skillsConfig,
        toolPolicy: { ...this._skillsConfig.toolPolicy, [field]: newList },
      };
    }
  }

  private _getResolvedTools(): { included: string[]; denied: string[] } {
    if (!this._skillsConfig) return { included: [], denied: [] };
    const policy = this._skillsConfig.toolPolicy;
    const base = PROFILE_TOOLS[policy.profile] ?? [];
    const combined = new Set([...base, ...policy.allow]);
    const denied = new Set(policy.deny);
    const included = [...combined].filter((t) => !denied.has(t));
    const deniedList = [...combined].filter((t) => denied.has(t));
    return { included, denied: deniedList };
  }

  private _renderPolicyList(
    title: string,
    items: string[],
    field: "allow" | "deny",
    inputValue: string,
    onInput: (v: string) => void,
  ) {
    return html`
      <div class="list-section">
        <div class="list-title">${title}</div>
        ${
          items.length > 0
            ? html`
                <div class="list-items">
                  ${items.map(
                    (item) => html`
                      <span class="list-item">
                        ${item}
                        <button
                          class="list-item-remove"
                          aria-label="Remove ${item}"
                          @click=${() => this._removePolicyItem(field, item)}
                        >\u2715</button>
                      </span>
                    `,
                  )}
                </div>
              `
            : html`<div class="empty-list">No items</div>`
        }
        <div class="list-add-row">
          <input
            class="list-add-input"
            type="text"
            placeholder="Tool name..."
            .value=${inputValue}
            @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                this._addPolicyItem(field, inputValue);
                onInput("");
              }
            }}
          />
          <button
            class="list-add-btn"
            @click=${() => {
              this._addPolicyItem(field, inputValue);
              onInput("");
            }}
          >Add</button>
        </div>
      </div>
    `;
  }

  // --- Main render ---

  private _renderRecentActivity() {
    if (this._recentSkillEvents.length === 0) return nothing;
    return html`
      <div class="recent-activity">
        <h3>Recent Activity <span class="recent-activity-count">(${this._recentSkillEvents.length})</span></h3>
        <div class="event-list">
          ${this._recentSkillEvents.slice(0, 20).map(ev => html`
            <div class="event-entry">
              <span class="event-skill">${ev.skillName}</span>
              <span class="event-agent">${ev.agentId || "\u2014"}</span>
              <span class=${ev.outcome === "executed" ? "event-outcome--executed" : "event-outcome--rejected"}>
                ${ev.outcome}${ev.reason ? html` <span class="event-reason">(${ev.reason})</span>` : ""}
              </span>
              <span class="event-time">${new Date(ev.timestamp).toLocaleTimeString()}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private _renderTabContent() {
    switch (this._activeTab) {
      case "tools":
        return this._renderToolsTab();
      case "skills":
        return this._renderSkillsTab();
      default:
        return nothing;
    }
  }

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${this._error}</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="view-header">
        <div class="view-title">Skills & Tools</div>
        ${this._agentIds.length > 1 ? html`
          <div style="display: flex; gap: var(--ic-space-sm); align-items: center;">
            <select
              class="form-input"
              .value=${this._targetAgentId}
              @change=${(e: Event) => this._onAgentChange((e.target as HTMLSelectElement).value)}
            >
              <option value="" ?selected=${this._targetAgentId === ""}>All Agents</option>
              ${this._agentIds.map(id => html`
                <option value=${id} ?selected=${id === this._targetAgentId}>${id}</option>
              `)}
            </select>
            <select
              class="form-input"
              .value=${this._skillScope}
              @change=${(e: Event) => { this._skillScope = (e.target as HTMLSelectElement).value as "all" | "local" | "shared"; }}
            >
              <option value="all" ?selected=${this._skillScope === "all"}>All Skills</option>
              <option value="local" ?selected=${this._skillScope === "local"}>Agent Skills</option>
              <option value="shared" ?selected=${this._skillScope === "shared"}>Shared Skills</option>
            </select>
          </div>
        ` : nothing}
      </div>
      <ic-tabs
        .tabs=${TABS}
        .activeTab=${this._activeTab}
        @tab-change=${(e: CustomEvent<string>) => { this._activeTab = e.detail; }}
      ></ic-tabs>
      <div style="margin-top: var(--ic-space-md);">
        ${this._renderTabContent()}
      </div>
      ${this._renderRecentActivity()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-skills-view": IcSkillsView;
  }
}
