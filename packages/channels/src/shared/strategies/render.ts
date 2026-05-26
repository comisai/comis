// SPDX-License-Identifier: Apache-2.0
/**
 * Shared rendering helpers for the channel-agnostic strategies.
 *
 * The strategies paint from the redacted `ActivityEvent` hints only — never from
 * raw params (the frame is already projected + redacted, 70-05/70-06;
 * T-70-07-04). `eventLabel` picks the best available short label; `failureLabel`
 * formats the closing failure form from the `TurnOutcome` errorKind (the kept
 * diagnostic, §7.3). Pure functions: no I/O, no logger.
 */
import type { ActivityEvent, TurnOutcome } from "@comis/core";

/** Best-effort short label for one event, drawn from already-redacted hints. */
export function eventLabel(event: ActivityEvent): string {
  return event.defaultLabel ?? event.toolName ?? event.kind;
}

/** One status line per event in display order. */
export function renderFrameText(events: readonly ActivityEvent[]): string {
  return events.map(eventLabel).join("\n");
}

/** Closing failure marker carrying the (closed-union) errorKind. */
export function failureLabel(outcome: Extract<TurnOutcome, { kind: "failure" }>): string {
  return `❌ ${outcome.errorKind}`;
}
