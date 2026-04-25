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
import { validateExecCommand } from "../builtin/exec-security.js";
import { GATEWAY_ACTIONS } from "../builtin/platform/gateway-tool.js";

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
  registerToolMetadata("agents_list",      { isReadOnly: true });

  registerToolMetadata("ctx_search",  { isReadOnly: true });
  registerToolMetadata("ctx_inspect", { isReadOnly: true });
  registerToolMetadata("ctx_expand",  { isReadOnly: true });
  registerToolMetadata("ctx_recall",  { isReadOnly: true });

  registerToolMetadata("image_analyze",    { isReadOnly: true });
  registerToolMetadata("describe_video",   { isReadOnly: true });
  registerToolMetadata("extract_document", { isReadOnly: true });
  registerToolMetadata("transcribe_audio", { isReadOnly: true });

  registerToolMetadata("obs_query",     { isReadOnly: true });
  registerToolMetadata("models_manage", { isReadOnly: true });

  registerToolMetadata("discover_tools", { isReadOnly: true });

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
  // bridge + handler cannot drift (quick-260420-iv2 regression fix).
  // When the rejected section has a dedicated *_manage tool, the message
  // includes a parameter-correct redirect via formatRedirectHint() so any
  // LLM (Opus/Sonnet/Haiku, GPT-5, Gemini, Mistral, etc.) can self-recover
  // without model-specific prompting (quick-260425-t40).
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
  registerToolMetadata("agents_list",      { searchHint: "bots agents roster fleet inventory configured available" });

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

  // --- Context tools ---
  registerToolMetadata("ctx_search",  { searchHint: "rag context knowledge semantic embedding retrieve similar" });
  registerToolMetadata("ctx_inspect", { searchHint: "context detail metadata source provenance inspect entry" });
  registerToolMetadata("ctx_expand",  { searchHint: "context expand elaborate detail follow-up deeper related" });
  registerToolMetadata("ctx_recall",  { searchHint: "memory recall remember fact previous mentioned earlier" });

  // --- Platform channel actions ---
  registerToolMetadata("discord_action",  { searchHint: "pin kick ban roles threads channels guild server discord" });
  registerToolMetadata("telegram_action", { searchHint: "pin poll sticker admin topics group supergroup telegram" });
  registerToolMetadata("slack_action",    { searchHint: "pin react thread channel topic archive bookmark slack" });
  registerToolMetadata("whatsapp_action", { searchHint: "status group admin label broadcast forward whatsapp" });

  // --- Privileged management tools ---
  registerToolMetadata("agents_manage",    { searchHint: "fleet create delete suspend resume agent configure workspace" });
  registerToolMetadata("obs_query",        { searchHint: "diagnostics monitoring metrics billing traces logs health" });
  registerToolMetadata("sessions_manage",  { searchHint: "delete reset export compact session lifecycle cleanup admin" });
  registerToolMetadata("memory_manage",    { searchHint: "delete flush export browse stats storage cleanup purge" });
  registerToolMetadata("channels_manage",  { searchHint: "enable disable restart channel adapter platform connection" });
  registerToolMetadata("tokens_manage",    { searchHint: "api key token rotate revoke generate auth credential" });
  registerToolMetadata("models_manage",    { searchHint: "llm provider model switch configure cost tier pricing" });
  registerToolMetadata("skills_manage",    { searchHint: "skill plugin capability register unregister enable toggle" });
  registerToolMetadata("mcp_manage",       { searchHint: "mcp server protocol connect disconnect tool external" });
  registerToolMetadata("heartbeat_manage", { searchHint: "heartbeat keepalive watchdog health probe interval alive" });

  // =========================================================================
  // Co-discovery Relationships (quick-260414-ppo)
  // =========================================================================

  // Model switching requires both models_manage (catalog) and agents_manage (apply model to agent)
  registerToolMetadata("models_manage", { coDiscoverWith: ["agents_manage"] });
  registerToolMetadata("agents_manage", { coDiscoverWith: ["models_manage"] });
}
