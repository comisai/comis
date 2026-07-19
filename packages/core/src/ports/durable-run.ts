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
import type { DeliveryOrigin } from "../domain/delivery-origin.js";
import type { UserTrustLevel } from "../context/context.js";
import type { AgentCapability } from "../security/capability.js";
import type { ConversationRef, ConversationScope } from "../domain/conversation-scope.js";

/** A running row that could not cross the durable authority boundary. */
export interface InvalidDurableRunCheckpoint {
  readonly checkpointId: string;
  readonly rootRunId: string;
  readonly reason: "record_validation_failed";
}

/** One boot scan, separating resumable authority from rows that need quarantine. */
export interface DurableRunResumeScan {
  readonly records: DurableRunRecord[];
  readonly invalid: InvalidDurableRunCheckpoint[];
}

/** Authenticated authority that may claim a persisted checkpoint for resume. */
interface DurableRunResumePrincipal {
  readonly tenantId: string;
  readonly agentId: string;
  readonly conversationRef: ConversationRef;
  readonly conversationScope: ConversationScope;
  readonly principalId: string;
  readonly deliveryOrigin: DeliveryOrigin | null;
  readonly trustLevel: UserTrustLevel;
  readonly caps: readonly AgentCapability[];
}

/** Atomic source-to-replacement transition requested by an explicit resume. */
export interface DurableRunResumeClaim {
  readonly checkpointId: string;
  readonly replacementCheckpointId: string;
  readonly principal: DurableRunResumePrincipal;
  readonly claimedAtMs: number;
}

/** Expected outcomes of an authoritative resume claim. */
export type DurableRunResumeClaimOutcome =
  | { readonly kind: "claimed"; readonly record: DurableRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_resumable" }
  | { readonly kind: "authorization_denied" };

/**
 * The persisted run-checkpoint store. Execution lifecycle methods are keyed on
 * `checkpointId`; tree-wide revocation is keyed on `rootRunId`.
 * `getByCheckpoint` returns `ok(undefined)` for an absent run
 * — distinct from a real lookup error, mirroring `VideoJobStore.get`.
 */
export interface DurableRunPort {
  /**
   * Idempotent insert-or-update keyed on `checkpointId`.
   */
  upsertCheckpoint(record: DurableRunRecord): Promise<Result<void, Error>>;

  /**
   * The boot-resume scan: valid running records plus the stable identities of
   * invalid running rows. Callers resume `records` and orphan `invalid` entries,
   * so one corrupt checkpoint cannot block recovery of unrelated runs.
   */
  listResumable(): Promise<Result<DurableRunResumeScan, Error>>;

  /**
   * Read a single checkpoint by `checkpointId`. Not-found is `ok(undefined)`
   * (distinct from a lookup error) so callers can branch "no such run" vs
   * "read failed".
   */
  getByCheckpoint(checkpointId: string): Promise<Result<DurableRunRecord | undefined, Error>>;

  /**
   * Atomically consume one running checkpoint and create its running replacement.
   * The store validates the persisted principal and capability ceiling inside the
   * same write transaction, so two processes cannot both claim the source and a
   * concurrent root revocation wins before either replacement can be inserted.
   * `claimedAtMs` timestamps the authority-row transition; it does not advance
   * `lastHeartbeatAt`. Only resumed execution progress may advance the heartbeat.
   */
  claimForResume(claim: DurableRunResumeClaim): Promise<Result<DurableRunResumeClaimOutcome, Error>>;

  /**
   * Flip a record to status `orphaned` with an operator-readable `reason` — an
   * un-resumable run found by the boot scan (no live lease, failed precondition).
   */
  markOrphaned(checkpointId: string, reason: string): Promise<Result<void, Error>>;

  /** Flip a record to status `completed` — the run finished; resume skips it. */
  markCompleted(checkpointId: string): Promise<Result<void, Error>>;

  /**
   * The keep-alive write: stamp `lastHeartbeatAt = atMs`. A run whose
   * heartbeat goes stale past the threshold is a crash candidate for the
   * orphan-sweep.
   */
  touchHeartbeat(checkpointId: string, atMs: number): Promise<Result<void, Error>>;

  /**
   * Flip the record to status `revoked` so resume can NEVER re-mint it.
   * Called when the run's authority (lease/caps) is revoked out from under it; a
   * revoked checkpoint is terminal and is filtered out of `listResumable`.
   */
  invalidateForRevoke(rootRunId: string): Promise<Result<void, Error>>;

  /**
   * Windowed status counts read DIRECTLY from
   * `durable_run_checkpoints`. Crash-surviving: the row IS the durability, so this count
   * survives a hard crash that would lose an in-process lifecycle event. Counts
   * ONLY rows with `updated_at_ms >= sinceMs` (the system window), grouped by
   * status; absent statuses default to 0. The `comis system-health` assembler
   * reads this for the orphaned/resumed/revoked/running counts alongside the
   * `health_signal` rows. Mirrors the obs store's `getRollingSpendUsd`
   * windowed-aggregate (`WHERE … >= ?`) precedent.
   */
  countByStatus(
    sinceMs: number,
  ): Promise<Result<{ orphaned: number; revoked: number; running: number; completed: number }, Error>>;
}
