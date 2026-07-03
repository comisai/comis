// SPDX-License-Identifier: Apache-2.0
/**
 * DurableRunPort — the hexagonal boundary for the run-checkpoint store.
 * A long-running agent run persists a
 * {@link DurableRunRecord} here so a daemon restart can find and resume it
 * (`listResumable`), keep it alive (`touchHeartbeat`), and refuse to re-mint a
 * revoked one (`invalidateForRevoke`).
 *
 * Every method is `Result`-returning and never throws — the same discipline as
 * {@link DeliveryQueuePort} and `VideoJobStore`. The SQLite adapter
 * implements it; reads degrade through the row mapper.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { DurableRunRecord } from "../domain/durable-run.js";

/**
 * The persisted run-checkpoint store. All methods are keyed on `rootRunId` (the
 * run idempotency key). `getByRootRun` returns `ok(undefined)` for an absent run
 * — distinct from a real lookup error, mirroring `VideoJobStore.get`.
 */
export interface DurableRunPort {
  /**
   * Idempotent insert-or-update keyed on `rootRunId`. Writes the
   * checkpoint fields; MUST NEVER touch the dedicated `outward_step` column
   * — that counter is owned solely by
   * {@link DurableRunPort.allocateOutwardStep}, so a checkpoint between two
   * outward sends cannot reset it and cause a duplicate outward send.
   */
  upsertCheckpoint(record: DurableRunRecord): Promise<Result<void, Error>>;

  /**
   * The boot-resume scan: every record in status `running`. These are
   * the runs a restarting daemon must resume (or orphan if un-resumable).
   */
  listResumable(): Promise<Result<DurableRunRecord[], Error>>;

  /**
   * Read a single checkpoint by `rootRunId`. Not-found is `ok(undefined)`
   * (distinct from a lookup error) so callers can branch "no such run" vs
   * "read failed".
   */
  getByRootRun(rootRunId: string): Promise<Result<DurableRunRecord | undefined, Error>>;

  /**
   * Flip a record to status `orphaned` with an operator-readable `reason` — an
   * un-resumable run found by the boot scan (no live lease, failed precondition).
   */
  markOrphaned(rootRunId: string, reason: string): Promise<Result<void, Error>>;

  /** Flip a record to status `completed` — the run finished; resume skips it. */
  markCompleted(rootRunId: string): Promise<Result<void, Error>>;

  /**
   * The keep-alive write: stamp `lastHeartbeatAt = atMs`. A run whose
   * heartbeat goes stale past the threshold is a crash candidate for the
   * orphan-sweep.
   */
  touchHeartbeat(rootRunId: string, atMs: number): Promise<Result<void, Error>>;

  /**
   * Flip the record to status `revoked` so resume can NEVER re-mint it.
   * Called when the run's authority (lease/caps) is revoked out from under it; a
   * revoked checkpoint is terminal and is filtered out of `listResumable`.
   */
  invalidateForRevoke(rootRunId: string): Promise<Result<void, Error>>;

  /**
   * Atomically increment a monotonic per-`rootRunId` outward-
   * send counter (the dedicated `outward_step` column) and return the NEW
   * index. The FIRST call returns 0, the second 1, etc. (the column seeds at the
   * -1 'never-sent' sentinel, so `outward_step + 1` yields 0 on the first call).
   *
   * This is the SOLE source of the `(rootRunId, stepIndex)` idempotency key for
   * the outward-send ledger. It MUST be atomic — a single
   * `UPDATE ... SET outward_step = outward_step + 1 ... RETURNING outward_step`
   * or an equivalent transaction — so two concurrent outward sends in one run
   * never collide on the same index. A run with no row yet gets one created at
   * `outward_step` 0.
   */
  allocateOutwardStep(rootRunId: string): Promise<Result<number, Error>>;

  /**
   * Windowed status counts read DIRECTLY from
   * `durable_runs`. Crash-surviving: the row IS the durability, so this count
   * survives a hard crash that would lose an in-process lifecycle event. Counts
   * ONLY rows with `updated_at_ms >= sinceMs` (the fleet window), grouped by
   * status; absent statuses default to 0. The `comis fleet` assembler
   * reads this for the orphaned/resumed/revoked/running counts alongside the
   * `health_signal` rows. Mirrors the obs store's `getRollingSpendUsd`
   * windowed-aggregate (`WHERE … >= ?`) precedent.
   */
  countByStatus(
    sinceMs: number,
  ): Promise<Result<{ orphaned: number; revoked: number; running: number; completed: number }, Error>>;
}
