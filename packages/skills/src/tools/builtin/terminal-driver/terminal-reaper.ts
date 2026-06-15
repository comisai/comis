// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal-driver reaper (spec §4.6).
 *
 * Bounds the per-worker/cgroup session footprint with THREE caps, each evicting
 * with an audited reason:
 *   - idle-TTL (reason `idle`): a periodic sweep evicts sessions idle longer than
 *     `idleTtlMs` (`nowMs() - lastActivity > idleTtlMs`).
 *   - wall-clock age (reason `wall_clock`): the SAME sweep evicts sessions
 *     whose total lifetime exceeds `wallClockMs` (`nowMs() - startedAtMs >
 *     wallClockMs`) — even an actively-used session.
 *   - max-sessions overflow (reason `max_sessions`): `checkOverflow()` (run
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
 *     infra/observability). The daemon (composition root) constructs the
 *     concrete `TimerPort` (`createSystemTimers`) + the `nowMs` clock and injects
 *     them; tests inject a fake clock/timer.
 *   - CLOSURE-local state only: a single sweep-interval `handle` — NO module-global
 *     mutable state. Two `createTerminalReaper` instances are independent.
 *   - NO raw `setInterval`/`setTimeout`/`Date.now`/`new Date()` global — time is read
 *     only via the injected `nowMs`, and the sweep uses the injected
 *     `timers.setInterval(...).unref()` (so it never holds the loop open on SIGTERM).
 *     Ring bytes are enforced in the WORKER (`ringBytes`), NOT here — the reaper
 *     bounds session count + idle + lifetime.
 *
 * Analog: packages/agent/src/background/background-task-manager.ts (injected
 * `ClockPort`/`TimerPort` + closure-local state + the `setInterval(...).unref()` cap).
 *
 * @module
 */

import type { TimerPort, TimerHandle } from "@comis/core";

/**
 * The audited eviction reason — the full four-value union carried on the
 * `terminal:session_evicted` event. The reaper emits `idle`/`wall_clock` (the
 * sweep) + `max_sessions` (the create-overflow check); `max_interactions` is
 * emitted on the SAME `onEvict` path. `max_requests` is NOT here — it REJECTS
 * (session survives).
 */
export type EvictReason = "idle" | "max_sessions" | "wall_clock" | "max_interactions";

/** A session snapshot row the reaper reads — the idle + wall-clock signals. */
export interface ReaperSession {
  sessionId: string;
  lastActivity: number; // last activity epoch ms (the idle-TTL + overflow-idlest signal).
  startedAtMs: number; // session start epoch ms (the wall-clock-age signal).
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
  /**
   * OPTIONAL alive-and-busy predicate (ENDURE-01 / I9 — the endurance invariant).
   * When supplied, a session the idle sweep would otherwise reap is EXCLUDED while
   * this returns `true`, so a quiet-but-busy multi-hour compile is never killed for
   * its quietness — the load-bearing fix for the documented pitfall that
   * `lastActivity` does NOT advance for a backgrounded drive that quietly compiles
   * (no tool round-trip lands), making a naive lastActivity-only idle sweep evict a
   * healthy 2h build. The DECISION lives in `terminal-busy-predicate.ts` (165-02,
   * `busyOrHung(...) === "busy"`); the daemon (165-07) binds it over the session's
   * worker progress and injects it here — the reaper stays a thin sweep and the
   * heuristic stays unit-testable in isolation. ABSENT ⇒ today's behavior (idle
   * eviction on quietness alone, I1). It gates ONLY the idle branch — the deliberate
   * `wall_clock`/`max_interactions` caps are NOT a quietness signal and STILL fire
   * (a named operator bound, not a mystery).
   */
  isBusy?: (s: ReaperSession) => boolean;
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
   *
   * ENDURE-01 / I9: the idle branch is GATED on `!isBusy` — a session quiet past
   * `idleTtlMs` but alive-and-busy (recent worker progress) is EXCLUDED from idle
   * eviction (no death for quietness alone). The wall-clock branch is UNCHANGED: a
   * deliberate operator bound that fires even for a busy session, carrying its cap
   * name on the reason (the daemon surfaces it onto the `failed` outcome — a choice,
   * not a mystery). No new reason exists for the exclusion — it is an ABSENCE of
   * eviction, not a kind of one.
   */
  function sweep(): void {
    const now = deps.nowMs();
    for (const s of deps.listSessions()) {
      // I9: skip idle eviction while the drive is alive-and-busy (a quiet compile is
      // not idle). `isBusy` absent ⇒ `false` ⇒ today's quietness-only behavior (I1).
      if (deps.idleTtlMs > 0 && now - s.lastActivity > deps.idleTtlMs && !(deps.isBusy?.(s) ?? false)) {
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

// ---------------------------------------------------------------------------
// Registry composition (the SINGLE audited eviction site + the wired reaper)
// ---------------------------------------------------------------------------

/** Eviction-relevant payload the reaper emits to the registry's `onEvict` hook. */
export interface ReaperEvictInfo {
  sessionId: string;
  reason: EvictReason;
  /** The session's wall-clock age at eviction (`nowMs() - startedAtMs`), in ms. */
  durationMs: number;
}

/** The reaper-relevant subset of a registry session handle (the wiring reads these). */
export interface ReaperSessionHandle {
  sessionId: string;
  lastActivity: number;
  startedAt: number;
}

/**
 * The reaper caps + eviction hooks — the registry deps EXTEND this so the daemon
 * threads them flat (worker.{maxSessions,idleTtlMs} + entry limits.wallClockMs +
 * createSystemTimers + the eviction emit/log + caps.forget). All optional: when
 * `timers` + `maxSessions` are both provided the registry composes the reaper;
 * otherwise the reaper is undefined (no sweep — unit tests that don't exercise it).
 */
export interface ReaperCaps {
  maxSessions?: number; // worker.maxSessions — over-cap creates evict the idlest (max_sessions).
  idleTtlMs?: number; // worker.idleTtlMs — idle-longer sessions reaped (idle). 0 ⇒ disabled.
  wallClockMs?: number; // entry limits.wallClockMs — older sessions reaped (wall_clock). 0 ⇒ disabled.
  sweepIntervalMs?: number; // sweep cadence ms (default 30_000).
  timers?: TimerPort; // injected TimerPort (daemon: createSystemTimers); type-only @comis/core. Absent ⇒ no reaper.
  onEvict?: (info: ReaperEvictInfo) => void; // daemon emits terminal:session_evicted + _state(lost) + a WARN.
  onCapForget?: (sessionId: string) => void; // daemon wires caps.forget (no cap-map leak on the reap path).
  // ENDURE-01 / I9: the alive-and-busy idle exclusion. The daemon (165-07) binds this
  // to `busyOrHung(...) === "busy"` over the session's worker progress (the decision
  // lives in terminal-busy-predicate.ts); it is threaded onto the reaper's idle gate
  // so a quiet-but-busy compile is never idle-evicted. Absent ⇒ today's behavior (I1).
  isBusy?: (s: ReaperSession) => boolean;
}

/**
 * The minimal registry primitives the reaper wiring needs — so the registry's OWN
 * diff is tiny (it does NOT inline the snapshot/drop closures + cap-defaulting + the
 * eviction site). Generic over the handle type `H` so the registry passes its own
 * `SessionHandle` map + `evictInternal` verbatim (a `SessionHandle` IS a `ReaperSessionHandle`).
 */
export interface RegistryReaperWiring<H extends ReaperSessionHandle> {
  /** The registry's live session map (the wiring derives the snapshot + lookup + drop from it). */
  sessions: Map<string, H>;
  /** The registry's injected `nowMs`. */
  nowMs: () => number;
  /** The registry's single drop + kill-frame + workspace-cleanup step (reused, never re-implemented). */
  evictInternal: (handle: H) => void;
  /** The registry's structural logger (the audited WARN; NOT `@comis/infra`). */
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
  /** The reaper caps + hooks from the registry deps (all optional). */
  caps: ReaperCaps;
}

/**
 * Compose the registry's reaper + its SINGLE audited eviction site from the live
 * `sessions` map + primitives (cap defaults: sweep 30_000ms, undefined caps ⇒ 0).
 * Returns `evict(sessionId, reason)` — the ONE place a reaped session is dropped: it
 * reuses the registry's `evictInternal` (the kill drop + `cleanupSessionWorkspace`,
 * never duplicated), FORGETS the per-session cap state via `onCapForget` (no
 * SessionCaps Map leak on the reap path), emits the audited reason via
 * `onEvict`, and logs a WARN (`hint` + `errorKind: "resource"`, §2.7). The
 * `max_interactions` eviction reuses this exact `evict`. The reaper is undefined when
 * `timers`/`maxSessions` are not both provided — `checkOverflow`/`stop` then no-op.
 */
export function wireRegistryReaper<H extends ReaperSessionHandle>(w: RegistryReaperWiring<H>): {
  reaper: TerminalReaper | undefined;
  evict: (sessionId: string, reason: EvictReason) => void;
} {
  const idleTtlMs = w.caps.idleTtlMs ?? 0;
  const wallClockMs = w.caps.wallClockMs ?? 0;
  const maxSessions = w.caps.maxSessions ?? 0;

  function evict(sessionId: string, reason: EvictReason): void {
    const handle = w.sessions.get(sessionId);
    if (handle === undefined) return; // already gone — idempotent.
    const durationMs = w.nowMs() - handle.startedAt;
    w.evictInternal(handle); // reuse the kill drop + workspace cleanup (single site).
    w.caps.onCapForget?.(sessionId); // forget the cap state on EVERY eviction (no map leak).
    w.caps.onEvict?.({ sessionId, reason, durationMs });
    w.logger.warn(
      { sessionId, reason, durationMs, hint: "session evicted by reaper", errorKind: "resource" as const },
      "terminal session evicted",
    );
  }

  const reaper =
    w.caps.timers !== undefined && maxSessions > 0
      ? createTerminalReaper({
          nowMs: w.nowMs,
          timers: w.caps.timers,
          idleTtlMs,
          wallClockMs,
          maxSessions,
          sweepIntervalMs: w.caps.sweepIntervalMs ?? 30_000,
          listSessions: () =>
            Array.from(w.sessions.values()).map((s) => ({
              sessionId: s.sessionId,
              lastActivity: s.lastActivity,
              startedAtMs: s.startedAt,
            })),
          onEvict: (sessionId, reason) => evict(sessionId, reason),
          // ENDURE-01 / I9: thread the daemon-bound alive-busy predicate onto the
          // sweep's idle gate (undefined ⇒ today's quietness-only eviction, I1).
          isBusy: w.caps.isBusy,
        })
      : undefined;

  return { reaper, evict };
}
