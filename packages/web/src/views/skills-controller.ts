// SPDX-License-Identifier: Apache-2.0
/**
 * Skills view controller.
 *
 * Owns state + RPC orchestration for the skills management view:
 * config.read for skills config, skills.list for discovered prompt skills,
 * config.patch for tool toggle / prompt fields / lists / policy mutations,
 * skills.upload / skills.import / skills.delete for skill management,
 * and SSE event subscriptions for live skill execution/rejection updates.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import { systemClearTimeout, systemNowMs, systemSetTimeout } from "@comis/core";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type LoadState = "loading" | "loaded" | "error";

/** Built-in tool descriptions keyed by tool name. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
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
export const TOOL_PARAM_HINTS: Record<string, string[]> = {
  webSearch: [
    "freshness: pd (past day), pw (past week), pm (past month), py (past year), or YYYY-MM-DDtoYYYY-MM-DD",
    "deepFetch: 0-5 - auto-fetch full page content for top N results",
    "provider: override search provider per call",
  ],
};

/** Tool categories with their tool names. */
export const TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  { label: "File Operations", tools: ["read", "write", "edit", "find", "ls"] },
  { label: "Execution", tools: ["exec", "process"] },
  { label: "Search", tools: ["grep"] },
  { label: "Web", tools: ["webSearch", "webFetch", "browser"] },
];

/** All 11 built-in tool names. */
export const ALL_TOOLS = TOOL_CATEGORIES.flatMap((c) => c.tools);

/** Profile to base tool set mapping. */
export const PROFILE_TOOLS: Record<string, string[]> = {
  minimal: ["exec"],
  coding: ["read", "write", "edit", "grep", "find", "ls", "exec", "process"],
  messaging: ["exec", "webSearch", "webFetch"],
  supervisor: ["read", "write", "edit", "grep", "find", "ls", "exec", "process", "webSearch", "webFetch"],
  full: [...ALL_TOOLS],
};

/** Platform tool descriptions keyed by tool name. */
export const PLATFORM_TOOL_DESCRIPTIONS: Record<string, string> = {
  memory_search: "Semantic hybrid search across memory and session transcripts",
  memory_get: "Read specific memory file sections by path with line ranges",
  memory_store: "Store facts, preferences, or context in long-term memory",
  memory_manage: "Stats, browse, delete, flush, and export memory entries",
  session_status: "View current session model, token usage, and duration",
  sessions_list: "List active sessions filtered by kind and recency",
  sessions_history: "View conversation history for a session with pagination",
  sessions_send: "Send a message into another session (fire-and-forget, wait, or ping-pong)",
  sessions_spawn: "Start a background sub-agent and return its run ID immediately",
  sessions_manage: "Delete, reset, export, or compact session lifecycles",
  agents_manage: "List, create, inspect, update, suspend/resume, and delete agents",
  subagents: "List, wait for, kill, or steer sub-agents",
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
export const PLATFORM_TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  { label: "MEMORY", tools: ["memory_search", "memory_get", "memory_store", "memory_manage"] },
  { label: "SESSIONS", tools: ["session_status", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "sessions_manage"] },
  { label: "AGENTS", tools: ["agents_manage", "subagents"] },
  { label: "MESSAGING", tools: ["message", "discord_action", "telegram_action", "slack_action", "whatsapp_action"] },
  { label: "MEDIA", tools: ["image_analyze", "tts_synthesize", "transcribe_audio", "describe_video", "extract_document"] },
  { label: "INFRASTRUCTURE", tools: ["cron", "gateway", "browser", "obs_query"] },
  { label: "SYSTEM MANAGEMENT", tools: ["models_manage", "tokens_manage", "channels_manage", "skills_manage"] },
];

export const SKILLS_TABS = [
  { id: "tools", label: "Built-in Tools" },
  { id: "skills", label: "Prompt Skills" },
];

/** Shape of the skills section from config.read */
export interface SkillsConfig {
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
export interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
  disableModelInvocation?: boolean;
  source?: "bundled" | "workspace" | "local";
}

/** Shape of a live skill execution/rejection event (SSE in-memory append). */
export interface SkillEventRecord {
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
export function agentIdFromLocation(location: string): string {
  const match = location.match(/\/workspace-([^/]+)\/skills\//);
  if (match) return match[1]!;
  if (/\/workspace\/skills\//.test(location)) return "default";
  return "";
}

/* ------------------------------------------------------------------ */
/*  Snapshot + Controller interfaces                                   */
/* ------------------------------------------------------------------ */

export interface SkillsViewSnapshot {
  readonly loadState: LoadState;
  readonly error: string;
  readonly activeTab: string;
  readonly skillsConfig: SkillsConfig | null;
  readonly discoveredSkills: ReadonlyArray<DiscoveredSkill>;
  readonly targetAgentId: string;
  readonly agentIds: ReadonlyArray<string>;
  readonly skillScope: "all" | "local" | "shared";
  readonly defaultAgentId: string;
  readonly searchQuery: string;
  readonly importUrl: string;
  readonly isImportingSkill: boolean;
  readonly isUploadingSkill: boolean;
  readonly deletingSkill: string | null;
  readonly installAgent: string;
  readonly installScope: "shared" | "agent";
  readonly newAllowedSkill: string;
  readonly newDeniedSkill: string;
  readonly newPolicyAllow: string;
  readonly newPolicyDeny: string;
  readonly recentSkillEvents: ReadonlyArray<SkillEventRecord>;
}

export interface SkillsController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  getSnapshot(): SkillsViewSnapshot;
  loadData(): Promise<void>;
  tryLoad(): void;
  refreshSkills(): Promise<void>;
  onToolToggle(toolName: string, enabled: boolean): Promise<void>;
  onPromptFieldChange(field: string, value: unknown): Promise<void>;
  addToList(field: "allowedSkills" | "deniedSkills", item: string): Promise<void>;
  removeFromList(field: "allowedSkills" | "deniedSkills", item: string): Promise<void>;
  onAgentChange(agentId: string): Promise<void>;
  handleFolderSelected(input: HTMLInputElement): Promise<void>;
  handleImportSkill(): Promise<void>;
  handleDeleteSkill(name: string): void;
  confirmDeleteSkill(): Promise<void>;
  cancelDeleteSkill(): void;
  onProfileChange(profile: string): Promise<void>;
  addPolicyItem(field: "allow" | "deny", item: string): Promise<void>;
  removePolicyItem(field: "allow" | "deny", item: string): Promise<void>;
  getResolvedTools(): { included: string[]; denied: string[] };
  setActiveTab(tab: string): void;
  setSearchQuery(query: string): void;
  setSkillScope(scope: "all" | "local" | "shared"): void;
  setImportUrl(url: string): void;
  setInstallAgent(id: string): void;
  setInstallScope(scope: "shared" | "agent"): void;
  setNewAllowedSkill(v: string): void;
  setNewDeniedSkill(v: string): void;
  setNewPolicyAllow(v: string): void;
  setNewPolicyDeny(v: string): void;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createSkillsController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
  eventDispatcher: EventDispatcher | null,
): SkillsController {
  let state: SkillsViewSnapshot = Object.freeze({
    loadState: "loading" as LoadState,
    error: "",
    activeTab: "tools",
    skillsConfig: null,
    discoveredSkills: [],
    targetAgentId: "",
    agentIds: [],
    skillScope: "all" as const,
    defaultAgentId: "default",
    searchQuery: "",
    importUrl: "",
    isImportingSkill: false,
    isUploadingSkill: false,
    deletingSkill: null,
    installAgent: "",
    installScope: "shared" as const,
    newAllowedSkill: "",
    newDeniedSkill: "",
    newPolicyAllow: "",
    newPolicyDeny: "",
    recentSkillEvents: [],
  });

  function _mutate(partial: Partial<SkillsViewSnapshot>): void {
    state = Object.freeze({ ...state, ...partial });
    host.requestUpdate();
  }

  let sse: SseController | null = null;
  let rpcStatusUnsub: (() => void) | null = null;
  let dataLoaded = false;
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  function _scheduleReload(delayMs = 300): void {
    if (reloadDebounce !== null) systemClearTimeout(reloadDebounce);
    reloadDebounce = systemSetTimeout(() => {
      reloadDebounce = null;
      void controller.loadData();
    }, delayMs);
  }

  function _initSse(): void {
    if (!eventDispatcher || sse) return;
    sse = new SseController(host, eventDispatcher, {
      "skill:loaded": () => { _scheduleReload(); },
      "skill:registry_reset": () => { _scheduleReload(); },
      "agent:hot_added": () => { _scheduleReload(); },
      "agent:hot_removed": () => { _scheduleReload(); },
      "skill:executed": (data) => {
        const d = data as { skillName?: string; agentId?: string; timestamp?: number };
        const next: SkillEventRecord = {
          skillName: d.skillName ?? "unknown",
          agentId: d.agentId ?? "",
          timestamp: d.timestamp ?? systemNowMs(),
          outcome: "executed",
        };
        _mutate({
          recentSkillEvents: [next, ...state.recentSkillEvents].slice(0, 50),
        });
      },
      "skill:rejected": (data) => {
        const d = data as { skillName?: string; agentId?: string; timestamp?: number; reason?: string };
        const next: SkillEventRecord = {
          skillName: d.skillName ?? "unknown",
          agentId: d.agentId ?? "",
          timestamp: d.timestamp ?? systemNowMs(),
          outcome: "rejected",
          reason: d.reason,
        };
        _mutate({
          recentSkillEvents: [next, ...state.recentSkillEvents].slice(0, 50),
        });
      },
    });
  }

  async function _patchConfig(path: string, value: unknown): Promise<boolean> {
    try {
      const dotIdx = path.indexOf(".");
      const section = dotIdx > 0 ? path.slice(0, dotIdx) : path;
      const key = dotIdx > 0 ? path.slice(dotIdx + 1) : undefined;
      await rpcClient.call("config.patch", { section, key, value });
      IcToast.show("Configuration updated", "success");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update configuration";
      IcToast.show(msg, "error");
      return false;
    }
  }

  const controller: SkillsController = {
    hostConnected(): void {
      _initSse();
      // _tryLoad runs from the view's `updated()` once rpcClient is set
      // (this controller is created only after rpcClient is non-null, but
      // we still need to wait for "connected" status).
      controller.tryLoad();
    },

    hostDisconnected(): void {
      rpcStatusUnsub?.();
      rpcStatusUnsub = null;
      if (reloadDebounce !== null) {
        systemClearTimeout(reloadDebounce);
        reloadDebounce = null;
      }
    },

    getSnapshot(): SkillsViewSnapshot {
      return state;
    },

    tryLoad(): void {
      rpcStatusUnsub?.();
      if (rpcClient.status === "connected") {
        void controller.loadData();
      } else {
        rpcStatusUnsub = rpcClient.onStatusChange((status) => {
          if (status === "connected" && !dataLoaded) {
            void controller.loadData();
          }
        });
      }
    },

    async loadData(): Promise<void> {
      _mutate({ loadState: "loading", error: "" });
      try {
        const result = await rpcClient.call("config.read");
        const agents = result.config?.agents;
        const agentIds = agents ? Object.keys(agents) : [];
        let targetAgentId = state.targetAgentId;
        const firstAgentId = agentIds[0];
        if (targetAgentId && firstAgentId && !agentIds.includes(targetAgentId)) {
          targetAgentId = firstAgentId;
        }

        // ConfigReadResult does not declare `routing` in its interface — it
        // returns the full YAML config blob as Record<string, unknown>.
        const routing = (result.config as Record<string, unknown>)?.routing as
          | Record<string, unknown>
          | undefined;
        const defaultAgentId = (routing?.defaultAgentId as string) ?? "default";

        const skillsConfig =
          targetAgentId && agentIds.includes(targetAgentId)
            // eslint-disable-next-line security/detect-object-injection -- targetAgentId checked via includes() above
            ? agents![targetAgentId]!.skills ?? null
            : null;

        dataLoaded = true;
        _mutate({
          agentIds,
          targetAgentId,
          defaultAgentId,
          skillsConfig,
          loadState: "loaded",
        });

        // Fetch discovered prompt skills in the background (non-blocking).
        if (targetAgentId) {
          rpcClient
            .call("skills.list", {
              agentId: targetAgentId,
            })
            .then((skillsResult) => {
              _mutate({ discoveredSkills: skillsResult.skills ?? [] });
            })
            .catch(() => {
              _mutate({ discoveredSkills: [] });
            });
        } else {
          // "All Agents" mode: fetch from every agent and merge.
          Promise.allSettled(
            agentIds.map((id) =>
              rpcClient.call("skills.list", {
                agentId: id,
              }),
            ),
          ).then((results) => {
            const seen = new Map<string, DiscoveredSkill>();
            for (const r of results) {
              if (r.status !== "fulfilled") continue;
              for (const skill of r.value.skills ?? []) {
                const key =
                  skill.source === "local"
                    ? skill.name
                    : `${skill.name}:${skill.location}`;
                if (!seen.has(key)) seen.set(key, skill);
              }
            }
            _mutate({ discoveredSkills: [...seen.values()] });
          });
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to load skills configuration";
        _mutate({ error: msg, loadState: "error" });
      }
    },

    async refreshSkills(): Promise<void> {
      try {
        const result = await rpcClient.call(
          "skills.list",
          { agentId: state.targetAgentId },
        );
        _mutate({ discoveredSkills: result.skills ?? [] });
      } catch {
        // Refresh failure is non-fatal.
      }
    },

    async onToolToggle(toolName: string, enabled: boolean): Promise<void> {
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        builtinTools: { [toolName]: enabled },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            builtinTools: {
              ...state.skillsConfig.builtinTools,
              [toolName]: enabled,
            },
          },
        });
      }
    },

    async onPromptFieldChange(field: string, value: unknown): Promise<void> {
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        promptSkills: { [field]: value },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            promptSkills: {
              ...state.skillsConfig.promptSkills,
              [field]: value,
            },
          },
        });
      }
    },

    async addToList(
      field: "allowedSkills" | "deniedSkills",
      item: string,
    ): Promise<void> {
      if (!item.trim() || !state.skillsConfig) return;
      const currentList = [...state.skillsConfig.promptSkills[field]];
      if (currentList.includes(item.trim())) return;
      const newList = [...currentList, item.trim()];
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        promptSkills: { [field]: newList },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            promptSkills: {
              ...state.skillsConfig.promptSkills,
              [field]: newList,
            },
          },
        });
      }
    },

    async removeFromList(
      field: "allowedSkills" | "deniedSkills",
      item: string,
    ): Promise<void> {
      if (!state.skillsConfig) return;
      const newList = state.skillsConfig.promptSkills[field].filter(
        (s) => s !== item,
      );
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        promptSkills: { [field]: newList },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            promptSkills: {
              ...state.skillsConfig.promptSkills,
              [field]: newList,
            },
          },
        });
      }
    },

    async onAgentChange(agentId: string): Promise<void> {
      _mutate({ targetAgentId: agentId, skillScope: "all" });
      await controller.loadData();
    },

    async handleFolderSelected(input: HTMLInputElement): Promise<void> {
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;

      const firstPath = fileList[0].webkitRelativePath;
      const folderName = firstPath.split("/")[0];
      if (!folderName) {
        IcToast.show("Could not determine folder name", "error");
        return;
      }

      _mutate({ isUploadingSkill: true });
      try {
        const files: Array<{ path: string; content: string }> = [];
        for (const file of Array.from(fileList)) {
          const relativePath = file.webkitRelativePath
            .split("/")
            .slice(1)
            .join("/");
          if (!relativePath) continue;
          const content = await file.text();
          files.push({ path: relativePath, content });
        }
        if (files.length === 0) {
          IcToast.show("No files found in folder", "error");
          return;
        }
        await rpcClient.call("skills.upload", {
          name: folderName,
          files,
          agentId:
            state.installScope === "agent"
              ? state.installAgent
              : state.defaultAgentId,
          scope: state.installScope === "shared" ? "shared" : "local",
        });
        IcToast.show(`Skill "${folderName}" uploaded`, "success");
        await controller.refreshSkills();
      } catch (err) {
        IcToast.show(
          `Failed to upload skill: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
      } finally {
        _mutate({ isUploadingSkill: false });
        input.value = "";
      }
    },

    async handleImportSkill(): Promise<void> {
      const url = state.importUrl.trim();
      if (!url || state.isImportingSkill) return;
      _mutate({ isImportingSkill: true });
      try {
        const result = await rpcClient.call("skills.import", {
          url,
          agentId:
            state.installScope === "agent"
              ? state.installAgent
              : state.defaultAgentId,
          scope: state.installScope === "shared" ? "shared" : "local",
        });
        IcToast.show(
          `Skill "${result.name}" imported (${result.fileCount} files)`,
          "success",
        );
        _mutate({ importUrl: "" });
        await controller.refreshSkills();
      } catch (err) {
        IcToast.show(
          `Failed to import skill: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
      } finally {
        _mutate({ isImportingSkill: false });
      }
    },

    handleDeleteSkill(name: string): void {
      if (state.deletingSkill) return;
      _mutate({ deletingSkill: name });
    },

    async confirmDeleteSkill(): Promise<void> {
      if (!state.deletingSkill) return;
      const name = state.deletingSkill;
      try {
        const delAgent = agentIdFromLocation(
          state.discoveredSkills.find((s) => s.name === name)?.location ?? "",
        );
        await rpcClient.call("skills.delete", {
          name,
          agentId: delAgent || state.defaultAgentId,
          scope: delAgent ? "local" : "shared",
        });
        IcToast.show(`Skill "${name}" deleted`, "success");
        _mutate({ deletingSkill: null });
        await controller.refreshSkills();
      } catch (err) {
        IcToast.show(
          `Failed to delete skill: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error",
        );
        _mutate({ deletingSkill: null });
      }
    },

    cancelDeleteSkill(): void {
      _mutate({ deletingSkill: null });
    },

    async onProfileChange(profile: string): Promise<void> {
      if (!state.skillsConfig) return;
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        toolPolicy: { ...state.skillsConfig.toolPolicy, profile },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            toolPolicy: { ...state.skillsConfig.toolPolicy, profile },
          },
        });
      }
    },

    async addPolicyItem(
      field: "allow" | "deny",
      item: string,
    ): Promise<void> {
      if (!item.trim() || !state.skillsConfig) return;
      const currentList = [...state.skillsConfig.toolPolicy[field]];
      if (currentList.includes(item.trim())) return;
      const newList = [...currentList, item.trim()];
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        toolPolicy: { ...state.skillsConfig.toolPolicy, [field]: newList },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            toolPolicy: {
              ...state.skillsConfig.toolPolicy,
              [field]: newList,
            },
          },
        });
      }
    },

    async removePolicyItem(
      field: "allow" | "deny",
      item: string,
    ): Promise<void> {
      if (!state.skillsConfig) return;
      const newList = state.skillsConfig.toolPolicy[field].filter(
        (s) => s !== item,
      );
      const ok = await _patchConfig(`agents.${state.targetAgentId}.skills`, {
        toolPolicy: { ...state.skillsConfig.toolPolicy, [field]: newList },
      });
      if (ok && state.skillsConfig) {
        _mutate({
          skillsConfig: {
            ...state.skillsConfig,
            toolPolicy: {
              ...state.skillsConfig.toolPolicy,
              [field]: newList,
            },
          },
        });
      }
    },

    getResolvedTools(): { included: string[]; denied: string[] } {
      if (!state.skillsConfig) return { included: [], denied: [] };
      const policy = state.skillsConfig.toolPolicy;
      const base = PROFILE_TOOLS[policy.profile] ?? [];
      const combined = new Set([...base, ...policy.allow]);
      const denied = new Set(policy.deny);
      const included = [...combined].filter((t) => !denied.has(t));
      const deniedList = [...combined].filter((t) => denied.has(t));
      return { included, denied: deniedList };
    },

    setActiveTab(tab: string): void { _mutate({ activeTab: tab }); },
    setSearchQuery(query: string): void { _mutate({ searchQuery: query }); },
    setSkillScope(scope: "all" | "local" | "shared"): void { _mutate({ skillScope: scope }); },
    setImportUrl(url: string): void { _mutate({ importUrl: url }); },
    setInstallAgent(id: string): void { _mutate({ installAgent: id }); },
    setInstallScope(scope: "shared" | "agent"): void { _mutate({ installScope: scope }); },
    setNewAllowedSkill(v: string): void { _mutate({ newAllowedSkill: v }); },
    setNewDeniedSkill(v: string): void { _mutate({ newDeniedSkill: v }); },
    setNewPolicyAllow(v: string): void { _mutate({ newPolicyAllow: v }); },
    setNewPolicyDeny(v: string): void { _mutate({ newPolicyDeny: v }); },
  };

  host.addController(controller);
  return controller;
}
