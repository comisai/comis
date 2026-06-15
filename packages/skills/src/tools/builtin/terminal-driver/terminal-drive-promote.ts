// SPDX-License-Identifier: Apache-2.0
/**
 * The pure auto-promotion predicate (DRIVE-02; design §4 Phase B, §7.1.2 LOCKED).
 *
 * `shouldPromoteDrive(result, mode)` answers ONE question over a `terminal_session_wait`
 * settle result: should this drive promote from the inline (attached) path to the
 * DRIVE-01 detached drive-owner? A drive starts ATTACHED (inline, snappy) and, under
 * `mode:"auto"`, promotes the FIRST time a wait returns the honest
 * `isComplete:false,producing:true` settle signal — the existing diagnostic the shipped
 * settle already emits on a not-complete timeout (`terminal-settle.ts` `producing:sawChange`
 * → `terminal-wait-reply.ts` `WaitResult.producing`). It is the decision boundary that
 * keeps a quick `git status` one-shot inline (I1) while a long `claude` build promotes to
 * a backgrounded drive-owner.
 *
 * Keyed off the HONEST SIGNAL, NOT a wall-clock (§7.1.2 LOCKED, Pitfall 1). This is NOT the
 * orthogonal `auto-background-middleware` (`wrapToolForAutoBackground`, `config.autoBackgroundMs`):
 * there is deliberately NO `setTimeout` / `Date.now` / `promoteAfterMs` here. A drive
 * promotes because the CLI told us (honestly) it is still working — not because a timer
 * fired. The shipped settle never lies "done" (the I6 / `mapWaitReply` never-coerce-to-true
 * contract), so `isComplete:false && producing===true` means "the program is working, not
 * done" — exactly the promotion trigger, and a wedged worker's `degradedWaitResult()`
 * (`isComplete:false`, no `producing`) is handled truthfully (it does not spuriously promote
 * or suppress).
 *
 * The mode matrix (`drive.mode`, design §4 Phase B):
 *   - `"auto"`     (default) — promote ⇔ the honest signal (`isComplete:false,producing:true`).
 *   - `"attached"`           — NEVER promote (= today's inline-only behavior; I1 explicit opt-out).
 *   - `"detached"`           — promote at the FIRST wait regardless of the result (explicit opt-in).
 *
 * The I1 invariant is load-bearing: a wait that completes inline (`isComplete:true`) never
 * promotes under `auto`, so the short-drive stays byte-identical to today (no detached
 * context, no journal, no notification). The predicate only READS `isComplete`/`producing`;
 * it never fabricates `isComplete:true` — it mirrors `mapWaitReply`'s never-coerce contract
 * from the consuming side (T-164-05): a not-complete settle stays not-complete.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors the pure-sibling
 * predicates `terminal-dialog-detector.ts` `detectsFullScreenDialog` and `terminal-settle.ts`
 * `settleHint`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads, NO module-global mutable
 *     state, NO I/O. A request → boolean response (Pitfall 1 — no wall-clock).
 *   - TOTAL / NEVER throws: every `(result, mode)` pair yields a boolean. It does not mutate
 *     its argument.
 *   - Infra-free: value-imports NOTHING at runtime (no node builtins needed) + a type-only
 *     `WaitResult` from `terminal-wait-reply.ts` — no platform runtime packages, no
 *     observability egress, no raw timer (the globals + infra-runtime-scope gates).
 *
 * State ownership: this predicate is the DECISION only. The skills layer evaluates it where
 * the wait-result is available; the daemon remains the state owner and enforces promote-once
 * via its `alreadyPromoted` guard + emits the single notification (plan 04); the routing of a
 * promoted drive's woken turns to the drive scope is wired in plan 06. No state is held here.
 *
 * @module
 */

import type { WaitResult } from "./terminal-wait-reply.js";

/** The operator-selectable promotion policy (`drive.mode`, design §4 Phase B). */
export type DriveMode = "auto" | "attached" | "detached";

/**
 * Should this drive promote from the inline path to the DRIVE-01 detached drive-owner,
 * given a `terminal_session_wait` settle `result` and the configured `mode`?
 *
 * Pure + total — no clock, no I/O, never throws. Reads only `isComplete`/`producing`.
 *
 * @param result - The wait settle result; only `isComplete`/`producing` are consulted. The
 *   honest `isComplete:false,producing:true` signal (a not-complete timeout that was STILL
 *   producing output) is the `auto`-mode promotion trigger. `isComplete` is read VERBATIM and
 *   never coerced — a completed-inline wait (`isComplete:true`) keeps the short-drive
 *   byte-identical to today (I1), even if `producing` is also `true`.
 * @param mode - The promotion policy: `"auto"` (honest-signal-driven, the default),
 *   `"attached"` (never promote = today, I1 opt-out), `"detached"` (promote at the first
 *   wait, explicit opt-in).
 * @returns `true` to promote to a detached drive-owner, `false` to stay inline.
 */
export function shouldPromoteDrive(
  result: Pick<WaitResult, "isComplete" | "producing">,
  mode: DriveMode,
): boolean {
  if (mode === "attached") return false; // I1: never background (= today's inline-only behavior).
  if (mode === "detached") return true; // explicit opt-in: promote at the first wait.
  // auto (default): the honest signal — not done, but still producing output. `isComplete` is
  // read verbatim (never coerced to true), so a completed-inline wait stays inline (I1) and a
  // wedged worker's honest not-complete-without-producing settle does not promote.
  return result.isComplete === false && result.producing === true;
}
