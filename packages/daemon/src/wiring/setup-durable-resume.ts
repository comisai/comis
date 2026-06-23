// SPDX-License-Identifier: Apache-2.0
/**
 * Durable resume subsystem wiring (Phase 216 — the composition root for the
 * durability engine). Mirrors `setup-delivery.ts`'s two-phase STRUCTURE:
 *
 *   1. `setupDurableResume()` constructs the two SQLite stores (against the SHARED
 *      `memory.db`) + the resume engine immediately, and returns them alongside a
 *      deferred `resumeAndStart()` + a `shutdown()`.
 *   2. `resumeAndStart()` is called AFTER `setupChannels` populates the channel
 *      adapters (the boot-order constraint — the engine's reconcile + replay need
 *      LIVE adapters), exactly like the delivery queue's `drainAndStart()`. It
 *      runs the bounded boot recovery (`engine.resumeAll()`) THEN starts a single
 *      daemon-wide watchdog interval (HB-01) that sweeps lapsed heartbeats.
 *   3. `shutdown()` cancels the watchdog interval — no leaked timer.
 *
 * GATING: when `config.enabled` is false (the default, OR no autonomy-bearing
 * agent is configured — the daemon folds both into `enabled`), the function
 * returns inert stubs (no stores constructed, `resumeAndStart`/`shutdown` no-ops,
 * NO watchdog timer) so a default install is byte-identical — mirroring
 * `setup-delivery.ts`'s inert-when-disabled return.
 *
 * The engine itself is PURE / I/O-free (Plan 04); this wiring binds it to the
 * real stores + the injected LeaseManager re-mint / run-resume / send-replay /
 * channel-adapter / notify closures (Task 3 supplies those). The watchdog uses
 * the INJECTED TimerPort (never the interval-scheduler global — the
 * globals.test.ts arch-gate).
 *
 * @module
 */

import type { ChannelPort, ClockPort, TimerPort, TimerHandle, DurableRunPort, OutwardSendLedgerPort, OutwardSendRecord, DurableRunRecord } from "@comis/core";
import { createSqliteDurableRunStore, createSqliteOutwardSendLedger } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import {
  createDurableResumeEngine,
  type MintLeaseInput,
  type IssuedLease,
  type NotifyFn,
  type DurableEventEmitter,
} from "../autonomy/durable-resume-engine.js";
import { detectStaleRuns } from "../autonomy/durable-watchdog.js";

/** The resolved `autonomy.durability` config the wiring reads (Plan 07-Task-1 schema). */
export interface DurableResumeConfig {
  /** Master gate — already folds in `autonomy.durability.enabled AND an autonomy agent`. */
  readonly enabled: boolean;
  /** The lapsed-heartbeat threshold (ms) — the watchdog interval period + the stale cutoff. */
  readonly staleHeartbeatMs: number;
  /** The wall-clock recovery budget (ms) for one boot/watchdog pass (HB-02). */
  readonly recoveryBudgetMs: number;
}

/** The deps `setupDurableResume` closes over (Task 3 binds the real closures). */
export interface SetupDurableResumeDeps {
  /** Raw better-sqlite3 handle (typed unknown to avoid a cross-package type dep — mirrors setupDeliveryQueue). */
  db: unknown;
  /** The resolved `autonomy.durability` posture (gate + thresholds). */
  config: DurableResumeConfig;
  /** Narrow content-free event emitter (Task 3 adapts the real TypedEventBus). */
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
  /** Content-free operator notification for an orphan / unresolved reconcile (HB-03). */
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is better-sqlite3 Database; typed unknown to avoid a cross-package type dependency (mirrors setupDeliveryQueue).
  const durableRunStore = createSqliteDurableRunStore(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same cross-package type-avoidance as above.
  const outwardLedger = createSqliteOutwardSendLedger(db as any);

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
    //    by recoveryBudgetMs (HB-02 — a backlog larger than the budget is deferred).
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

    // 2. Start the single daemon-wide watchdog (HB-01). It fires at the stale
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
