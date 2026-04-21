// SPDX-License-Identifier: Apache-2.0
/**
 * Media section builders: media files, autonomous media processing,
 * and reaction guidance.
 */

// ---------------------------------------------------------------------------
// 12. Reaction Guidance (skip if minimal or no reactionLevel)
// ---------------------------------------------------------------------------

export function buildReactionGuidanceSection(
  reactionLevel: "minimal" | "extensive" | undefined,
  channelType: string | undefined,
  isMinimal: boolean,
): string[] {
  if (isMinimal || !reactionLevel) return [];

  const channelLabel = channelType ?? "this channel";

  if (reactionLevel === "minimal") {
    return [
      "## Reactions",
      `Reactions are enabled for ${channelLabel} in minimal mode.`,
      "React ONLY when truly relevant:",
      "- Acknowledge important user requests or confirmations",
      "- Express genuine sentiment (humor, appreciation) sparingly",
      "- Avoid reacting to routine messages or your own replies",
      "Guideline: at most 1 reaction per 5-10 exchanges.",
    ];
  }

  return [
    "## Reactions",
    `Reactions are enabled for ${channelLabel} in extensive mode.`,
    "Feel free to react liberally:",
    "- Acknowledge messages with appropriate emojis",
    "- Express sentiment and personality through reactions",
    "- React to interesting content, humor, or notable events",
    "- Use reactions to confirm understanding or agreement",
    "Guideline: react whenever it feels natural.",
  ];
}

// ---------------------------------------------------------------------------
// 19. Persisted Media Files (skip if minimal, disabled, or missing tools)
// ---------------------------------------------------------------------------

/**
 * Build the "Persisted Media Files" section that teaches the agent about
 * the media persistence -> memory search -> message attach retrieval flow.
 *
 * Gated on: !isMinimal, mediaPersistenceEnabled, hasMemoryTools,
 * hasMessageTool, and workspaceDir being defined.
 */
export function buildMediaFilesSection(
  hasMemoryTools: boolean,
  hasMessageTool: boolean,
  workspaceDir: string | undefined,
  mediaPersistenceEnabled: boolean,
  isMinimal: boolean,
): string[] {
  if (isMinimal) return [];
  if (!mediaPersistenceEnabled) return [];
  if (!hasMemoryTools) return [];
  if (!hasMessageTool) return [];
  if (!workspaceDir) return [];

  return [
    "## Persisted Media Files",
    "",
    "Photos, videos, documents, and audio sent to you are automatically saved to your workspace and indexed in memory.",
    "",
    "### File Organization",
    "- Photos: `photos/<uuid>.ext`",
    "- Videos: `videos/<uuid>.ext`",
    "- Documents: `documents/<uuid>.ext`",
    "- Audio: `audio/<uuid>.ext`",
    "",
    "### Retrieving and Sending Back Media",
    "When a user asks about previously received files, or asks you to send a file back:",
    '1. Search memory: use `memory_search` with a query like "photo from <user>" or "received files"',
    "   Results contain: `File: photos/<uuid>.ext | [Photo received] From: <sender> via <channel>`",
    "2. Extract the relative path (e.g., `photos/abc123.jpg`) from the memory result",
    `3. Build the absolute path: \`${workspaceDir}/<relative_path>\``,
    `4. Send via: \`message\` tool with action="attach", attachment_url="<absolute_path>", attachment_type matching the media kind (image, video, audio, or file)`,
    "",
    "### Important",
    "- File names are UUIDs -- always search memory to find the correct path. Never guess filenames.",
    `- Use absolute paths when sending: combine your workspace directory (\`${workspaceDir}\`) with the relative path from memory.`,
    "- Do NOT read binary files (photos, videos, audio). Send the path directly via `message` attach.",
    "- For web URLs, use MEDIA: directives. For workspace files, use `message` with action=attach.",
  ];
}

// ---------------------------------------------------------------------------
// 20. Autonomous Media Processing (skip if minimal or auto-processing fully enabled)
// ---------------------------------------------------------------------------

/**
 * Build the "Autonomous Media Processing" section that instructs the agent
 * to proactively process attachment hints using on-demand tools.
 *
 * Gated on: !isMinimal AND autonomousMediaEnabled=true (at least one
 * preprocessing pipeline is disabled, so hints will appear in messages).
 */
export function buildAutonomousMediaSection(
  autonomousMediaEnabled: boolean,
  isMinimal: boolean,
): string[] {
  if (isMinimal || !autonomousMediaEnabled) return [];

  return [
    "## Processing Attachment Hints",
    "",
    "When a preprocessing pipeline is disabled, you will see attachment hints in messages like:",
    "- `[Attached: voice message (3000ms, audio/ogg) — use transcribe_audio tool to listen | url: tg-file://...]`",
    "- `[Attached: image (image/jpeg, 12345 bytes) — use image_analyze tool to view | url: tg-file://...]`",
    "- `[Attached: video (video/mp4, 99999 bytes) — use describe_video tool to view | url: tg-file://...]`",
    "- `[Attached: document \"report.pdf\" (application/pdf) — use extract_document tool to read | url: tg-file://...]`",
    "",
    "### Instructions",
    "When you see an attachment hint:",
    "1. Use the specified tool, passing the `url:` value as `attachment_url`.",
    "2. For voice messages: **always** transcribe before responding — the user expects you to hear them.",
    "3. For images, videos, documents: use the tool when the attachment is relevant to the conversation.",
    "4. Process attachments before formulating your response so you have the full context.",
    "",
    "### Tool Reference",
    "- Voice/audio hints → `transcribe_audio(attachment_url: <url>)` — optional `language` BCP-47 hint",
    "- Image hints → `image_analyze(attachment_url: <url>)` — optional `prompt` for specific questions",
    "- Video hints → `describe_video(attachment_url: <url>)` — optional `prompt` for specific questions",
    "- Document hints → `extract_document(attachment_url: <url>)` — optional `max_chars` limit",
  ];
}
