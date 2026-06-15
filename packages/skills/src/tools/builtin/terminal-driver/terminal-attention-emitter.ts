// SPDX-License-Identifier: Apache-2.0
/**
 * The transition-only in-worker attention emitter (spec §2.3; TR-11, OPS-04).
 *
 * `createAttentionEmitter({ sessionId, writeFd3 })` is the WORKER half of the
 * no-poll attention mechanism. The worker calls `observe(classification)` after each
 * {@link classifyFrame} on a SETTLED frame; the emitter writes a length-prefixed
 * {@link TerminalEventFrame} to the injected `writeFd3` ONLY when the classified
 * state TRANSITIONS (e.g. `working → awaiting-input`). It is EDGE-TRIGGERED: an
 * unchanged state writes nothing, and there is NO timer anywhere — the mechanism is
 * a push driven entirely by `observe`. This is the load-bearing TR-11 invariant
 * ("the agent is woken by the event, never spins"): a polling loop is the explicit
 * anti-pattern, so this module schedules no work and reads no clock.
 *
 * The fd3 push channel is SEPARATE from the busy stdout reply stream (spec §2.3) so
 * a busy session can never delay an attention event. The registry reads `child.stdio[3]`
 * with the HR-02 crash-guard (124-05 Task 3) and re-publishes onto the daemon's
 * TypedEventBus.
 *
 * State → event-frame mapping (the worker-known fields ONLY; the daemon adds
 * `agentId`/`timestamp` on re-publish — the worker is owner-agnostic):
 *   - `awaiting-input` → `terminal:input_needed`, payload `{ state, reason, confidence }`
 *   - `stuck`          → `terminal:stuck`,        payload `{ noProgressMs, reason, confidence }`
 *   - `exited`         → `terminal:session_state`, payload `{ state: "exited" }`
 *                        (a per-session exit; the worker hosts OTHER sessions, so the
 *                        worker-process close is NOT a per-session signal — this is)
 *   - `working`        → no frame (not an attention state) — but the last-state still
 *                        advances so a later return to a prompt re-fires.
 *
 * REDACTION-SAFE BY CONSTRUCTION (T-124-14): every payload carries state / reason /
 * counts ONLY — never a `screen`/`text`/`snapshot`/`cursor` field, so an emit site
 * cannot leak screen contents even by mistake. The screen that drove the
 * classification rides the structured LOG, never the bus.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-loop-guard.ts` / `terminal-classifier.ts`):
 *   - NO module-global mutable state: the last emitted state is CLOSURE-local inside
 *     the factory — two emitter instances never share it (one per session).
 *   - EVENT-DRIVEN ONLY: no scheduled work, no wall-clock read (the worker owns the
 *     clock and supplies `noProgressMs` via the observe options). The `globals`
 *     architecture gate forbids raw timers/clock; this module touches none.
 *   - NEVER throws: `observe` is total — an unmapped state simply records the
 *     transition without a frame.
 *   - Infra-free: value-imports ONLY the terminal-ipc framer (`encodeFrame`) +
 *     (type-only) the classifier verdict — no platform runtime packages, no
 *     observability egress (the infra-runtime-scope architecture gate).
 *
 * @module
 */

import { encodeFrame, type TerminalEventFrame } from "./terminal-ipc.js";
import type { Classification, ClassifierState } from "./terminal-classifier.js";

/** Extra signals the worker supplies per observe (the emitter reads no clock itself). */
export interface ObserveOptions {
  /**
   * The elapsed no-progress window in ms (settled, no affordance) the worker measured
   * against its injected clock — carried on the `terminal:stuck` frame. A DURATION, not
   * content. Defaults to 0 when the worker omits it.
   */
  noProgressMs?: number;
}

/** The emitter's surface — exactly what the worker (124-05 Task 2) drives. */
export interface AttentionEmitter {
  /**
   * Observe the classification of the latest settled frame. Writes a redaction-safe
   * {@link TerminalEventFrame} to `writeFd3` IFF `c.state` differs from the last
   * emitted state (edge-triggered). Records the new state regardless (so a return to
   * an attention state later re-fires). Never throws, never schedules.
   */
  observe(c: Classification, opts?: ObserveOptions): void;
}

/** The emitter's injected dependencies. */
export interface AttentionEmitterDeps {
  /** The session this emitter is bound to — stamped onto every fd3 frame. */
  sessionId: string;
  /**
   * Write a length-prefixed frame to fd3 (the push channel). Production wraps
   * `fs.writeSync(3, …)` or a fd-3 socket; tests inject a capturing fake (RESEARCH A1).
   * Injected so the worker stays fd-posture-agnostic and the logic is provable on macOS.
   */
  writeFd3: (b: Buffer) => void;
}

/**
 * Build the {@link TerminalEventFrame} for an ATTENTION state, or `undefined` for a
 * non-attention state (`working`). Pure + total; the payload is redaction-safe by
 * construction (state / reason / counts only).
 */
function frameForState(
  sessionId: string,
  c: Classification,
  noProgressMs: number,
): TerminalEventFrame | undefined {
  switch (c.state) {
    case "awaiting-input":
      // The attention wake — a real prompt the agent must answer (TR-11). Carries the
      // classifier verdict's confidence (CLASS-02) — a content-free enum, not screen text.
      return {
        sessionId,
        event: "terminal:input_needed",
        payload: { state: "awaiting-input", reason: c.reason, confidence: c.confidence },
      };
    case "stuck":
      // Settled, no affordance, no progress past the stuck window (OPS-04) — a
      // duration signal, never screen content. Carries the verdict reason + confidence
      // (CLASS-02, observability symmetry) — both content-free machine tags/enums.
      return {
        sessionId,
        event: "terminal:stuck",
        payload: { noProgressMs, reason: c.reason, confidence: c.confidence },
      };
    case "exited":
      // A per-session PTY exit. The worker process stays up for its OTHER sessions,
      // so the worker-process close is NOT this session's signal — this frame is.
      return { sessionId, event: "terminal:session_state", payload: { state: "exited" } };
    case "working":
      // Not an attention state — no frame (the last-state still advances upstream).
      return undefined;
    default: {
      // Exhaustive over the closed ClassifierState union — a new state must be mapped.
      const _exhaustive: never = c.state;
      return _exhaustive;
    }
  }
}

/**
 * Create a transition-only attention emitter. The last emitted state is CLOSURE-local
 * (no module-global); `observe` is the SOLE entry and writes to fd3 only on a change.
 * No timer, no clock — purely event-driven (the TR-11 no-poll guarantee).
 *
 * @param deps - The bound `sessionId` + the injected fd3-writer.
 * @returns The {@link AttentionEmitter} surface.
 */
export function createAttentionEmitter(deps: AttentionEmitterDeps): AttentionEmitter {
  const { sessionId, writeFd3 } = deps;
  // Closure-local — NOT module scope (no module-global mutable state). `undefined`
  // is the implicit "no state emitted yet" start, so the first attention state is a
  // transition. Two createAttentionEmitter instances never share this.
  let lastState: ClassifierState | undefined;

  return {
    observe(c: Classification, opts?: ObserveOptions): void {
      // Edge-trigger: nothing to do while the state is unchanged (NOT level-triggered).
      if (c.state === lastState) return;
      lastState = c.state;

      const frame = frameForState(sessionId, c, opts?.noProgressMs ?? 0);
      // A non-attention state (`working`) records the transition but emits no frame.
      if (frame === undefined) return;
      writeFd3(encodeFrame(frame));
    },
  };
}
