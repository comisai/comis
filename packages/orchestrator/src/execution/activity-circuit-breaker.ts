// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityCircuitBreaker — auto-managed per-agent×channel breaker.
 * A permission storm against a forbidden channel API must
 * auto-quiesce without operator intervention while staying visible to ops.
 *
 * Two independent failure modes, classified on the `ActivityRenderError.kind`
 * union produced by `renderer.apply()` (`channel-activity-renderer.ts:85-90`) —
 * NOT the log error-kind union, which has no `permission`/transient-network
 * member:
 *   • `permission`                        → 3 consecutive → STICKY trip. The
 *     clock-based half-open NEVER applies; only `reset(key)` (the config-reload
 *     path) clears it.
 *   • `internal` | `transient_network`    → 5 consecutive → trip with a
 *     clock-delta half-open probe after 5 minutes (a successful probe closes
 *     it; a failed probe re-opens it).
 *   • `rate_limited` | `not_supported`    → NON-tripping (debounce/backoff and
 *     the renderer's own drop handle these). They neither advance nor
 *     reset the tripping counters.
 *
 * Timing is clock-delta only (`clock.now() - openedAt >= halfOpenMs`) — there
 * are no raw timer globals (AGENTS.md §2.5). The half-open transition is
 * computed lazily on every `isTripped`/`getTripped` read, mirroring
 * `agent/src/safety/circuit-breaker.ts:40-44` (which cannot be imported —
 * orchestrator ⊀ agent internals — so the clock-delta pattern is reimplemented
 * here with two counters + a per-key `Map`).
 *
 * State is held in a module-private `Map<string, BreakerState>` keyed
 * `${agentId}::${channelKey}` (both fields on `TurnActivityContext`). On a
 * fresh trip, `record` returns `{ tripped: true, reason }` exactly once so the
 * coordinator fires its single WARN + increments the
 * `activity.circuit_breaker.tripped{agentId,channelKey,reason}` counter once
 * per trip, never per subsequent skipped flush.
 *
 * @module
 */
import type { ActivityRenderError, ClockPort } from "@comis/core";
import type { Result } from "@comis/shared";

/** Default consecutive-`permission` count that trips a sticky breaker. */
const DEFAULT_PERMISSION_THRESHOLD = 3;
/** Default consecutive `internal`|`transient_network` count that trips a half-open breaker. */
const DEFAULT_TRANSIENT_THRESHOLD = 5;
/** Default half-open probe delay for a transient trip — 5 minutes. */
const DEFAULT_HALF_OPEN_MS = 300_000;

/**
 * The breaker key — a single (agentId, channelKey) pair. Distinct keys are
 * fully isolated (a permission storm on `a::discord` never trips `a::slack`).
 */
export interface BreakerKey {
  readonly agentId: string;
  readonly channelKey: string;
}

/**
 * The tripping mode of a breaker, as a closed union so the `/status` surface
 * and the counter label stay exhaustive.
 *   • `permission` — the sticky mode (clears only on `reset`).
 *   • `transient`  — the half-open mode (clears on probe success or `reset`).
 */
export type BreakerReason = "permission" | "transient";

/** Result of a single `record` — whether THIS call caused a fresh trip. */
export interface RecordOutcome {
  /** True only on the record that crossed a threshold / re-opened a half-open probe. */
  readonly tripped: boolean;
  /** The mode of the fresh trip; present iff `tripped`. */
  readonly reason?: BreakerReason;
}

/** A tripped-breaker entry for the `/status` surface and the counter. */
export interface TrippedEntry {
  readonly agentId: string;
  readonly channelKey: string;
  readonly reason: BreakerReason;
}

/** Tuning knobs; all optional with spec defaults (3 / 5 / 5 min). */
export interface ActivityCircuitBreakerOptions {
  /** Consecutive `permission` errors that trip the sticky breaker. Default 3. */
  readonly permissionThreshold?: number;
  /** Consecutive `internal`|`transient_network` errors that trip the half-open breaker. Default 5. */
  readonly transientThreshold?: number;
  /** Half-open probe delay (ms) for a transient trip. Default 300_000 (5 min). */
  readonly halfOpenMs?: number;
}

/**
 * The breaker surface the coordinator and `/status` consume.
 */
export interface ActivityCircuitBreaker {
  /**
   * Classify an apply result for `key` and advance the state machine. Returns
   * whether THIS call caused a fresh trip (so the coordinator emits its single
   * WARN + bumps the counter exactly once per trip). A success (ok) resets both
   * consecutive counters and closes a transient half-open; non-tripping kinds
   * (`rate_limited`/`not_supported`) are ignored (no counter movement).
   */
  record(key: BreakerKey, result: Result<void, ActivityRenderError>): RecordOutcome;
  /**
   * True when the coordinator must skip `renderer.apply` for `key`. A sticky
   * permission trip is always tripped until `reset`; a transient trip applies
   * the clock-delta half-open (after `halfOpenMs`, one probe is allowed —
   * `isTripped` returns false so the next apply runs).
   */
  isTripped(key: BreakerKey): boolean;
  /** Close `key` and clear its counters — the ONLY path that clears a sticky permission trip. */
  reset(key: BreakerKey): void;
  /** Snapshot of currently-tripped keys for `/status` + the counter. Half-open keys are omitted. */
  getTripped(): TrippedEntry[];
}

/** The internal three-state shape per key. */
type BreakerPhase = "closed" | "open" | "halfOpen";

interface BreakerState {
  phase: BreakerPhase;
  /**
   * The ORIGINAL composite-key components, carried verbatim so `getTripped()`
   * returns the exact `agentId`/`channelKey` with no string round-trip. The Map
   * key string (`${agentId}::${channelKey}`) is lossy when either component
   * contains `::` (agent/channel ids are unvalidated free-form strings —
   * config schema: `z.record(z.string().min(1), …)`), so the snapshot reads
   * these fields rather than re-splitting the key.
   */
  agentId: string;
  channelKey: string;
  /** Which mode opened the breaker; only meaningful while `phase !== "closed"`. */
  reason: BreakerReason;
  /** Consecutive `permission` failures since the last reset/success. */
  permissionFailures: number;
  /** Consecutive `internal`|`transient_network` failures since the last reset/success. */
  transientFailures: number;
  /** `clock.now()` when a transient trip opened (basis for the half-open delta). */
  openedAt: number;
}

/**
 * Classify an `ActivityRenderError` into a tripping mode. Closed exhaustive
 * switch (AGENTS.md §2.8): a new render-error variant fails `tsc` here until it
 * is explicitly routed. `"ignore"` covers the non-tripping kinds.
 */
type Classification = BreakerReason | "ignore";
function classify(e: ActivityRenderError): Classification {
  switch (e.kind) {
    case "permission":
      return "permission";
    case "internal":
    case "transient_network":
      return "transient";
    case "rate_limited":
    case "not_supported":
      return "ignore";
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return "ignore";
    }
  }
}

function freshState(key: BreakerKey): BreakerState {
  return {
    phase: "closed",
    agentId: key.agentId,
    channelKey: key.channelKey,
    reason: "transient",
    permissionFailures: 0,
    transientFailures: 0,
    openedAt: 0,
  };
}

/**
 * Construct a per-agent×channel circuit breaker. One instance lives for the
 * process (or until a config reload reconstructs it); `reset(key)` is the
 * per-key clear the config-reload path calls for a sticky permission trip.
 */
export function createActivityCircuitBreaker(
  clock: ClockPort,
  opts?: ActivityCircuitBreakerOptions,
): ActivityCircuitBreaker {
  const permissionThreshold = opts?.permissionThreshold ?? DEFAULT_PERMISSION_THRESHOLD;
  const transientThreshold = opts?.transientThreshold ?? DEFAULT_TRANSIENT_THRESHOLD;
  const halfOpenMs = opts?.halfOpenMs ?? DEFAULT_HALF_OPEN_MS;

  const states = new Map<string, BreakerState>();

  function keyOf(key: BreakerKey): string {
    return `${key.agentId}::${key.channelKey}`;
  }

  function getOrCreate(key: BreakerKey): BreakerState {
    const id = keyOf(key);
    let s = states.get(id);
    if (s === undefined) {
      s = freshState(key);
      states.set(id, s);
    }
    return s;
  }

  /**
   * Apply the clock-delta half-open transition for a transient trip (no-op for
   * a sticky permission trip). Mirrors circuit-breaker.ts:40-44 — read on every
   * gate evaluation so the probe window opens lazily without a timer.
   */
  function maybeHalfOpen(s: BreakerState): void {
    if (s.phase === "open" && s.reason === "transient" && clock.now() - s.openedAt >= halfOpenMs) {
      s.phase = "halfOpen";
    }
  }

  return {
    record(key: BreakerKey, result: Result<void, ActivityRenderError>): RecordOutcome {
      const s = getOrCreate(key);

      // A successful apply resets both consecutive counters and closes a
      // transient half-open probe. A sticky permission trip is intentionally
      // NOT cleared by a success — only `reset` clears it.
      if (result.ok) {
        s.permissionFailures = 0;
        s.transientFailures = 0;
        if (s.phase !== "open" || s.reason !== "permission") {
          // closed stays closed; halfOpen → closed (probe succeeded).
          s.phase = "closed";
        }
        return { tripped: false };
      }

      const mode = classify(result.error);
      if (mode === "ignore") {
        // Non-tripping kinds neither advance nor reset the tripping counters.
        return { tripped: false };
      }

      // A failed probe on a half-open transient breaker re-opens it (a fresh
      // trip), regardless of which tripping kind the failure was.
      if (s.phase === "halfOpen") {
        s.phase = "open";
        s.reason = "transient";
        s.openedAt = clock.now();
        return { tripped: true, reason: "transient" };
      }

      // While already open, further failures do not re-report a fresh trip.
      if (s.phase === "open") return { tripped: false };

      if (mode === "permission") {
        s.permissionFailures++;
        s.transientFailures = 0; // a permission error breaks a transient streak
        if (s.permissionFailures >= permissionThreshold) {
          s.phase = "open";
          s.reason = "permission";
          s.openedAt = clock.now();
          return { tripped: true, reason: "permission" };
        }
        return { tripped: false };
      }

      // mode === "transient"
      s.transientFailures++;
      s.permissionFailures = 0; // a transient error breaks a permission streak
      if (s.transientFailures >= transientThreshold) {
        s.phase = "open";
        s.reason = "transient";
        s.openedAt = clock.now();
        return { tripped: true, reason: "transient" };
      }
      return { tripped: false };
    },

    isTripped(key: BreakerKey): boolean {
      const s = states.get(keyOf(key));
      if (s === undefined) return false;
      maybeHalfOpen(s);
      // halfOpen allows one probe through (not tripped); closed is not tripped;
      // open (sticky permission or pre-window transient) is tripped.
      return s.phase === "open";
    },

    reset(key: BreakerKey): void {
      states.set(keyOf(key), freshState(key));
    },

    getTripped(): TrippedEntry[] {
      const out: TrippedEntry[] = [];
      for (const s of states.values()) {
        maybeHalfOpen(s);
        if (s.phase !== "open") continue;
        // Return the ORIGINAL components verbatim — no `::` re-split, so an
        // agentId/channelKey that itself contains `::` is reported exactly.
        // The lossy string-key parse + `slice(sep + 2)` magic offset
        // are gone.
        out.push({
          agentId: s.agentId,
          channelKey: s.channelKey,
          reason: s.reason,
        });
      }
      return out;
    },
  };
}
