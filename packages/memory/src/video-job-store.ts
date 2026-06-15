// SPDX-License-Identifier: Apache-2.0
/**
 * VideoJobStore — SQLite persistence for the Phase-189 durable async video-job
 * lifecycle (JOB-01/JOB-03/JOB-04).
 *
 * Factory-function pattern (modeled on `createSqliteDeliveryQueue`): prepares
 * fixed SQL statements once in the closure, returns a frozen `VideoJobStore`.
 * Maps between camelCase domain fields and snake_case database columns via
 * `createRowMapper(VideoJobDbRowSchema)` so a corrupt row degrades to a
 * `Result.err`, never a throw.
 *
 * The job row is the durable spine the background poller resumes against across
 * a daemon restart: a row survives the agent turn AND a restart because it lives
 * on disk in the shared `memory.db` (Q1/O3 LOCKED: shared db, not an own .db).
 *
 * WHERE IT DIFFERS FROM THE DELIVERY QUEUE:
 *  1. `get(jobId, agentId)` is agent-scoped (filters BOTH columns — JOB-04 /
 *     Pitfall 6). A bare `get(jobId)` is FORBIDDEN: it would leak another
 *     agent's job. A cross-agent jobId returns not-found (`ok(undefined)`).
 *  2. Carries a video path + cost + progress columns (the queue carries text).
 *  3. State domain is `pending | done | failed` (the queue's is broader).
 *  4. ZERO fd-based fs (no explicit file-sync/chmod-by-fd) — better-sqlite3 +
 *     the shared `db` are permission-model-safe by construction (Pitfall 2 / A4).
 *
 * SECURITY (T-189-02): the persisted columns carry NO secret — the `jobId` is
 * the opaque provider request id; the credential is held by the boot-bound
 * adapter and is never written here.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { systemNowMs } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import {
  VideoJobDbRowSchema,
  VideoJobAttemptRowSchema,
  type VideoJobDbRow,
} from "./video-job-row-schema.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** The state machine for a video job (JOB-01). */
export type VideoJobState = "pending" | "done" | "failed";

/** A persisted video-generation job (camelCase domain view of a `video_jobs` row). */
export interface VideoJobRecord {
  /** Opaque, durable provider request id (secret-free — T-189-02). */
  readonly jobId: string;
  readonly provider: string;
  readonly model?: string;
  readonly agentId: string;
  readonly channelType?: string;
  readonly channelId?: string;
  readonly traceId?: string;
  /** OBS-04 (Phase 192): the formatted session key — the off-turn poller resolves
   *  the per-session trajectory recorder by this to stitch a background-completed
   *  render to its originating turn. Nullable in the row (old rows are NULL). */
  readonly sessionKey?: string;
  readonly state: VideoJobState;
  readonly estimatedCostUsd?: number;
  readonly actualCostUsd?: number;
  readonly mediaPath?: string;
  readonly progress?: number;
  readonly lastError?: string;
  /** CR-01: count of delivery/completion attempts; bounds the poller's
   *  redelivery loop (dead-letter once it exceeds maxDeliveryAttempts). */
  readonly deliverAttempts: number;
  readonly submittedAtMs: number;
  readonly updatedAtMs: number;
}

/** Insert payload — the JOB-01 fields recorded at submit. */
export interface VideoJobInsert {
  readonly jobId: string;
  readonly provider: string;
  readonly model?: string;
  readonly agentId: string;
  readonly channelType?: string;
  readonly channelId?: string;
  readonly traceId?: string;
  /** OBS-04 (Phase 192): the formatted session key persisted at submit (the
   *  off-turn recorder fold key). Optional — `undefined` outside a request scope. */
  readonly sessionKey?: string;
  readonly state: VideoJobState;
  readonly estimatedCostUsd?: number;
  readonly submittedAtMs: number;
  readonly updatedAtMs: number;
}

/** The completion payload for `markDone` (the poller's `done` tail — JOB-02). */
export interface VideoJobDoneInput {
  readonly mediaPath: string;
  readonly actualCostUsd?: number;
}

/**
 * The persisted video-job store. Every method is `Result`-returning and never
 * throws (reads degrade via the row mapper). `get` is agent-scoped.
 */
export interface VideoJobStore {
  /** Persist a submitted job (state typically 'pending'). */
  insert(record: VideoJobInsert): Promise<Result<void, Error>>;
  /** All rows in state 'pending', oldest first (the poller's boot-resume scan). */
  listPending(): Promise<Result<VideoJobRecord[], Error>>;
  /**
   * Read a job scoped to BOTH jobId AND agentId (JOB-04 / Pitfall 6).
   * Not-found (no such job for this agent) is `ok(undefined)` — distinct from a
   * real error, so the status handler can answer "no such job" vs "lookup failed".
   */
  get(jobId: string, agentId: string): Promise<Result<VideoJobRecord | undefined, Error>>;
  /** Transition to 'done' + record the delivered path + actual cost (JOB-02). */
  markDone(jobId: string, input: VideoJobDoneInput): Promise<Result<void, Error>>;
  /**
   * Transition to 'failed' + record `last_error` (JOB-02).
   *
   * WR-02 (Phase 190): pass the optional `lastError` to persist an ACTIONABLE
   * operator hint (what `video.status` returns as `error`) instead of the bare
   * `errorKind` enum token. When omitted, `errorKind` is written verbatim (the
   * pre-190 behavior — preserved for callers/tests that pass only the kind).
   */
  markFailed(jobId: string, errorKind: string, lastError?: string): Promise<Result<void, Error>>;
  /** Update the optional progress fraction (JOB-02). */
  updateProgress(jobId: string, progress: number): Promise<Result<void, Error>>;
  /**
   * CR-01: atomically `deliver_attempts = deliver_attempts + 1` and return the
   * NEW count. The poller calls this on each delivery/completion attempt and
   * dead-letters the row to `failed` once the count exceeds maxDeliveryAttempts,
   * so a persistent delivery failure converges instead of re-polling +
   * re-downloading forever. Returns `0` when the jobId matches no row (e.g. the
   * handler's insert-failure path tracks an un-persisted job in-memory) so the
   * caller can still bound that case — never an infinite loop.
   */
  incrementDeliveryAttempt(jobId: string): Promise<Result<number, Error>>;
}

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase)
// ---------------------------------------------------------------------------

const videoJobMapper = createRowMapper(VideoJobDbRowSchema);
const videoJobAttemptMapper = createRowMapper(VideoJobAttemptRowSchema);

/** Map a validated DB row to the domain record (nullable → `?? undefined`). */
function rowToRecord(row: VideoJobDbRow): VideoJobRecord {
  return {
    jobId: row.job_id,
    provider: row.provider,
    ...(row.model !== null ? { model: row.model } : {}),
    agentId: row.agent_id,
    ...(row.channel_type !== null ? { channelType: row.channel_type } : {}),
    ...(row.channel_id !== null ? { channelId: row.channel_id } : {}),
    ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
    ...(row.session_key !== null ? { sessionKey: row.session_key } : {}),
    state: row.state as VideoJobState,
    ...(row.estimated_cost_usd !== null ? { estimatedCostUsd: row.estimated_cost_usd } : {}),
    ...(row.actual_cost_usd !== null ? { actualCostUsd: row.actual_cost_usd } : {}),
    ...(row.media_path !== null ? { mediaPath: row.media_path } : {}),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    deliverAttempts: row.deliver_attempts,
    submittedAtMs: row.submitted_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `VideoJobStore`.
 *
 * Assumes `initSchema()` (which calls `ensureVideoJobTable`) has already been
 * called — the `video_jobs` table exists. Prepares fixed SQL once.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns VideoJobStore implementation (frozen)
 */
export function createVideoJobStore(db: Database.Database): VideoJobStore {
  // --- Prepared statements ---

  const insertStmt = db.prepare(`
    INSERT INTO video_jobs (
      job_id, provider, model, agent_id, channel_type, channel_id, trace_id,
      session_key, state, estimated_cost_usd, actual_cost_usd, media_path,
      progress, last_error, submitted_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);

  // Agent-scoped read — filters by BOTH columns (the must-differ point 1;
  // JOB-04 / Pitfall 6). A cross-agent jobId matches no row → not-found.
  const getStmt = db.prepare(`
    SELECT * FROM video_jobs WHERE job_id = ? AND agent_id = ?
  `);

  const pendingStmt = db.prepare(`
    SELECT * FROM video_jobs WHERE state = 'pending' ORDER BY submitted_at_ms ASC
  `);

  const markDoneStmt = db.prepare(`
    UPDATE video_jobs
    SET state = 'done', media_path = ?, actual_cost_usd = ?, updated_at_ms = ?
    WHERE job_id = ?
  `);

  const markFailedStmt = db.prepare(`
    UPDATE video_jobs
    SET state = 'failed', last_error = ?, updated_at_ms = ?
    WHERE job_id = ?
  `);

  const updateProgressStmt = db.prepare(`
    UPDATE video_jobs SET progress = ?, updated_at_ms = ? WHERE job_id = ?
  `);

  // CR-01: atomic redelivery-counter bump. better-sqlite3 is synchronous +
  // single-connection, so the UPDATE and the paired read below run in the SAME
  // event-loop turn — no interleaving, so the read sees this UPDATE's value.
  const incrementAttemptStmt = db.prepare(`
    UPDATE video_jobs SET deliver_attempts = deliver_attempts + 1, updated_at_ms = ?
    WHERE job_id = ?
  `);
  const readAttemptStmt = db.prepare(`
    SELECT deliver_attempts FROM video_jobs WHERE job_id = ?
  `);

  // --- Store implementation ---

  const store: VideoJobStore = {
    insert(record: VideoJobInsert): Promise<Result<void, Error>> {
      try {
        insertStmt.run(
          record.jobId,
          record.provider,
          record.model ?? null,
          record.agentId,
          record.channelType ?? null,
          record.channelId ?? null,
          record.traceId ?? null,
          record.sessionKey ?? null,
          record.state,
          record.estimatedCostUsd ?? null,
          record.submittedAtMs,
          record.updatedAtMs,
        );
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    listPending(): Promise<Result<VideoJobRecord[], Error>> {
      try {
        const parsed = videoJobMapper.parseRows(pendingStmt.all());
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        return Promise.resolve(ok(parsed.value.map(rowToRecord)));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    get(jobId: string, agentId: string): Promise<Result<VideoJobRecord | undefined, Error>> {
      try {
        const parsed = videoJobMapper.parseOptionalRow(getStmt.get(jobId, agentId));
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        // ok(undefined) when no row matched the (jobId, agentId) pair —
        // a different agent's jobId is not-found (no cross-agent leak).
        return Promise.resolve(
          ok(parsed.value === undefined ? undefined : rowToRecord(parsed.value)),
        );
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markDone(jobId: string, input: VideoJobDoneInput): Promise<Result<void, Error>> {
      try {
        markDoneStmt.run(input.mediaPath, input.actualCostUsd ?? null, systemNowMs(), jobId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markFailed(jobId: string, errorKind: string, lastError?: string): Promise<Result<void, Error>> {
      try {
        // WR-02: persist the actionable hint when supplied; else the bare kind.
        markFailedStmt.run(lastError ?? errorKind, systemNowMs(), jobId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    updateProgress(jobId: string, progress: number): Promise<Result<void, Error>> {
      try {
        updateProgressStmt.run(progress, systemNowMs(), jobId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    incrementDeliveryAttempt(jobId: string): Promise<Result<number, Error>> {
      try {
        // Atomic bump. `.changes === 0` means no such row (e.g. the handler's
        // insert-failure path tracks an un-persisted job in-memory) — return 0
        // so the caller bounds that case rather than spinning forever.
        const info = incrementAttemptStmt.run(systemNowMs(), jobId);
        if (info.changes === 0) return Promise.resolve(ok(0));
        // Same synchronous turn (better-sqlite3 is sync + single-connection), so
        // this read observes the UPDATE above. Parsed via the mapper — never an
        // untyped `.get(...) as Type` cast (untyped-sqlite invariant).
        const parsed = videoJobAttemptMapper.parseOptionalRow(readAttemptStmt.get(jobId));
        if (!parsed.ok) {
          return Promise.resolve(
            err(new Error(`Row validation failed: ${parsed.error.message}`)),
          );
        }
        return Promise.resolve(ok(parsed.value === undefined ? 0 : parsed.value.deliver_attempts));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(store);
}
