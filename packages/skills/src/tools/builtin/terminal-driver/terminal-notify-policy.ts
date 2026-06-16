// SPDX-License-Identifier: Apache-2.0
/**
 * The pure NOTIFY-01 `drive.notify` gate (design §4 Phase D; CONTEXT I4).
 *
 * `shouldNotifyOutcome(outcome, policy)` answers ONE question over a user-facing terminal
 * outcome: should it reach the user, given the operator's `drive.notify` policy? This is
 * what makes the I4 invariant — "an escalation notifies even under `none`" — RED-pinnable
 * in isolation, separate from the wake-holder wiring.
 *
 * The contract (the NOTIFY-01 gate table):
 *   - `"needs-you"` (an escalation) → ALWAYS `true`. SEC-12/SEC-11 are NEVER weakened by
 *     "notify only on terminal outcome": an escalation IS a terminal notification and fires
 *     even under `drive.notify:"none"` (I4 — the load-bearing cell). The caller must NOT
 *     route the escalation through any OTHER suppression (Pitfall 1 — a uniform guard over
 *     every outcome is the I4 regression; `needs-you` here returns `true` unconditionally so
 *     a correct caller can gate all outcomes through this ONE fn safely).
 *   - `"done"` / `"failed"` → `policy !== "none"`. Suppressed ONLY under `"none"`; they fire
 *     under `"terminal"` (the default) and `"all"`.
 *
 * `"all"` additionally permits the debug-only per-wake (answer/wait) notification — that is
 * a SEPARATE caller decision (a per-wake line is not a terminal `outcome`), NOT this gate;
 * this fn governs only the three terminal outcomes.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-spend-ceiling.ts` / `terminal-drive-promote.ts`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads, NO module-global mutable
 *     state, NO I/O. An (outcome, policy) → boolean response.
 *   - TOTAL / NEVER throws: every pair yields a boolean; the SAFE direction for an
 *     escalation is always-notify (I4 — never silence a security signal).
 *   - Infra-free: value-imports NOTHING at runtime — no platform runtime packages, no
 *     observability egress (the globals + infra-runtime-scope gates; this file names none).
 *
 * @module
 */

/** The operator `drive.notify` policy (schema-skills.ts; design §4 Phase D, default `terminal`). */
export type NotifyPolicy = "terminal" | "all" | "none";

/**
 * Should this terminal outcome reach the user, given the `drive.notify` policy? — NOTIFY-01.
 *
 * `"needs-you"` ALWAYS returns `true` (I4 — an escalation notifies even under `"none"`);
 * `"done"`/`"failed"` return `policy !== "none"` (suppressed only under `"none"`). Pure +
 * total; never throws.
 *
 * @param outcome - The user-facing terminal outcome (`done` | `needs-you` | `failed`).
 * @param policy - The operator `drive.notify` policy.
 * @returns `true` to notify the user, `false` to suppress.
 */
export function shouldNotifyOutcome(
  outcome: "done" | "needs-you" | "failed",
  policy: NotifyPolicy,
): boolean {
  // I4: an escalation is a security signal — it notifies under EVERY policy, including
  // "none". This is the canary cell; never make it conditional on `policy`.
  if (outcome === "needs-you") return true;
  // done/failed: suppressed ONLY under "none"; fire under "terminal"/"all".
  return policy !== "none";
}
