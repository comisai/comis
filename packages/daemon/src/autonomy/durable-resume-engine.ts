// SPDX-License-Identifier: Apache-2.0
/**
 * Durable resume engine. On boot (and on
 * each watchdog tick) it turns persisted state back into live runs:
 *
 *   1. PARK crashed-mid-send rows. Every `unknown_after_send` or
 *      `send_attempt_started` row is atomically parked and escalated. Recovery
 *      never infers platform truth from content history and never issues a
 *      second platform call.
 *   2. RESUME-OR-ORPHAN. For each resumable run the engine
 *      re-mints a lease from the PERSISTED attenuated caps VERBATIM (never
 *      re-attenuating from a live parent — the persisted caps ARE the attenuated
 *      result). A `revoked` re-read, a caps-parse failure (a tampered superset),
 *      or an un-resumable run is ORPHANED + the operator is notified — never
 *      silently re-minted and never silently dropped.
 *   3. BOUNDED RECOVERY. The whole pass is bounded by a wall-clock
 *      `recoveryBudgetMs`; a backlog larger than the budget is partially
 *      recovered and the remainder DEFERRED (status stays `running`, so the
 *      watchdog / next boot picks them up) — no thundering herd.
 *   4. ORPHAN NOTIFICATION. Every orphan fires the injected NotifyFn + an
 *      eventBus `durable:orphaned` + an INFO line — an un-resumed run is never
 *      silently vanished.
 *
 * The engine is deliberately PURE / I/O-free: every dependency (the stores, the
 * LeaseManager re-mint, the operator notify, the clock, the event bus) is
 * INJECTED so it is exhaustively unit-testable with a fake clock + stub stores. The
 * wiring binds it to the real stores / LeaseManager / channel adapters and calls
 * `resumeAll()` on boot. No callable-global time/timer reads here (the
 * globals.test.ts arch-gate forbids the wall-clock and interval-scheduler
 * globals) — `nowMs` is injected.
 *
 * Logging/§2.7: every resume/orphan/reconcile outcome emits an INFO completion
 * line (with durationMs) + an eventBus event; every failure branch carries
 * `hint` + `errorKind` (the closed precondition|dependency|platform|internal
 * union). Content-free: rootRunId/stepIndex/state/reconcileOutcome/counts ONLY —
 * never the message body (park-only recovery never reads content history).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import {
  emitObservationalEventSafely,
  conversationScopeToSessionKey,
  formatSessionKey,
  parseDurableRunRecord,
  toSafeErrorLogString,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type DurableRunPort,
  type DurableRunRecord,
  type InvalidDurableRunCheckpoint,
  type AgentCapability,
  type ComisLogger,
  type TypedEventBus,
  type UserTrustLevel,
  type ResolvedTurnScope,
} from "@comis/core";

/**
 * The content-free operator notification. Reuses the background-task
 * NotifyFn shape: ids + a reason + a hint, NEVER a message body. Fired
 * out-of-band for every orphan / unresolved reconcile.
 */
export type NotifyFn = (opts: {
  kind: string;
  rootRunId: string;
  reason: string;
  hint: string;
}) => void;

/** The lease-mint input the engine passes to the injected re-mint closure. */
export interface MintLeaseInput {
  readonly agentId: string;
  readonly caps: readonly AgentCapability[];
  readonly budgetRef: string;
  readonly sessionKey: string;
  readonly trustLevel: UserTrustLevel;
  readonly deliveryOrigin?: import("@comis/core").DeliveryOrigin;
  readonly turnScope?: ResolvedTurnScope;
  readonly rootRunId: string;
  readonly checkpointId: string;
  readonly parentLeaseId?: string;
  readonly ttlMs?: number;
  readonly maxTtlMs?: number;
}

/** The minted lease the re-mint closure returns. */
export interface IssuedLease {
  readonly leaseId: string;
  readonly bearer: string;
}

/**
 * The narrow content-free event emitter the engine calls on each transition.
 * The wiring binds a real TypedEventBus adapter; the engine stays I/O-free
 * and the closed EventMap (owned at the wiring layer) is not coupled here.
 */
export type DurableEventEmitter = Pick<TypedEventBus, "emitSafely">;

/**
 * Map the engine's free-text orphan reason to the CLOSED enum the
 * `durable:orphaned` EVENT carries (events-orchestration.ts). TOTAL over
 * `string` — the `default` arm guarantees every input (including a brand-new
 * unmapped reason) returns a union member and the function NEVER echoes its
 * `freeText` argument. This is the content-free invariant AT THE SOURCE: the
 * free string stays ONLY on the WARN log / notify (the operator's debugging
 * surface); the closed enum is the only thing that crosses onto the event/obs-row.
 * Mirrors the closed-union discriminator pattern of `execution:aborted.reason`.
 */
export function orphanReasonToEnum(
  freeText: string,
):
  | "not_resumable"
  | "reread_failed"
  | "invalid_record"
  | "invalid_caps"
  | "outward_uncertain"
  | "resume_failed" {
  // Match against the engine's known orphan() call-site reasons (durable-resume-engine
  // orphan() invocations). Order matters only where substrings overlap; they do not here.
  if (/not resumable|status=/i.test(freeText)) return "not_resumable";
  if (/re-?read|reconcile|query failed/i.test(freeText)) return "reread_failed";
  if (/invalid durable record/i.test(freeText)) return "invalid_record";
  if (/invalid caps|caps/i.test(freeText)) return "invalid_caps";
  if (/outward.*uncertain|outward effect unresolved/i.test(freeText)) {
    return "outward_uncertain";
  }
  // The default arm makes the function TOTAL — "resume failed" AND any unmatched
  // input collapse to resume_failed, so a free-text reason can never leak through.
  return "resume_failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan-reclaim hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The injected seams the orphan-reclaim hook composes. Both are best-effort /
 * result-degrading in production (a missing file is a no-op), so reclaim is
 * IDEMPOTENT. Injected so the hook is macOS-unit-testable against a real temp
 * workspace with no daemon boot / no concrete store import.
 */
export interface OrchestrateReclaimSeams {
  /** Resolve the dead run's workspace ROOT (undefined ⇒ nothing to reclaim). */
  readonly workspaceFor: (record: DurableRunRecord) => string | undefined;
  /** Delete the run's `results/` dir — reuses result-ref-store.cleanupRun (rmSync recursive). */
  readonly cleanupResults: (workspacePath: string, runId: string) => Promise<void>;
  /** Delete the pinned `<scriptRef>` at the workspace root (guarded rmSync — a missing file is a no-op). */
  readonly removePinnedScript: (workspacePath: string, scriptRef: string) => void;
}

/**
 * Reclaim a dead resumable orchestrate run's artifacts: its surviving `results/`
 * (the checkpoint blob + any materialized results) + the pinned `<scriptRef>`.
 *
 * The orphan sweep. A run orphaned on boot (its checkpoint gone) or on a
 * lapsed-heartbeat watchdog tick has NO surviving runner to GC its workspace (the
 * runner's own run-end cleanup never fired — the process crashed mid-pipeline), so
 * the orphan path is the OWNER of the reclaim. SCOPED to orchestrate-kind rows
 * (`scriptRef != null` — a re-runnable orchestrate row); a DAG/flat legacy orphan
 * carries no `scriptRef` and is a no-op. IDEMPOTENT — a second reclaim finds the
 * files already gone (the seams degrade, never throw). Composes the EXISTING
 * `cleanupRun` + a guarded `rmSync` — no new GC primitive (NG4).
 */
export async function reclaimOrphanedOrchestrateRun(
  record: DurableRunRecord,
  seams: OrchestrateReclaimSeams,
): Promise<void> {
  const scriptRef = record.scriptRef;
  // Scoped: only a re-runnable orchestrate row (a pinned scriptRef) has artifacts
  // this hook owns; a DAG/flat legacy orphan is unaffected.
  if (scriptRef == null) return;
  const workspacePath = seams.workspaceFor(record);
  if (workspacePath === undefined) return; // unresolvable workspace ⇒ nothing to reclaim
  // 1. results/ — the checkpoint blob (+ any surviving materialized results) live here.
  await seams.cleanupResults(workspacePath, record.checkpointId);
  // 2. the pinned script at the workspace ROOT (cleanupRun is results/-only).
  seams.removePinnedScript(workspacePath, scriptRef);
}

/** Dependencies for {@link reconcileLedgerRow}. */
export interface ReconcileLedgerDeps {
  readonly ledger: OutwardSendLedgerPort;
  readonly notify: NotifyFn;
  readonly nowMs: () => number;
  readonly logger: ComisLogger;
  readonly eventBus?: DurableEventEmitter;
}

/**
 * Atomically park ONE crashed-mid-send ledger row. Recovery has no authoritative
 * platform operation receipt, so it never queries message history and never
 * issues another platform call. Only the atomic transition winner escalates.
 */
export async function reconcileLedgerRow(
  row: OutwardSendRecord,
  deps: ReconcileLedgerDeps,
): Promise<Result<"cleared" | "parked", Error>> {
  const { ledger, notify, nowMs, logger, eventBus } = deps;
  const { rootRunId, stepIndex } = row;
  const emitState = (
    transition: "park",
    outcome: "parked",
  ): void => {
    if (eventBus === undefined) return;
    emitObservationalEventSafely({ eventBus, logger }, "delivery:outward_ledger_transition", {
      rootRunId,
      stepIndex,
      transition,
      outcome,
      timestamp: nowMs(),
    });
  };

  // An already-committed row is a pure no-op (a re-scan must not
  // re-query or re-send a confirmed send).
  if (row.state === "committed") {
    return ok("cleared");
  }

  const parked = await ledger.parkUncertain(rootRunId, stepIndex);
  if (!parked.ok) {
    return failLedger(logger, parked.error, "parkUncertain", rootRunId, stepIndex);
  }
  if (!parked.value) {
    return ok("parked");
  }

  notify({
    kind: "send_unresolved",
    rootRunId,
    reason: "outward delivery outcome is uncertain",
    hint: "verify the platform manually before re-launching the run",
  });
  logger.warn(
    {
      rootRunId,
      stepIndex,
      reconcileOutcome: "unresolved",
      errorKind: "precondition" as const,
      hint: "verify the platform manually before re-launching the run",
    },
    "Durable recovery parked an uncertain outward delivery",
  );
  emitState("park", "parked");
  return ok("parked");
}

/** Helper: a ledger-write failure is a real dependency error (vs a resolved row). */
function failLedger<T = never>(
  logger: ComisLogger,
  cause: Error,
  method: string,
  rootRunId: string,
  stepIndex: number,
): Result<T, Error> {
  logger.error(
    { rootRunId, stepIndex, method, errorKind: "dependency" as const, err: toSafeErrorLogString(cause), hint: "ledger write failed during reconcile — row left in place for the next tick" },
    "Durable reconcile: ledger write failed",
  );
  return err(cause);
}

// ─────────────────────────────────────────────────────────────────────────────
// createDurableResumeEngine
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencies for {@link createDurableResumeEngine}. */
export interface DurableResumeEngineDeps {
  readonly durableRuns: DurableRunPort;
  readonly ledger: OutwardSendLedgerPort;
  /** Re-mint a lease from the persisted attenuated caps (the wiring's closure). */
  readonly remintLease: (input: MintLeaseInput) => IssuedLease;
  /** Revoke a lease whose recovered run failed before accepting execution. */
  readonly revokeLease?: (leaseId: string) => void;
  /** Resume a run from its checkpoint under the re-minted lease. */
  readonly resumeRun: (record: DurableRunRecord, lease: IssuedLease) => Promise<Result<void, Error>>;
  readonly notify: NotifyFn;
  readonly nowMs: () => number;
  /** The wall-clock recovery budget (ms) — the whole pass is bounded by it. */
  readonly recoveryBudgetMs: number;
  readonly logger: ComisLogger;
  readonly eventBus: DurableEventEmitter;
  /**
   * Reclaim a dead resumable orchestrate run's artifacts when recovery proves
   * them unusable (for example, the boot sweep found a missing checkpoint).
   * Outward uncertainty does not call this hook because the checkpoint, replay,
   * and pinned script are evidence for manual verification and re-launch.
   * Scoped + idempotent by the bound
   * {@link reclaimOrphanedOrchestrateRun} (a non-orchestrate row is a no-op).
   * Absent ⇒ no reclaim (a flat/legacy-only wiring).
   */
  readonly reclaimOrchestrateRun?: (record: DurableRunRecord) => Promise<void>;
}

/** The result of one boot/watchdog recovery pass. */
export interface ResumeAllResult {
  readonly resumed: number;
  readonly orphaned: number;
  readonly deferred: number;
}

export interface DurableResumeEngine {
  /**
   * Run ONE bounded recovery pass over `listResumable()`: reconcile each run's
   * crashed-mid-send rows, then resume-or-orphan it, stopping when the wall-clock
   * budget is exhausted (the remainder deferred). Returns the counts.
   */
  resumeAll(options?: {
    /** Exact authority rows eligible for this pass. Omitted only for boot recovery. */
    eligibleCheckpointIds?: readonly string[];
  }): Promise<Result<ResumeAllResult, Error>>;
}

const DEFAULT_BUDGET_REF = "durable-resume";
const OUTWARD_RECOVERY_BATCH_SIZE = 100;

/**
 * Bound how many times the watchdog re-anchors a run that makes NO progress.
 * The orchestrate resume arm is SURFACE-ONLY (re-anchor the lease, no re-spawn on boot),
 * so a run whose process is gone (killed by a restart) is re-detected as lapsed and
 * re-anchored on EVERY watchdog tick — forever — because a surface-only re-anchor never
 * advances the heartbeat and the row never reaches a terminal state. That is a real (LOW,
 * resource-light) lifecycle defect: an unbounded re-anchor loop + a permanent "running"
 * ghost row. We cap it: after this many consecutive re-anchors with an UNCHANGED heartbeat
 * (no progress), the run is abandoned → orphaned (durable:orphaned). A run that DOES advance
 * its heartbeat (a genuinely live run that checkpoints) resets the counter, so a healthy long
 * run is never false-orphaned; a live no-checkpoint run is bounded by its own orchestrate
 * timeoutMs. The count is in-memory (resets on daemon restart — boot re-anchors once, then the
 * watchdog counts), carried from each source checkpoint id to its atomic
 * replacement so sibling rows under one root never share attempts.
 */
const MAX_REANCHOR_ATTEMPTS = 3;

export function createDurableResumeEngine(deps: DurableResumeEngineDeps): DurableResumeEngine {
  const {
    durableRuns,
    ledger,
    remintLease,
    revokeLease,
    resumeRun,
    notify,
    nowMs,
    recoveryBudgetMs,
    logger,
    eventBus,
    reclaimOrchestrateRun,
  } = deps;

  // Re-anchor ledger: current checkpointId → { heartbeat, consecutive count }.
  // A successful claim transfers the entry to its replacement checkpoint id.
  const reanchorLedger = new Map<string, { heartbeat: number; count: number }>();

  /** Orphan a run: markOrphaned + NotifyFn + eventBus + INFO (never silent). */
  async function orphan(record: Pick<DurableRunRecord, "checkpointId" | "rootRunId">, reason: string, hint: string): Promise<void> {
    const { checkpointId, rootRunId } = record;
    const reasonCode = orphanReasonToEnum(reason);
    const marked = await durableRuns.markOrphaned(checkpointId, reason);
    if (!marked.ok) {
      logger.error(
        { rootRunId, reason: reasonCode, errorKind: "dependency" as const, err: toSafeErrorLogString(marked.error), hint: "markOrphaned write failed — operator still notified out-of-band" },
        "Durable resume: markOrphaned failed",
      );
    }
    notify({ kind: "run_orphaned", rootRunId, reason, hint });
    // The EVENT carries the CLOSED enum — the free-text `reason` stays on the
    // notify + logger.info below (the operator surface).
    emitObservationalEventSafely({ eventBus, logger }, "durable:orphaned", {
      rootRunId,
      reason: reasonCode,
      timestamp: nowMs(),
    });
    logger.info({ rootRunId, reason: reasonCode }, "Durable resume: run orphaned");
  }

  return {
    async resumeAll(options): Promise<Result<ResumeAllResult, Error>> {
      const passStart = nowMs();
      const deadline = passStart + recoveryBudgetMs;

      const outwardScan = await ledger.listUnreconciled(OUTWARD_RECOVERY_BATCH_SIZE + 1);
      if (!outwardScan.ok) {
        logger.error(
          {
            errorKind: "dependency" as const,
            err: toSafeErrorLogString(outwardScan.error),
            hint: "outward recovery scan failed; no durable run was resumed",
          },
          "Durable resume: outward recovery scan failed",
        );
        return err(outwardScan.error);
      }
      const outwardBatch = outwardScan.value.slice(0, OUTWARD_RECOVERY_BATCH_SIZE);
      const outwardOverflow = Math.max(
        0,
        outwardScan.value.length - OUTWARD_RECOVERY_BATCH_SIZE,
      );
      let outwardAttempted = 0;
      for (const ledgerRow of outwardBatch) {
        if (nowMs() > deadline) {
          return ok({
            resumed: 0,
            orphaned: 0,
            deferred: outwardBatch.length - outwardAttempted + outwardOverflow,
          });
        }
        outwardAttempted++;
        const parked = await reconcileLedgerRow(ledgerRow, {
          ledger,
          notify,
          nowMs,
          logger,
          eventBus,
        });
        if (!parked.ok) return parked;
      }

      const backlogResult = await durableRuns.listResumable();
      if (!backlogResult.ok) {
        logger.error(
          { errorKind: "dependency" as const, err: toSafeErrorLogString(backlogResult.error), hint: "listResumable failed — no recovery this pass; the next boot/tick retries" },
          "Durable resume: listResumable failed",
        );
        return err(backlogResult.error);
      }
      const scan = backlogResult.value;
      const fullBacklog: Array<
        | { kind: "record"; value: DurableRunRecord }
        | { kind: "invalid"; value: InvalidDurableRunCheckpoint }
      > = [
        ...scan.invalid.map((value) => ({ kind: "invalid" as const, value })),
        ...scan.records.map((value) => ({ kind: "record" as const, value })),
      ];
      const eligibleCheckpointIds = options?.eligibleCheckpointIds === undefined
        ? undefined
        : new Set(options.eligibleCheckpointIds);
      const backlog = eligibleCheckpointIds === undefined
        ? fullBacklog
        : fullBacklog.filter((candidate) => eligibleCheckpointIds.has(candidate.value.checkpointId));

      // Prune re-anchor-ledger entries for runs no longer in the backlog (completed /
      // orphaned / revoked ⇒ off listResumable) so the in-memory map can't slowly grow.
      const backlogCheckpointIds = new Set(
        fullBacklog.map((candidate) => candidate.value.checkpointId),
      );
      for (const key of reanchorLedger.keys()) {
        if (!backlogCheckpointIds.has(key)) reanchorLedger.delete(key);
      }

      let resumed = 0;
      let orphaned = 0;
      let attempted = 0;

      for (const candidateEntry of backlog) {
        // Bounded recovery: stop when the wall-clock budget is spent; the
        // remainder stays `running` so the watchdog / next boot picks them up. No
        // thundering herd.
        if (nowMs() > deadline) {
          const remaining = backlog.length - attempted;
          logger.info(
            { budgetMs: recoveryBudgetMs, attempted, remaining },
            "Durable resume: budget exhausted",
          );
          return ok({ resumed, orphaned, deferred: remaining + outwardOverflow });
        }
        attempted++;

        if (candidateEntry.kind === "invalid") {
          await orphan(
            candidateEntry.value,
            "invalid durable record",
            "the persisted checkpoint principal or authority fields failed validation; inspect the protected store before re-launching",
          );
          orphaned++;
          continue;
        }

        const candidate = candidateEntry.value;

        const { checkpointId, rootRunId } = candidate;

        // Belt: re-read the record — a concurrent revoke may have flipped it to
        // 'revoked' since listResumable. A non-running re-read is orphaned.
        const reread = await durableRuns.getByCheckpoint(checkpointId);
        if (!reread.ok) {
          await orphan(candidate, "re-read failed", "the checkpoint could not be re-read; verify the store");
          orphaned++;
          continue;
        }
        const rereadRecord = reread.value;
        if (!rereadRecord || rereadRecord.status !== "running") {
          await orphan(
            candidate,
            `not resumable: status=${rereadRecord?.status ?? "missing"}`,
            "the run was revoked/completed/removed between scan and resume",
          );
          orphaned++;
          continue;
        }

        // Cap-tamper guard: parse the re-read record (the closed
        // AgentCapability union + strictObject). A tampered superset / malformed
        // record orphans — never re-minted. The parsed result is the
        // authoritative record rehydrated below.
        const parsed = parseDurableRunRecord(rereadRecord);
        if (!parsed.ok) {
          await orphan(
            candidate,
            "invalid caps",
            "the persisted caps/record failed validation (tampered or malformed); resume refused",
          );
          orphaned++;
          continue;
        }
        const sourceRecord = parsed.value;

        // Bound no-progress re-anchors. A surface-only re-anchor never advances the
        // heartbeat, so a run whose process is gone (killed by a restart, never explicitly
        // resumed) would otherwise be re-anchored on EVERY watchdog tick forever. Count
        // consecutive re-anchors at an UNCHANGED heartbeat; once it exceeds the cap, abandon the
        // run → orphan it (never re-anchor again). A heartbeat change (progress) resets the
        // counter, so a genuinely live run that checkpoints is never false-orphaned.
        //
        const seen = reanchorLedger.get(checkpointId);
        const attempts = seen !== undefined && seen.heartbeat === sourceRecord.lastHeartbeatAt ? seen.count + 1 : 1;
        reanchorLedger.set(checkpointId, { heartbeat: sourceRecord.lastHeartbeatAt, count: attempts });
        if (attempts > MAX_REANCHOR_ATTEMPTS) {
          await orphan(
            sourceRecord,
            `not resumable: exceeded ${MAX_REANCHOR_ATTEMPTS} no-progress re-anchor attempts`,
            "the run's heartbeat never advanced across repeated re-anchors — its process is gone and it was never explicitly resumed; re-launch it if still needed",
          );
          orphaned++;
          reanchorLedger.delete(checkpointId);
          // Reclaim the dead resumable orchestrate run's workspace, mirroring the
          // resume-failure orphan path below (a non-orchestrate row is a no-op).
          if (reclaimOrchestrateRun) await reclaimOrchestrateRun(sourceRecord);
          continue;
        }

        // Atomically retire the source and create one replacement before any
        // reconcile, lease mint, or execution. A concurrent boot/watchdog pass
        // loses this claim and performs no work.
        const replacementCheckpointId = `resume-${randomUUID()}`;
        // Wall clocks can move backward across a restart. The durable store
        // rejects a claim that would regress the source heartbeat, so clamp the
        // replacement timestamp to the persisted temporal authority.
        const claimedAtMs = Math.max(
          nowMs(),
          sourceRecord.lastHeartbeatAt,
          sourceRecord.rootBudget.startedAtMs,
        );
        const claimed = await durableRuns.claimForResume({
          checkpointId,
          replacementCheckpointId,
          principal: {
            tenantId: sourceRecord.tenantId,
            agentId: sourceRecord.agentId,
            conversationRef: sourceRecord.conversationRef,
            conversationScope: sourceRecord.conversationScope,
            principalId: sourceRecord.principalId,
            deliveryOrigin: sourceRecord.deliveryOrigin,
            trustLevel: sourceRecord.trustLevel,
            caps: sourceRecord.caps,
          },
          claimedAtMs,
        });
        if (!claimed.ok) {
          logger.error(
            {
              rootRunId,
              checkpointId,
              err: toSafeErrorLogString(claimed.error),
              hint: "Retry recovery after the durable authority store is healthy",
              errorKind: "dependency" as const,
            },
            "Durable resume claim failed",
          );
          return err(claimed.error);
        }
        if (claimed.value.kind !== "claimed") {
          logger.info(
            { rootRunId, checkpointId, claimOutcome: claimed.value.kind },
            "Durable resume claim lost or refused",
          );
          continue;
        }
        // Keep the source entry until the next scan prunes whichever side of the
        // atomic replacement is no longer authoritative. Recording both makes
        // the transfer robust to stores/tests whose claim visibility changes on
        // the following listResumable call rather than inside claimForResume.
        reanchorLedger.set(replacementCheckpointId, {
          heartbeat: sourceRecord.lastHeartbeatAt,
          count: attempts,
        });
        const replacement = parseDurableRunRecord({
          ...claimed.value.record,
          checkpointId: replacementCheckpointId,
          leaseIds: [],
          status: "running",
        });
        if (!replacement.ok) {
          await orphan(
            { checkpointId: replacementCheckpointId, rootRunId },
            "invalid durable replacement",
            "the atomic replacement failed local validation and was quarantined",
          );
          orphaned++;
          continue;
        }
        const record = replacement.value;

        const uncertainty = await ledger.hasUncertainty(rootRunId);
        if (!uncertainty.ok) {
          await orphan(
            record,
            "outward uncertainty query failed",
            "the outward ledger could not prove this run safe to resume; repair the store and verify platform effects",
          );
          logger.error(
            {
              rootRunId,
              errorKind: "dependency" as const,
              err: toSafeErrorLogString(uncertainty.error),
              hint: "the replacement was orphaned; repair the outward ledger before re-launching",
            },
            "Durable resume: outward uncertainty query failed",
          );
          return err(uncertainty.error);
        }
        if (uncertainty.value) {
          await orphan(
            record,
            "outward delivery uncertain",
            "verify the platform side effect before re-launching this execution",
          );
          orphaned++;
          logger.warn(
            {
              rootRunId,
              checkpointId: record.checkpointId,
              hint: "resolve the crash-uncertain outward effect manually before re-launching",
              errorKind: "precondition" as const,
            },
            "Durable resume blocked by an uncertain outward delivery",
          );
          continue;
        }

        // Re-mint from the PERSISTED attenuated caps VERBATIM.
        // Rehydrate the persisted attenuated caps — do NOT re-attenuate
        // from a live parent (the persisted set IS the attenuated result; a
        // re-attenuation against a stale/broadened parent would resurrect or
        // broaden authority).
        const displaySession = conversationScopeToSessionKey(record.conversationScope);
        const partition = record.conversationScope.partition;
        const endpoint = partition.kind === "endpoint-conversation-principal"
          ? partition.endpoint
          : undefined;
        if (!displaySession.ok || endpoint === undefined) {
          await orphan(
            record,
            "invalid durable record authority",
            "the persisted conversation authority cannot reconstruct a resolved resume turn",
          );
          orphaned++;
          continue;
        }
        const turnScope: ResolvedTurnScope = {
          conversation: record.conversationScope,
          principal: { principalId: record.principalId },
          endpoint,
        };
        const lease = remintLease({
          agentId: record.agentId,
          caps: record.caps,
          budgetRef: DEFAULT_BUDGET_REF,
          sessionKey: formatSessionKey(displaySession.value),
          trustLevel: record.trustLevel,
          ...(record.deliveryOrigin !== null ? { deliveryOrigin: record.deliveryOrigin } : {}),
          turnScope,
          rootRunId,
          checkpointId: record.checkpointId,
        });

        const runStart = nowMs();
        let resumeResult: Result<void, Error>;
        try {
          resumeResult = await resumeRun(record, lease);
        } catch (cause) {
          resumeResult = err(cause instanceof Error ? cause : new Error(String(cause)));
        }
        if (resumeResult.ok) {
          resumed++;
          emitObservationalEventSafely({ eventBus, logger }, "durable:resumed", {
            rootRunId,
            checkpointId: record.checkpointId,
            timestamp: nowMs(),
          });
          logger.info(
            { rootRunId, checkpointId: record.checkpointId, durationMs: nowMs() - runStart },
            "Durable resume: run resumed",
          );
        } else {
          revokeLease?.(lease.leaseId);
          // Propagate the resume failure's specific reason (e.g. the orchestrate
          // arm's "not resumable: the checkpoint blob is gone") so the WARN log /
          // notify name WHY AND `orphanReasonToEnum` maps it to the fitting closed
          // member (a missing checkpoint → not_resumable) — the free text NEVER
          // crosses onto the event; it remains content-free.
          const safeResumeError = toSafeErrorLogString(resumeResult.error);
          await orphan(
            record,
            safeResumeError,
            "the run could not be resumed from its checkpoint; inspect the cause and re-launch if needed",
          );
          orphaned++;
          // Orphan reclaim: a dead resumable orchestrate run has no
          // surviving runner to GC its workspace — reclaim its results/ + pinned
          // script now. Scoped + idempotent by the bound seam (a non-orchestrate
          // row is a no-op); absent ⇒ no reclaim.
          if (reclaimOrchestrateRun) await reclaimOrchestrateRun(sourceRecord);
          logger.warn(
            { rootRunId, checkpointId: record.checkpointId, errorKind: "internal" as const, err: safeResumeError, hint: "resumeRun returned err — orphaned + operator notified" },
            "Durable resume: resumeRun failed → orphaned",
          );
        }
      }

      logger.info(
        { resumed, orphaned, deferred: outwardOverflow, durationMs: nowMs() - passStart },
        "Durable resume: pass complete",
      );
      return ok({ resumed, orphaned, deferred: outwardOverflow });
    },
  };
}
