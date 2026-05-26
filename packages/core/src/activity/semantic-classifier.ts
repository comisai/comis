// SPDX-License-Identifier: Apache-2.0
/**
 * semantic-classifier — maps a tool name to a {@link SemanticPhase} (ACT-07,
 * spec §6 / §17.1 line 1758). Pure string mapping; no channel coupling, no
 * logger. The label resolver (plan 70-08) uses this as the deterministic
 * fallback when no per-tool `LabelSpec` is registered.
 *
 * @module
 */

/**
 * The closed set of semantic phases — the same enum carried by
 * `ActivityEventSchema.semanticPhase` (spec §4.1, `activity-event.ts`). Never
 * widened to `string` (AGENTS.md §2.8).
 */
export type SemanticPhase =
  | "tool"
  | "coding"
  | "web"
  | "memory"
  | "media"
  | "thinking"
  | "queued"
  | "done"
  | "error";
