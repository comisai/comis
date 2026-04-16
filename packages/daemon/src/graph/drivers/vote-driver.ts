/**
 * Parallel independent voting node type driver.
 * Spawns all voter agents in parallel. Each votes independently without
 * seeing other voters' outputs. Results are aggregated into a formatted
 * tally when all voters complete.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  voters: z.array(z.string().min(1)).min(2),
  prompt_suffix: z.string().optional(),
  verdict_format: z.string().optional(),
  /** Forward-compatible: no effect until coordinator supports partial failure. */
  min_voters: z.number().int().min(1).optional(),
});

export function createVoteDriver(): NodeTypeDriver {
  return {
    typeId: "vote",
    name: "Parallel Independent Voting",
    description:
      "All agents vote independently in parallel. Results are aggregated into a summary with tally.",
    configSchema,
    defaultTimeoutMs: 300_000,
    estimateDurationMs(config) {
      // Parallel execution -- duration is ~1 agent regardless of voter count
      // Add a small buffer per voter for spawn overhead
      return 90_000 + ((config as { voters?: string[] }).voters?.length ?? 2) * 5_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      const suffix = config.prompt_suffix ?? "";
      const verdictHint = config.verdict_format
        ? `\n\nProvide your verdict in this format: ${config.verdict_format}`
        : "";

      return {
        action: "spawn_all",
        spawns: config.voters.map((voter) => ({
          agentId: voter,
          task: `${ctx.task}${suffix ? `\n\n${suffix}` : ""}${verdictHint}`,
        })),
      };
    },
    onTurnComplete(_ctx: NodeDriverContext, _agentOutput: string): NodeDriverAction {
      // Vote driver uses spawn_all -- no sequential follow-up expected
      return { action: "fail", error: "Unexpected sequential turn in vote driver" };
    },
    onParallelTurnComplete(
      _ctx: NodeDriverContext,
      outputs: Array<{ agentId: string; output: string }>,
    ): NodeDriverAction {
      // All outputs are successful (coordinator aborts on any failure)
      return { action: "complete", output: formatVoteTally(outputs) };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },
  };
}

/** Format vote outputs into a structured tally. */
function formatVoteTally(
  outputs: Array<{ agentId: string; output: string }>,
): string {
  const parts = [
    `--- Vote Results (${outputs.length} of ${outputs.length} voters) ---`,
  ];
  for (const { agentId, output } of outputs) {
    parts.push(`\n[${agentId}]: ${output}`);
  }
  parts.push("\n--- End Vote Results ---");
  return parts.join("\n");
}
