import { z } from "zod";

/**
 * Schema for a single buffered system event entry.
 * Events are produced by subsystems (cron, exec) and consumed by the heartbeat cycle.
 */
export const SystemEventEntrySchema = z.strictObject({
  /** Event text content (e.g., "Check disk space", "Command completed: git pull") */
  text: z.string().min(1),
  /** Classification key for filtering (e.g., "cron:job-abc", "exec:cmd-123") */
  contextKey: z.string().min(1),
  /** Timestamp when the event was enqueued (ms since epoch) */
  enqueuedAt: z.number().int().positive(),
});

export type SystemEventEntry = z.infer<typeof SystemEventEntrySchema>;
