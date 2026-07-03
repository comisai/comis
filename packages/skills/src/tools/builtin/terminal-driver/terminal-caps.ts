// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session usage caps for the terminal driver.
 *
 * `createSessionCaps(limits, nowMs)` is a pure, fully-injected primitive that enforces
 * the per-entry operator caps from the closed config `limits`:
 *
 *   - `maxRequestsPerSession` — the entitlement-misuse control: bound how
 *     many `send_*` calls a single session may make. A breach is the typed discriminant
 *     `{ breach: "max_requests" }`; the tool layer maps it to a typed
 *     `throwToolError` REJECT and the session SURVIVES (read/list/other sends still work).
 *   - `maxInteractions` — the interaction budget. A breach
 *     (`{ breach: "max_interactions" }`) drives an EVICT at the send_* tool layer
 *     (`registry.evict(..., "max_interactions")`).
 *   - `wallClockMs` — the wall-clock age budget. A breach
 *     (`{ breach: "wall_clock" }`) drives an EVICT (the reaper sweep + the per-send
 *     immediate guard route through the same eviction path).
 *
 * Design invariants (binding — AGENTS.md):
 *   - NO module-global mutable state. ALL counters live in a CLOSURE-local
 *     `Map<sessionId, CapState>` created inside the factory — two `createSessionCaps`
 *     instances never share state, and two sessionIds never share a counter.
 *   - The injected `nowMs: () => number` is the ONLY clock source — there is no raw
 *     wall-clock global here (the `globals` architecture gate forbids it; the reaper/tool
 *     pass `systemNowMs` in production and a fake clock in tests).
 *   - This module NEVER throws and NEVER evicts. It returns a cap-state decision; the
 *     tool/registry layer acts on it (REJECT vs EVICT per the EVICT-vs-REJECT split).
 *   - Dependency-light: node + `@comis/core` type-only imports at most — NEVER
 *     `@comis/infra` or `@comis/observability` (worker ↛ infra/observability).
 *
 * The structural `SessionLimits` shape mirrors the closed config
 * `TerminalAllowEntrySchema.limits` (packages/core/src/config/schema-skills.ts) WITHOUT
 * importing zod or the config module — this is a self-contained pure primitive (like
 * the allowlist matcher), so it takes the limits shape structurally.
 *
 * Analog: packages/agent/src/background/background-task-manager.ts (closure-local counter
 * Map + cap predicate + injected clock).
 *
 * @module
 */

/** A typed cap-breach discriminant. The tool/registry layer maps each to a reject/evict. */
export type CapBreach = "max_requests" | "max_interactions" | "wall_clock";

/**
 * The per-entry limits shape this module enforces — a STRUCTURAL mirror of the closed
 * config `limits` (schema-skills.ts). All fields optional; an undefined field ⇒ no cap.
 * `maxSessions` is consumed by the reaper, not by the per-session caps.
 */
export interface SessionLimits {
  maxSessions?: number;
  /** Max `send_*` requests per session (REJECT on breach; session survives). */
  maxRequestsPerSession?: number;
  /** Max wall-clock age in ms (EVICT on breach). */
  wallClockMs?: number;
  /** Max interactions per session (EVICT on breach). */
  maxInteractions?: number;
}

/** The injected wall-clock reader (epoch ms). Never a raw global. */
export type NowMs = () => number;

/** The cap primitive's surface — exactly what the tool layer consumes. */
export interface SessionCaps {
  /**
   * Capture the session's wall-clock start. Idempotent — a re-call does NOT re-anchor
   * `startedAtMs` (so a long-lived session cannot dodge the wall-clock cap by re-calling).
   */
  startSession(sessionId: string): void;
  /** Returns `{ breach: "max_requests" }` on the Nth+1 request; increments only on ok. */
  consumeRequest(sessionId: string): { breach: CapBreach } | undefined;
  /** Returns `{ breach: "max_interactions" }` on the Nth+1 interaction; increments only on ok. */
  consumeInteraction(sessionId: string): { breach: CapBreach } | undefined;
  /** Returns `{ breach: "wall_clock" }` once `nowMs() - startedAtMs` EXCEEDS the cap. */
  checkWallClock(sessionId: string): { breach: CapBreach } | undefined;
  /** Clear a session's counters on kill/evict so the map never leaks and a re-used id is fresh. */
  forget(sessionId: string): void;
}

/** Closure-local per-session counter record. */
interface CapState {
  requests: number;
  interactions: number;
  startedAtMs: number;
}

/**
 * Create a per-session cap enforcer. All state is CLOSURE-local (no module-global); the
 * injected `nowMs` is the only clock. The returned object's methods never throw.
 */
export function createSessionCaps(
  limits: SessionLimits | undefined,
  nowMs: NowMs,
): SessionCaps {
  // Closure-local — NOT module scope (no module-global mutable state). One CapState per
  // sessionId; two distinct createSessionCaps instances each get their own Map.
  const state = new Map<string, CapState>();

  /** Get-or-create the session's counter record, anchoring startedAt at first touch. */
  function ensure(sessionId: string): CapState {
    let entry = state.get(sessionId);
    if (entry === undefined) {
      entry = { requests: 0, interactions: 0, startedAtMs: nowMs() };
      state.set(sessionId, entry);
    }
    return entry;
  }

  return {
    startSession(sessionId: string): void {
      // Idempotent: only anchor startedAt if the session is not already tracked, so a
      // re-call never resets the wall clock.
      if (!state.has(sessionId)) {
        state.set(sessionId, {
          requests: 0,
          interactions: 0,
          startedAtMs: nowMs(),
        });
      }
    },

    consumeRequest(sessionId: string): { breach: CapBreach } | undefined {
      const cap = limits?.maxRequestsPerSession;
      const entry = ensure(sessionId);
      // Check the cap FIRST; do NOT increment on a breach (the counter never leaks an
      // extra allowance — a re-check keeps breaching).
      if (cap !== undefined && entry.requests >= cap) {
        return { breach: "max_requests" };
      }
      entry.requests += 1;
      return undefined;
    },

    consumeInteraction(sessionId: string): { breach: CapBreach } | undefined {
      const cap = limits?.maxInteractions;
      const entry = ensure(sessionId);
      if (cap !== undefined && entry.interactions >= cap) {
        return { breach: "max_interactions" };
      }
      entry.interactions += 1;
      return undefined;
    },

    checkWallClock(sessionId: string): { breach: CapBreach } | undefined {
      const cap = limits?.wallClockMs;
      if (cap === undefined) {
        return undefined;
      }
      // Anchor startedAt on first touch so a checkWallClock before startSession does not
      // spuriously breach (elapsed against `now` itself is 0).
      const entry = ensure(sessionId);
      // Strict `>`: at the exact cap boundary the budget is not yet spent.
      if (nowMs() - entry.startedAtMs > cap) {
        return { breach: "wall_clock" };
      }
      return undefined;
    },

    forget(sessionId: string): void {
      // No-op for an unknown id (never throws).
      state.delete(sessionId);
    },
  };
}
