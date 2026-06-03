// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal-driver reaper (spec §4.6; TR-06, OPS-06).
 *
 * Bounds the per-worker/cgroup session footprint with THREE caps, each evicting
 * with an audited reason:
 *   - idle-TTL (reason `idle`): a periodic sweep evicts sessions idle longer than
 *     `idleTtlMs` (`nowMs() - lastActivity > idleTtlMs`).
 *   - wall-clock age (reason `wall_clock`, OPS-06): the SAME sweep evicts sessions
 *     whose total lifetime exceeds `wallClockMs` (`nowMs() - startedAtMs >
 *     wallClockMs`) — even an actively-used session.
 *   - max-sessions overflow (reason `max_sessions`, TR-06): `checkOverflow()` (run
 *     from `create`) evicts the idlest session(s) until size == `maxSessions`.
 *
 * The reaper does NOT own the session map — it calls back into the registry's
 * injected `onEvict(sessionId, reason)`, which drops the handle, cleans the
 * workspace, flips the handle to lost, forgets the per-session cap state, and
 * emits the audited reason (`terminal:session_evicted` + a WARN log). This keeps
 * the map single-owned and the reaper unit-testable with a fake clock/timer.
 *
 * Architecture (binding):
 *   - TYPE-ONLY ports from `@comis/core` (`TimerPort`/`TimerHandle`) — this module
 *     value-imports NEITHER `@comis/infra` NOR `@comis/observability` (worker ↛
 *     infra/observability, SEC-07). The daemon (composition root) constructs the
 *     concrete `TimerPort` (`createSystemTimers`) + the `nowMs` clock and injects
 *     them; tests inject a fake clock/timer.
 *   - CLOSURE-local state only: a single `handle` for the sweep interval — NO
 *     module-global mutable state. Two `createTerminalReaper` instances are
 *     independent.
 *   - NO raw `setInterval`/`setTimeout`/`Date.now`/`new Date()` global — time is
 *     read only via the injected `nowMs`, and the sweep uses the injected
 *     `timers.setInterval(...).unref()` (the unref so the sweep never holds the
 *     event loop open on SIGTERM). Ring bytes are enforced in the WORKER (P0
 *     `ringBytes`), NOT here — the reaper bounds session count + idle + lifetime.
 *
 * Analog: packages/agent/src/background/background-task-manager.ts (injected
 * `ClockPort`/`TimerPort` + closure-local state + the `setInterval(...).unref()`
 * cap pattern).
 *
 * @module
 */

import type { TimerPort, TimerHandle } from "@comis/core";

/**
 * The audited eviction reason — the full four-value union (123-01
 * `terminal:session_evicted`). This plan emits `idle`/`wall_clock` (the sweep)
 * and `max_sessions` (the create-overflow check); Plan 05 emits `max_interactions`
 * on the SAME `onEvict` path (the interaction budget spent at the send_* tool
 * layer). `max_requests` is NOT here — it REJECTS the call (the session survives).
 */
export type EvictReason = "idle" | "max_sessions" | "wall_clock" | "max_interactions";

/** A session snapshot row the reaper reads — the idle + wall-clock signals. */
export interface ReaperSession {
  sessionId: string;
  /** Last activity epoch ms (the idle-TTL + overflow-idlest signal). */
  lastActivity: number;
  /** Session start epoch ms (the wall-clock-age signal). */
  startedAtMs: number;
}

/** Injected reaper dependencies — all supplied by the registry/daemon (or tests). */
export interface ReaperDeps {
  /** Wall-clock reader (epoch ms). Injected — NEVER a raw `Date.now` global. */
  nowMs: () => number;
  /**
   * The injected timer port (the sweep uses `setInterval(...).unref()`). The
   * daemon passes `createSystemTimers()` from `@comis/infra`; tests pass a fake.
   */
  timers: TimerPort;
  /** Idle-TTL in ms; a session idle longer than this is evicted. `0` ⇒ disabled. */
  idleTtlMs: number;
  /** Wall-clock-age budget in ms; a session older than this is evicted. `0` ⇒ disabled. */
  wallClockMs: number;
  /** Max concurrent sessions; `checkOverflow` evicts the idlest beyond this. */
  maxSessions: number;
  /** The periodic sweep cadence in ms. */
  sweepIntervalMs: number;
  /** Current session snapshot (the registry's live map, mapped to the reaper rows). */
  listSessions: () => ReaperSession[];
  /** Called for every eviction with the audited reason — the registry drops + cleans + emits. */
  onEvict: (sessionId: string, reason: EvictReason) => void;
}

/** The reaper's surface: arm/cancel the sweep + the per-create overflow check. */
export interface TerminalReaper {
  /** Arm the periodic sweep (idle + wall-clock). The interval handle is unref'd. */
  start(): void;
  /** Cancel the sweep interval (the registry calls this from cleanup — no leaked interval). */
  stop(): void;
  /** Evict the idlest session(s) until size == maxSessions (run from create). */
  checkOverflow(): void;
}

/**
 * Create a terminal reaper. The sweep interval handle is the ONLY state and it is
 * CLOSURE-local (no module-global). The injected `nowMs`/`timers` are the only
 * clock/scheduler — no raw globals.
 */
export function createTerminalReaper(deps: ReaperDeps): TerminalReaper {
  // Closure-local — NOT module scope (no module-global mutable state).
  let handle: TimerHandle | undefined;

  /**
   * One sweep pass: evict each session at most once, idle taking precedence over
   * wall-clock. A `0` cap is "disabled" so each cap can be exercised in isolation.
   */
  function sweep(): void {
    const now = deps.nowMs();
    for (const s of deps.listSessions()) {
      if (deps.idleTtlMs > 0 && now - s.lastActivity > deps.idleTtlMs) {
        deps.onEvict(s.sessionId, "idle");
        continue;
      }
      if (deps.wallClockMs > 0 && now - s.startedAtMs > deps.wallClockMs) {
        deps.onEvict(s.sessionId, "wall_clock");
      }
    }
  }

  function checkOverflow(): void {
    const xs = deps.listSessions();
    const overflow = xs.length - deps.maxSessions;
    if (overflow <= 0) return;
    // Evict the idlest (lowest lastActivity) first, exactly `overflow` of them.
    const idlestFirst = [...xs].sort((a, b) => a.lastActivity - b.lastActivity);
    for (let i = 0; i < overflow; i++) {
      deps.onEvict(idlestFirst[i].sessionId, "max_sessions");
    }
  }

  function start(): void {
    handle = deps.timers.setInterval(() => sweep(), deps.sweepIntervalMs);
    // .unref() so the sweep never holds the event loop open on SIGTERM (TimerHandle contract).
    handle.unref();
  }

  function stop(): void {
    handle?.cancel();
    handle = undefined;
  }

  return { start, stop, checkOverflow };
}
