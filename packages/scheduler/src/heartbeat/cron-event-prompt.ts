/**
 * Cron-event prompt wrappers: named delegates to buildHeartbeatPrompt
 * for cron and exec-event trigger kinds.
 *
 * buildCronEventPrompt: prompt embedding reminder text from cron job payloads
 * buildExecEventPrompt: prompt for async command completion results
 *
 * @module
 */

import type { SystemEventEntry } from "../system-events/system-event-types.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import { buildHeartbeatPrompt } from "./prompt-builder.js";

/**
 * Build a cron-event-specific prompt from queued cron events.
 * Wraps buildHeartbeatPrompt("cron", ...) with the correct trigger kind.
 */
export function buildCronEventPrompt(
  cronEvents: readonly SystemEventEntry[],
  config: Pick<EffectiveHeartbeatConfig, "prompt">,
): string {
  return buildHeartbeatPrompt("cron", cronEvents, config);
}

/**
 * Build an exec-event-specific prompt from queued execution events.
 * Wraps buildHeartbeatPrompt("exec-event", ...) with the correct trigger kind.
 */
export function buildExecEventPrompt(
  execEvents: readonly SystemEventEntry[],
  config: Pick<EffectiveHeartbeatConfig, "prompt">,
): string {
  return buildHeartbeatPrompt("exec-event", execEvents, config);
}
