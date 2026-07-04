// SPDX-License-Identifier: Apache-2.0
/**
 * Durable resume subsystem wiring (the composition root for the
 * durability engine). Mirrors `setup-delivery.ts`'s two-phase STRUCTURE:
 *
 *   1. `setupDurableResume()` constructs the two SQLite stores (against the SHARED
 *      `memory.db`) + the resume engine immediately, and returns them alongside a
 *      deferred `resumeAndStart()` + a `shutdown()`.
 *   2. `resumeAndStart()` is called AFTER `setupChannels` populates the channel
 *      adapters (the boot-order constraint — the engine's reconcile + replay need
 *      LIVE adapters), exactly like the delivery queue's `drainAndStart()`. It
 *      runs the bounded boot recovery (`engine.resumeAll()`) THEN starts a single
 *      daemon-wide watchdog interval that sweeps lapsed heartbeats.
 *   3. `shutdown()` cancels the watchdog interval — no leaked timer.
 *
 * GATING: when `config.enabled` is false (the default, OR no autonomy-bearing
 * agent is configured — the daemon folds both into `enabled`), the function
 * returns inert stubs (no stores constructed, `resumeAndStart`/`shutdown` no-ops,
 * NO watchdog timer) so a default install is byte-identical — mirroring
 * `setup-delivery.ts`'s inert-when-disabled return.
 *
 * The engine itself is PURE / I/O-free; this wiring binds it to the
 * real stores + the injected LeaseManager re-mint / run-resume / send-replay /
 * channel-adapter / notify closures. The watchdog uses
 * the INJECTED TimerPort (never the interval-scheduler global — the
 * globals.test.ts arch-gate).
 *
 * @module
 */

import type { ChannelPort, ClockPort, TimerPort, TimerHandle, DurableRunPort, OutwardSendLedgerPort, OutwardSendRecord, DurableRunRecord, PerAgentConfig, AgentCapability, DeliveryAdapter, TypedEventBus } from "@comis/core";
import { resolveAutonomy, DurabilityConfigSchema, safePath } from "@comis/core";
import { createSqliteDurableRunStore, createSqliteOutwardSendLedger } from "@comis/memory";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import { ok, err, type Result } from "@comis/shared";
import {
  createDurableResumeEngine,
  type MintLeaseInput,
  type IssuedLease,
  type NotifyFn,
  type DurableEventEmitter,
} from "../autonomy/durable-resume-engine.js";
import { detectStaleRuns } from "../autonomy/durable-watchdog.js";
import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";
import { isDagSpawnTree } from "../graph/graph-durable-checkpoint.js";

// ───────────────────────────────────────────────────────────────────────────
// The orchestrate-kind resume arm (233). A durable row with a FLAT spawnTree
// AND a pinned `scriptRef` is a RE-RUNNABLE orchestrate row (the runner writes
// it). On boot the sweep dispatches it to THIS arm (never resumeGraph) to VERIFY
// its pinned script + checkpoint survived the crash — surface-only; the byte
// re-execution is the explicit `orchestrate({resumeRunId})` (A2).
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
 * explicit `orchestrate({resumeRunId})`, A2); MISSING → `err` (the engine's
 * existing orphan path turns it into a `durable:orphaned` + reclaim). Every `err`
 * message NAMES why AND contains "not resumable" so `orphanReasonToEnum` maps it
 * to the closed `not_resumable` member — the free text stays on the WARN
 * log / notify only (INV-5). Pure over the injected seams.
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
  /** Resolve a LIVE channel adapter by channel type (undefined when none) — populated post-setupChannels. */
  channelAdapters: (type: string) => ChannelPort | undefined;
  /** Re-mint a lease from the persisted attenuated caps VERBATIM (the LeaseManager closure). */
  remintLease: (input: MintLeaseInput) => IssuedLease;
  /** Resume a run from its checkpoint under the re-minted lease. */
  resumeRun: (record: DurableRunRecord, leaseId: string) => Promise<Result<void, Error>>;
  /** Re-deliver a not_sent ledger row exactly once. */
  replaySend: (row: OutwardSendRecord) => Promise<Result<{ platformMessageId: string }, Error>>;
  /** Content-free operator notification for an orphan / unresolved reconcile. */
  notify: NotifyFn;
  clock: ClockPort;
  timers: TimerPort;
}

/** The handle `setupDurableResume` returns (mirrors DeliveryQueueResult). */
export interface DurableResumeResult {
  /** The durable-run checkpoint store (undefined when disabled). */
  durableRunStore: DurableRunPort | undefined;
  /** The outward-send exactly-once ledger (undefined when disabled). */
  outwardLedger: OutwardSendLedgerPort | undefined;
  /** Boot recovery (engine.resumeAll) THEN start the watchdog interval. Call AFTER setupChannels. */
  resumeAndStart: () => Promise<void>;
  /** Cancel the watchdog interval (call on shutdown — no leaked timer). */
  shutdown: () => void;
}

export function setupDurableResume(deps: SetupDurableResumeDeps): DurableResumeResult {
  const { db, config, eventBus, logger, channelAdapters, remintLease, resumeRun, replaySend, notify, clock, timers } = deps;

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
    channelFor: channelAdapters,
    remintLease,
    resumeRun,
    replaySend,
    notify,
    nowMs: () => clock.now(),
    recoveryBudgetMs: config.recoveryBudgetMs,
    logger,
    eventBus,
  });

  // ONE daemon-wide watchdog interval (Open Question 2 — NOT per-run). Cancelled
  // on shutdown so there is no leaked timer across a restart.
  let watchdog: TimerHandle | undefined;

  const resumeAndStart = async (): Promise<void> => {
    // 1. Boot recovery: reconcile crashed-mid-send rows + resume-or-orphan, bounded
    //    by recoveryBudgetMs (a backlog larger than the budget is deferred).
    const startMs = clock.now();
    const result = await engine.resumeAll();
    if (result.ok) {
      logger.info(
        { resumed: result.value.resumed, orphaned: result.value.orphaned, deferred: result.value.deferred, durationMs: clock.now() - startMs },
        "Durable resume: boot recovery complete",
      );
    } else {
      logger.warn(
        { err: result.error, hint: "boot recovery failed — the watchdog/next boot retries; no runs were resumed this pass", errorKind: "dependency" as const, durationMs: clock.now() - startMs },
        "Durable resume: boot recovery failed",
      );
    }

    // 2. Start the single daemon-wide watchdog. It fires at the stale
    //    threshold cadence, detects lapsed-heartbeat runs, and feeds the engine.
    //    .unref() so it never blocks event-loop exit (mirrors the delivery drain timer).
    watchdog = timers.setInterval(() => {
      void (async () => {
        const runs = await durableRunStore.listResumable();
        if (!runs.ok) {
          logger.debug(
            { err: runs.error, hint: "watchdog listResumable failed; the next tick retries", errorKind: "dependency" as const },
            "Durable watchdog: listResumable failed",
          );
          return;
        }
        const stale = detectStaleRuns(runs.value, clock.now(), config.staleHeartbeatMs);
        if (stale.length > 0) {
          logger.info({ staleCount: stale.length }, "Durable watchdog: lapsed-heartbeat runs detected, sweeping");
          await engine.resumeAll();
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
  ) => { caps: readonly AgentCapability[]; leaseIds: readonly string[]; budgetConsumed: number } | undefined;
}

/**
 * Build the durable-resume engine (after the cap layer so BoundedAutonomy is
 * reachable) reusing the EARLY-built stores. Wires the LeaseManager re-mint, the
 * resume re-anchor (registerRoot), the content-free replay-park, the operator
 * notify, and the late-bound channel-adapter lookup (resolved at resumeAndStart
 * time — after channels). Returns the handle + the boot seam + the facts resolver.
 */
export function buildDurableResume(deps: {
  db: unknown;
  durabilityCfg: DurableStoresResult["durabilityCfg"];
  durableRunStore?: DurableRunPort | undefined;
  outwardLedger?: OutwardSendLedgerPort | undefined;
  boundedAutonomy: BoundedAutonomy | undefined;
  sharedLeaseManager: LeaseManager;
  channelAdaptersRef: Map<string, DeliveryAdapter> | undefined;
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
   * time — after channels + after the coordinator exists). Absent ⇒ a DAG record degrades
   * to the flat re-anchor (no crash; node re-entry is simply unavailable).
   */
  resumeGraph?: (record: DurableRunRecord) => Promise<Result<void, Error>>;
  /**
   * The orchestrate-kind resume seams (workspace resolver + fs-exists probe). When
   * present, a flat row with `scriptRef != null` routes to the orchestrate arm —
   * VERIFY the pinned script + checkpoint on disk (surface-only on boot; explicit
   * `orchestrate({resumeRunId})` re-executes — A2). Absent ⇒ a scriptRef row degrades
   * to the plain flat re-anchor (no disk verification) — the gated, deny-by-absence
   * posture: the runner only writes scriptRef rows when `orchestrateResume` is on.
   */
  orchestrateResume?: OrchestrateResumeSeams;
}): DurableResumeWiring {
  const { durabilityCfg, durableRunStore, outwardLedger, boundedAutonomy, sharedLeaseManager, channelAdaptersRef, eventBus, logger, clock, timers, resumeGraph, orchestrateResume } = deps;
  const durableResume: DurableResumeResult = setupDurableResume({
    db: deps.db,
    ...(durableRunStore ? { durableRunStore } : {}),
    ...(outwardLedger ? { outwardLedger } : {}),
    config: { enabled: durabilityCfg.enabled, staleHeartbeatMs: durabilityCfg.staleHeartbeatMs, recoveryBudgetMs: durabilityCfg.recoveryBudgetMs },
    // Narrow content-free emitter over the real TypedEventBus (the closed EventMap
    // does not type durable:* events; the engine emits through this adapter).
    eventBus: { emit: (event, payload) => eventBus.emit(event as never, payload as never) },
    logger,
    // channelFor reads the LIVE registry (populated by reference post-setupChannels).
    channelAdapters: (type: string) => channelAdaptersRef?.get(type) as ChannelPort | undefined,
    // remintLease: re-mint from the persisted attenuated caps VERBATIM.
    remintLease: (input) => sharedLeaseManager.mintLease(input),
    // resumeRun: re-anchor the root with BoundedAutonomy so the re-minted lease is
    // bounded (budget/kill reach). The checkpoint carries caps/tree/budget, not a
    // full re-spawnable task spec, so a run resumes-as-anchored (a richer re-spawn
    // from the checkpoint is a future enhancement).
    resumeRun: async (record: DurableRunRecord, leaseId: string): Promise<Result<void, Error>> => {
      // DAG-vs-flat-vs-orchestrate dispatch — all explicit discriminators, never a
      // heuristic, so a flat run can NEVER mis-route:
      //   - a DAG record (spawn_tree entries are OBJECTS with a `status` field →
      //     isDagSpawnTree) routes to the graph coordinator's resumeGraph for node
      //     re-entry;
      //   - a flat RE-RUNNABLE orchestrate row (string[] spawn_tree AND a pinned
      //     `scriptRef`, with the orchestrateResume seams wired) takes the
      //     orchestrate arm — VERIFY the pinned script + checkpoint are on disk
      //     (SURFACE-ONLY on boot; the byte re-execution is the explicit
      //     `orchestrate({resumeRunId})` — A2). A MISSING artifact returns err so the
      //     engine's orphan path emits `durable:orphaned` + reclaims (no silent loss);
      //   - a plain flat sub-agent run (no scriptRef, or the seams unwired) takes the
      //     flat re-anchor below.
      if (isDagSpawnTree(record.spawnTree)) {
        if (resumeGraph) return resumeGraph(record);
        // resumeGraph not wired (e.g. coordinator absent) ⇒ degrade to the flat
        // re-anchor so the run is still bounded/killable across restart (no crash).
        logger.warn(
          { rootRunId: record.rootRunId, hint: "DAG record but resumeGraph is unwired; falling back to the flat re-anchor (no node re-entry)", errorKind: "internal" as const },
          "Durable resume: DAG resume unavailable",
        );
      } else if (record.scriptRef != null && orchestrateResume) {
        // Orchestrate-kind arm: verify the pinned script + checkpoint on disk. On a
        // MISSING artifact the engine's existing orphan path turns this err into a
        // durable:orphaned (closed-enum) + reclaim — do NOT emit orphaned here.
        const verified = verifyOrchestrateResumable(record, orchestrateResume);
        if (!verified.ok) return verified;
        // PRESENT → fall through to the re-anchor (surface-only; no re-spawn on boot).
      }
      try {
        boundedAutonomy?.registerRoot(record.rootRunId, leaseId);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },
    // replaySend: the content-free ledger row has no body, so a replay that lacks
    // the original message is an err — the engine parks it unresolved rather than
    // double-sending a wrong body (honesty over a fabricated replay).
    replaySend: async (_row: OutwardSendRecord) =>
      err(new Error("durable replay requires the original message body, which the content-free ledger does not retain; parked unresolved")),
    // notify: content-free operator escalation. The engine also emits durable:orphaned.
    notify: (opts) => logger.warn({ kind: opts.kind, rootRunId: opts.rootRunId, hint: opts.hint, errorKind: "internal" as const }, `Durable resume: ${opts.reason}`),
    clock,
    timers,
  });
  const startAndResumeDurable = (): Promise<void> => durableResume.resumeAndStart();
  // durableRunFacts: the runner's checkpoint reads the correlated leaseIds
  // from BoundedAutonomy (caps come from the spawn param; budgetConsumed is
  // informational — the meter exposes remaining, not consumed, so 0 here).
  const durableRunFacts = durableResume.durableRunStore
    ? (rootRunId: string, _agentId: string) => ({
        caps: [] as readonly AgentCapability[],
        leaseIds: boundedAutonomy ? [...boundedAutonomy.leaseIdsForRoot(rootRunId)] : [],
        budgetConsumed: 0,
      })
    : undefined;
  return { durableResume, startAndResumeDurable, ...(durableRunFacts ? { durableRunFacts } : {}) };
}
