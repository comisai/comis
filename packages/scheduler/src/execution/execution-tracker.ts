// SPDX-License-Identifier: Apache-2.0
/**
 * JSONL-based execution tracking with auto-prune and anomaly detection.
 *
 * Records execution entries (start/end/duration) to a JSONL file,
 * automatically prunes when file exceeds size threshold, and detects
 * duration anomalies based on median historical runtime.
 */

import * as fs from "node:fs/promises";
import { z } from "zod";

/** A single execution log entry. */
export interface ExecutionLogEntry {
  /** Timestamp (epoch ms) of the execution. */
  ts: number;
  /** Identifier of the scheduled job. */
  jobId: string;
  /** Outcome of the execution. */
  status: "ok" | "error" | "skipped";
  /** Duration in milliseconds. */
  durationMs: number;
  /** Error message if status is "error". */
  error?: string;
  /** Optional human-readable summary. */
  summary?: string;
  /** Total tokens consumed during execution. */
  totalTokens?: number;
  /** Estimated cost in USD. */
  costUsd?: number;
  /** Number of tool calls executed. */
  toolCalls?: number;
  /** Number of LLM API calls made. */
  llmCalls?: number;
  /** Names of tools that failed during execution. */
  failedTools?: string[];
}

/** Zod schema for validating JSONL execution log entries after JSON.parse. */
const ExecutionLogEntrySchema = z.object({
  ts: z.number(),
  jobId: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  durationMs: z.number(),
  error: z.string().optional(),
  summary: z.string().optional(),
  totalTokens: z.number().optional(),
  costUsd: z.number().optional(),
  toolCalls: z.number().optional(),
  llmCalls: z.number().optional(),
  failedTools: z.array(z.string()).optional(),
});

/** Options for creating an execution tracker. */
export interface ExecutionTrackerOptions {
  /** Directory where execution.jsonl is stored. */
  logDir: string;
  /** Maximum log file size in bytes before pruning (default 2_000_000). */
  maxLogBytes?: number;
  /** Number of most recent lines to keep after pruning (default 2_000). */
  keepLines?: number;
  /** Flag duration as anomaly if > median * multiplier (default 3). */
  anomalyMultiplier?: number;
}

/** Anomaly check result. */
export interface AnomalyResult {
  isAnomaly: boolean;
  medianMs: number;
  thresholdMs: number;
}

/** Execution tracker interface. */
export interface ExecutionTracker {
  /** Append an execution entry to the JSONL log. */
  record(entry: ExecutionLogEntry): Promise<void>;
  /** Retrieve execution history for a given job, sorted by ts desc. */
  getHistory(jobId: string, limit?: number): Promise<ExecutionLogEntry[]>;
  /** Check if a duration is anomalous for a given job. */
  checkAnomaly(jobId: string, durationMs: number): Promise<AnomalyResult>;
}

const LOG_FILENAME = "execution.jsonl";

const DEFAULTS = {
  maxLogBytes: 2_000_000,
  keepLines: 2_000,
  anomalyMultiplier: 3,
} as const;

/**
 * Create an execution tracker that writes to a JSONL file.
 */
export function createExecutionTracker(options: ExecutionTrackerOptions): ExecutionTracker {
  const logDir = options.logDir;
  const maxLogBytes = options.maxLogBytes ?? DEFAULTS.maxLogBytes;
  const keepLines = options.keepLines ?? DEFAULTS.keepLines;
  const anomalyMultiplier = options.anomalyMultiplier ?? DEFAULTS.anomalyMultiplier;

  const logPath = `${logDir}/${LOG_FILENAME}`;

  async function ensureDir(): Promise<void> {
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  }

  async function record(entry: ExecutionLogEntry): Promise<void> {
    await ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(logPath, line, { encoding: "utf-8", mode: 0o600 });

    // Check file size and prune if needed
    try {
      const stat = await fs.stat(logPath);
      if (stat.size > maxLogBytes) {
        await prune();
      }
    } catch {
      // File might have been deleted between append and stat; ignore
    }
  }

  async function prune(): Promise<void> {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const kept = lines.slice(-keepLines);
    const tmpPath = logPath + ".tmp";
    await fs.writeFile(tmpPath, kept.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, logPath);
  }

  async function readAllEntries(): Promise<ExecutionLogEntry[]> {
    try {
      const content = await fs.readFile(logPath, "utf-8");
      return content
        .split("\n")
        .filter((l) => l.length > 0)
        .flatMap((l) => {
          try {
            const result = ExecutionLogEntrySchema.safeParse(JSON.parse(l));
            return result.success ? [result.data] : [];
          } catch {
            return [];
          }
        });
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return [];
      }
      throw e;
    }
  }

  async function getHistory(jobId: string, limit: number = 100): Promise<ExecutionLogEntry[]> {
    const entries = await readAllEntries();
    return entries
      .filter((e) => e.jobId === jobId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  async function checkAnomaly(jobId: string, durationMs: number): Promise<AnomalyResult> {
    const history = await getHistory(jobId, 50);
    const okDurations = history.filter((e) => e.status === "ok").map((e) => e.durationMs);

    if (okDurations.length < 5) {
      return { isAnomaly: false, medianMs: 0, thresholdMs: 0 };
    }

    const medianMs = computeMedian(okDurations);
    const thresholdMs = medianMs * anomalyMultiplier;
    const isAnomaly = durationMs > thresholdMs;

    return { isAnomaly, medianMs, thresholdMs };
  }

  return { record, getHistory, checkAnomaly };
}

/**
 * Compute the median of a numeric array.
 * Returns the middle value for odd lengths, or the average of the two
 * middle values for even lengths.
 */
export function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
