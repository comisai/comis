// SPDX-License-Identifier: Apache-2.0
/**
 * Coalescing rules engine for the chat projection.
 *
 * Coalescing belongs to the **chat** projection, not to `ActivityStream`. ACP
 * and Web projections deliberately do not coalesce (IDEs want every step), so
 * this engine lives in core and is consumed only by `chat-projection.ts`. Pure:
 * no I/O, no logger, no clock — timing is read from the event `ts` strings. Never
 * mutates its input.
 */
import type { ActivityEvent } from "../activity-event.js";

/**
 * Activity-rendering verbosity (distinct from the response-style
 * `VerbosityLevel` config — that controls assistant reply length; this controls
 * how much of the activity scaffolding a chat surface shows).
 */
export type ActivityVerbosity = "silent" | "quiet" | "normal" | "verbose";

/** Drop successful steps faster than this (ms) unless verbosity is verbose. */
const FAST_SUCCESS_MS = 1500;
/** Group consecutive same-tool/same-action events closer than this (ms) apart. */
const GROUP_WINDOW_MS = 800;

/**
 * Static coalescing parameters. `maxLines` caps the visible set per
 * verbosity; preserved events (failures/approvals/subagents) are kept even when
 * the cap would otherwise truncate them.
 */
export const CHAT_COALESCE_RULES: {
  readonly fastSuccessMs: number;
  readonly groupWindowMs: number;
  readonly maxLines: Readonly<Record<ActivityVerbosity, number>>;
} = {
  fastSuccessMs: FAST_SUCCESS_MS,
  groupWindowMs: GROUP_WINDOW_MS,
  maxLines: { silent: 0, quiet: 2, normal: 5, verbose: 12 },
};

/** The result of coalescing: the visible events + the surrogate→constituents map. */
export interface CoalesceResult {
  visible: ActivityEvent[];
  grouped: Record<string, readonly string[]>;
}

/**
 * An event is always preserved (never dropped, never silently truncated away)
 * when it is a failure, an approval prompt, or a sub-agent boundary.
 */
function isPreserved(e: ActivityEvent): boolean {
  return e.status === "failed" || e.kind === "approval" || e.kind === "subagent";
}

/** A fast successful step is dropped at every verbosity except verbose. */
function isDroppableFastSuccess(e: ActivityEvent, verbosity: ActivityVerbosity): boolean {
  return (
    e.status === "completed" &&
    (e.durationMs ?? 0) < FAST_SUCCESS_MS &&
    verbosity !== "verbose"
  );
}

/** Two adjacent events group when same tool + same action within the window. */
function sameGroup(a: ActivityEvent, b: ActivityEvent): boolean {
  return (
    a.toolName === b.toolName &&
    a.action === b.action &&
    a.toolName !== undefined &&
    Date.parse(b.ts) - Date.parse(a.ts) < GROUP_WINDOW_MS
  );
}

/** A coalesced run's surrogate id — deterministic (pure), derived from its head. */
function surrogateIdFor(head: ActivityEvent): string {
  return `group:${head.activityId}`;
}

/**
 * Apply the chat coalescing rules to a canonical event stream.
 *
 * Order: (1) drop fast successes (preserved events exempt), (1.5) phase-pair
 * dedup by activityId preferring the `end` event (terminal state), (2) group
 * adjacent same-tool/same-action runs <800ms apart into a single surrogate
 * line, (3) cap the visible set to `maxLines[verbosity]` while always
 * retaining preserved events.
 */
export function coalesce(
  events: readonly ActivityEvent[],
  verbosity: ActivityVerbosity,
): CoalesceResult {
  // 1) Drop fast successes (failures/approvals/subagents are exempt).
  const kept = events.filter(
    (e) => isPreserved(e) || !isDroppableFastSuccess(e, verbosity),
  );

  // 1.5) Phase-pair dedup — for each activityId, keep ONE event. Prefer the
  //      `phase === "end"` event (terminal state, carries the final status +
  //      durationMs) so coalesced lines render with the call's terminal
  //      classification. Without this dedup, a slow-success
  //      start+end pair produced "🔧 doing thing\ndoing thing" — the marked
  //      start AND the bare end both survived Step 1 (start has no
  //      durationMs; end has durationMs ≥ 1500ms). Replacing the start at the
  //      same display position keeps original ordering intact and also feeds
  //      the renderer's failure-marker prefix (status:"failed" → ❌ in
  //      render.ts/eventLabel).
  const dedupedByActivityId: ActivityEvent[] = [];
  const seenIdx = new Map<string, number>();
  for (const e of kept) {
    const existingIdx = seenIdx.get(e.activityId);
    if (existingIdx === undefined) {
      seenIdx.set(e.activityId, dedupedByActivityId.length);
      dedupedByActivityId.push(e);
    } else if (e.phase === "end") {
      // Replace the prior event (typically the start) with the end at the
      // same display position. existingIdx came from `seenIdx.set` above
      // (this module's own Map, never attacker input) — the lint waiver
      // cites that provenance.
      // eslint-disable-next-line security/detect-object-injection -- existingIdx is from this module's seenIdx.set call above, not attacker input
      dedupedByActivityId[existingIdx] = e;
    }
    // else: the new event is not an end (start or progress) and we already
    // have an entry for this activityId — keep the first (the existing entry
    // is either an end, which we don't overwrite, or an earlier start/progress
    // we prefer to stable order).
  }

  // 2) Group consecutive same-tool/same-action runs. A Map avoids
  //    attacker-keyed computed-index sinks (security/detect-object-injection).
  const grouped = new Map<string, readonly string[]>();
  const visible: ActivityEvent[] = [];
  let i = 0;
  while (i < dedupedByActivityId.length) {
    const head = dedupedByActivityId[i]!;
    let j = i + 1;
    // Extend the run while each next event groups with the run head.
    while (j < dedupedByActivityId.length && sameGroup(head, dedupedByActivityId[j]!)) {
      j += 1;
    }
    const runLength = j - i;
    if (runLength > 1) {
      const constituents = dedupedByActivityId.slice(i, j);
      const surrogateId = surrogateIdFor(head);
      // Defense-in-depth: count DISTINCT activityIds, not raw
      // constituent length. Step 1.5 above already collapses same-id pairs,
      // so the production-path constituents array carries distinct ids; the
      // `new Set(...)` dedup here protects against a future regression that
      // re-introduces same-id events into the grouped run (e.g. a Step-1.5
      // tweak that allows start AND end to survive for some kind).
      grouped.set(surrogateId, [...new Set(constituents.map((e) => e.activityId))]);
      // Surrogate carries the head's classification with the surrogate id.
      visible.push({ ...head, activityId: surrogateId });
    } else {
      visible.push(head);
    }
    i = j;
  }

  // 3) Enforce maxLines: keep all preserved events, then fill remaining slots in
  //    order. A surrogate (grouped) line is treated as non-preserved.
  const cap = CHAT_COALESCE_RULES.maxLines[verbosity];
  if (visible.length <= cap) {
    return { visible, grouped: pruneGrouped(grouped, visible) };
  }

  const preserved = visible.filter((e) => isPreserved(e));
  const remainingSlots = Math.max(0, cap - preserved.length);
  const nonPreserved = visible.filter((e) => !isPreserved(e)).slice(0, remainingSlots);

  // Re-assemble in original display order.
  const survivorIds = new Set([...preserved, ...nonPreserved].map((e) => e.activityId));
  const capped = visible.filter((e) => survivorIds.has(e.activityId));
  return { visible: capped, grouped: pruneGrouped(grouped, capped) };
}

/** Drop grouped entries whose surrogate did not survive the maxLines cap. */
function pruneGrouped(
  grouped: ReadonlyMap<string, readonly string[]>,
  visible: readonly ActivityEvent[],
): Record<string, readonly string[]> {
  const liveIds = new Set(visible.map((e) => e.activityId));
  return Object.fromEntries(
    [...grouped].filter(([surrogateId]) => liveIds.has(surrogateId)),
  );
}
