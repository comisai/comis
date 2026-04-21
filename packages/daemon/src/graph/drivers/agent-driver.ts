// SPDX-License-Identifier: Apache-2.0
/**
 * Single sub-agent node type driver.
 * Spawns one sub-agent to execute the node's task. Completes when the
 * agent finishes -- no multi-turn state needed.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().optional(),
  max_steps: z.number().int().positive().optional(),
});

export function createAgentDriver(): NodeTypeDriver {
  return {
    typeId: "agent",
    name: "Single Sub-Agent",
    description: "Run a single sub-agent to execute the task independently.",
    configSchema,
    defaultTimeoutMs: 300_000,
    estimateDurationMs(_config) {
      return 90_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      return {
        action: "spawn",
        agentId: config.agent,
        task: ctx.task,
        model: config.model,
        maxSteps: config.max_steps,
      };
    },
    onTurnComplete(_ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      return { action: "complete", output: agentOutput };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },
  };
}
