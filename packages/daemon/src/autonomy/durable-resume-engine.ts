// SPDX-License-Identifier: Apache-2.0
/**
 * Durable resume engine. On boot (and on
 * each watchdog tick) it turns persisted state back into live runs:
 *
 *   1. RECONCILE crashed-mid-send rows. An `unknown_after_send`
 *      ledger row is NEVER blind-replayed — the owning channel's `reconcileSend?`
 *      resolves it three ways: `sent` → ack once (commit, no replay), `not_sent`
 *      → replay exactly once, `unresolved` (or a channel that cannot reconcile)
 *      → park + escalate. A channel with no `reconcileSend` is treated as
 *      `unresolved` (never a double-send dressed as a reconcile).
 *   2. RESUME-OR-ORPHAN. For each resumable run the engine
 *      re-mints a lease from the PERSISTED attenuated caps VERBATIM (never
 *      re-attenuating from a live parent — the persisted caps ARE the attenuated
 *      result). A `revoked` re-read, a caps-parse failure (a tampered superset),
 *      or an un-resumable run is ORPHANED + the operator is notified — never
 *      silently re-minted and never silently dropped. A legitimate never-sent run
 *      (stepIndex = -1, the never-sent sentinel) PASSES the guard and is resumed.
 *   3. BOUNDED RECOVERY. The whole pass is bounded by a wall-clock
 *      `recoveryBudgetMs`; a backlog larger than the budget is partially
 *      recovered and the remainder DEFERRED (status stays `running`, so the
 *      watchdog / next boot picks them up) — no thundering herd.
 *   4. ORPHAN NOTIFICATION. Every orphan fires the injected NotifyFn + an
 *      eventBus `durable:orphaned` + an INFO line — an un-resumed run is never
 *      silently vanished.
 *
 * The engine is deliberately PURE / I/O-free: every dependency (the stores, the
 * LeaseManager re-mint, the channel lookup, the replay closure, the operator
 * notify, the clock, the event bus) is INJECTED so it is exhaustively
 * unit-testable with a fake clock + stub stores + a stub channel. The
 * wiring binds it to the real stores / LeaseManager / channel adapters and calls
 * `resumeAll()` on boot. No callable-global time/timer reads here (the
 * globals.test.ts arch-gate forbids the wall-clock and interval-scheduler
 * globals) — `nowMs` is injected.
 *
 * Logging/§2.7: every resume/orphan/reconcile outcome emits an INFO completion
 * line (with durationMs) + an eventBus event; every failure branch carries
 * `hint` + `errorKind` (the closed precondition|dependency|platform|internal
 * union). Content-free: rootRunId/stepIndex/state/reconcileOutcome/counts ONLY —
 * never the message body (the reconcile query keys on a contentDigest).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import {
  isPermanentError,
  attenuateCaps,
  parseDurableRunRecord,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type ReconcileSendOutcome,
  type ChannelPort,
  type DurableRunPort,
  type DurableRunRecord,
  type AgentCapability,
  type ComisLogger,
} from "@comis/core";

// `attenuateCaps` is imported ONLY to anchor this doc reference — it is the mint
// trust boundary at SPAWN time (capability.ts:92). On RESUME the engine does NOT
// call it: `record.caps` is already the persisted attenuated result, and
// re-attenuating from a (possibly stale or broadened) live parent would be the
// elevation-of-privilege hole. The `void` keeps the import live without
// invoking it.
void attenuateCaps;

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
  readonly rootRunId: string;
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
export interface DurableEventEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
}

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
): "not_resumable" | "reread_failed" | "invalid_caps" | "resume_failed" {
  // Match against the engine's known orphan() call-site reasons (durable-resume-engine
  // orphan() invocations). Order matters only where substrings overlap; they do not here.
  if (/not resumable|status=/i.test(freeText)) return "not_resumable";
  if (/re-?read|reconcile|query failed/i.test(freeText)) return "reread_failed";
  if (/invalid caps|caps/i.test(freeText)) return "invalid_caps";
  // The default arm makes the function TOTAL — "resume failed" AND any unmatched
  // input collapse to resume_failed, so a free-text reason can never leak through.
  return "resume_failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan-reclaim hook (RESUME-04)
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
 * The RESUME-04 orphan sweep. A run orphaned on boot (its checkpoint gone) or on a
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
  await seams.cleanupResults(workspacePath, record.rootRunId);
  // 2. the pinned script at the workspace ROOT (cleanupRun is results/-only).
  seams.removePinnedScript(workspacePath, scriptRef);
}

/** Dependencies for {@link reconcileLedgerRow}. */
export interface ReconcileLedgerDeps {
  readonly ledger: OutwardSendLedgerPort;
  /** The owning channel adapter, or `undefined` when no live adapter exists. */
  readonly channel: ChannelPort | undefined;
  /** Re-deliver a not_sent row exactly once. Returns the platform message id. */
  readonly replaySend: (row: OutwardSendRecord) => Promise<Result<{ platformMessageId: string }, Error>>;
  readonly notify: NotifyFn;
  readonly nowMs: () => number;
  readonly logger: ComisLogger;
}

/**
 * The reconcile-window half-width (ms) the query brackets around the row. A
 * crashed send's true platform timestamp is near the row's recovery time; a
 * generous window (well past any single send's latency) avoids a false
 * `not_sent` from too-tight a bracket (the same conservative-threshold spirit as
 * the watchdog).
 */
const RECONCILE_WINDOW_MS = 600_000; // 10 min

/**
 * Reconcile ONE crashed-mid-send ledger row. The exactly-once
 * core: it asks the channel "was this sent?" and resolves the row accordingly —
 * it NEVER blind-replays.
 *
 *   - `committed` row → no-op (already terminal-success).
 *   - channel has no `reconcileSend` → treated as `unresolved` → park + escalate,
 *     NO replay (an un-queryable channel must never double-send).
 *   - `sent`       → resolveReconcile("sent") + commit(platformMessageId); NO replay.
 *   - `not_sent`   → resolveReconcile("not_sent") + replay ONCE; on ok → commit;
 *                    on a PERMANENT error → markFailed("permanent") (retry
 *                    budget skipped); on a TRANSIENT error → leave for the next tick.
 *   - `unresolved` → resolveReconcile("unresolved") + notify escalation; NO replay,
 *                    NO commit.
 *
 * Returns `ok` for every RESOLVED outcome (including a parked unresolved or a
 * permanent failure — those are resolved rows, not engine errors). Returns `err`
 * only when a ledger write itself fails (a real dependency error).
 */
export async function reconcileLedgerRow(
  row: OutwardSendRecord,
  deps: ReconcileLedgerDeps,
): Promise<Result<void, Error>> {
  const { ledger, channel, replaySend, notify, nowMs, logger } = deps;
  const { rootRunId, stepIndex } = row;

  // An already-committed row is a pure no-op (a re-scan must not
  // re-query or re-send a confirmed send).
  if (row.state === "committed") {
    return ok(undefined);
  }

  // Build the content-free reconcile query — a contentDigest + a time window
  // bracketed around the recovery time (never the body).
  const now = nowMs();
  const query = {
    channelId: row.channelId,
    contentDigest: row.contentDigest,
    sentAfterMs: now - RECONCILE_WINDOW_MS,
    sentBeforeMs: now + RECONCILE_WINDOW_MS,
  };

  // ABSENCE of reconcileSend = unresolved. A channel that cannot tell
  // is parked + escalated, NEVER replayed.
  // prettier-ignore
  const outcomeResult: Result<ReconcileSendOutcome, Error> = channel?.reconcileSend ? await channel.reconcileSend(query) : ok({ kind: "unresolved" } as ReconcileSendOutcome);

  if (!outcomeResult.ok) {
    // The reconcile query itself errored (a platform/dependency failure). Park
    // the row as unresolved + escalate rather than guessing — a query error is
    // NOT evidence the send did not land.
    const resolved = await ledger.resolveReconcile(rootRunId, stepIndex, "unresolved");
    if (!resolved.ok) return failLedger(logger, resolved.error, "resolveReconcile", rootRunId, stepIndex);
    notify({
      kind: "send_reconcile_error",
      rootRunId,
      reason: "reconcile query failed; row parked unresolved",
      hint: "verify the platform manually; the run is parked",
    });
    logger.warn(
      { rootRunId, stepIndex, reconcileOutcome: "unresolved", errorKind: "platform" as const, err: outcomeResult.error, hint: "reconcile query errored — parked + escalated, never replayed" },
      "Durable reconcile: query failed, parked unresolved",
    );
    return ok(undefined);
  }

  const outcome = outcomeResult.value;
  switch (outcome.kind) {
    case "sent": {
      // The platform HAS the message — record the verdict and commit once. NO replay.
      const resolved = await ledger.resolveReconcile(rootRunId, stepIndex, "sent");
      if (!resolved.ok) return failLedger(logger, resolved.error, "resolveReconcile", rootRunId, stepIndex);
      const committed = await ledger.commit(rootRunId, stepIndex, outcome.platformMessageId);
      if (!committed.ok) return failLedger(logger, committed.error, "commit", rootRunId, stepIndex);
      logger.info({ rootRunId, stepIndex, reconcileOutcome: "sent" }, "Durable reconcile: sent (ack once)");
      return ok(undefined);
    }
    case "not_sent": {
      // The platform did NOT receive it — replay EXACTLY ONCE.
      const resolved = await ledger.resolveReconcile(rootRunId, stepIndex, "not_sent");
      if (!resolved.ok) return failLedger(logger, resolved.error, "resolveReconcile", rootRunId, stepIndex);
      const replayed = await replaySend(row);
      if (replayed.ok) {
        const committed = await ledger.commit(rootRunId, stepIndex, replayed.value.platformMessageId);
        if (!committed.ok) return failLedger(logger, committed.error, "commit", rootRunId, stepIndex);
        logger.info({ rootRunId, stepIndex, reconcileOutcome: "not_sent" }, "Durable reconcile: not_sent → replayed once");
        return ok(undefined);
      }
      // A permanent error is terminal — markFailed, skip the retry budget.
      if (isPermanentError(replayed.error.message)) {
        const failed = await ledger.markFailed(rootRunId, stepIndex, "permanent");
        if (!failed.ok) return failLedger(logger, failed.error, "markFailed", rootRunId, stepIndex);
        logger.warn(
          { rootRunId, stepIndex, reconcileOutcome: "not_sent", errorKind: "precondition" as const, hint: "permanent send error — marked failed, retry budget skipped" },
          "Durable reconcile: not_sent replay hit a permanent error → failed",
        );
        return ok(undefined);
      }
      // Transient — leave the row in place; the next tick/boot retries it.
      logger.warn(
        { rootRunId, stepIndex, reconcileOutcome: "not_sent", errorKind: "platform" as const, err: replayed.error, hint: "transient send error — left for the next recovery tick" },
        "Durable reconcile: not_sent replay transiently failed → deferred",
      );
      return ok(undefined);
    }
    case "unresolved": {
      // The honest "cannot tell" — park + escalate. NO replay, NO commit.
      const resolved = await ledger.resolveReconcile(rootRunId, stepIndex, "unresolved");
      if (!resolved.ok) return failLedger(logger, resolved.error, "resolveReconcile", rootRunId, stepIndex);
      notify({
        kind: "send_unresolved",
        rootRunId,
        reason: "reconcile unresolved",
        hint: "verify the platform manually; the run is parked",
      });
      logger.info({ rootRunId, stepIndex, reconcileOutcome: "unresolved" }, "Durable reconcile: unresolved → parked + escalated");
      return ok(undefined);
    }
    default: {
      // Exhaustive switch on the closed ReconcileSendOutcome union — a new member
      // is a compile error here, never a silent fall-through.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** Helper: a ledger-write failure is a real dependency error (vs a resolved row). */
function failLedger(
  logger: ComisLogger,
  cause: Error,
  method: string,
  rootRunId: string,
  stepIndex: number,
): Result<void, Error> {
  logger.error(
    { rootRunId, stepIndex, method, errorKind: "dependency" as const, err: cause, hint: "ledger write failed during reconcile — row left in place for the next tick" },
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
  /** Resolve a live channel adapter by channel type (undefined when none). */
  readonly channelFor: (channelType: string) => ChannelPort | undefined;
  /** Re-mint a lease from the persisted attenuated caps (the wiring's closure). */
  readonly remintLease: (input: MintLeaseInput) => IssuedLease;
  /** Resume a run from its checkpoint under the re-minted lease. */
  readonly resumeRun: (record: DurableRunRecord, leaseId: string) => Promise<Result<void, Error>>;
  /** Re-deliver a not_sent ledger row exactly once. */
  readonly replaySend: (row: OutwardSendRecord) => Promise<Result<{ platformMessageId: string }, Error>>;
  readonly notify: NotifyFn;
  readonly nowMs: () => number;
  /** The wall-clock recovery budget (ms) — the whole pass is bounded by it. */
  readonly recoveryBudgetMs: number;
  readonly logger: ComisLogger;
  readonly eventBus: DurableEventEmitter;
  /**
   * Reclaim a dead resumable orchestrate run's artifacts on the orphan path
   * (RESUME-04). Called for a run whose resume FAILED (e.g. the boot-sweep arm
   * found a missing checkpoint); scoped + idempotent by the bound
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
  resumeAll(): Promise<Result<ResumeAllResult, Error>>;
}

const DEFAULT_BUDGET_REF = "durable-resume";

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
 * watchdog counts), keyed by rootRunId+heartbeat so progress resets it.
 */
const MAX_REANCHOR_ATTEMPTS = 3;

export function createDurableResumeEngine(deps: DurableResumeEngineDeps): DurableResumeEngine {
  const {
    durableRuns,
    ledger,
    channelFor,
    remintLease,
    resumeRun,
    replaySend,
    notify,
    nowMs,
    recoveryBudgetMs,
    logger,
    eventBus,
    reclaimOrchestrateRun,
  } = deps;

  // Re-anchor ledger: rootRunId → { the heartbeat we last saw, how many consecutive
  // no-progress re-anchors at that heartbeat }. A changed heartbeat (progress) resets count.
  const reanchorLedger = new Map<string, { heartbeat: number; count: number }>();

  /** Orphan a run: markOrphaned + NotifyFn + eventBus + INFO (never silent). */
  async function orphan(rootRunId: string, reason: string, hint: string): Promise<void> {
    const marked = await durableRuns.markOrphaned(rootRunId, reason);
    if (!marked.ok) {
      logger.error(
        { rootRunId, reason, errorKind: "dependency" as const, err: marked.error, hint: "markOrphaned write failed — operator still notified out-of-band" },
        "Durable resume: markOrphaned failed",
      );
    }
    notify({ kind: "run_orphaned", rootRunId, reason, hint });
    // The EVENT carries the CLOSED enum — the free-text `reason` stays on the
    // notify + logger.info below (the operator surface).
    eventBus.emit("durable:orphaned", {
      rootRunId,
      reason: orphanReasonToEnum(reason),
      timestamp: nowMs(),
    });
    logger.info({ rootRunId, reason }, "Durable resume: run orphaned");
  }

  return {
    async resumeAll(): Promise<Result<ResumeAllResult, Error>> {
      const passStart = nowMs();
      const deadline = passStart + recoveryBudgetMs;

      const backlogResult = await durableRuns.listResumable();
      if (!backlogResult.ok) {
        logger.error(
          { errorKind: "dependency" as const, err: backlogResult.error, hint: "listResumable failed — no recovery this pass; the next boot/tick retries" },
          "Durable resume: listResumable failed",
        );
        return err(backlogResult.error);
      }
      const backlog = backlogResult.value;

      // Prune re-anchor-ledger entries for runs no longer in the backlog (completed /
      // orphaned / revoked ⇒ off listResumable) so the in-memory map can't slowly grow.
      const backlogRoots = new Set(backlog.map((c) => c.rootRunId));
      for (const key of reanchorLedger.keys()) {
        if (!backlogRoots.has(key)) reanchorLedger.delete(key);
      }

      let resumed = 0;
      let orphaned = 0;
      let attempted = 0;

      for (const candidate of backlog) {
        // Bounded recovery: stop when the wall-clock budget is spent; the
        // remainder stays `running` so the watchdog / next boot picks them up. No
        // thundering herd.
        if (nowMs() > deadline) {
          const remaining = backlog.length - attempted;
          logger.info(
            { budgetMs: recoveryBudgetMs, attempted, remaining },
            "Durable resume: budget exhausted",
          );
          return ok({ resumed, orphaned, deferred: remaining });
        }
        attempted++;

        const rootRunId = candidate.rootRunId;

        // Belt: re-read the record — a concurrent revoke may have flipped it to
        // 'revoked' since listResumable. A non-running re-read is orphaned.
        const reread = await durableRuns.getByRootRun(rootRunId);
        if (!reread.ok) {
          await orphan(rootRunId, "re-read failed", "the checkpoint could not be re-read; verify the store");
          orphaned++;
          continue;
        }
        const rereadRecord = reread.value;
        if (!rereadRecord || rereadRecord.status !== "running") {
          await orphan(
            rootRunId,
            `not resumable: status=${rereadRecord?.status ?? "missing"}`,
            "the run was revoked/completed/removed between scan and resume",
          );
          orphaned++;
          continue;
        }

        // Cap-tamper guard: parse the re-read record (the closed
        // AgentCapability union + strictObject). A tampered superset / malformed
        // record orphans — never re-minted. parseDurableRunRecord PERMITS
        // stepIndex = -1, so a legitimate never-sent run PASSES and is resumed (the
        // guard rejects only genuinely-malformed caps/records, never a legitimate
        // never-sent run). The parsed result is THE authoritative `record` we
        // rehydrate from.
        const parsed = parseDurableRunRecord(rereadRecord);
        if (!parsed.ok) {
          await orphan(
            rootRunId,
            "invalid caps",
            "the persisted caps/record failed validation (tampered or malformed); resume refused",
          );
          orphaned++;
          continue;
        }
        const record = parsed.value;

        // Bound no-progress re-anchors. A surface-only re-anchor never advances the
        // heartbeat, so a run whose process is gone (killed by a restart, never explicitly
        // resumed) would otherwise be re-anchored on EVERY watchdog tick forever. Count
        // consecutive re-anchors at an UNCHANGED heartbeat; once it exceeds the cap, abandon the
        // run → orphan it (never re-anchor again). A heartbeat change (progress) resets the
        // counter, so a genuinely live run that checkpoints is never false-orphaned.
        //
        // The cap reaps ONLY a run that has PROGRESSED past the spawn boundary
        // (stepIndex >= 0 — it allocated at least one outward step) and then stalled. A
        // NEVER-SENT run (stepIndex === -1) is the canonical fresh-resumable checkpoint —
        // nothing sent yet — and MUST survive repeated boot-sweep re-anchors, never be
        // false-orphaned (the durable-resume-e2e "never-sent RESUMES, not orphaned" gate).
        const seen = reanchorLedger.get(rootRunId);
        const attempts = seen !== undefined && seen.heartbeat === record.lastHeartbeatAt ? seen.count + 1 : 1;
        reanchorLedger.set(rootRunId, { heartbeat: record.lastHeartbeatAt, count: attempts });
        if (record.stepIndex >= 0 && attempts > MAX_REANCHOR_ATTEMPTS) {
          await orphan(
            rootRunId,
            `not resumable: exceeded ${MAX_REANCHOR_ATTEMPTS} no-progress re-anchor attempts`,
            "the run's heartbeat never advanced across repeated re-anchors — its process is gone and it was never explicitly resumed; re-launch it if still needed",
          );
          orphaned++;
          reanchorLedger.delete(rootRunId);
          // Reclaim the dead resumable orchestrate run's workspace (RESUME-04), mirroring the
          // resume-failure orphan path below (a non-orchestrate row is a no-op).
          if (reclaimOrchestrateRun) await reclaimOrchestrateRun(record);
          continue;
        }

        // Reconcile this run's crashed-mid-send rows BEFORE resuming, so a
        // mid-send row is resolved (acked/replayed/parked) before the run advances.
        const unreconciledResult = await ledger.listUnreconciled();
        if (!unreconciledResult.ok) {
          logger.warn(
            { rootRunId, errorKind: "dependency" as const, err: unreconciledResult.error, hint: "listUnreconciled failed — resume continues; rows retried next tick" },
            "Durable resume: listUnreconciled failed",
          );
        } else {
          for (const ledgerRow of unreconciledResult.value) {
            if (ledgerRow.rootRunId !== rootRunId) continue;
            await reconcileLedgerRow(ledgerRow, {
              ledger,
              channel: channelFor(ledgerRow.channelType),
              replaySend,
              notify,
              nowMs,
              logger,
            });
          }
        }

        // Re-mint from the PERSISTED attenuated caps VERBATIM.
        // Rehydrate the persisted attenuated caps — do NOT re-attenuate
        // from a live parent (the persisted set IS the attenuated result; a
        // re-attenuation against a stale/broadened parent would resurrect or
        // broaden authority).
        const sessionKey = firstLeaseId(record) ?? rootRunId;
        const lease = remintLease({
          agentId: deriveAgentId(record),
          caps: record.caps,
          budgetRef: DEFAULT_BUDGET_REF,
          sessionKey,
          rootRunId,
        });

        const runStart = nowMs();
        const resumeResult = await resumeRun(record, lease.leaseId);
        if (resumeResult.ok) {
          resumed++;
          // Numeric stepIndex + timestamp (content-free per the §2.7 logging matrix).
          eventBus.emit("durable:resumed", {
            rootRunId,
            stepIndex: record.stepIndex,
            timestamp: nowMs(),
          });
          logger.info(
            { rootRunId, stepIndex: record.stepIndex, durationMs: nowMs() - runStart },
            "Durable resume: run resumed",
          );
        } else {
          // Propagate the resume failure's specific reason (e.g. the orchestrate
          // arm's "not resumable: the checkpoint blob is gone") so the WARN log /
          // notify name WHY AND `orphanReasonToEnum` maps it to the fitting closed
          // member (a missing checkpoint → not_resumable) — the free text NEVER
          // crosses onto the event (content-free — INV-5).
          await orphan(
            rootRunId,
            resumeResult.error.message,
            "the run could not be resumed from its checkpoint; inspect the cause and re-launch if needed",
          );
          orphaned++;
          // RESUME-04 orphan-reclaim: a dead resumable orchestrate run has no
          // surviving runner to GC its workspace — reclaim its results/ + pinned
          // script now. Scoped + idempotent by the bound seam (a non-orchestrate
          // row is a no-op); absent ⇒ no reclaim.
          if (reclaimOrchestrateRun) await reclaimOrchestrateRun(record);
          logger.warn(
            { rootRunId, stepIndex: record.stepIndex, errorKind: "internal" as const, err: resumeResult.error, hint: "resumeRun returned err — orphaned + operator notified" },
            "Durable resume: resumeRun failed → orphaned",
          );
        }
      }

      logger.info(
        { resumed, orphaned, deferred: 0, durationMs: nowMs() - passStart },
        "Durable resume: pass complete",
      );
      return ok({ resumed, orphaned, deferred: 0 });
    },
  };
}

/**
 * Derive the agentId for the re-mint. The DurableRunRecord does not
 * carry a dedicated agentId field; the run's authority is keyed by rootRunId +
 * caps + leases, and the wiring's remintLease closure resolves the
 * concrete agent from the lease/session context. We pass the rootRunId as a
 * stable correlation id so the mint is attributable; the closure may override.
 */
function deriveAgentId(record: DurableRunRecord): string {
  return record.rootRunId;
}

/** The first lease id (the flat-run session-key node), or undefined. */
function firstLeaseId(record: DurableRunRecord): string | undefined {
  return record.leaseIds[0];
}
