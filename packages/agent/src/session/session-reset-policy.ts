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

import type { ComisLogger } from "@comis/infra";
import type { TypedEventBus } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";
import type { SessionResetPolicyConfig, ResetPolicyOverride } from "@comis/core";
import type { SessionStore, SessionDetailedEntry } from "@comis/memory";
import { computeNextRunAtMs } from "@comis/scheduler";
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
  sessionStore: SessionStore;
  sessionManager: SessionLifecycle;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  /** Callback to read current config (reads current config on each call). */
  getConfig: () => SessionResetPolicyConfig | undefined;
  /** Injectable clock for testing. Defaults to Date.now. */
  nowMs?: () => number;
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
 * Classify a session as dm, group, or thread based on its formatted key.
 *
 * If the parsed key has a guildId, it is a group session.
 * Otherwise (including unparseable keys), it falls back to "dm".
 * Thread classification is reserved for future platform metadata enrichment.
 */
export function classifySession(session: SessionDetailedEntry): SessionKind {
  const parsed = parseFormattedSessionKey(session.sessionKey);
  if (parsed?.guildId) return "group";
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
 * Uses croner (via computeNextRunAtMs) to determine if the daily reset
 * hour has passed since the session was last updated. If the next
 * occurrence of "0 {hour} * * *" after updatedAt is <= nowMs, the
 * session should be reset.
 */
export function isDailyResetDue(
  updatedAt: number,
  hour: number,
  timezone: string,
  nowMs: number,
): boolean {
  const cronExpr = `0 ${hour} * * *`;
  const schedule = {
    kind: "cron" as const,
    expr: cronExpr,
    tz: timezone || undefined,
  };
  const nextRun = computeNextRunAtMs(schedule, updatedAt);
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
 */
export function checkReset(
  policy: EffectiveResetPolicy,
  session: SessionDetailedEntry,
  nowMs: number,
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
  const getNow = deps.nowMs ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    const config = deps.getConfig();
    if (!config || config.mode === "none") {
      deps.logger.debug("Session reset sweep skipped: policy disabled or absent");
      return;
    }

    const sessions = deps.sessionStore.listDetailed();
    let resetCount = 0;

    for (const session of sessions) {
      // Skip sub-agent sessions (they have their own lifecycle)
      if (session.metadata.parentSessionKey) continue;

      const kind = classifySession(session);
      const policy = resolvePolicy(config, kind);

      if (policy.mode === "none") continue;

      const now = getNow();
      const result = checkReset(policy, session, now);

      if (result.reset) {
        const parsed = parseFormattedSessionKey(session.sessionKey);
        if (parsed) {
          deps.sessionManager.expire(parsed);
          deps.eventBus.emit("session:expired", {
            sessionKey: parsed,
            reason: `auto-reset:${result.reason}`,
          });
          resetCount++;
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
      timer = setInterval(sweep, intervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    sweep,
  };
}
