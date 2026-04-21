// SPDX-License-Identifier: Apache-2.0
/**
 * Silent Execution Planner (SEP): Checklist formatting for injection.
 *
 * Formats the current execution plan state as a compact checklist string
 * suitable for injection into the dynamic preamble or followUp messages.
 *
 * @module
 */

import type { ExecutionPlan } from "./types.js";

/**
 * Format the execution plan as a checklist for injection into LLM context.
 *
 * Produces a compact, structured text block showing step statuses with
 * marker symbols ([x] done, [>] in_progress, [-] skipped, [ ] pending)
 * and an appropriate footer based on completion state.
 *
 * @param plan - The current execution plan
 * @param verificationNudge - Whether to include verification questions on completion (default: true)
 * @returns Formatted checklist string, or empty string if plan is inactive/empty
 */
export function formatChecklistForInjection(plan: ExecutionPlan, verificationNudge?: boolean): string {
  if (!plan.active || plan.steps.length === 0) return "";

  const lines = plan.steps.map(step => {
    const marker = step.status === "done" ? "[x]"
      : step.status === "in_progress" ? "[>]"
      : step.status === "skipped" ? "[-]"
      : "[ ]";
    return `${marker} ${step.index}. ${step.description}`;
  });

  const allComplete = plan.completedCount >= plan.steps.length ||
    plan.steps.every(s => s.status === "done" || s.status === "skipped");

  let footer: string;
  if (!allComplete) {
    footer = "Continue with the next unchecked step. Do not repeat completed steps.";
  } else if (verificationNudge !== false) {
    footer = [
      "All steps complete. Before responding to the user, briefly verify the result:",
      "- Did each step produce the expected outcome?",
      "- Are there any error messages in tool results that were overlooked?",
      "- Does the overall result satisfy the user's original request?",
    ].join("\n");
  } else {
    footer = "All steps complete. Verify the result works as expected, then respond to the user.";
  }

  return [
    `[Execution checklist: ${plan.completedCount}/${plan.steps.length} complete]`,
    ...lines,
    footer,
  ].join("\n");
}
