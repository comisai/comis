// SPDX-License-Identifier: Apache-2.0
/**
 * Shared rendering helpers for the channel-agnostic strategies.
 *
 * The strategies paint from the redacted `ActivityEvent` hints only — never from
 * raw params (the frame is already projected + redacted upstream).
 * `eventLabel` picks the best available short label; `failureLabel`
 * formats the closing failure form from the `TurnOutcome` errorKind (the kept
 * diagnostic). Pure functions: no I/O, no logger.
 *
 * Subagent parent line: a `kind:"subagent"` event's `defaultLabel`
 * already carries the `🤖` marker the projection set (activity-stream),
 * so `renderFrameText`/`eventLabel` paint it verbatim — Discord/Slack key the
 * thread shell off that marker in the sent text. `subagentLine` lets a
 * plain-text, depth-aware renderer (IRC) prepend a `↳ ` depth prefix;
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
 * literals MUST mirror the `default` theme's markers so a marker-less
 * call stays byte-identical to the default theme's cross/check closing lines.
 */
const DEFAULT_MARKERS: Pick<ActivityStatusMarkers, "success" | "failure"> = {
  success: "✓",
  failure: "❌",
};

/**
 * Default running glyph mirrors {@link DEFAULT_MARKERS}'s pattern (parity with
 * the failure branch). Kept here — not exported — so a markerless `eventLabel`
 * call stays byte-identical to the `default` theme's `🔧`.
 *
 * The running marker is baked into START events only, at the activity-stream
 * emit site (by design — the marker conveys in-flight status). coalesce.ts
 * Step 1.5 prefers `phase:"end"` events (failed end events get the ❌ prefix
 * in `eventLabel`'s failure branch). Slow-completed end events (>=1500ms,
 * exempt from isDroppableFastSuccess) survive Step 1 AND are kept by
 * Step 1.5 → their bare defaultLabel reaches `eventLabel` with no baked-in
 * marker → without re-derivation the render would be asymmetric (fast tool
 * calls show 🔧 because the marked start survives; slow tool calls render
 * bare). The kept-end re-derivation branch below keeps the per-step
 * running-glyph symmetric regardless of duration. Idempotent on
 * already-marked start events.
 */
const DEFAULT_RUNNING_MARKER = "🔧";

/**
 * Boundary / depth-prefix markers that downstream projections or renderers may
 * have already baked into `defaultLabel`. When the label starts with one of
 * these (followed by a space), the running glyph is omitted — that line is NOT
 * an in-flight tool step:
 *   - `🤖 ` — subagent boundary marker (projection-baked at activity-stream
 *     emit, per activity-stream.ts:602/621). Pairs with the `kind:"subagent"`
 *     exemption in {@link eventLabel}; the label-level guard catches the test
 *     shorthand where a `kind:"tool"` event carries a `🤖 …` label.
 *   - `↳ ` — IRC depth prefix (applied by `subagentLine` in the IRC renderer
 *     for nested subagent lines). Catches the same test shorthand.
 *
 * Match the `"${marker} "` prefix INCLUDING the trailing space — the running
 * marker is baked space-delimited at the activity-stream START emit
 * (`"🔧 …"`); a defaultLabel that happens to start with the same
 * glyph glued to text (no space) is NOT already-marked and should still get
 * the prefix.
 */
const BOUNDARY_LABEL_PREFIXES = ["🤖 ", "↳ "] as const;

function withRunningMarker(base: string, runningMarker: string): string {
  if (base.startsWith(`${runningMarker} `)) return base;
  for (const p of BOUNDARY_LABEL_PREFIXES) if (base.startsWith(p)) return base;
  return `${runningMarker} ${base}`;
}

/**
 * Best-effort short label for one event, drawn from already-redacted hints.
 *
 * Three branches, in priority order:
 *   1. `status === "failed"` — prefix the themed failure marker (default: ❌,
 *      ascii: [ERR]). The kept end event of a failed call arrives bare (the
 *      running 🔧 is only baked into start events at the activity-stream emit
 *      site, by design — the marker conveys in-flight status), so the renderer
 *      is the right place to surface the final status.
 *   2. Boundary / structural-ask kinds (`subagent`, `approval`, `clarify`) —
 *      return the label verbatim. These are NOT in-flight tool steps:
 *      - subagent: the projection bakes the `🤖` boundary marker; that glyph
 *        is the semantic signal (render.ts:14-17 docblock — Discord/Slack key
 *        thread shells off it).
 *      - approval / clarify: structural asks ("approval required: bash" /
 *        "needs clarification") — they invite a user response, they do not
 *        represent an in-flight tool step. Both are preserved by coalesce.ts
 *        Step 1 (isPreserved branch at line 51); the running 🔧 glyph would
 *        misrepresent them as work-in-progress.
 *   3. Otherwise — prepend the themed running marker (default: 🔧, ascii: [..])
 *      via {@link withRunningMarker}. Idempotent on labels that already carry
 *      the same marker (baked-in START events pass through
 *      unchanged). Kept slow-completed end events (>=1500ms) arrive bare;
 *      they get the per-step glyph here for symmetry with fast-completed
 *      calls.
 *
 * Default-theme parity: markerless call falls back to {@link DEFAULT_MARKERS}
 * for failure and {@link DEFAULT_RUNNING_MARKER} for running, byte-identical
 * to `failureLabel`'s / the `default` theme's markers.
 */
export function eventLabel(event: ActivityEvent, markers?: ActivityStatusMarkers): string {
  const base = event.defaultLabel ?? event.toolName ?? event.kind;
  if (event.status === "failed") {
    return `${markers?.failure ?? DEFAULT_MARKERS.failure} ${base}`;
  }
  if (event.kind === "subagent" || event.kind === "approval" || event.kind === "clarify") {
    return base;
  }
  return withRunningMarker(base, markers?.running ?? DEFAULT_RUNNING_MARKER);
}

/**
 * Render a frame to text: a plan-state header (when SEP is active) +
 * a bounded `(step N of M)` counter + a `───` separator + one status
 * line per visible event. Appends `×N` (default) /
 * `xN` (ascii) to any visible event that represents a coalesced surrogate
 * (`frame.groupedActivityIds[event.activityId].length > 1`). Appends
 * `(running N s)` as an elapsed-time fallback
 * when no plan is active AND the caller supplies `elapsedMs`.
 *
 * The 3 in-scope strategies (EditPlace, AppendOnly, DeleteAndRepost) capture
 * `startedAtMs` on first apply() and pass `elapsedMs = clock.now() - startedAtMs`
 * here. LinePerEvent and DigestOnly do NOT call this function — they use
 * `eventLabel(event)` per-event and own their own elapsed display.
 */
export function renderFrameText(
  frame: ActivityRenderFrame,
  markers?: ActivityStatusMarkers,
  elapsedMs?: number,
): string {
  const lines: string[] = [];

  // Plan-state checkbox header above the event list when SEP is
  // active. renderPlan emits ALL entries regardless of visibility filter —
  // by-design (the plan is meta-context, not an event); descriptions are
  // redacted upstream at the adapter site, so plan text never carries
  // unredacted content into a channel.
  if (frame.planSnapshot !== undefined && frame.planSnapshot.entries.length > 0) {
    lines.push(renderPlan(frame.planSnapshot));
    // Bounded `(step N of M)` counter from the
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

  // Per-event line + coalescing surrogate count.
  // `frame.groupedActivityIds[event.activityId]` is the constituents array;
  // a length > 1 marks this event as a coalesced surrogate (the head id is
  // the surrogate's activityId, the array carries the underlying ids the
  // surrogate stands in for). Single-element entries (length === 1) are NOT
  // surrogates — they're a degenerate 1-of-1 group and render bare. Subagent
  // collapse uses parentActivityId (a separate mechanism), NOT
  // groupedActivityIds — so subagent events are never decorated with ×N.
  //
  // The contract declares `groupedActivityIds` as a non-optional
  // `Readonly<Record<string, readonly string[]>>` (channel-activity-renderer.ts:40),
  // but some older test fixtures construct frames via `as` casts that
  // omit it. Guarding against `undefined` here keeps those frames rendering
  // bare (no ×N decoration) — the production projection always supplies the
  // map, so this only protects the pre-existing test surface.
  const grouped = frame.groupedActivityIds ?? {};
  for (const event of frame.visibleEvents) {
    // Thread `markers` so a failed event picks up the themed failure glyph
    // (default: ❌, ascii: [ERR]) — see eventLabel's docstring for the
    // rationale (kept end events of failed calls arrive bare; the emit-site
    // marker only conveys in-flight status).
    const base = eventLabel(event, markers);
    const constituents = grouped[event.activityId];
    const groupCount = constituents !== undefined ? constituents.length : 0;
    if (groupCount > 1) {
      // Defense-in-depth fallback chain: theme-supplied separator → hard-coded
      // `"×"` literal (the default theme also supplies `"×"`, so a markerless
      // call stays byte-identical to the themed default). A custom theme that
      // omits surrogateSeparator inherits the multiplication sign — graceful.
      const sep = markers?.surrogateSeparator ?? "×";
      lines.push(`${base} ${sep}${groupCount}`);
    } else {
      lines.push(base);
    }
  }

  // Elapsed-time fallback when no
  // SEP plan is active. Fires when `elapsedMs` is supplied (`!== undefined`,
  // so `elapsedMs === 0` legitimately produces `(running 0 s)` on the first
  // apply()) AND `frame.planSnapshot === undefined` (the plan header above
  // already conveys progress — no double-display).
  if (frame.planSnapshot === undefined && elapsedMs !== undefined) {
    const seconds = Math.floor(elapsedMs / 1000);
    lines.push(`(running ${seconds} s)`);
  }

  return lines.join("\n");
}

/**
 * Render a subagent (or any) event line with an optional depth prefix.
 *
 * The IRC LinePerEvent renderer calls this with `depthPrefix: "↳ "` to
 * mark a nested subagent line; surfaces that paint the `🤖`-marked
 * `defaultLabel` directly call it with no prefix (the default). Pure: returns
 * `${depthPrefix}${eventLabel(event)}` with no truncation — line caps stay the
 * caller's concern (LinePerEvent's 512-char IRC cap).
 */
export function subagentLine(event: ActivityEvent, opts?: { depthPrefix?: string }): string {
  return `${opts?.depthPrefix ?? ""}${eventLabel(event)}`;
}

/**
 * Append a plain-text approval prompt under the frame text.
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
 * output is the cross-prefixed `"<marker> {errorKind}"`;
 * the ascii theme yields `"[ERR] {errorKind}"` with no emoji. Interpolates
 * ONLY the closed-union `errorKind` plus the fixed one-line `reason` (a
 * named-constant string from the abort mapper) — never raw outcome internals.
 *
 * When `outcome.reason` is present (a resource abort: step limit / loop), the
 * label reads `"<marker> {errorKind} — {reason}"` so a stopped turn renders
 * truthfully instead of the bare errorKind. Absent reason → the bare
 * `"<marker> {errorKind}"` form.
 */
export function failureLabel(
  outcome: Extract<TurnOutcome, { kind: "failure" }>,
  markers?: Pick<ActivityStatusMarkers, "failure">,
): string {
  const base = `${markers?.failure ?? DEFAULT_MARKERS.failure} ${outcome.errorKind}`;
  if (outcome.reason === undefined || outcome.reason.length === 0) return base;
  return `${base} — ${outcome.reason}`;
}

/**
 * Closing success marker for the windowed-edit success line; themed when
 * markers are supplied. With no markers (or the default theme's markers) the
 * output is the check-prefixed `"<marker> done"`; the
 * ascii theme yields `"[OK] done"` with no emoji. The success line carries
 * no errorKind, so `successLabel` takes no outcome.
 *
 * The optional 2nd arg `recoveredFailures` (the
 * count from `TurnOutcome.success_with_recovered_failures.recoveredFailures.length`)
 * appends `(with N recovered failure[s])` after the base label when N > 0,
 * with English singular/plural agreement. 0 or undefined → base label only.
 */
export function successLabel(
  markers?: Pick<ActivityStatusMarkers, "success">,
  recoveredFailures?: number,
): string {
  const base = `${markers?.success ?? DEFAULT_MARKERS.success} done`;
  if (recoveredFailures !== undefined && recoveredFailures > 0) {
    const noun = recoveredFailures === 1 ? "failure" : "failures";
    return `${base} (with ${recoveredFailures} recovered ${noun})`;
  }
  return base;
}
