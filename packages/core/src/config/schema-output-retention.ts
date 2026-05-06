// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Output retention configuration schema.
 *
 * Per-class retention for files in the agent's output directory. The
 * housekeeper (packages/daemon/src/wiring/setup-output-retention.ts)
 * runs at intervalMs, scans output/, deletes files whose age exceeds
 * the class-specific retentionMs.
 *
 * Phase 10 housekeeper consumes JSONL details.visibleDelivery (R8, D-O1)
 * for offline analysis; per-class retention bounds the JSONL persistence
 * cost (closes the loop with cherry-pick D-J1).
 *
 * Per AGENTS §6.4: schema follows `z.strictObject` + `.default()` + `z.infer`
 * (mirrors schema-background-tasks.ts). Wired into AppConfigSchema as a
 * top-level section because output retention is daemon-level (not per-agent
 * like backgroundTasks): a single housekeeper scans the workspace's output/
 * tree across all agents.
 *
 * @module schema-output-retention
 */

/** Per-class retention. Each class is a directory under `output/`. */
const RetentionClassSchema = z.strictObject({
  /** Time-to-live for files in this class, in ms. Must be a positive integer. */
  retentionMs: z.number().int().positive(),
});

export const OutputRetentionConfigSchema = z.strictObject({
  /** Whether the housekeeper is enabled. Default true. */
  enabled: z.boolean().default(true),
  /** How often the housekeeper scans output/ for expired files. Default 1h. */
  intervalMs: z.number().int().positive().default(3_600_000),
  /**
   * Per-class retention. Keys are class names (subdirectory names under
   * output/); values are `{ retentionMs }`. Default classes:
   *  - "attachment"  — channel-delivered attachments (caption + bytes), 7 days
   *  - "chart"       — generated chart images, 30 days
   *  - "transcript"  — STT transcript files, 90 days
   *  - "default"     — fallback for files in output/ not matching a class, 14 days
   */
  classes: z
    .record(z.string(), RetentionClassSchema)
    .default({
      attachment: { retentionMs: 7 * 24 * 3_600_000 },
      chart: { retentionMs: 30 * 24 * 3_600_000 },
      transcript: { retentionMs: 90 * 24 * 3_600_000 },
      default: { retentionMs: 14 * 24 * 3_600_000 },
    }),
});

export type OutputRetentionConfig = z.infer<typeof OutputRetentionConfigSchema>;
export type RetentionClass = z.infer<typeof RetentionClassSchema>;
