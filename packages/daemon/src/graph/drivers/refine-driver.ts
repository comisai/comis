/**
 * Sequential refinement chain node type driver.
 * Passes output through a chain of reviewers, each improving the previous
 * version. The first reviewer produces the initial draft from the task;
 * subsequent reviewers receive the prior output with improvement instructions.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  reviewers: z.array(z.string().min(1)).min(2),
});

interface RefineState {
  reviewers: string[];
  currentIndex: number;
  previousOutput: string;
}

export function createRefineDriver(): NodeTypeDriver {
  return {
    typeId: "refine",
    name: "Sequential Refinement Chain",
    description: "Sequential refinement where each agent improves the previous agent's work.",
    configSchema,
    defaultTimeoutMs: 300_000,
    estimateDurationMs(config) {
      const c = config as z.infer<typeof configSchema>;
      return ((c.reviewers as string[])?.length ?? 2) * 90_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      ctx.setState<RefineState>({
        reviewers: config.reviewers,
        currentIndex: 0,
        previousOutput: "",
      });
      return {
        action: "spawn",
        agentId: config.reviewers[0],
        task: ctx.task,
      };
    },
    onTurnComplete(ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      const state = ctx.getState<RefineState>()!;
      state.previousOutput = agentOutput;
      state.currentIndex++;

      if (state.currentIndex >= state.reviewers.length) {
        return { action: "complete", output: agentOutput };
      }

      ctx.setState(state);
      const nextReviewer = state.reviewers[state.currentIndex];
      return {
        action: "spawn",
        agentId: nextReviewer,
        task: buildRefineTask(ctx.task, agentOutput, state.currentIndex, state.reviewers.length),
      };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },
  };
}

/** Build task text with the previous version and improvement instructions. */
function buildRefineTask(
  originalTask: string,
  previousOutput: string,
  step: number,
  total: number,
): string {
  return [
    originalTask,
    `\n\n--- Previous Version (step ${step} of ${total}) ---`,
    previousOutput,
    "--- End Previous Version ---",
    "\n\nReview and improve the above. Preserve what works, fix what doesn't, " +
    "and produce an improved version.",
  ].join("\n");
}
