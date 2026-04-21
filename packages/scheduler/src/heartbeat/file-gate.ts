// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat file gate: trigger-based bypass logic.
 *
 * Event-driven triggers (cron, exec-event, wake, hook) bypass the
 * empty-file gate because the event itself is the instruction --
 * not the HEARTBEAT.md file content.
 *
 * Only "interval" triggers respect the empty-file gate.
 *
 * @module
 */

/** Discriminated trigger kinds for heartbeat execution. */
export type HeartbeatTriggerKind = "interval" | "cron" | "exec-event" | "wake" | "hook";

const BYPASS_TRIGGERS: ReadonlySet<HeartbeatTriggerKind> = new Set([
  "cron",
  "exec-event",
  "wake",
  "hook",
]);

/**
 * Determine whether a trigger kind bypasses the HEARTBEAT.md empty-file gate.
 *
 * Event-driven triggers always execute regardless of file content because
 * the triggering event carries its own context (cron completion, exec result,
 * wake request, lifecycle hook). Only periodic "interval" ticks consult the
 * file to decide whether an LLM call is warranted.
 */
export function shouldBypassFileGates(trigger: HeartbeatTriggerKind): boolean {
  return BYPASS_TRIGGERS.has(trigger);
}
