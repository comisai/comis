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
import type {
  ActivityEvent,
  ActivityRenderFrame,
  ActivityStatusMarkers,
  TurnOutcome,
} from "@comis/core";
import { renderPlan } from "../plan-renderer.js";

/**
 * Closing-line glyphs when no theme markers are injected (default-theme parity).
 *
 * Only `success`/`failure` are painted on closing lines (`subagent`/`running`
 * are not), so a local `Pick` keeps the intent tight and avoids a runtime
 * dependency on the `default` theme bundle from the channels tier. These two
 * literals MUST mirror the `default` theme's markers (75-01) so a marker-less
 * call stays byte-identical to the pre-75-06 cross/check closing lines.
 */
const DEFAULT_MARKERS: Pick<ActivityStatusMarkers, "success" | "failure"> = {
  success: "✓",
  failure: "❌",
};

/** Best-effort short label for one event, drawn from already-redacted hints. */
export function eventLabel(event: ActivityEvent): string {
  return event.defaultLabel ?? event.toolName ?? event.kind;
}

/**
 * Render a frame to text: SPEC §8.3 plan-state header (when SEP is active) +
 * SPEC §8.5 bounded `(step N of M)` counter + a `───` separator + one status
 * line per visible event.
 *
 * WS-D Phase 78 — the signature migrated from `(events)` to `(frame, markers?)`
 * in one atomic commit covering the 3 strategy call sites + this test file
 * (AGENTS.md §2.10 escape: combined RED+GREEN because the old call shape would
 * not compile against the new signature; the commit message cites this). The
 * elapsed-time fallback (when `planSnapshot === undefined`) lands in Plan
 * 78-05's WS-F.
 */
export function renderFrameText(
  frame: ActivityRenderFrame,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- WS-D Phase 78: markers parameter reserved for Plan 78-05 (WS-E `×N` surrogate count + WS-F elapsed line themed prefix). Threading it through every strategy NOW keeps the migration atomic.
  markers?: ActivityStatusMarkers,
): string {
  const lines: string[] = [];

  // SPEC §8.3: plan-state checkbox header above the event list when SEP is
  // active. renderPlan emits ALL entries regardless of visibility filter —
  // by-design (the plan is meta-context, not an event); descriptions are
  // redacted upstream at the adapter site (Security V9 mitigation).
  if (frame.planSnapshot !== undefined && frame.planSnapshot.entries.length > 0) {
    lines.push(renderPlan(frame.planSnapshot));
    // SPEC §8.5 (first half): bounded `(step N of M)` counter from the
    // in_progress entry's 1-based index. When no entry is in_progress (all
    // done or all pending), the counter is omitted (the header + separator
    // still render).
    const total = frame.planSnapshot.entries.length;
    const inProgressIdx = frame.planSnapshot.entries.findIndex((e) => e.status === "in_progress");
    if (inProgressIdx >= 0) {
      lines.push(`(step ${inProgressIdx + 1} of ${total})`);
    }
    lines.push("───");
  }

  for (const event of frame.visibleEvents) {
    lines.push(eventLabel(event));
  }

  return lines.join("\n");
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

/**
 * Append a plain-text approval prompt under the frame text (APV-10, §6.4.6).
 *
 * The button-less channels (WhatsApp / Signal / iMessage) paint the redacted frame
 * label and, when the frame carries a `kind:"approval"` event, the prompt on the
 * next line ("Reply approve or deny …"). An empty/absent prompt leaves the text
 * byte-identical, so a non-approval frame is untouched. Pure string join — the
 * prompt copy is owned by `buildApprovalPrompt`.
 */
export function appendPrompt(text: string, prompt?: string): string {
  if (prompt === undefined || prompt.length === 0) return text;
  if (text.length === 0) return prompt;
  return `${text}\n${prompt}`;
}

/**
 * Closing failure marker carrying the (closed-union) errorKind; themed when
 * markers are supplied. With no markers (or the default theme's markers) the
 * output is byte-identical to the pre-75-06 cross-prefixed `"<marker> {errorKind}"`;
 * the ascii theme yields `"[ERR] {errorKind}"` with no emoji (UX-01). Interpolates
 * ONLY the closed-union `errorKind` — never raw outcome internals.
 */
export function failureLabel(
  outcome: Extract<TurnOutcome, { kind: "failure" }>,
  markers?: Pick<ActivityStatusMarkers, "failure">,
): string {
  return `${markers?.failure ?? DEFAULT_MARKERS.failure} ${outcome.errorKind}`;
}

/**
 * Closing success marker for the windowed-edit success line (§7.3); themed when
 * markers are supplied. With no markers (or the default theme's markers) the
 * output is byte-identical to the pre-75-06 check-prefixed `"<marker> done"`; the
 * ascii theme yields `"[OK] done"` with no emoji (UX-01). The success line carries
 * no errorKind, so `successLabel` takes no outcome.
 */
export function successLabel(markers?: Pick<ActivityStatusMarkers, "success">): string {
  return `${markers?.success ?? DEFAULT_MARKERS.success} done`;
}
