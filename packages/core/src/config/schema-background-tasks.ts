// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Background tasks configuration schema.
 *
 * Controls automatic promotion of long-running tool executions to background tasks.
 * When a tool call exceeds `autoBackgroundMs`, it is promoted to a tracked background
 * task with its own concurrency limits and hard timeout.
 *
 * @module schema-background-tasks
 */
export const BackgroundTasksConfigSchema = z.strictObject({
  /** Whether auto-background promotion is enabled. */
  enabled: z.boolean().default(true),
  /** Milliseconds before a tool call is promoted to background. */
  autoBackgroundMs: z.number().int().positive().default(10_000),
  /** Maximum concurrent background tasks per agent. */
  maxPerAgent: z.number().int().positive().default(5),
  /** Maximum total concurrent background tasks across all agents. */
  maxTotal: z.number().int().positive().default(20),
  /** Hard timeout in ms for background tasks (aborted after this). */
  maxBackgroundDurationMs: z.number().int().positive().default(300_000),
  /** Tool names excluded from auto-background promotion. */
  excludeTools: z.array(z.string()).default([]),
});

export type BackgroundTasksConfig = z.infer<typeof BackgroundTasksConfigSchema>;
