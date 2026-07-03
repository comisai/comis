// SPDX-License-Identifier: Apache-2.0
/**
 * acp-projection — pure pass-through projection.
 *
 * ACP and Web surfaces want full fidelity: every step, no coalescing, no
 * verbosity policy. So this projection emits all events verbatim,
 * `groupedActivityIds` is ALWAYS empty, and only the changeSet is computed (so
 * the ACP `tool_call`/`tool_call_update` stream can still diff cheaply). Pure:
 * no I/O, no logger, never mutates its input.
 */
import type { ActivityEvent } from "../activity-event.js";
import type { ActivityRenderFrame } from "../channel-activity-renderer.js";

/**
 * Project a canonical event stream to an ACP render frame — pass-through with a
 * changeSet diff against `prevFrame`. No drop, no group, no verbosity policy.
 */
export function acpProjection(
  events: readonly ActivityEvent[],
  prevFrame?: ActivityRenderFrame,
): ActivityRenderFrame {
  const prev = prevFrame?.visibleEvents ?? [];
  const prevById = new Map(prev.map((e) => [e.activityId, e]));
  const nextIds = new Set(events.map((e) => e.activityId));

  const added: string[] = [];
  const edited: string[] = [];
  for (const e of events) {
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

  return {
    frameSeq: prevFrame ? prevFrame.frameSeq + 1 : 0,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: prevFrame?.planSnapshot,
    changeSet: { added, edited, removed },
  };
}
