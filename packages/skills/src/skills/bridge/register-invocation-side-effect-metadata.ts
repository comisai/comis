// SPDX-License-Identifier: Apache-2.0
import { registerToolMetadata } from "@comis/core";

const REVIEWED_EMITTED_TOOL_NAMES = [
  "agents_manage",
  "apply_patch",
  "background_tasks",
  "browser",
  "channels_manage",
  "cron",
  "ctx_expand",
  "ctx_inspect",
  "ctx_search",
  "describe_video",
  "discord_action",
  "discover_tools",
  "edit",
  "exec",
  "extract_document",
  "find",
  "gateway",
  "get_prompt",
  "grep",
  "heartbeat_manage",
  "image_analyze",
  "image_generate",
  "list_prompts",
  "list_resources",
  "ls",
  "mcp_login",
  "mcp_manage",
  "memory_ask",
  "memory_get",
  "memory_manage",
  "memory_search",
  "memory_store",
  "message",
  "models_manage",
  "notebook_edit",
  "notify_user",
  "obs_explain",
  "obs_query",
  "obs_system_health",
  "pipeline",
  "process",
  "providers_manage",
  "read",
  "read_resource",
  "session_search",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_manage",
  "sessions_send",
  "sessions_spawn",
  "skills_manage",
  "slack_action",
  "sleep",
  "subagents",
  "telegram_action",
  "terminal_session_create",
  "terminal_session_kill",
  "terminal_session_list",
  "terminal_session_read",
  "terminal_session_resize",
  "terminal_session_send_key",
  "terminal_session_send_text",
  "terminal_session_status",
  "terminal_session_wait",
  "tokens_manage",
  "transcribe_audio",
  "tts_synthesize",
  "video_generate",
  "video_status",
  "web_fetch",
  "web_search",
  "whatsapp_action",
  "write",
] as const;

/** Register the fail-closed execution side-effect classifier by emitted name. */
export function registerInvocationSideEffectMetadata(): void {
  for (const name of REVIEWED_EMITTED_TOOL_NAMES) {
    registerToolMetadata(name, {
      invocationSideEffects: { kind: "always", capabilities: [] },
    });
  }

  registerToolMetadata("cron", {
    validActions: ["add", "list", "update", "remove", "status", "runs", "run", "wake"],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        add: ["scheduling"],
        list: [],
        update: ["scheduling"],
        remove: ["scheduling"],
        status: [],
        runs: [],
        run: ["scheduling"],
        wake: ["scheduling"],
      },
    },
  });
  registerToolMetadata("message", {
    validActions: ["send", "reply", "react", "edit", "delete", "fetch", "attach"],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        send: ["outbound_delivery"],
        reply: ["outbound_delivery"],
        react: ["outbound_delivery"],
        edit: ["outbound_delivery"],
        delete: ["outbound_delivery"],
        fetch: [],
        attach: ["outbound_delivery"],
      },
    },
  });
  registerToolMetadata("discord_action", {
    validActions: [
      "pin", "unpin", "kick", "ban", "unban", "role_add", "role_remove",
      "set_topic", "set_slowmode", "guild_info", "channel_info", "threadCreate",
      "threadList", "threadReply", "channelCreate", "channelEdit", "channelDelete",
      "channelMove", "setPresence",
    ],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        pin: [], unpin: [], kick: [], ban: [], unban: [], role_add: [], role_remove: [],
        set_topic: [], set_slowmode: [], guild_info: [], channel_info: [], threadCreate: [],
        threadList: [], threadReply: ["outbound_delivery"], channelCreate: [], channelEdit: [],
        channelDelete: [], channelMove: [], setPresence: [],
      },
    },
  });
  registerToolMetadata("telegram_action", {
    validActions: [
      "pin", "unpin", "poll", "sticker", "chat_info", "member_count", "get_admins",
      "set_title", "set_description", "ban", "unban", "promote",
    ],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        pin: [], unpin: [], poll: ["outbound_delivery"], sticker: ["outbound_delivery"],
        chat_info: [], member_count: [], get_admins: [], set_title: [], set_description: [],
        ban: [], unban: [], promote: [],
      },
    },
  });
  registerToolMetadata("pipeline", {
    validActions: ["define", "execute", "status", "cancel", "save", "load", "list", "delete", "outputs", "from_intent"],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        define: [], execute: ["deferred_work"], status: ["deferred_work"],
        cancel: ["deferred_work"], save: [], load: [], list: [], delete: [],
        outputs: ["deferred_work"], from_intent: ["deferred_work"],
      },
    },
  });
  registerToolMetadata("heartbeat_manage", {
    validActions: ["get", "update", "status", "trigger"],
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        get: [], update: ["scheduling"], status: [], trigger: ["deferred_work"],
      },
    },
  });

  for (const name of ["notify_user", "sessions_send", "tts_synthesize", "image_generate"] as const) {
    registerToolMetadata(name, {
      invocationSideEffects: { kind: "always", capabilities: ["outbound_delivery"] },
    });
  }
  registerToolMetadata("video_generate", {
    invocationSideEffects: {
      kind: "always",
      capabilities: ["outbound_delivery", "deferred_work"],
    },
  });
  for (const name of [
    "video_status",
    "sessions_spawn",
    "exec",
    "process",
    "subagents",
    "background_tasks",
    "terminal_session_create",
    "terminal_session_kill",
    "terminal_session_list",
    "terminal_session_read",
    "terminal_session_resize",
    "terminal_session_send_key",
    "terminal_session_send_text",
    "terminal_session_status",
    "terminal_session_wait",
  ] as const) {
    registerToolMetadata(name, {
      invocationSideEffects: { kind: "always", capabilities: ["deferred_work"] },
    });
  }
}
