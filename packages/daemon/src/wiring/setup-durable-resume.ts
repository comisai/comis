// SPDX-License-Identifier: Apache-2.0
/**
 * Durable resume subsystem wiring (the composition root for the
 * durability engine). Mirrors `setup-delivery.ts`'s two-phase STRUCTURE:
 *
 *   1. `setupDurableResume()` constructs the two SQLite stores (against the SHARED
 *      `memory.db`) + the resume engine immediately, and returns them alongside a
 *      deferred `resumeAndStart()` + a `shutdown()`.
 *   2. `resumeAndStart()` runs after graph recovery wiring is ready. It runs the
 *      bounded boot recovery (`engine.resumeAll()`) and then starts a single
 *      daemon-wide watchdog interval that sweeps lapsed heartbeats.
 *   3. `shutdown()` cancels the watchdog interval — no leaked timer.
 *
 * GATING: when `config.enabled` is false (the default, OR no autonomy-bearing
 * agent is configured — the daemon folds both into `enabled`), the function
 * returns inert stubs (no stores constructed, `resumeAndStart`/`shutdown` no-ops,
 * NO watchdog timer), matching `setup-delivery.ts`'s inert-when-disabled return.
 *
 * The engine itself is PURE / I/O-free; this wiring binds it to the
 * real stores plus the injected LeaseManager re-mint, run-resume, and operator
 * notification closures. Crash-uncertain sends are parked without a platform
 * lookup or replay. The watchdog uses
 * the INJECTED TimerPort (never the interval-scheduler global — the
 * globals.test.ts arch-gate).
 *
 * @module
 */

import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ClockPort, TimerPort, TimerHandle, DurableRunPort, OutwardSendLedgerPort, DurableRunRecord, PerAgentConfig, AgentCapability, TypedEventBus } from "@comis/core";
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  resolveAutonomy,
  DurabilityConfigSchema,
  runWithContext,
  safePath,
  toSafeErrorLogString,
} from "@comis/core";
import { createSqliteDurableRunStore, createSqliteOutwardSendLedger } from "@comis/memory";
import { createResultRefStore } from "@comis/skills/tools";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import { ok, err, type Result } from "@comis/shared";
import {
  createDurableResumeEngine,
  reclaimOrphanedOrchestrateRun,
  type MintLeaseInput,
  type IssuedLease,
  type NotifyFn,
  type DurableEventEmitter,
  type DurableResumeEngine,
} from "../autonomy/durable-resume-engine.js";
import { detectStaleRuns } from "../autonomy/durable-watchdog.js";
import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";
import { isDagSpawnTree } from "../graph/graph-durable-checkpoint.js";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";

// ───────────────────────────────────────────────────────────────────────────
// The orchestrate-kind resume arm (233). A durable row with a FLAT spawnTree
// AND a pinned `scriptRef` is a RE-RUNNABLE orchestrate row (the runner writes
// it). On boot the sweep dispatches it to THIS arm (never resumeGraph) to VERIFY
// its pinned script + checkpoint survived the crash — surface-only; the byte
// re-execution is the explicit `orchestrate({resumeRunId})` path.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The injected seams the orchestrate-kind resume arm verifies against — a
 * workspace resolver + an fs-exists probe. Injected so the arm is PURE and
 * macOS-unit-testable against a real temp workspace with no daemon boot.
 */
export interface OrchestrateResumeSeams {
  /**
   * Resolve a run's workspace ROOT from its record (undefined ⇒ unresolvable ⇒
   * not resumable). The pinned script lives at the workspace root; the checkpoint
   * blob lives under `<workspace>/results/`.
   */
  readonly workspaceFor: (record: DurableRunRecord) => string | undefined;
  /** Whether an absolute path exists on disk (the real `existsSync` in production). */
  readonly fileExists: (absPath: string) => boolean;
}

/**
 * The orchestrate-kind resume arm: VERIFY the pinned script + (when a
 * `checkpointRef` is set) the checkpoint blob are on disk. The refs are
 * WORKSPACE-RELATIVE (a `<runId>.<language>` at the root / a `results/…`
 * ResultRef), `safePath`-confined BEFORE any fs touch (a `..`/absolute escape is
 * refused, never resumed). PRESENT → `ok` (the closure re-anchors + the engine
 * surfaces `durable:resumed` — SURFACE-ONLY on boot; the byte re-execution is the
 * explicit `orchestrate({resumeRunId})`); MISSING → `err` (the engine's
 * existing orphan path turns it into a `durable:orphaned` + reclaim). Every `err`
 * message NAMES why AND contains "not resumable" so `orphanReasonToEnum` maps it
 * to the closed `not_resumable` member — the free text stays on the WARN
 * log and notify only. Pure over the injected seams.
 */
export function verifyOrchestrateResumable(
  record: DurableRunRecord,
  seams: OrchestrateResumeSeams,
): Result<void, Error> {
  const workspacePath = seams.workspaceFor(record);
  if (workspacePath === undefined) {
    return err(new Error("orchestrate resume not resumable: workspace unavailable"));
  }
  const scriptRef = record.scriptRef;
  if (scriptRef == null) {
    // The closure discriminator guarantees scriptRef != null before this is
    // called; a null here is a mis-routed non-orchestrate row — refuse honestly.
    return err(new Error("orchestrate resume not resumable: no pinned script"));
  }
  // 1. the pinned script (workspace ROOT, `<runId>.<language>`).
  let scriptAbs: string;
  try {
    scriptAbs = safePath(workspacePath, scriptRef);
  } catch {
    return err(new Error("orchestrate resume not resumable: pinned script path escaped the workspace"));
  }
  if (!seams.fileExists(scriptAbs)) {
    return err(new Error("orchestrate resume not resumable: the pinned script is gone"));
  }
  // 2. the checkpoint blob (`<workspace>/results/…`), when a `checkpointRef` is
  //    set. A null checkpointRef = a run that registered but never checkpointed —
  //    still resumable from the pinned bytes alone (a re-run from scratch).
  const checkpointRef = record.checkpointRef;
  if (checkpointRef != null) {
    let checkpointAbs: string;
    try {
      checkpointAbs = safePath(workspacePath, checkpointRef);
    } catch {
      return err(new Error("orchestrate resume not resumable: checkpoint path escaped the workspace"));
    }
    if (!seams.fileExists(checkpointAbs)) {
      return err(new Error("orchestrate resume not resumable: the checkpoint blob is gone"));
    }
  }
  return ok(undefined);
}

/**
 * The full orchestrate-resume wiring cluster `buildDurableResume` binds: the arm
 * seams ({@link OrchestrateResumeSeams}) PLUS the orphan-reclaim seams. ONE
 * optional cluster (not N loose fields — optional-field-bloat honesty): the arm
 * and orphan reclaim are wired together because both need the workspace resolver.
 * Structurally a superset of both the arm's {@link OrchestrateResumeSeams} and the
 * engine's `OrchestrateReclaimSeams`, so the SAME object passes to
 * `verifyOrchestrateResumable` (the arm) and `reclaimOrphanedOrchestrateRun` (the
 * reclaim) directly.
 */
export interface OrchestrateResumeWiring extends OrchestrateResumeSeams {
  /** Delete a dead run's `results/` dir — reuses result-ref-store.cleanupRun (rmSync recursive). */
  readonly cleanupResults: (workspacePath: string, runId: string) => Promise<void>;
  /** Delete the pinned `<scriptRef>` (guarded rmSync — a missing file is a no-op → idempotent). */
  readonly removePinnedScript: (workspacePath: string, scriptRef: string) => void;
}

/**
 * Build the production {@link OrchestrateResumeWiring} cluster for the composition
 * root — the live seams the boot sweep and orphan reclaim run
 * against. The durable record's persisted `agentId` is the authoritative
 * workspace key. A missing mapping returns undefined and the recovery path
 * honestly orphans the record; it never probes the default agent's files. The
 * reclaim REUSES the existing
 * `result-ref-store.cleanupRun` (rmSync-recursive of `results/`) for the checkpoint
 * blob + a `safePath`-guarded `rmSync` for the pinned `<runId>.<language>` script at
 * the workspace root. Reclamation is run-scoped and idempotent (a missing
 * file / a traversal-escape scriptRef is a no-op, never a throw that aborts the sweep).
 */
export function buildOrchestrateResumeWiring(deps: {
  /** Live per-agent jailed workspace roots, keyed by persisted agentId. */
  workspaceDirs: ReadonlyMap<string, string>;
  /** Logger for the reused result-ref store (its cleanupRun path). */
  logger: ComisLogger;
}): OrchestrateResumeWiring {
  // Reuse the SHIPPED result-ref store for cleanupRun (results/ wipe) — never a
  // hand-rolled results-dir resolver that could drift from the store's layout.
  const resultStore = createResultRefStore({ logger: deps.logger });
  return {
    workspaceFor: (record) => deps.workspaceDirs.get(record.agentId),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is safePath-confined by the caller (the boot-sweep arm resolves scriptRef/checkpointRef via safePath before probing).
    fileExists: (absPath) => existsSync(absPath),
    cleanupResults: (workspacePath, runId) => resultStore.cleanupRun({ workspacePath, runId }),
    removePinnedScript: (workspacePath, scriptRef) => {
      // safePath refuses a `..`/absolute escape BEFORE any unlink; rmSync force:true
      // makes a missing file a no-op (idempotent). A refused/failed path is a silent
      // no-op — the reclaim must never throw and abort the boot/watchdog sweep.
      try {
        const abs = safePath(workspacePath, scriptRef);
        rmSync(abs, { force: true });
      } catch {
        /* traversal-escape scriptRef (safePath threw) or an unlink failure — no-op. */
      }
    },
  };
}

/** The resolved `autonomy.durability` config the wiring reads. */
export interface DurableResumeConfig {
  /** Master gate — already folds in `autonomy.durability.enabled AND an autonomy agent`. */
  readonly enabled: boolean;
  /** The lapsed-heartbeat threshold (ms) — the watchdog interval period + the stale cutoff. */
  readonly staleHeartbeatMs: number;
  /** The wall-clock recovery budget (ms) for one boot/watchdog pass. */
  readonly recoveryBudgetMs: number;
}

/** The deps `setupDurableResume` closes over. */
export interface SetupDurableResumeDeps {
  /**
   * The durable-run + outward-send stores. The daemon builds these EARLY (before
   * the cap layer, so the jail-leg chokepoint can thread the durable store for the
   * _outwardStepIndex allocation) and passes them here. When omitted AND
   * `config.enabled`, they are constructed from `db` (the standalone/test path).
   */
  durableRunStore?: DurableRunPort;
  outwardLedger?: OutwardSendLedgerPort;
  /** Raw better-sqlite3 handle — used to construct the stores when they are not passed (typed unknown to avoid a cross-package type dep). */
  db: unknown;
  /** The resolved `autonomy.durability` posture (gate + thresholds). */
  config: DurableResumeConfig;
  /** Narrow content-free event emitter (adapts the real TypedEventBus). */
  eventBus: DurableEventEmitter;
  logger: ComisLogger;
  /** Re-mint a lease from the persisted attenuated caps VERBATIM (the LeaseManager closure). */
  remintLease: (input: MintLeaseInput) => IssuedLease;
  /** Revoke a newly minted lease when recovered execution is not accepted. */
  revokeLease?: (leaseId: string) => void;
  /** Resume a run from its checkpoint under the re-minted lease. */
  resumeRun: (record: DurableRunRecord, lease: IssuedLease) => Promise<Result<void, Error>>;
  /** Reclaim a dead resumable orchestrate run's artifacts on the orphan path. */
  reclaimOrchestrateRun?: (record: DurableRunRecord) => Promise<void>;
  /** Content-free operator notification for an orphan or parked outward operation. */
  notify: NotifyFn;
  clock: ClockPort;
  timers: TimerPort;
}

/** The handle `setupDurableResume` returns (mirrors DeliveryQueueResult). */
export interface DurableResumeResult {
  /** The durable-run checkpoint store (undefined when disabled). */
  durableRunStore: DurableRunPort | undefined;
  /** The outward-send uncertainty ledger (undefined when disabled). */
  outwardLedger: OutwardSendLedgerPort | undefined;
  /** Boot recovery (engine.resumeAll) THEN start the watchdog interval. Call AFTER setupChannels. */
  resumeAndStart: () => Promise<void>;
  /** Cancel the watchdog interval (call on shutdown — no leaked timer). */
  shutdown: () => void;
}

export function setupDurableResume(deps: SetupDurableResumeDeps): DurableResumeResult {
  const { db, config, eventBus, logger, remintLease, resumeRun, notify, clock, timers } = deps;

  // GATING: disabled (default, or no autonomy agent) ⇒ inert. No stores, no
  // engine, no timer — a default install is byte-identical (mirrors
  // setup-delivery.ts's inert-when-disabled return).
  if (!config.enabled) {
    logger.debug("Durable resume engine disabled (autonomy.durability.enabled=false or no autonomy agent)");
    return {
      durableRunStore: undefined,
      outwardLedger: undefined,
      resumeAndStart: async () => {},
      shutdown: () => {},
    };
  }

  // Use the daemon-supplied stores (built EARLY so the cap chokepoint shares the
  // SAME durable store — ONE store either way), else construct from db (the
  // standalone/test path). eslint-disable: db is better-sqlite3 Database; typed
  // unknown to avoid a cross-package type dep (mirrors setupDeliveryQueue).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const durableRunStore = deps.durableRunStore ?? createSqliteDurableRunStore(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outwardLedger = deps.outwardLedger ?? createSqliteOutwardSendLedger(db as any);

  const engine = createDurableResumeEngine({
    durableRuns: durableRunStore,
    ledger: outwardLedger,
    remintLease,
    ...(deps.revokeLease ? { revokeLease: deps.revokeLease } : {}),
    resumeRun,
    notify,
    nowMs: () => clock.now(),
    recoveryBudgetMs: config.recoveryBudgetMs,
    logger,
    eventBus,
    // The engine calls this on the orphan path to reclaim a dead
    // resumable orchestrate run's artifacts (scoped + idempotent). Absent ⇒ no reclaim.
    ...(deps.reclaimOrchestrateRun ? { reclaimOrchestrateRun: deps.reclaimOrchestrateRun } : {}),
  });

  // One daemon-wide watchdog interval, never one timer per run. Cancelled
  // on shutdown so there is no leaked timer across a restart.
  let watchdog: TimerHandle | undefined;
  let recoveryInFlight: ReturnType<DurableResumeEngine["resumeAll"]> | undefined;

  const runRecovery = (
    eligibleCheckpointIds?: readonly string[],
  ): ReturnType<DurableResumeEngine["resumeAll"]> => {
    if (recoveryInFlight !== undefined) return recoveryInFlight;
    const active = engine.resumeAll(
      eligibleCheckpointIds === undefined ? undefined : { eligibleCheckpointIds },
    );
    recoveryInFlight = active;
    const clear = (): void => {
      if (recoveryInFlight === active) recoveryInFlight = undefined;
    };
    void active.then(clear, clear);
    return active;
  };

  const resumeAndStart = async (): Promise<void> => {
    // 1. Boot recovery: reconcile crashed-mid-send rows + resume-or-orphan, bounded
    //    by recoveryBudgetMs (a backlog larger than the budget is deferred).
    const startMs = clock.now();
    const result = await runRecovery();
    if (result.ok) {
      logger.info(
        { resumed: result.value.resumed, orphaned: result.value.orphaned, deferred: result.value.deferred, durationMs: clock.now() - startMs },
        "Durable resume: boot recovery complete",
      );
    } else {
      logger.warn(
        { err: toSafeErrorLogString(result.error), hint: "boot recovery failed — the watchdog/next boot retries; no runs were resumed this pass", errorKind: "dependency" as const, durationMs: clock.now() - startMs },
        "Durable resume: boot recovery failed",
      );
    }

    // 2. Start the single daemon-wide watchdog. It fires at the stale
    //    threshold cadence, detects lapsed-heartbeat runs, and feeds the engine.
    //    .unref() so it never blocks event-loop exit (mirrors the delivery drain timer).
    watchdog = timers.setInterval(() => {
      void (async () => {
        const outward = await outwardLedger.listUnreconciled(1);
        if (!outward.ok) {
          logger.warn(
            {
              err: toSafeErrorLogString(outward.error),
              hint: "outward watchdog scan failed; the bounded recovery pass will fail closed",
              errorKind: "dependency" as const,
            },
            "Durable watchdog: outward scan failed",
          );
          return;
        }
        const runs = await durableRunStore.listResumable();
        if (!runs.ok) {
          logger.debug(
            { err: toSafeErrorLogString(runs.error), hint: "watchdog listResumable failed; the next tick retries", errorKind: "dependency" as const },
            "Durable watchdog: listResumable failed",
          );
          return;
        }
        const stale = detectStaleRuns(
          runs.value.records,
          clock.now(),
          config.staleHeartbeatMs,
        );
        if (outward.value.length > 0 || stale.length > 0 || runs.value.invalid.length > 0) {
          logger.info(
            {
              outwardPendingCount: outward.value.length,
              staleCount: stale.length,
              invalidCount: runs.value.invalid.length,
            },
            "Durable watchdog: recoverable checkpoints detected, sweeping",
          );
          await runRecovery([
            ...stale.map((record) => record.checkpointId),
            ...runs.value.invalid.map((record) => record.checkpointId),
          ]);
        }
      })();
    }, config.staleHeartbeatMs);
    watchdog.unref();
  };

  const shutdown = (): void => {
    // Clear the interval — no leaked timer (the fake-timers test asserts cancel).
    watchdog?.cancel();
    watchdog = undefined;
  };

  return { durableRunStore, outwardLedger, resumeAndStart, shutdown };
}

// ───────────────────────────────────────────────────────────────────────────
// Daemon composition helpers — extracted from daemon.ts to hold its
// 3000-line cap, co-located with the engine wiring. buildDurableStores resolves
// the gate + builds the stores EARLY (before the cap layer — the jail-leg
// chokepoint shares the SAME store for the _outwardStepIndex allocation);
// buildDurableResume builds the engine (after the cap layer — BoundedAutonomy
// reachable) + the boot/facts seams.
// ───────────────────────────────────────────────────────────────────────────

/** The resolved durability gate + thresholds + the (optional) early-built stores. */
export interface DurableStoresResult {
  /** The resolved posture: `enabled` folds (an autonomy agent present) AND (its durability.enabled). */
  durabilityCfg: { enabled: boolean; staleHeartbeatMs: number; keepAliveMs: number; recoveryBudgetMs: number };
  /** ONE durable-run store shared by the cap chokepoint, the wrap, the runner, the engine (undefined when off). */
  durableRunStore: DurableRunPort | undefined;
  /** ONE outward-send ledger (undefined when off). */
  outwardLedger: OutwardSendLedgerPort | undefined;
}

/**
 * Resolve the durability posture from the autonomy-bearing agent + build the
 * durable stores EARLY (gated). `enabled` is true only when an autonomy agent is
 * configured AND its `autonomy.durability.enabled` is set — a default install
 * builds no stores (byte-identical). Mirrors the cap-layer's autonomyBearingConfig
 * gate (setup-capability-endpoint-boot.ts).
 */
export function buildDurableStores(deps: {
  agents: Record<string, PerAgentConfig>;
  /** Raw better-sqlite3 handle (typed unknown to avoid a cross-package type dep). */
  db: unknown;
}): DurableStoresResult {
  const bearer = Object.values(deps.agents).find((a) => resolveAutonomy(a.autonomy).enabled);
  const parsed = DurabilityConfigSchema.parse(bearer?.autonomy?.durability ?? {});
  const durabilityCfg = { ...parsed, enabled: parsed.enabled && bearer !== undefined };
  let durableRunStore: DurableRunPort | undefined;
  let outwardLedger: OutwardSendLedgerPort | undefined;
  if (durabilityCfg.enabled) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is better-sqlite3 Database; typed unknown to avoid a cross-package type dep (mirrors setupDeliveryQueue).
    durableRunStore = createSqliteDurableRunStore(deps.db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same cross-package type-avoidance.
    outwardLedger = createSqliteOutwardSendLedger(deps.db as any);
  }
  return { durabilityCfg, durableRunStore, outwardLedger };
}

/** The durable-resume engine handle + the boot-after-channels seam + the runner facts resolver. */
export interface DurableResumeWiring {
  durableResume: DurableResumeResult;
  /** Bound to durableResume.resumeAndStart — invoked AFTER channels (boot-order). */
  startAndResumeDurable: () => Promise<void>;
  /** The runner's checkpoint facts resolver (leaseIds from BoundedAutonomy; undefined when off). */
  durableRunFacts?: (
    rootRunId: string,
    agentId: string,
  ) => {
    caps: readonly AgentCapability[];
    leaseIds: readonly string[];
    rootBudget: import("@comis/core").DurableRootBudget;
  } | undefined;
}

/**
 * Build the durable-resume engine (after the cap layer so BoundedAutonomy is
 * reachable) reusing the EARLY-built stores. Wires the LeaseManager re-mint, the
 * resume re-anchor (registerRoot), conservative outward parking, and operator
 * notification. Returns the handle, boot seam, and facts resolver.
 */
export function buildDurableResume(deps: {
  db: unknown;
  durabilityCfg: DurableStoresResult["durabilityCfg"];
  durableRunStore?: DurableRunPort | undefined;
  outwardLedger?: OutwardSendLedgerPort | undefined;
  boundedAutonomy: BoundedAutonomy | undefined;
  sharedLeaseManager: LeaseManager;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  clock: ClockPort;
  timers: TimerPort;
  /**
   * The graph coordinator's `resumeGraph(record)`
   * entry. The resume engine's `resumeRun` dispatch routes a DAG-shaped run
   * record (spawn_tree entries are OBJECTS with a `status` field — {@link isDagSpawnTree})
   * to this for node re-entry; a flat run (string[] spawn_tree) takes the flat re-anchor.
   * Late-bound: the daemon constructs the coordinator AFTER buildDurableResume, so it is
   * passed as a holder whose `.ref` is populated post-construction (read at resumeAndStart
   * time — after channels + after the coordinator exists). An absent handler
   * makes a DAG checkpoint non-resumable; it must never be reported as resumed
   * without node re-entry.
   */
  resumeGraph?: (record: DurableRunRecord, lease: IssuedLease) => Promise<Result<void, Error>>;
  resumePlain?: (record: DurableRunRecord, lease: IssuedLease) => Promise<Result<void, Error>>;
  resolveWorkspacePolicy?: (policyHash: string) => Result<void, Error>;
  /**
   * The orchestrate-kind resume + orphan-reclaim seams (workspace resolver +
   * fs-exists probe + cleanupRun/rmSync reclaim). When present: a flat row with
   * `scriptRef != null` routes to the orchestrate arm — VERIFY the pinned script +
   * checkpoint on disk (surface-only on boot; explicit `orchestrate({resumeRunId})`
   * re-executes) — and a dead resumable run's artifacts are reclaimed on the
   * orphan path. Absent means a scriptRef row degrades to the plain flat
   * re-anchor (no disk verification, no reclaim) — the gated, deny-by-absence
   * posture: the runner only writes scriptRef rows when `orchestrateResume` is on.
   */
  orchestrateResume?: OrchestrateResumeWiring;
}): DurableResumeWiring {
  const { durabilityCfg, durableRunStore, outwardLedger, boundedAutonomy, sharedLeaseManager, eventBus, logger, clock, timers, resumeGraph, resumePlain, resolveWorkspacePolicy, orchestrateResume } = deps;
  // Bind the engine's orphan-reclaim hook to the wiring's
  // reclaim seams (workspace + cleanupRun + guarded rmSync). The bound helper is
  // scoped (a non-orchestrate row is a no-op) + idempotent. Absent ⇒ no reclaim.
  const reclaimOrchestrateRun = orchestrateResume
    ? (record: DurableRunRecord): Promise<void> => reclaimOrphanedOrchestrateRun(record, orchestrateResume)
    : undefined;
  const durableResume: DurableResumeResult = setupDurableResume({
    db: deps.db,
    ...(durableRunStore ? { durableRunStore } : {}),
    ...(outwardLedger ? { outwardLedger } : {}),
    config: { enabled: durabilityCfg.enabled, staleHeartbeatMs: durabilityCfg.staleHeartbeatMs, recoveryBudgetMs: durabilityCfg.recoveryBudgetMs },
    // The engine uses isolated observational fan-out so subscriber failures
    // cannot alter recovery after a durable authority transition.
    eventBus,
    logger,
    // remintLease: re-mint from the persisted attenuated caps VERBATIM.
    remintLease: (input) => sharedLeaseManager.mintLease(input),
    revokeLease: (leaseId) => {
      sharedLeaseManager.revoke(leaseId);
    },
    // resumeRun: re-anchor the root with BoundedAutonomy so the re-minted lease is
    // bounded (budget/kill reach). The checkpoint carries caps/tree/budget, not a
    // full re-spawnable task spec, so a run resumes-as-anchored (a richer re-spawn
    // from the checkpoint is a future enhancement).
    resumeRun: async (record: DurableRunRecord, lease: IssuedLease): Promise<Result<void, Error>> => {
      boundedAutonomy?.rehydrateBudget(record.rootRunId, record.rootBudget);
      // DAG-vs-flat-vs-orchestrate dispatch — all explicit discriminators, never a
      // heuristic, so a flat run can NEVER mis-route:
      //   - a DAG record (spawn_tree entries are OBJECTS with a `status` field →
      //     isDagSpawnTree) routes to the graph coordinator's resumeGraph for node
      //     re-entry;
      //   - a flat RE-RUNNABLE orchestrate row (string[] spawn_tree AND a pinned
      //     `scriptRef`, with the orchestrateResume seams wired) takes the
      //     orchestrate arm — VERIFY the pinned script + checkpoint are on disk
      //     (SURFACE-ONLY on boot; the byte re-execution is the explicit
      //     `orchestrate({resumeRunId})`). A missing artifact returns err so the
      //     engine's orphan path emits `durable:orphaned` + reclaims (no silent loss);
      //   - a plain flat sub-agent run (no scriptRef, or the seams unwired) takes the
      //     flat re-anchor below.
      const attempt = async (): Promise<Result<void, Error>> => {
        if (isDagSpawnTree(record.spawnTree)) {
          if (resumeGraph) return resumeGraph(record, lease);
          return err(new Error("DAG checkpoint cannot resume because graph recovery is unavailable"));
        }
        if (record.scriptRef != null && orchestrateResume) {
          // Orchestrate-kind arm: verify the pinned script + checkpoint on disk. On a
          // MISSING artifact the engine's existing orphan path turns this err into a
          // durable:orphaned (closed-enum) + reclaim — do NOT emit orphaned here.
          const verified = verifyOrchestrateResumable(record, orchestrateResume);
          if (!verified.ok) return verified;
          try {
            boundedAutonomy?.registerRoot(record.rootRunId, lease.leaseId);
            return ok(undefined);
          } catch (cause) {
            return err(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }
        if (
          record.resumeDescriptorHash === undefined
          || record.workspacePolicyHash === undefined
          || resumePlain === undefined
          || resolveWorkspacePolicy === undefined
        ) {
          return err(new Error("Plain sub-agent checkpoint lacks protected restart authority"));
        }
        const policy = resolveWorkspacePolicy(record.workspacePolicyHash);
        if (!policy.ok) return policy;
        try {
          boundedAutonomy?.registerRoot(record.rootRunId, lease.leaseId);
        } catch (cause) {
          return err(cause instanceof Error ? cause : new Error(String(cause)));
        }
        const resumed = await resumePlain(record, lease);
        if (!resumed.ok) {
          boundedAutonomy?.evictRootIfIdle(record.rootRunId);
        }
        return resumed;
      };
      const internalIdentity = resolveInternalTurnIdentity({
        tenantId: record.tenantId,
        agentId: record.agentId,
        originKind: "durable-resume",
        instanceId: "daemon",
        conversationId: record.checkpointId,
        principalId: `durable-resume-${record.checkpointId}`,
      });
      if (!internalIdentity.ok) return err(internalIdentity.error);
      const resumeContext = createResolvedRequestContext({
        tenantId: record.tenantId,
        userId: internalIdentity.value.turnScope.principal.principalId,
        sessionKey: internalIdentity.value.displaySessionKey,
        agentId: record.agentId,
        traceId: randomUUID(),
        startedAt: clock.now(),
        trustLevel: record.trustLevel,
        channelType: internalIdentity.value.turnScope.endpoint.channelType,
        deliveryOrigin: createDeliveryOrigin({
          tenantId: record.tenantId,
          userId: internalIdentity.value.turnScope.principal.principalId,
          channelType: internalIdentity.value.turnScope.endpoint.channelType,
          channelId: internalIdentity.value.turnScope.endpoint.conversationId,
        }),
        turnScope: internalIdentity.value.turnScope,
      });
      if (!resumeContext.ok) return resumeContext;
      const outcome = await runWithContext(resumeContext.value, attempt);
      if (!outcome.ok) boundedAutonomy?.evictRootIfIdle(record.rootRunId);
      return outcome;
    },
    // reclaimOrchestrateRun: the engine calls this on the orphan path to reclaim a
    // dead resumable orchestrate run's results/ and pinned script. Absent
    // ⇒ no reclaim (the seams unwired / orchestrateResume off).
    ...(reclaimOrchestrateRun ? { reclaimOrchestrateRun } : {}),
    // notify: content-free operator escalation. The engine also emits durable:orphaned.
    notify: (opts) => logger.warn(
      { kind: opts.kind, rootRunId: opts.rootRunId, hint: opts.hint, errorKind: "internal" as const },
      "Durable resume operator notification",
    ),
    clock,
    timers,
  });
  const startAndResumeDurable = (): Promise<void> => durableResume.resumeAndStart();
  // durableRunFacts: checkpoint the correlated leases and the meter's absolute
  // tree-wide state so every heartbeat preserves restart continuity.
  const durableRunFacts = durableResume.durableRunStore
    ? (rootRunId: string, _agentId: string) => ({
        caps: [] as readonly AgentCapability[],
        leaseIds: boundedAutonomy ? [...boundedAutonomy.leaseIdsForRoot(rootRunId)] : [],
        rootBudget: boundedAutonomy?.exportBudgetState(rootRunId) ?? {
          startedAtMs: clock.now(),
          tokensConsumed: 0,
          usdConsumed: 0,
        },
      })
    : undefined;
  return { durableResume, startAndResumeDurable, ...(durableRunFacts ? { durableRunFacts } : {}) };
}
