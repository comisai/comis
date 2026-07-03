// SPDX-License-Identifier: Apache-2.0
/**
 * GoalAnchor builder — pure function that formats an ExecutionPlan into a
 * tail-injected anchor block for the system prompt.
 *
 * The caller (wrapEnvelope) gates on scaffoldLevel === "max" before
 * calling this function. This module has no I/O and does not import from
 * @comis/core to keep the dependency graph clean (pure agent-internal utility).
 *
 * Threat mitigations:
 *   - Output bounded by maxChars (default 500); excess truncated with "…"
 *   - Plain text only — no HTML/markdown injection path in the formatted block
 *
 * @module
 */

import type { ExecutionPlan } from "../../planner/types.js";

/**
 * Re-exported config type so callers can type-check config objects without
 * importing from @comis/core directly.
 * Defined inline here; the canonical Zod schema lives in
 * packages/core/src/config/schema-agent/schema-agent-prompt.ts.
 */
export interface GoalAnchorConfig {
  enabled: boolean;
  maxChars: number;
}

/**
 * Build a GoalAnchor block from an execution plan.
 *
 * Format:
 *   [GoalAnchor: {plan.request}]
 *   ☐ 1. {pending/in_progress step}
 *   ☐ 2. {pending/in_progress step}
 *   ...
 *
 * Rules:
 *   - plan undefined → returns "" (safe no-op)
 *   - plan.active === false OR no steps → "[GoalAnchor: {plan.request}]" only
 *   - done/skipped steps are OMITTED
 *   - all uncompleted steps omitted → header-only string
 *   - length > maxChars → block.slice(0, maxChars) + "…"
 *
 * @param plan - The current execution plan (may be undefined when SEP is inactive).
 * @param maxChars - Maximum character length for the output block. Default: 500.
 * @returns Formatted GoalAnchor block string, or "" if plan is undefined.
 */
export function buildGoalAnchorBlock(
  plan: ExecutionPlan | undefined,
  maxChars = 500,
): string {
  if (plan === undefined) {
    return "";
  }

  const header = `[GoalAnchor: ${plan.request}]`;

  // Inactive plan or no steps → header only
  if (!plan.active || plan.steps.length === 0) {
    return header;
  }

  const uncompleted = plan.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );

  // All steps completed/skipped → header only
  if (uncompleted.length === 0) {
    return header;
  }

  const stepLines = uncompleted.map((s) => `☐ ${s.index}. ${s.description}`);
  const block = [header, ...stepLines].join("\n");

  if (block.length > maxChars) {
    return block.slice(0, maxChars) + "…";
  }

  return block;
}
