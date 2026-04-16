/**
 * Parallel map-reduce node type driver.
 * Splits work across multiple mapper agents in parallel, then spawns a
 * single reducer agent that sees all mapper outputs. Two-phase execution:
 * spawn_all (mappers) -> onParallelTurnComplete -> spawn (reducer) ->
 * onTurnComplete (complete).
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  mappers: z.array(z.strictObject({
    agent: z.string().min(1),
    task_suffix: z.string().optional(),
  })).min(2),
  reducer: z.string().min(1),
  reducer_prompt: z.string().optional(),
});

interface MapReduceState {
  phase: "mapping" | "reducing";
  reducer: string;
  reducerPrompt: string | undefined;
}

export function createMapReduceDriver(): NodeTypeDriver {
  return {
    typeId: "map-reduce",
    name: "Parallel Map-Reduce",
    description:
      "Splits work across multiple agents in parallel, then a reducer agent aggregates all results.",
    configSchema,
    defaultTimeoutMs: 600_000, // 10 min for parallel + reduce
    estimateDurationMs(_config) {
      // Parallel mappers (~1 agent duration) + 1 reducer
      return 90_000 + 90_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      ctx.setState<MapReduceState>({
        phase: "mapping",
        reducer: config.reducer,
        reducerPrompt: config.reducer_prompt,
      });
      return {
        action: "spawn_all",
        spawns: config.mappers.map((m) => ({
          agentId: m.agent,
          task: m.task_suffix ? `${ctx.task}\n\n${m.task_suffix}` : ctx.task,
        })),
      };
    },
    onTurnComplete(_ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      // Called when the reducer completes
      return { action: "complete", output: agentOutput };
    },
    onParallelTurnComplete(
      ctx: NodeDriverContext,
      outputs: Array<{ agentId: string; output: string }>,
    ): NodeDriverAction {
      const state = ctx.getState<MapReduceState>()!;
      state.phase = "reducing";
      ctx.setState(state);

      // Spawn the reducer with all mapper outputs
      return {
        action: "spawn",
        agentId: state.reducer,
        task: buildReducerTask(ctx.task, outputs, state.reducerPrompt),
      };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },
  };
}

/** Build reducer task text with all mapper outputs. */
function buildReducerTask(
  originalTask: string,
  outputs: Array<{ agentId: string; output: string }>,
  reducerPrompt: string | undefined,
): string {
  const parts = [originalTask, "\n\n--- Mapper Results ---"];
  for (const { agentId, output } of outputs) {
    parts.push(`\n[${agentId}]:\n${output}`);
  }
  parts.push("\n--- End Mapper Results ---");
  if (reducerPrompt) {
    parts.push(`\n\n${reducerPrompt}`);
  } else {
    parts.push(
      "\n\nYou are the reducer. Synthesize all mapper results into a single coherent output.",
    );
  }
  return parts.join("\n");
}
