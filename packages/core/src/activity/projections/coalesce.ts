// SPDX-License-Identifier: Apache-2.0
/**
 * Coalescing rules engine for the chat projection (spec §9).
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
 * Static coalescing parameters (spec §9). `maxLines` caps the visible set per
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
 * when it is a failure, an approval prompt, or a sub-agent boundary (§9).
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
 * Order: (1) drop fast successes (preserved events exempt), (2) group adjacent
 * same-tool/same-action runs <800ms apart into a single surrogate line,
 * (3) cap the visible set to `maxLines[verbosity]` while always retaining
 * preserved events.
 */
export function coalesce(
  events: readonly ActivityEvent[],
  verbosity: ActivityVerbosity,
): CoalesceResult {
  // 1) Drop fast successes (failures/approvals/subagents are exempt).
  const kept = events.filter(
    (e) => isPreserved(e) || !isDroppableFastSuccess(e, verbosity),
  );

  // 2) Group consecutive same-tool/same-action runs. A Map avoids
  //    attacker-keyed computed-index sinks (security/detect-object-injection).
  const grouped = new Map<string, readonly string[]>();
  const visible: ActivityEvent[] = [];
  let i = 0;
  while (i < kept.length) {
    const head = kept[i]!;
    let j = i + 1;
    // Extend the run while each next event groups with the run head.
    while (j < kept.length && sameGroup(head, kept[j]!)) {
      j += 1;
    }
    const runLength = j - i;
    if (runLength > 1) {
      const constituents = kept.slice(i, j);
      const surrogateId = surrogateIdFor(head);
      grouped.set(surrogateId, constituents.map((e) => e.activityId));
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
