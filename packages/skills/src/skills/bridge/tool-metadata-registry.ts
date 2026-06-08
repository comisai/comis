// SPDX-License-Identifier: Apache-2.0
/**
 * Tool metadata registry: Consolidated registration of all tool metadata.
 *
 * Previously split across 5 side-effect import files, now unified into
 * a single explicit registration function. Metadata is registered in
 * category order: result caps, parallelism, validators, output schemas,
 * search hints. For tools appearing in multiple categories, merge
 * semantics ({ ...existing, ...new }) are preserved by the
 * registerToolMetadata() function in @comis/core.
 *
 * @module
 */

import {
  registerToolMetadata,
  isImmutableConfigPath,
  getMutableOverridesForSection,
  getManagedSectionRedirect,
  formatRedirectHint,
} from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { validateExecCommand } from "../../tools/builtin/exec-security/index.js";
import { GATEWAY_ACTIONS } from "../../platform-tools/tools/gateway-tool.js";

export function registerAllToolMetadata(): void {
  // =========================================================================
  // Result Size Caps
  // =========================================================================

  // --- File tools (Comis-native via createComisFileTools) ---
  registerToolMetadata("grep", { maxResultSizeChars: 100_000 });
  registerToolMetadata("read", { maxResultSizeChars: 200_000 });
  registerToolMetadata("find", { maxResultSizeChars: 50_000 });
  registerToolMetadata("ls",   { maxResultSizeChars: 20_000 });

  // --- Exec tool ---
  registerToolMetadata("exec", { maxResultSizeChars: 100_000 });

  // --- Web tools ---
  registerToolMetadata("web_fetch",  { maxResultSizeChars: 150_000 });
  registerToolMetadata("web_search", { maxResultSizeChars: 50_000 });

  // --- Platform tools (RPC-based, created in daemon wiring) ---
  registerToolMetadata("sessions_history", { maxResultSizeChars: 100_000 });
  registerToolMetadata("obs_query",        { maxResultSizeChars: 100_000 });
  registerToolMetadata("memory_search",    { maxResultSizeChars: 50_000 });

  // =========================================================================
  // Parallelism Metadata
  // =========================================================================

  // --- Read-only tools (25) ---
  registerToolMetadata("read",  { isReadOnly: true });
  registerToolMetadata("grep",  { isReadOnly: true, searchHint: "search file contents with regex pattern ripgrep" });
  registerToolMetadata("find",  { isReadOnly: true });
  registerToolMetadata("ls",    { isReadOnly: true });

  registerToolMetadata("web_search", { isReadOnly: true });
  registerToolMetadata("web_fetch",  { isReadOnly: true });
  registerToolMetadata("browser",    { isReadOnly: true });

  registerToolMetadata("memory_search",  { isReadOnly: true });
  registerToolMetadata("memory_get",     { isReadOnly: true });
  registerToolMetadata("session_search", { isReadOnly: true });

  registerToolMetadata("sessions_list",    { isReadOnly: true });
  registerToolMetadata("session_status",   { isReadOnly: true });
  registerToolMetadata("sessions_history", { isReadOnly: true });

  registerToolMetadata("image_analyze",    { isReadOnly: true });
  registerToolMetadata("describe_video",   { isReadOnly: true });
  registerToolMetadata("extract_document", { isReadOnly: true });
  registerToolMetadata("transcribe_audio", { isReadOnly: true });

  registerToolMetadata("obs_query",     { isReadOnly: true });
  registerToolMetadata("models_manage", { isReadOnly: true });

  registerToolMetadata("discover_tools", { isReadOnly: true });

  // Context expansion (3) — in-session lossless-store recovery (E1/E2). They
  // only READ the LCD store, so they are read-only (parallel-execution safe).
  registerToolMetadata("ctx_search",  { isReadOnly: true });
  registerToolMetadata("ctx_inspect", { isReadOnly: true });
  registerToolMetadata("ctx_expand",  { isReadOnly: true });

  // --- Mutating tools (25) ---
  registerToolMetadata("edit",        { isReadOnly: false });
  registerToolMetadata("write",       { isReadOnly: false });
  registerToolMetadata("apply_patch", { isReadOnly: false });

  registerToolMetadata("exec",    { isReadOnly: false });
  registerToolMetadata("process", { isReadOnly: false });

  registerToolMetadata("memory_store",  { isReadOnly: false });
  registerToolMetadata("memory_manage", { isReadOnly: false });

  registerToolMetadata("sessions_manage", { isReadOnly: false });
  registerToolMetadata("sessions_send",   { isReadOnly: false });
  registerToolMetadata("sessions_spawn",  { isReadOnly: false });
  registerToolMetadata("subagents",       { isReadOnly: false });

  registerToolMetadata("pipeline",        { isReadOnly: false });
  registerToolMetadata("cron",            { isReadOnly: false });
  registerToolMetadata("gateway",         { isReadOnly: false });
  registerToolMetadata("heartbeat_manage", { isReadOnly: false });
  registerToolMetadata("channels_manage", { isReadOnly: false });
  registerToolMetadata("tokens_manage",   { isReadOnly: false });
  registerToolMetadata("skills_manage",   { isReadOnly: false });
  registerToolMetadata("mcp_manage",      { isReadOnly: false });
  registerToolMetadata("agents_manage",   { isReadOnly: false });

  registerToolMetadata("whatsapp_action", { isReadOnly: false });
  registerToolMetadata("discord_action",  { isReadOnly: false });
  registerToolMetadata("telegram_action", { isReadOnly: false });
  registerToolMetadata("slack_action",    { isReadOnly: false });

  registerToolMetadata("tts_synthesize", { isReadOnly: false });

  // --- Concurrency-safe mutating tool ---
  registerToolMetadata("message", { isReadOnly: false, isConcurrencySafe: true });

  // =========================================================================
  // Input Validators
  // =========================================================================

  // Exec tool -- command + env validation via security pipeline
  registerToolMetadata("exec", {
    validateInput: (params) => {
      const command = typeof params.command === "string" ? params.command : undefined;
      if (!command || command.trim() === "") {
        return "Missing required parameter: command";
      }
      const result = validateExecCommand(
        command,
        params.env && typeof params.env === "object"
          ? (params.env as Record<string, string>)
          : undefined,
      );
      return result?.message;
    },
  });

  // Cron tool -- action enum + per-action required param validation
  const VALID_CRON_ACTIONS = ["add", "list", "update", "remove", "status", "runs", "run", "wake"];
  const VALID_SCHEDULE_KINDS = ["cron", "every", "at"];

  registerToolMetadata("cron", {
    validateInput: (params) => {
      const action = typeof params.action === "string" ? params.action : undefined;
      if (!action || !VALID_CRON_ACTIONS.includes(action)) {
        return `Invalid action: "${action ?? ""}". Valid: ${VALID_CRON_ACTIONS.join(", ")}`;
      }
      if (action === "add") {
        if (!params.payload_kind) return "Missing required parameter: payload_kind (for add)";
        if (!params.payload_text) return "Missing required parameter: payload_text (for add)";
        if (params.schedule_kind && typeof params.schedule_kind === "string") {
          if (!VALID_SCHEDULE_KINDS.includes(params.schedule_kind)) {
            return `Invalid schedule_kind: "${params.schedule_kind}". Valid: ${VALID_SCHEDULE_KINDS.join(", ")}`;
          }
        }
      }
      if (["update", "remove", "runs", "run"].includes(action)) {
        if (!params.job_name) return `Missing required parameter: job_name (for ${action})`;
      }
      return undefined;
    },
  });

  // Message tool -- action enum + channel_type/channel_id presence
  const VALID_MESSAGE_ACTIONS = ["send", "reply", "react", "edit", "delete", "fetch", "attach"];

  registerToolMetadata("message", {
    validateInput: (params) => {
      const action = typeof params.action === "string" ? params.action : undefined;
      if (!action || !VALID_MESSAGE_ACTIONS.includes(action)) {
        return `Invalid action: "${action ?? ""}". Valid: ${VALID_MESSAGE_ACTIONS.join(", ")}`;
      }
      if (!params.channel_type || typeof params.channel_type !== "string") {
        return "Missing required parameter: channel_type";
      }
      if (!params.channel_id || typeof params.channel_id !== "string") {
        return "Missing required parameter: channel_id";
      }
      return undefined;
    },
  });

  // Gateway tool -- action enum + immutable path rejection for patch and apply.
  // Whitelist is derived from the tool's exported GATEWAY_ACTIONS tuple so
  // bridge + handler cannot drift.
  // When the rejected section has a dedicated *_manage tool, the message
  // includes a parameter-correct redirect via formatRedirectHint() so any
  // LLM (Opus/Sonnet/Haiku, GPT-5, Gemini, Mistral, etc.) can self-recover
  // without model-specific prompting.
  registerToolMetadata("gateway", {
    validateInput: (params) => {
      const action = typeof params.action === "string" ? params.action : undefined;
      if (!action || !(GATEWAY_ACTIONS as readonly string[]).includes(action)) {
        return `Invalid action: "${action ?? ""}". Valid: ${GATEWAY_ACTIONS.join(", ")}`;
      }
      const section = typeof params.section === "string" ? params.section : undefined;
      // Only check immutability for mutating actions (reads must succeed on immutable paths).
      if (action === "patch") {
        const key = typeof params.key === "string" ? params.key : undefined;
        if (section && isImmutableConfigPath(section, key)) {
          const mutablePaths = getMutableOverridesForSection(section, key);
          const redirect = getManagedSectionRedirect(section, key);
          const fullPath = `${section}${key ? "." + key : ""}`;
          const suffix = redirect
            ? ` ${formatRedirectHint(redirect, mutablePaths)}`
            : mutablePaths.length > 0
              ? ` Patchable: ${mutablePaths.join(", ")}.`
              : "";
          return `Cannot patch immutable config path: ${fullPath}.${suffix}`;
        }
      }
      if (action === "apply") {
        if (section && isImmutableConfigPath(section)) {
          const redirect = getManagedSectionRedirect(section);
          const suffix = redirect ? ` ${formatRedirectHint(redirect)}` : "";
          return `Cannot apply to immutable config section: ${section}.${suffix}`;
        }
      }
      return undefined;
    },
  });

  // =========================================================================
  // Tool-Entry Schema
  //
  // Generic action enum + valid keys + per-action required fields. Consumed
  // by validateToolEntry() in ./schema-validator.ts via
  // wrapWithMetadataEnforcement BEFORE per-tool validateInput runs.
  //
  // Each tool's shape is sourced from its TypeBox Type.Union([Type.Literal(...)])
  // action enum + each action handler's readStringParam(p, X) /
  // throwToolError("missing_param", ...) calls in its actionOverrides.
  //
  // Cross-consistency: managed-section entries in
  // @comis/core/src/config/managed-sections.ts also declare
  // requiredByAction for the redirect-hint payload. The registrations
  // here are the runtime gate; the managed-section entries are the
  // user-facing redirect hint.
  // =========================================================================

  registerToolMetadata("mcp_manage", {
    validActions: ["list", "status", "connect", "disconnect", "reconnect"],
    validKeys: ["action", "server_name", "transport", "command", "args", "url", "headers", "auth"],
    // connect requires [server_name, transport]; command (stdio) / url (sse|http) are
    // transport-conditional and validated downstream by the handler. `auth`
    // ("headers" | "oauth") is the OAuth opt-in — must be in validKeys
    // so the bridge schema-validator doesn't reject before execute() runs.
    requiredByAction: {
      status:     ["server_name"],
      connect:    ["server_name", "transport"],
      disconnect: ["server_name"],
      reconnect:  ["server_name"],
    },
  });

  registerToolMetadata("agents_manage", {
    validActions: ["create", "get", "update", "delete", "suspend", "resume", "list"],
    validKeys: ["action", "agent_id", "config"],
    // agent_id is required for every action except list.
    requiredByAction: {
      create:  ["agent_id", "config"],
      get:     ["agent_id"],
      update:  ["agent_id", "config"],
      delete:  ["agent_id"],
      suspend: ["agent_id"],
      resume:  ["agent_id"],
    },
  });

  registerToolMetadata("tokens_manage", {
    validActions: ["list", "create", "revoke", "rotate"],
    validKeys: ["action", "token_id", "scopes"],
    // create: token_id is auto-generated when omitted (per the schema +
    // handler's non-required readStringParam call); only scopes is strictly
    // required.
    requiredByAction: {
      create: ["scopes"],
      revoke: ["token_id"],
      rotate: ["token_id"],
    },
  });

  registerToolMetadata("providers_manage", {
    validActions: ["list", "get", "create", "update", "delete", "enable", "disable"],
    validKeys: ["action", "provider_id", "config"],
    requiredByAction: {
      get:     ["provider_id"],
      create:  ["provider_id", "config"],
      update:  ["provider_id", "config"],
      delete:  ["provider_id"],
      enable:  ["provider_id"],
      disable: ["provider_id"],
    },
  });

  registerToolMetadata("channels_manage", {
    validActions: ["list", "get", "enable", "disable", "restart", "configure"],
    validKeys: ["action", "channel_type", "setting", "enabled"],
    requiredByAction: {
      get:       ["channel_type"],
      enable:    ["channel_type"],
      disable:   ["channel_type"],
      restart:   ["channel_type"],
      configure: ["channel_type", "setting", "enabled"],
    },
  });

  registerToolMetadata("sessions_manage", {
    validActions: ["delete", "reset", "export", "compact"],
    validKeys: ["action", "session_key", "instructions"],
    requiredByAction: {
      delete:  ["session_key"],
      reset:   ["session_key"],
      export:  ["session_key"],
      compact: ["session_key"],
    },
  });

  registerToolMetadata("skills_manage", {
    validActions: ["list", "import", "delete", "create", "update"],
    validKeys: ["action", "url", "name", "content", "description", "scope"],
    requiredByAction: {
      import: ["url"],
      delete: ["name"],
      create: ["name", "content"],
      update: ["name", "content"],
    },
  });

  registerToolMetadata("memory_manage", {
    validActions: ["stats", "browse", "delete", "flush", "export"],
    validKeys: [
      "action", "tenant_id", "agent_id", "ids", "offset", "limit", "sort",
      "memory_type", "trust_level", "tags",
    ],
    // tenant_id / agent_id are scope filters with defaults; only ids is
    // strictly required (for delete).
    requiredByAction: {
      delete: ["ids"],
    },
  });

  registerToolMetadata("models_manage", {
    validActions: ["list", "test", "list_providers"],
    validKeys: ["action", "provider", "model"],
    requiredByAction: {
      test: ["provider", "model"],
    },
  });

  registerToolMetadata("heartbeat_manage", {
    validActions: ["get", "update", "status", "trigger"],
    validKeys: [
      "action", "agent_id", "enabled", "interval_ms", "prompt", "model",
      "target_channel_type", "target_channel_id", "target_chat_id", "target_is_dm",
      "light_context", "show_ok", "show_alerts", "allow_dm",
      "skip_heartbeat_only_delivery", "ack_max_chars", "response_prefix", "session",
      "alert_threshold", "alert_cooldown_ms", "stale_ms",
    ],
    // Every action's params beyond `action` are Type.Optional. Empty
    // requiredByAction still gates unknown action values + unknown keys via
    // validActions / validKeys.
    requiredByAction: {},
  });

  // =========================================================================
  // Output Schemas
  // =========================================================================

  registerToolMetadata("read", {
    outputSchema: {
      type: "object",
      description: "File read metadata",
      properties: {
        totalLines: { type: "number", description: "Total lines in file" },
        startLine: { type: "number", description: "First line returned (1-based)" },
        endLine: { type: "number", description: "Last line returned (1-based)" },
        sizeBytes: { type: "number", description: "File size in bytes" },
        encoding: { type: "string", description: "Detected encoding (utf-8, utf-16le, latin1)" },
        paginated: { type: "boolean", description: "True when offset/limit cropped the output" },
        notebook: { type: "boolean", description: "True for .ipynb files" },
        cells: { type: "number", description: "Number of notebook cells (notebooks only)" },
        pdf: { type: "boolean", description: "True for PDF files" },
        pageCount: { type: "number", description: "Pages extracted (PDFs only)" },
        totalPages: { type: "number", description: "Total pages in PDF" },
      },
    },
  });

  registerToolMetadata("grep", {
    outputSchema: {
      type: "string",
      description:
        "Text output (not JSON). Default mode: `filepath:linenum: content` per line. " +
        "files_with_matches mode: one filepath per line. " +
        "count mode: `filepath: N matches` per line, sorted descending. " +
        "Trailing `[...]` notices indicate truncation or limits.",
    },
  });

  registerToolMetadata("find", {
    outputSchema: {
      type: "string",
      description:
        "Text output (not JSON). Newline-separated file paths sorted by modification time (most recent first). " +
        "Paths relative to workspace root. Trailing `[...]` notices for truncation.",
    },
  });

  registerToolMetadata("exec", {
    outputSchema: {
      type: "object",
      description: "Shell command execution result",
      properties: {
        exitCode: { type: "number", description: "0 = success, 124 = timeout" },
        stdout: { type: "string", description: "Standard output" },
        stderr: { type: "string", description: "Standard error" },
        description: { type: "string", description: "User-provided command label" },
        truncated: { type: "boolean", description: "True when output exceeded buffer" },
        fullOutputPath: { type: "string", description: "Path to full output on disk" },
      },
    },
  });

  registerToolMetadata("memory_search", {
    outputSchema: {
      type: "object",
      description: "Memory search results",
      properties: {
        results: {
          type: "array",
          description: "Matching entries (content max 500 chars each)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              score: { type: "number" },
              tags: { type: "array", items: { type: "string" } },
              createdAt: { type: "number", description: "Epoch ms" },
            },
          },
        },
      },
    },
  });

  registerToolMetadata("web_search", {
    outputSchema: {
      type: "object",
      description:
        "Web search results. List-based providers (Brave/Tavily) return results[]. " +
        "Perplexity/Grok return { content, citations } instead.",
      properties: {
        query: { type: "string" },
        provider: { type: "string" },
        tookMs: { type: "number" },
        results: {
          type: "array",
          description: "List-based provider results",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    },
  });

  registerToolMetadata("sessions_list", {
    outputSchema: {
      type: "object",
      description: "Active sessions listing",
      properties: {
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sessionKey: { type: "string" },
              agentId: { type: "string" },
              userId: { type: "string" },
              channelId: { type: "string" },
              kind: { type: "string" },
              messageCount: { type: "number" },
              totalTokens: { type: "number" },
              updatedAt: { type: "number" },
              createdAt: { type: "number" },
            },
          },
        },
        total: { type: "number", description: "Total session count" },
      },
    },
  });

  // =========================================================================
  // Search Hints
  // =========================================================================

  // --- Session tools ---
  registerToolMetadata("sessions_list",    { searchHint: "active sessions connections users online list enumerate" });
  registerToolMetadata("sessions_history", { searchHint: "chat log transcript conversation history messages past" });
  registerToolMetadata("sessions_send",    { searchHint: "send reply respond direct message channel session inject" });
  registerToolMetadata("sessions_spawn",   { searchHint: "delegate subagent background async child worker spawn" });
  registerToolMetadata("subagents",        { searchHint: "parallel fan-out concurrent multi-agent batch delegate" });
  registerToolMetadata("pipeline",         { searchHint: "workflow dag graph orchestrate chain multi-step sequential" });
  registerToolMetadata("session_status",   { searchHint: "session state alive running progress heartbeat check" });
  registerToolMetadata("session_search",   { searchHint: "find session lookup filter match query user channel" });
  // --- Platform tools ---
  registerToolMetadata("cron",             { searchHint: "schedule timer reminder recurring job automation crontab interval" });
  registerToolMetadata("gateway",          { searchHint: "config restart patch status settings yaml update system admin" });
  registerToolMetadata("image_analyze",    { searchHint: "vision ocr describe photo picture identify detect recognize" });
  registerToolMetadata("tts_synthesize",   { searchHint: "speech voice audio speak narrate text-to-speech vocalize" });
  registerToolMetadata("transcribe_audio", { searchHint: "stt speech-to-text whisper dictation voice recording audio" });
  registerToolMetadata("describe_video",   { searchHint: "video clip movie mp4 mov webm scene describe motion visual" });

  // --- Document and browser tools ---
  registerToolMetadata("extract_document", { searchHint: "pdf csv docx xlsx parse text content extract spreadsheet" });
  registerToolMetadata("browser",          { searchHint: "chrome headless puppeteer navigate click screenshot scrape" });

  // --- Platform channel actions ---
  registerToolMetadata("discord_action",  { searchHint: "pin kick ban roles threads channels guild server discord" });
  registerToolMetadata("telegram_action", { searchHint: "pin poll sticker admin topics group supergroup telegram" });
  registerToolMetadata("slack_action",    { searchHint: "pin react thread channel topic archive bookmark slack" });
  registerToolMetadata("whatsapp_action", { searchHint: "status group admin label broadcast forward whatsapp" });

  // --- Privileged management tools ---
  registerToolMetadata("agents_manage",    { searchHint: "fleet list create delete suspend resume agent configure roster inventory" });
  registerToolMetadata("obs_query",        { searchHint: "diagnostics monitoring metrics billing health explain incident post-mortem" });
  registerToolMetadata("sessions_manage",  { searchHint: "delete reset export compact session lifecycle cleanup admin" });
  registerToolMetadata("memory_manage",    { searchHint: "delete flush export browse stats storage cleanup purge" });
  registerToolMetadata("channels_manage",  { searchHint: "enable disable restart channel adapter platform connection" });
  registerToolMetadata("tokens_manage",    { searchHint: "api key token rotate revoke generate auth credential" });
  registerToolMetadata("models_manage",    { searchHint: "llm provider model switch configure cost tier pricing" });
  registerToolMetadata("skills_manage",    { searchHint: "skill plugin capability register unregister enable toggle" });
  registerToolMetadata("mcp_manage",       { searchHint: "mcp server protocol connect disconnect tool external" });
  registerToolMetadata("heartbeat_manage", { searchHint: "heartbeat keepalive watchdog health probe interval alive" });

  // =========================================================================
  // Co-discovery Relationships
  // =========================================================================

  // Model switching requires both models_manage (catalog) and agents_manage (apply model to agent)
  registerToolMetadata("models_manage", { coDiscoverWith: ["agents_manage"] });
  registerToolMetadata("agents_manage", { coDiscoverWith: ["models_manage"] });

  // =========================================================================
  // MCP Export Policy
  //
  // Per-tool policy controlling exposure via the Comis-as-MCP-Server
  // endpoint at /mcp/v1. The CI gate at
  // test/architecture/mcp-export-policy.test.ts AST-walks this file and
  // asserts every UNIQUE tool name registered above has at least ONE call
  // here (or anywhere in this file) setting `mcpExportPolicy`.
  //
  // 51 unique tool names → 51 annotation lines below. Spread-merge in
  // @comis/core's registerToolMetadata preserves all sibling fields
  // (size cap, isReadOnly, validateInput, outputSchema, searchHint,
  // coDiscoverWith) — annotating in a dedicated section is auditable
  // for code-review and grep-able for the security reviewer.
  //
  // SECURITY GATE — these values are CONSERVATIVE DEFAULTS subject to a
  // HUMAN security-reviewer gate before the gateway endpoint
  // flips live. The CI gate enforces ANNOTATION PRESENCE only; the
  // literal value here IS the security policy.
  //
  // Categories:
  //   "safe"             — exposed to any mcp-client token (no allowlist required).
  //                        Demonstrably non-PII, read-only, no Comis state read,
  //                        caller-supplied input only.
  //   "permission-gated" — exposed ONLY if the token's mcpClient.allowlist
  //                        includes the tool name. Read-only views over Comis
  //                        state, or caller-data-dependent tools (file access,
  //                        memory/session reads, context engine, observability,
  //                        media analysis where the caller supplies the asset
  //                        but the tool MAY read Comis-stored media IDs).
  //   "never-export"     — NEVER exposed under any operator config. Admin tools,
  //                        filesystem/process mutation, outbound channel sends,
  //                        memory/session writes, agent spawning, scheduled
  //                        tasks, token/skill/MCP/provider/model/channel admin,
  //                        cross-account effects, cost-bearing synthesis.
  //
  // Media tools (image_analyze, describe_video, extract_document, transcribe_audio)
  // default to `permission-gated` (safer default) — the registry comments do NOT
  // assert caller-supplied-only semantics. The security reviewer should
  // re-confirm whether to upgrade any of these to `safe`.
  // =========================================================================

  // --- safe (3) — public/caller-supplied input, no Comis state read ---
  registerToolMetadata("web_search", { mcpExportPolicy: "safe" });
  registerToolMetadata("web_fetch",  { mcpExportPolicy: "safe" });
  registerToolMetadata("browser",    { mcpExportPolicy: "safe" });

  // --- permission-gated (21) — caller-data-dependent; allowlist required ---
  // Workspace file access (4) — operator allowlists by path scope at the daemon.
  registerToolMetadata("read", { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("ls",   { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("find", { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("grep", { mcpExportPolicy: "permission-gated" });
  // Comis memory read (2) — allowlist by tenant.
  registerToolMetadata("memory_search", { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("memory_get",    { mcpExportPolicy: "permission-gated" });
  // Read-only session views (4) — CONFIRMED-only filter enforced by the resources adapter.
  registerToolMetadata("session_search",   { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("session_status",   { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("sessions_list",    { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("sessions_history", { mcpExportPolicy: "permission-gated" });
  // Observability (3) — all permission-gated; operator allowlists by query scope. obs_explain (154-03) + obs_fleet_health (161-02) are READ-ONLY digests that run their assembler directly under daemon authority (NOT the admin RPC); the allowlist is the grant (merged comments to stay under the 800-line cap).
  registerToolMetadata("obs_query", { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("obs_explain", { mcpExportPolicy: "permission-gated", isReadOnly: true, maxResultSizeChars: 100_000, searchHint: "explain incident root-cause post-mortem session report" });
  registerToolMetadata("obs_fleet_health", { mcpExportPolicy: "permission-gated", isReadOnly: true, maxResultSizeChars: 100_000, searchHint: "fleet health cross-session degradation rate errorKinds breaker trips config posture model health" });
  // Meta-tool (1) — reveals registered-tools attack surface; per-client allowlist required.
  registerToolMetadata("discover_tools", { mcpExportPolicy: "permission-gated" });
  // Media analysis (4) — see media-tools note above. Default permission-gated
  // because the registry does NOT assert caller-supplied-only semantics;
  // these tools MAY read Comis-stored media IDs in some code paths.
  // TODO: security review — re-confirm whether any of these can safely
  // be upgraded to "safe" (caller-supplied-only).
  registerToolMetadata("image_analyze",    { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("describe_video",   { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("extract_document", { mcpExportPolicy: "permission-gated" });
  registerToolMetadata("transcribe_audio", { mcpExportPolicy: "permission-gated" });

  // --- never-export (28) — admin / mutation / outbound / secrets / cost ---
  // Filesystem mutation (3).
  registerToolMetadata("write",       { mcpExportPolicy: "never-export" });
  registerToolMetadata("edit",        { mcpExportPolicy: "never-export" });
  registerToolMetadata("apply_patch", { mcpExportPolicy: "never-export" });
  // Arbitrary command/process execution (2).
  registerToolMetadata("exec",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("process", { mcpExportPolicy: "never-export" });
  // Memory write/delete (2).
  registerToolMetadata("memory_store",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("memory_manage", { mcpExportPolicy: "never-export" });
  // Session mutation / message sending / agent spawn (4).
  registerToolMetadata("sessions_manage", { mcpExportPolicy: "never-export" });
  registerToolMetadata("sessions_send",   { mcpExportPolicy: "never-export" });
  registerToolMetadata("sessions_spawn",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("subagents",       { mcpExportPolicy: "never-export" });
  // Scheduled tasks / workflows (2).
  registerToolMetadata("pipeline", { mcpExportPolicy: "never-export" });
  registerToolMetadata("cron",     { mcpExportPolicy: "never-export" });
  // Admin tools — gateway config, agents, tokens, MCP, skills, channels, providers, models, heartbeat (9).
  registerToolMetadata("gateway",          { mcpExportPolicy: "never-export" });
  registerToolMetadata("heartbeat_manage", { mcpExportPolicy: "never-export" });
  registerToolMetadata("channels_manage",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("tokens_manage",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("skills_manage",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("mcp_manage",       { mcpExportPolicy: "never-export" });
  registerToolMetadata("agents_manage",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("providers_manage", { mcpExportPolicy: "never-export" });
  registerToolMetadata("models_manage",    { mcpExportPolicy: "never-export" });
  // Outbound channel send (5) — generic + per-platform actions.
  registerToolMetadata("message",         { mcpExportPolicy: "never-export" });
  registerToolMetadata("whatsapp_action", { mcpExportPolicy: "never-export" });
  registerToolMetadata("discord_action",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("telegram_action", { mcpExportPolicy: "never-export" });
  registerToolMetadata("slack_action",    { mcpExportPolicy: "never-export" });
  // Cost-bearing synthesis (1).
  registerToolMetadata("tts_synthesize", { mcpExportPolicy: "never-export" });
  // Terminal driver (9) — never-export; inside Comis's trust boundary, NOT an MCP-exported surface.
  registerToolMetadata("terminal_session_create",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_list",      { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_read",      { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_send_text", { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_send_key",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_wait",      { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_status",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_resize",    { mcpExportPolicy: "never-export" });
  registerToolMetadata("terminal_session_kill",      { mcpExportPolicy: "never-export" });
  // Context expansion (3) — never-export; in-session lossless-store recovery (E1/E2),
  // NOT an MCP-exported surface and DISTINCT from cross-session recall.
  registerToolMetadata("ctx_search",  { mcpExportPolicy: "never-export" });
  registerToolMetadata("ctx_inspect", { mcpExportPolicy: "never-export" });
  registerToolMetadata("ctx_expand",  { mcpExportPolicy: "never-export" });

  // =========================================================================
  // Failure Detectors (§16.10/§16.11)
  //
  // Pure, synchronous predicates consulted in pi-event-bridge.ts BEFORE the
  // tool:executed emit, over the RAW result (the only site that sees it).
  // They flag a logically-failed result the SDK reported as success
  // (isError:false) — e.g. web_search/web_fetch that returned a real failure
  // payload alongside a 200.
  //
  // They inspect ONLY the tool's STRUCTURED failure fields — NEVER the fetched
  // body — so legitimate page DATA cannot mis-flag a successful result:
  //   - web_fetch: classify off `error` (a string set only on real failures) and
  //     numeric `status` (>= 400). Never read `result.text`/body. This is the fix
  //     for production session 678314278, where a 200 Yahoo Finance fetch was
  //     mis-flagged `dependency` because IBM's share price "403.92999267578"
  //     contains the substring "403" — a body-substring scan over `/403/` matched
  //     legitimate content, then the tool-retry-breaker told the model to stop
  //     retrying web_fetch.
  //   - web_search: classify off the structured failure fields `error` (a stable
  //     machine code: invalid_provider / invalid_freshness / all_providers_failed),
  //     `message`, and `failures` (joined). web_search has no numeric `status`. The
  //     human-readable reason lives in message+failures, NOT the per-result snippets,
  //     which are never read — so a success snippet containing "rate limit" is safe.
  //
  // MUST NOT throw (object-narrowing guards prevent property-access throws; the
  // regexes only ever run over short structured strings, never untrusted bodies) and
  // MUST return a canonical ErrorKind member (resource/timeout/dependency/…). The
  // internal heuristic kinds used elsewhere in the bridge are NOT valid here — only
  // the closed 10-member ErrorKind union. When isError is already set the SDK flagged
  // it, so the detector defers (returns false — no double-flag). exec's non-zero
  // exitCode is already handled upstream in the bridge, so there is no exec detector
  // here. Spread-merge attaches these to the EXISTING web_search/web_fetch entries —
  // the 51-tool unique count is unchanged.
  // =========================================================================

  registerToolMetadata("web_search", {
    failureDetector: (result, isError) => {
      if (isError) return false; // SDK already flagged it — defer.
      if (result === null || typeof result !== "object") return false;
      const r = result as { error?: unknown; message?: unknown; failures?: unknown };
      // A real web_search failure is signalled by a top-level `error` MACHINE CODE
      // (invalid_provider / invalid_freshness / all_providers_failed). A SUCCESS payload
      // carries `results` but NO top-level `error` — so a success whose snippet contains
      // "rate limit"/"blocked" returns false here (never reads result.results[].snippet).
      if (typeof r.error !== "string") return false;
      // Build the classification text from the STRUCTURED failure fields only — the machine
      // code plus the human-readable `message` and joined `failures` reasons — NEVER the body.
      const failures = Array.isArray(r.failures)
        ? r.failures.filter((f): f is string => typeof f === "string").join(" ")
        : "";
      const text = `${r.error} ${typeof r.message === "string" ? r.message : ""} ${failures}`;
      if (/rate limit|quota exceeded|too many requests/i.test(text)) {
        // Attribute the verdict to the human-readable `message` field (the rate-limit
        // reason lives there + in `failures`, never in the stable `error` code) and report
        // the LITERAL rule that matched — a fixed description, not a serialized RegExp.
        return {
          errorKind: "resource" satisfies ErrorKind,
          classifiedField: "message",
          matchedRule: "/rate limit|quota exceeded|too many requests/",
        };
      }
      // blocked/forbidden/provider-error set, broadened to the failures-chain reasons.
      // A genuine top-level error with an unrecognised reason is still a real failure →
      // default to dependency (never false once `error` is present). Attributed to the
      // top-level `error` machine code; no matchedRule/matchedToken (this is the catch-all).
      return { errorKind: "dependency" satisfies ErrorKind, classifiedField: "error" };
    },
  });

  registerToolMetadata("web_fetch", {
    failureDetector: (result, isError) => {
      if (isError) return false; // SDK already flagged it — defer.
      if (result === null || typeof result !== "object") return false;
      const r = result as { error?: unknown; status?: unknown };
      // Classify off the structured failure fields ONLY. A SUCCESS result has a numeric
      // `status` 200 and NO `error` key — its body lives in `r.text` and may contain "403"
      // (e.g. the IBM share price 403.92999267578 — production session 678314278), "blocked",
      // "timeout" etc. as legitimate DATA. We never read `r.text`/body, so those don't flag.
      if (typeof r.error === "string") {
        // Timeout text lives in the descriptive error string ("Fetch failed: …timed out…").
        // Attribute to the `error` field + the literal timeout rule.
        if (/\btimed out\b|\btimeout\b/i.test(r.error)) {
          return {
            errorKind: "timeout" satisfies ErrorKind,
            classifiedField: "error",
            matchedRule: "/timed out|timeout/",
          };
        }
        // Catch-all once `error` is set and the timeout rule did not match — attributed to
        // the `error` field, no matchedRule/matchedToken.
        return { errorKind: "dependency" satisfies ErrorKind, classifiedField: "error" };
      }
      if (typeof r.status === "number" && r.status >= 400) {
        // No `error` key → the numeric HTTP `status` drives the verdict; the concrete code
        // is the matched token. Gateway-timeout (504) / request-timeout (408) map to timeout.
        if (r.status === 408 || r.status === 504) {
          return {
            errorKind: "timeout" satisfies ErrorKind,
            classifiedField: "status",
            matchedToken: String(r.status),
          };
        }
        return {
          errorKind: "dependency" satisfies ErrorKind,
          classifiedField: "status",
          matchedToken: String(r.status),
        };
      }
      return false;
    },
  });
}
