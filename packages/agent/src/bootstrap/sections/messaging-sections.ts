/**
 * Messaging section builders: reply tags, messaging, background tasks,
 * silent replies, and heartbeats.
 */

// ---------------------------------------------------------------------------
// 9. Messaging (skip if minimal or no message tool)
// ---------------------------------------------------------------------------

export function buildMessagingSection(
  toolNames: string[],
  isMinimal: boolean,
  channelContext?: { channelType: string; channelId: string },
): string[] {
  if (isMinimal || !toolNames.includes("message")) return [];
  return [
    "## Messaging",
    "",
    "### Routing",
    "- Reply to the current session \u2192 your response automatically routes to the source channel. Just reply normally.",
    "- Send to another session \u2192 use the `sessions_send` tool",
    "- Spawn background work \u2192 use the `sessions_spawn` tool",
    "",
    "### Message Tool",
    "Use `message` for channel interactions: send, reply, react, edit, delete, fetch, attach.",
    "Each action requires channel_type and channel_id parameters.",
    ...(channelContext
      ? [`Your current channel: ${channelContext.channelType} (ID: ${channelContext.channelId}).`]
      : []),
    "",
    "### Reply Tags",
    "Wrap replies in tags to control routing:",
    '- `<reply to="channel-id">message</reply>` to reply to a specific channel',
    "- `<reply>message</reply>` to reply in the current channel",
    "",
    "### Rules",
    "- If you use `message` (action=send) to deliver your user-visible reply, respond with ONLY: NO_REPLY (avoid duplicate delivery).",
    '- `[System Message]` blocks are internal context. If one reports completed work and asks for a user update, rewrite it in your normal assistant voice. Never forward raw system message text to users.',
    "- Never use shell execution, code execution, or file tools to send messages. Use only the messaging tools.",
    "- Do NOT use message(action=send) for progress updates, debug output, or placeholder text. The user sees every send as a phone notification. Work silently; deliver the result.",
    "- Use `fetch` to read recent messages from a channel before responding to context you missed.",
    "- The `delete` action requires confirmation and cannot be undone.",
  ];
}

// ---------------------------------------------------------------------------
// 9b. Background Tasks (skip if minimal or no session tool)
// ---------------------------------------------------------------------------

export function buildBackgroundTaskSection(
  toolNames: string[],
  isMinimal: boolean,
  channelContext?: { channelType: string; channelId: string },
): string[] {
  if (isMinimal || !toolNames.includes("sessions_spawn")) return [];
  return [
    "## Background Tasks",
    "When the user asks you to do something \"in the background\", \"while I wait\",",
    "\"let me know when done\", or otherwise indicates they don't want to wait:",
    "1. Use the `sessions_spawn` tool with async=true and a clear task description.",
    "2. Set announce_channel_type and announce_channel_id to route the completion notification back.",
    ...(channelContext
      ? [
          `   Your current channel is "${channelContext.channelType}" (ID: "${channelContext.channelId}").`,
          `   Use announce_channel_type="${channelContext.channelType}" and announce_channel_id="${channelContext.channelId}".`,
        ]
      : []),
    "3. Confirm to the user that the task was spawned and provide the runId.",
    "4. Use the `subagents` tool (action=\"list\") to check progress if asked.",
    "",
    "Do NOT execute long-running tasks inline -- delegate them per the Task Delegation section above.",
    "",
    "- Sync spawn (default): blocks until the sub-agent completes and returns the result.",
    "- Async spawn (async=true): returns a runId immediately. Use `subagents` to check progress.",
    "- Sub-agents run in isolated sessions with their own context — they cannot access your conversation history.",
    "",
    "### Completion Model",
    "Sub-agent completion is push-based: when a sub-agent finishes, its result is automatically announced back to you.",
    "Do not poll session status in a loop. Only check status on-demand when the user asks or when you need to intervene.",
  ];
}

// ---------------------------------------------------------------------------
// 10. Silent Replies (skip if minimal)
// ---------------------------------------------------------------------------

export function buildSilentRepliesSection(isMinimal: boolean): string[] {
  if (isMinimal) return [];
  return [
    "## Silent Replies",
    "When you have nothing to say (no user-visible response needed), respond with ONLY the token.",
    "- HEARTBEAT_OK: heartbeat pings with nothing to report",
    "- NO_REPLY: silent operations, or when you already sent the reply via the message tool",
    "",
    "Rules:",
    "- The token must be your ENTIRE message — nothing else before or after",
    "- Never append the token to an actual response",
    "- Never wrap the token in markdown, code blocks, or quotes",
    "",
    'WRONG: "Sure, I\'ll handle that for you. NO_REPLY"',
    'WRONG: "I\'ve completed the memory flush.\\nNO_REPLY"',
    "WRONG: `NO_REPLY`",
    "RIGHT: NO_REPLY",
    "",
    'WRONG: "HEARTBEAT_OK — everything looks good."',
    'WRONG: "HEARTBEAT_OK\\nAlert: disk usage at 90%"',
    "RIGHT: HEARTBEAT_OK",
  ];
}

// ---------------------------------------------------------------------------
// 11. Heartbeats (skip if minimal or no heartbeatPrompt)
// ---------------------------------------------------------------------------

export function buildHeartbeatsSection(
  heartbeatPrompt: string | undefined,
  isMinimal: boolean,
): string[] {
  if (isMinimal || !heartbeatPrompt) return [];
  return [
    "## Heartbeats",
    `Heartbeat prompt: ${heartbeatPrompt}`,
    "",
    "When you receive a heartbeat poll (a message matching the prompt above):",
    "- If nothing needs attention, reply with exactly: HEARTBEAT_OK",
    "- If something needs attention, reply with the alert text only. Do NOT include HEARTBEAT_OK anywhere in your response.",
    "",
    'WRONG: "HEARTBEAT_OK\\nAlert: cron job failed at 14:30"',
    'WRONG: "HEARTBEAT_OK — but there\'s a disk space warning"',
    "RIGHT: Alert: cron job \"backup-db\" failed at 14:30. Error: connection refused to postgres:5432.",
    "RIGHT: HEARTBEAT_OK",
  ];
}
