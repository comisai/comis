// SPDX-License-Identifier: Apache-2.0
/**
 * Session Reset Policy: Sweep-based scheduler for automatic session expiry.
 *
 * Runs periodic sweeps over all active sessions and resets them based on
 * configurable policies: daily (at a specific hour), idle (after inactivity),
 * or hybrid (whichever condition expires first).
 *
 * Per-session-type overrides (dm/group/thread) allow different reset behavior
 * for different conversation contexts. Sub-agent sessions are excluded from
 * sweep to avoid disrupting in-progress sub-agent tasks.
 *
 * The `getConfig` callback is invoked on each sweep (not captured at creation
 * time) to support runtime configuration changes.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import type { TypedEventBus } from "@comis/core";
import type { SessionResetPolicyConfig, ResetPolicyOverride } from "@comis/core";
import type { SessionStorePort, SessionDetailedEntry, SessionQueryScope } from "@comis/core";
import type { ComputeDailyResetNextRun } from "@comis/core";
import type { TimerPort, TimerHandle } from "@comis/core";
import type { SessionLifecycle } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session kind derived from session key metadata. */
export type SessionKind = "dm" | "group" | "thread";

/**
 * Resolved policy for a specific session after merging per-type overrides.
 * Contains only the fields needed for reset evaluation (no sweep/trigger config).
 */
export interface EffectiveResetPolicy {
  mode: "daily" | "idle" | "hybrid" | "none";
  dailyResetHour: number;
  dailyResetTimezone: string;
  idleTimeoutMs: number;
}

/**
 * Dependencies for createSessionResetScheduler.
 *
 * `getConfig` is a callback -- NOT a captured config object -- so the sweep
 * always reads the latest config at call time.
 */
export interface SessionResetSchedulerDeps {
  sessionStore: SessionStorePort;
  sessionManager: SessionLifecycle;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  /** Callback to read current config (reads current config on each call). */
  getConfig: () => SessionResetPolicyConfig | undefined;
  /**
   * Daily-reset cron computation, injected by daemon composition. The canonical
   * implementation in `@comis/scheduler` (`computeNextRunAtMs` over a
   * `0 H * * *` cron schedule) is wired in `setup-schedulers.ts`. Injected as
   * a dep so agent does not import `@comis/scheduler` directly.
   */
  computeDailyResetNextRun: ComputeDailyResetNextRun;
  /** Wall-clock reads for sweep timing decisions. Caller wires from ClockPort. */
  nowMs: () => number;
  /** Timer scheduling. Sweep-interval uses .unref() so it does not block shutdown. */
  timers: TimerPort;
  /** Explicit tenant-agent authorities swept by this scheduler. */
  listQueryScopes: () => readonly SessionQueryScope[];
}

/** Session reset scheduler interface. */
export interface SessionResetScheduler {
  /** Start the periodic sweep timer. Runs an immediate sweep on start. */
  start(): void;
  /** Stop the periodic sweep timer. */
  stop(): void;
  /** Execute a single sweep (useful for testing or manual trigger). */
  sweep(): void;
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Classify a session from its validated conversation partition.
 */
export function classifySession(session: SessionDetailedEntry): SessionKind {
  const partition = session.conversationScope.partition;
  if (partition.kind === "endpoint-conversation" || partition.kind === "endpoint-conversation-principal") {
    if (partition.endpoint.threadId !== undefined) return "thread";
    if (partition.endpoint.conversationKind === "shared") return "group";
  }
  return "dm";
}

/**
 * Resolve the effective reset policy for a session kind by merging
 * any per-type override with the default policy.
 *
 * Override fields that are defined replace parent fields; undefined
 * fields inherit from the default policy.
 */
export function resolvePolicy(
  config: SessionResetPolicyConfig,
  kind: SessionKind,
): EffectiveResetPolicy {
  const override: ResetPolicyOverride | undefined = config.perType?.[kind];
  if (override) {
    return {
      mode: override.mode ?? config.mode,
      dailyResetHour: override.dailyResetHour ?? config.dailyResetHour,
      dailyResetTimezone: override.dailyResetTimezone ?? config.dailyResetTimezone,
      idleTimeoutMs: override.idleTimeoutMs ?? config.idleTimeoutMs,
    };
  }
  return {
    mode: config.mode,
    dailyResetHour: config.dailyResetHour,
    dailyResetTimezone: config.dailyResetTimezone,
    idleTimeoutMs: config.idleTimeoutMs,
  };
}

/**
 * Check whether a daily reset is due for a session.
 *
 * Delegates the cron-shape "next 0 H * * * (in tz) at or after updatedAt"
 * calculation to the injected `computeDailyResetNextRun` callback (canonical
 * implementation: `computeNextRunAtMs` from `@comis/scheduler`). If the next
 * occurrence after updatedAt is `<= nowMs`, the session should be reset.
 *
 * Injected as a deps callback so agent does not reach into scheduler at the
 * import boundary.
 */
export function isDailyResetDue(
  updatedAt: number,
  hour: number,
  timezone: string,
  nowMs: number,
  computeDailyResetNextRun: ComputeDailyResetNextRun,
): boolean {
  const nextRun = computeDailyResetNextRun(updatedAt, hour, timezone);
  if (nextRun === undefined) return false;
  return nextRun <= nowMs;
}

/**
 * Check whether an idle reset is due for a session.
 *
 * Returns true if the session has been idle for at least idleTimeoutMs.
 */
export function isIdleResetDue(
  updatedAt: number,
  idleTimeoutMs: number,
  nowMs: number,
): boolean {
  return updatedAt + idleTimeoutMs <= nowMs;
}

/**
 * Check whether a session should be reset based on the effective policy.
 *
 * Returns { reset, reason } where reason describes what triggered the reset.
 * For hybrid mode, the first matching condition determines the reason.
 *
 * `computeDailyResetNextRun` is forwarded into `isDailyResetDue`; the daily
 * + hybrid branches consult it, the idle branch ignores it. Tests inject a
 * deterministic stub; daemon composition wires the scheduler-backed callback.
 */
export function checkReset(
  policy: EffectiveResetPolicy,
  session: SessionDetailedEntry,
  nowMs: number,
  computeDailyResetNextRun: ComputeDailyResetNextRun,
): { reset: boolean; reason: string } {
  switch (policy.mode) {
    case "none":
      return { reset: false, reason: "disabled" };

    case "daily": {
      const due = isDailyResetDue(
        session.updatedAt,
        policy.dailyResetHour,
        policy.dailyResetTimezone,
        nowMs,
        computeDailyResetNextRun,
      );
      return { reset: due, reason: due ? "daily" : "not-due" };
    }

    case "idle": {
      const due = isIdleResetDue(session.updatedAt, policy.idleTimeoutMs, nowMs);
      return { reset: due, reason: due ? "idle" : "not-due" };
    }

    case "hybrid": {
      const dailyDue = isDailyResetDue(
        session.updatedAt,
        policy.dailyResetHour,
        policy.dailyResetTimezone,
        nowMs,
        computeDailyResetNextRun,
      );
      const idleDue = isIdleResetDue(session.updatedAt, policy.idleTimeoutMs, nowMs);

      if (dailyDue && idleDue) {
        return { reset: true, reason: "daily+idle" };
      }
      if (dailyDue) {
        return { reset: true, reason: "daily" };
      }
      if (idleDue) {
        return { reset: true, reason: "idle" };
      }
      return { reset: false, reason: "not-due" };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SessionResetScheduler that periodically sweeps active sessions
 * and resets them based on the current reset policy configuration.
 *
 * The sweep:
 * 1. Reads config via getConfig() (reads current config on each call).
 * 2. Lists all sessions via sessionStore.listDetailed().
 * 3. Skips sub-agent sessions (metadata.parentSessionKey).
 * 4. Classifies each session (dm/group/thread).
 * 5. Resolves the effective policy (with per-type overrides).
 * 6. Checks reset conditions (daily/idle/hybrid).
 * 7. Expires qualifying sessions and emits "session:expired".
 */
export function createSessionResetScheduler(
  deps: SessionResetSchedulerDeps,
): SessionResetScheduler {
  const getNow = deps.nowMs;
  let timer: TimerHandle | null = null;

  function sweep(): void {
    const config = deps.getConfig();
    if (!config || config.mode === "none") {
      deps.logger.debug("Session reset sweep skipped: policy disabled or absent");
      return;
    }

    const sessions: SessionDetailedEntry[] = [];
    for (const queryScope of deps.listQueryScopes()) {
      const listed = deps.sessionStore.listDetailed(queryScope);
      if (!listed.ok) {
        deps.logger.warn(
          {
            tenantId: queryScope.tenantId,
            agentId: queryScope.agentId,
            hint: "Inspect session database integrity and restore storage availability before the next reset sweep.",
            errorKind: listed.error.errorKind,
          },
          "Session reset scope could not be listed",
        );
        continue;
      }
      sessions.push(...listed.value);
    }
    let resetCount = 0;

    for (const session of sessions) {
      // Skip sub-agent sessions (they have their own lifecycle)
      if (session.metadata.parentSessionKey) continue;

      const kind = classifySession(session);
      const policy = resolvePolicy(config, kind);

      if (policy.mode === "none") continue;

      const now = getNow();
      const result = checkReset(policy, session, now, deps.computeDailyResetNextRun);

      if (result.reset) {
        const expired = deps.sessionManager.expire(session.conversationScope);
        if (expired.ok && expired.value) {
          deps.eventBus.emit("session:expired", {
            conversationScope: session.conversationScope,
            reason: `auto-reset:${result.reason}`,
          });
          resetCount++;
        } else if (!expired.ok) {
          deps.logger.warn(
            {
              tenantId: session.tenantId,
              agentId: session.agentId,
              hint: "Inspect session database integrity and retry the reset after storage recovers.",
              errorKind: expired.error.errorKind,
            },
            "Session reset deletion failed",
          );
        }
      }
    }

    deps.logger.info({
      scanned: sessions.length,
      reset: resetCount,
    }, "Session reset sweep complete");
  }

  return {
    start(): void {
      sweep();
      const config = deps.getConfig();
      const intervalMs = config?.sweepIntervalMs ?? 300_000;
      timer = deps.timers.setInterval(sweep, intervalMs);
      timer.unref();   // Sweep timer does not block shutdown
    },

    stop(): void {
      if (timer) {
        timer.cancel();
        timer = null;
      }
    },

    sweep,
  };
}
