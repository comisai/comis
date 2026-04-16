import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { CronJob } from "./cron-types.js";
import { CronJobSchema } from "./cron-types.js";
import { withExecutionLock } from "../execution/execution-lock.js";
import type { SchedulerLogger } from "../shared-types.js";

/**
 * CronStore: Atomic JSON file persistence for cron jobs.
 *
 * Uses write-to-temp-then-rename pattern for POSIX-atomic saves.
 * Best-effort backup copy before overwrite.
 * Mutation operations (addJob, removeJob, updateJob) are serialized
 * by an in-process mutex before acquiring the file-level lock via
 * withExecutionLock. This prevents "lock locked" errors when the LLM
 * agent issues parallel tool calls that hit CronStore concurrently
 * within the same process. Cross-process safety is still provided by
 * the file lock.
 */
export interface CronStore {
  /** Load all jobs from file. Returns empty array if file doesn't exist. */
  load(): Promise<CronJob[]>;
  /** Save all jobs atomically (write tmp, rename). */
  save(jobs: CronJob[]): Promise<void>;
  /** Append a job to the store (file-locked). */
  addJob(job: CronJob): Promise<void>;
  /** Remove a job by ID (file-locked). Returns true if found and removed. */
  removeJob(jobId: string): Promise<boolean>;
  /** Merge partial update into a job by ID (file-locked, re-validated). Returns true if found and updated. */
  updateJob(jobId: string, update: Partial<CronJob>): Promise<boolean>;
}

const CronJobArraySchema = z.array(CronJobSchema);

/** Lock options for CronStore mutations: short stale/update since operations are fast. */
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 };

/**
 * Create a CronStore backed by a JSON file at the given path.
 *
 * @param filePath - Path to the JSON file for job persistence.
 * @param logger - Optional logger for corruption warnings.
 */
export function createCronStore(filePath: string, logger?: SchedulerLogger): CronStore {
  const lockPath = `${filePath}.lock`;
  const mutex = createMutex();

  /** Internal load: reads and parses the store file. */
  async function loadFromFile(): Promise<CronJob[]> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      // Normalize legacy camelCase payload_kind values
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.payload?.kind === "systemEvent") item.payload.kind = "system_event";
          if (item?.payload?.kind === "agentTurn") item.payload.kind = "agent_turn";
        }
      }
      return CronJobArraySchema.parse(parsed);
    } catch (err: unknown) {
      // File doesn't exist -- return empty without warning
      if (isNodeError(err) && err.code === "ENOENT") {
        return [];
      }
      // JSON parse corruption -- log warning
      if (err instanceof SyntaxError) {
        logger?.warn({
          err: (err as Error).message,
          hint: "Cron store file contains invalid JSON; returning empty job list. Check .bak file for recovery.",
          errorKind: "validation" as const,
        }, "Cron store corruption detected");
        return [];
      }
      // Zod validation failure -- log warning
      if (err instanceof z.ZodError) {
        logger?.warn({
          err: (err as z.ZodError).message,
          hint: "Cron store data failed schema validation; returning empty job list. Check .bak file for recovery.",
          errorKind: "validation" as const,
        }, "Cron store schema validation failed");
        return [];
      }
      throw err;
    }
  }

  /** Internal save: writes jobs atomically (write tmp, rename). */
  async function saveToFile(jobs: CronJob[]): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Best-effort backup
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch {
      // File may not exist yet -- ignore
    }

    // Atomic write: tmp file then rename
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const data = JSON.stringify(jobs, null, 2);
    await fs.writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  }

  return {
    async load(): Promise<CronJob[]> {
      return loadFromFile();
    },

    async save(jobs: CronJob[]): Promise<void> {
      return saveToFile(jobs);
    },

    async addJob(job: CronJob): Promise<void> {
      await mutex.serialize(async () => {
        const result = await withExecutionLock(lockPath, async () => {
          const jobs = await loadFromFile();
          jobs.push(job);
          await saveToFile(jobs);
        }, LOCK_OPTIONS);
        if (!result.ok) {
          throw new Error(`CronStore addJob failed: lock ${result.error}`);
        }
      });
    },

    async removeJob(jobId: string): Promise<boolean> {
      return mutex.serialize(async () => {
        const result = await withExecutionLock(lockPath, async () => {
          const jobs = await loadFromFile();
          const idx = jobs.findIndex((j) => j.id === jobId);
          if (idx === -1) return false;
          jobs.splice(idx, 1);
          await saveToFile(jobs);
          return true;
        }, LOCK_OPTIONS);
        if (!result.ok) {
          throw new Error(`CronStore removeJob failed: lock ${result.error}`);
        }
        return result.value;
      });
    },

    async updateJob(jobId: string, update: Partial<CronJob>): Promise<boolean> {
      return mutex.serialize(async () => {
        const result = await withExecutionLock(lockPath, async () => {
          const jobs = await loadFromFile();
          const idx = jobs.findIndex((j) => j.id === jobId);
          if (idx === -1) return false;
          // Re-validate merged object through CronJobSchema
          const merged = { ...jobs[idx], ...update };
          const validated = CronJobSchema.parse(merged);
          jobs[idx] = validated;
          await saveToFile(jobs);
          return true;
        }, LOCK_OPTIONS);
        if (!result.ok) {
          throw new Error(`CronStore updateJob failed: lock ${result.error}`);
        }
        return result.value;
      });
    },
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Simple Promise-based serial queue (in-process mutex).
 *
 * Each call to `serialize()` chains onto the previous one, ensuring
 * only one `fn` runs at a time. This prevents concurrent calls from
 * racing on the file lock within the same Node.js process.
 */
function createMutex() {
  let chain = Promise.resolve();
  return {
    serialize<T>(fn: () => Promise<T>): Promise<T> {
      const p = chain.then(fn, fn); // run fn regardless of prior rejection
      chain = p.then(() => {}, () => {}); // swallow to keep chain alive
      return p;
    },
  };
}
