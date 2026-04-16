/**
 * Heartbeat prompt builder: per-trigger-type prompt construction.
 *
 * Resolves the trigger kind from SystemEventEntry contextKey prefixes,
 * then builds the appropriate prompt text for the LLM call.
 *
 * - interval: default or custom heartbeat prompt
 * - exec-event: completion notification with event details
 * - cron: scheduled reminder with event details
 *
 * All prompts have the current ISO timestamp appended.
 *
 * @module
 */

import type { SystemEventEntry } from "../system-events/system-event-types.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import type { HeartbeatTriggerKind } from "./file-gate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entry count threshold above which memory stats are injected into the heartbeat prompt. */
export const MEMORY_STATS_THRESHOLD = 100;

export const DEFAULT_HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. " +
  "Do not infer or repeat old tasks from prior chats. If nothing needs attention, " +
  "reply HEARTBEAT_OK.";

/** Memory stats for conditional heartbeat injection. */
export interface HeartbeatMemoryStats {
  totalEntries: number;
  oldestEntryAgeDays: number;
}

// ---------------------------------------------------------------------------
// Trigger resolution
// ---------------------------------------------------------------------------

/**
 * Determine the trigger kind from the system event queue entries.
 *
 * Priority: exec-event > cron > interval (fallback).
 * An empty events array always yields "interval".
 */
export function resolveHeartbeatTriggerKind(
  events: readonly SystemEventEntry[],
): HeartbeatTriggerKind {
  if (events.length === 0) return "interval";

  let hasCron = false;
  for (const event of events) {
    if (event.contextKey.startsWith("exec:")) return "exec-event";
    if (event.contextKey.startsWith("cron:")) hasCron = true;
  }

  return hasCron ? "cron" : "interval";
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the heartbeat prompt for the given trigger kind and events.
 *
 * The prompt is tailored to the trigger:
 * - **interval**: Uses `config.prompt` if set, otherwise `DEFAULT_HEARTBEAT_PROMPT`.
 * - **exec-event**: Completion notification listing event texts.
 * - **cron**: Scheduled reminder listing event texts.
 *
 * All prompts have `\n\nCurrent time: <ISO>` appended.
 */
export function buildHeartbeatPrompt(
  trigger: HeartbeatTriggerKind,
  events: readonly SystemEventEntry[],
  config: Pick<EffectiveHeartbeatConfig, "prompt">,
  memoryStats?: HeartbeatMemoryStats,
): string {
  let body: string;

  switch (trigger) {
    case "interval":
      body = config.prompt ?? DEFAULT_HEARTBEAT_PROMPT;
      break;

    case "exec-event": {
      const texts = events
        .filter((e) => e.contextKey.startsWith("exec:"))
        .map((e) => e.text);
      body =
        "An async command you ran earlier has completed. Here are the results:\n\n" +
        texts.join("\n");
      break;
    }

    case "cron": {
      const texts = events
        .filter((e) => e.contextKey.startsWith("cron:"))
        .map((e) => e.text);
      body =
        "A scheduled reminder has been triggered. Here are the details:\n\n" +
        texts.join("\n\n");
      break;
    }

    default:
      // wake, hook, or unknown -- use default prompt
      body = config.prompt ?? DEFAULT_HEARTBEAT_PROMPT;
      break;
  }

  if (memoryStats && memoryStats.totalEntries > MEMORY_STATS_THRESHOLD) {
    body += `\n\nMemory store status: ${memoryStats.totalEntries} entries, oldest is ${memoryStats.oldestEntryAgeDays} days old.`
      + "\nConsider reviewing old memories during this heartbeat. Use memory_search to find outdated or redundant entries, and memory_store to update or consolidate them.";
  }

  return body + `\n\nCurrent time: ${new Date().toISOString()}`;
}
