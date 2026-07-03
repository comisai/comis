// SPDX-License-Identifier: Apache-2.0
/**
 * chat-projection — pure (events, config) -> ActivityRenderFrame.
 *
 * The verbosity chokepoint before any renderer: it decides what a chat surface
 * shows. `silent` -> nothing; `quiet` -> only failures + approvals; `normal` ->
 * the coalesced stream; `verbose` -> everything (capped). It diffs against the
 * previous frame to produce a `changeSet` so renderers can minimise API calls.
 * Pure: no I/O, no logger, never mutates its input.
 */
import type { ActivityEvent } from "../activity-event.js";
import type {
  ActivityRenderFrame,
  PlanSnapshot,
} from "../channel-activity-renderer.js";
import {
  coalesce,
  CHAT_COALESCE_RULES,
  type ActivityVerbosity,
} from "./coalesce.js";

export interface ProjectionConfig {
  verbosity: ActivityVerbosity;
}

/** quiet shows only the always-preserved events (failures + approvals). */
function isQuietVisible(e: ActivityEvent): boolean {
  return e.status === "failed" || e.kind === "approval";
}

/**
 * Project a canonical event stream to a chat render frame under the configured
 * verbosity. `prevFrame` (if supplied) seeds the `changeSet` diff and advances
 * `frameSeq`. `latestPlanSnapshot` is the SEP
 * snapshot most recently cached by the coordinator; when present it wins over
 * `prevFrame?.planSnapshot` (a silent forward of prev would mask a
 * re-extracted plan within the same turn).
 */
export function chatProjection(
  events: readonly ActivityEvent[],
  config: ProjectionConfig,
  prevFrame?: ActivityRenderFrame,
  latestPlanSnapshot?: PlanSnapshot,
): ActivityRenderFrame {
  const { verbosity } = config;

  let visibleEvents: readonly ActivityEvent[];
  let groupedActivityIds: Readonly<Record<string, readonly string[]>>;

  switch (verbosity) {
    case "silent": {
      visibleEvents = [];
      groupedActivityIds = {};
      break;
    }
    case "quiet": {
      visibleEvents = events
        .filter(isQuietVisible)
        .slice(0, CHAT_COALESCE_RULES.maxLines.quiet);
      groupedActivityIds = {};
      break;
    }
    case "normal": {
      const { visible, grouped } = coalesce(events, "normal");
      visibleEvents = visible;
      groupedActivityIds = grouped;
      break;
    }
    case "verbose": {
      // Full fidelity, only the maxLines cap applies (no drop, no group).
      visibleEvents = events.slice(0, CHAT_COALESCE_RULES.maxLines.verbose);
      groupedActivityIds = {};
      break;
    }
    default: {
      const _exhaustive: never = verbosity;
      void _exhaustive;
      visibleEvents = [];
      groupedActivityIds = {};
    }
  }

  const changeSet = diffChangeSet(prevFrame?.visibleEvents ?? [], visibleEvents);

  return {
    frameSeq: prevFrame ? prevFrame.frameSeq + 1 : 0,
    visibleEvents,
    groupedActivityIds,
    // Latest-wins precedence so a re-extracted plan within the turn
    // supersedes the prevFrame's stale snapshot.
    planSnapshot: latestPlanSnapshot ?? prevFrame?.planSnapshot,
    changeSet,
  };
}

/**
 * Diff two visible-event sets into added/edited/removed activityIds. `edited`
 * covers events present in both frames whose `status` or `durationMs` changed.
 */
function diffChangeSet(
  prev: readonly ActivityEvent[],
  next: readonly ActivityEvent[],
): ActivityRenderFrame["changeSet"] {
  const prevById = new Map(prev.map((e) => [e.activityId, e]));
  const nextIds = new Set(next.map((e) => e.activityId));

  const added: string[] = [];
  const edited: string[] = [];
  for (const e of next) {
    const before = prevById.get(e.activityId);
    if (before === undefined) {
      added.push(e.activityId);
    } else if (before.status !== e.status || before.durationMs !== e.durationMs) {
      edited.push(e.activityId);
    }
  }
  const removed = prev
    .filter((e) => !nextIds.has(e.activityId))
    .map((e) => e.activityId);

  return { added, edited, removed };
}
