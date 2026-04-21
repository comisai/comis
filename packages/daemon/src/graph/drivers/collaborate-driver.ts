// SPDX-License-Identifier: Apache-2.0
/**
 * Sequential multi-perspective collaboration node type driver.
 * Multiple agents contribute perspectives sequentially, each building on
 * the full history of prior contributions. Supports multiple rounds where
 * agents revisit and extend earlier work.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  agents: z.array(z.string().min(1)).min(2),
  rounds: z.number().int().min(1).max(3).default(1),
});

interface CollaborateState {
  agents: string[];
  totalRounds: number;
  currentRound: number;
  currentAgentIndex: number;
  contributions: string[];
}

export function createCollaborateDriver(): NodeTypeDriver {
  return {
    typeId: "collaborate",
    name: "Sequential Multi-Perspective Collaboration",
    description: "Agents contribute perspectives sequentially, building on prior contributions.",
    configSchema,
    defaultTimeoutMs: 300_000,
    estimateDurationMs(config) {
      const c = config as z.infer<typeof configSchema>;
      const agents = (c.agents as string[])?.length ?? 2;
      const rounds = (c.rounds as number) ?? 1;
      return agents * rounds * 90_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      ctx.setState<CollaborateState>({
        agents: config.agents,
        totalRounds: config.rounds,
        currentRound: 1,
        currentAgentIndex: 0,
        contributions: [],
      });
      return {
        action: "spawn",
        agentId: config.agents[0],
        task: ctx.task,
      };
    },
    onTurnComplete(ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      const state = ctx.getState<CollaborateState>()!;
      const agentId = state.agents[state.currentAgentIndex];
      state.contributions.push(`[${agentId}] ${agentOutput}`);

      // Advance to next agent/round
      state.currentAgentIndex++;
      if (state.currentAgentIndex >= state.agents.length) {
        state.currentAgentIndex = 0;
        state.currentRound++;
      }

      if (state.currentRound > state.totalRounds) {
        return { action: "complete", output: formatContributions(state.contributions) };
      }

      ctx.setState(state);
      const nextAgent = state.agents[state.currentAgentIndex];
      return {
        action: "spawn",
        agentId: nextAgent,
        task: buildCollaborateTask(ctx.task, state.contributions),
      };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },
  };
}

/** Build task text with prior contributions for context. */
function buildCollaborateTask(task: string, contributions: string[]): string {
  if (contributions.length === 0) return task;
  return [
    task,
    "\n\n--- Prior Contributions ---",
    contributions.join("\n\n"),
    "--- End Prior Contributions ---",
    "\n\nAdd your perspective, building on what has been contributed so far.",
  ].join("\n");
}

/** Format all contributions as the final output. */
function formatContributions(contributions: string[]): string {
  return [
    "--- Collaborative Output ---",
    contributions.join("\n\n"),
    "--- End Collaborative Output ---",
  ].join("\n");
}
