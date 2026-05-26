// SPDX-License-Identifier: Apache-2.0
/**
 * Shared rendering helpers for the channel-agnostic strategies.
 *
 * The strategies paint from the redacted `ActivityEvent` hints only — never from
 * raw params (the frame is already projected + redacted, 70-05/70-06;
 * T-70-07-04). `eventLabel` picks the best available short label; `failureLabel`
 * formats the closing failure form from the `TurnOutcome` errorKind (the kept
 * diagnostic, §7.3). Pure functions: no I/O, no logger.
 *
 * Subagent parent line (APV-03): a `kind:"subagent"` event's `defaultLabel`
 * already carries the `🤖` marker the projection set (activity-stream T-73-07),
 * so `renderFrameText`/`eventLabel` paint it verbatim — Discord/Slack key the
 * thread shell off that marker in the sent text. `subagentLine` lets a
 * plain-text, depth-aware renderer (IRC, §18.3) prepend a `↳ ` depth prefix;
 * the prefix is a renderer concern, not data baked into the event here.
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

/**
 * Render a subagent (or any) event line with an optional depth prefix.
 *
 * The IRC LinePerEvent renderer (§18.3) calls this with `depthPrefix: "↳ "` to
 * mark a nested subagent line; surfaces that paint the `🤖`-marked
 * `defaultLabel` directly call it with no prefix (the default). Pure: returns
 * `${depthPrefix}${eventLabel(event)}` with no truncation — line caps stay the
 * caller's concern (LinePerEvent's 512-char IRC cap).
 */
export function subagentLine(event: ActivityEvent, opts?: { depthPrefix?: string }): string {
  return `${opts?.depthPrefix ?? ""}${eventLabel(event)}`;
}

/** Closing failure marker carrying the (closed-union) errorKind. */
export function failureLabel(outcome: Extract<TurnOutcome, { kind: "failure" }>): string {
  return `❌ ${outcome.errorKind}`;
}
