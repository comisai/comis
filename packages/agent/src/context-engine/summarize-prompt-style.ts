// SPDX-License-Identifier: Apache-2.0
/**
 * Depth-aware summarization prompt style builder (Phase 171, SUM-01).
 *
 * Pure function: no I/O, no imports from @comis/memory (agent↛memory cut).
 * NEVER logs instruction content — only structural metadata.
 *
 * @module
 */

/**
 * Build the depth-keyed summarization instructions for the leaf/condense passes.
 *
 * Depth mapping (per design/lcd-v3-unified-substrate.md §6.4):
 *  - d0 (leaf): extractive — concrete facts, file paths, decisions, tool outcomes
 *  - d1 (timeline): chronological — mark superseded decisions
 *  - d2 (trajectory): high-level arc — drop per-session minutiae
 *  - d3+ (memory-node): durable milestones — omit transient detail
 *
 * @param depth - the depth of the summary being created (0 = leaf, 1 = timeline, …)
 * @param aggressive - when true, append a terse/brevity directive (Level-2 hint)
 * @returns the instruction string to pass as `customInstructions` to generateSummary
 */
export function buildDepthAwareInstructions(depth: number, aggressive: boolean): string {
  // d0 (leaf): extractive — faithful and fact/decision/constraint-preserving
  if (depth <= 0) {
    const base =
      "Summarize the conversation chunk above into a faithful, compact summary. " +
      "Preserve concrete details: file paths, ids, decisions made, tool calls and " +
      "their outcomes (success/failure), and constraints. Include a 'Files:' line " +
      "if files were modified and an 'Expand for:' footer for important topics the " +
      "reader may want to expand. Do NOT invent facts.";
    return aggressive ? base + " Be as terse as possible while keeping the load-bearing facts." : base;
  }

  // d1: chronological timeline — mark decisions that were later superseded
  if (depth === 1) {
    const base =
      "Summarize the following sequence of conversation summaries as a chronological timeline. " +
      "Mark decisions that were later superseded (e.g. '[SUPERSEDED]'). Preserve all concrete " +
      "outcomes, file paths, and open questions.";
    return aggressive ? base + " Be as terse as possible while keeping the load-bearing facts." : base;
  }

  // d2: trajectory — what was the goal, key decisions, final state; drop per-session minutiae
  if (depth === 2) {
    const base =
      "Produce a trajectory summary: what was the overall goal, what key decisions were made, " +
      "what was the final state? Drop per-session minutiae (individual tool calls, retries). " +
      "Focus on durable information a future session would need.";
    return aggressive ? base + " Be as terse as possible while keeping the load-bearing facts." : base;
  }

  // d3+: durable memory node — milestones, architectural decisions, long-lived constraints
  const base =
    "Distill the following into a durable memory node: milestones, architectural decisions, " +
    "and constraints that would still be relevant months from now. Omit transient details. " +
    "Write as a dense, factual paragraph.";
  return aggressive ? base + " Be as terse as possible while keeping the load-bearing facts." : base;
}
