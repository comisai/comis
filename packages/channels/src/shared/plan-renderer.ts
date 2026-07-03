// SPDX-License-Identifier: Apache-2.0
/**
 * plan-renderer — pure checkbox rendering of SEP plan state.
 *
 * Maps a `PlanSnapshot` (sourced from the Silent Execution Planner via
 * `ExecutionPlanPort`) to deterministic plain-text checkbox lines. Rich
 * surfaces can re-skin per status; this is the canonical ASCII form for
 * plain-text channels (IRC, Email, Echo).
 *
 * Pure: no I/O, no logger, no channel coupling. A re-run over the same snapshot
 * yields byte-identical output (entry order is preserved).
 */
import type { PlanSnapshot } from "@comis/core";

type PlanStepStatus = PlanSnapshot["entries"][number]["status"];

/** Deterministic glyph per plan-step status. */
function glyph(status: PlanStepStatus): string {
  switch (status) {
    case "done":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "pending":
      return "[ ]";
    case "skipped":
      return "[-]";
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return "[ ]";
    }
  }
}

/**
 * Render a plan snapshot to checkbox text — one `"{glyph} {label}"` line per
 * entry, in order. An empty plan renders the empty string.
 */
export function renderPlan(snapshot: PlanSnapshot): string {
  return snapshot.entries.map((e) => `${glyph(e.status)} ${e.label}`).join("\n");
}
