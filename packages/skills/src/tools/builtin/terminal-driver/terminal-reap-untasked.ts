// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic honest-fail backstop for the unattended-drive flub
 * (`WEBHOOK-CLAUDE-AGENT-DRIVE-RELIABILITY`, webhook-claude-cli-tdd-20260701).
 *
 * The dominant flub: an UNATTENDED (webhook/cron) agent turn creates a `claude` drive, clears the
 * trust gate, but NEVER delivers the task (no `send_text`) — it hallucinates "I don't have a task"
 * and ends the turn. `cb57b96d` already stops that never-tasked drive from BACKGROUNDING (no
 * resurrec-able wake-state); the wait-tool directive ({@link ./terminal-wait-reply}
 * `WAIT_TASK_NOT_DELIVERED_NOTE`) best-efforts an in-turn recovery — but was LIVE-PROVEN
 * INSUFFICIENT (the model ignores the JIT directive, guard2 run). This is the DETERMINISTIC floor,
 * model-independent: at an unattended turn-end the caller reaps every LIVE, never-tasked drive the
 * turn left behind, so the origin records an HONEST failure (the webhook route flips
 * `webhook_delivered` success:false) instead of a silent "success" with a leaked idle drive.
 *
 * Reaping a never-tasked drive is always safe: it did no work (no task was ever delivered), and for
 * an UNATTENDED origin there is no human / next turn that will ever task it. This is scoped to the
 * unattended entry points (the webhook route today) — an interactive origin legitimately hands a
 * fresh drive back to the human between steps, so it is NOT reaped.
 *
 * @module
 */
import type { SessionOwner } from "./terminal-session-owner.js";
import type { SessionListing, SessionHandle } from "./terminal-session-types.js";

/**
 * The narrow registry surface the reap needs (STRUCTURAL — so this module does not import the
 * concrete registry / keep the skills layer free of a heavy dependency, mirroring the
 * `DrivePromoteEmitDeps` pattern). `list`/`get`/`kill` are all owner-scoped (a cross-owner call is
 * not-found / a no-op), so a reap can only ever touch drives THIS owner created.
 */
export interface ReapUntaskedRegistry {
  list(owner: SessionOwner): SessionListing[];
  get(sessionId: string, owner: SessionOwner): SessionHandle | undefined;
  kill(sessionId: string, owner: SessionOwner): Promise<void>;
}

/**
 * Reap every LIVE drive owned by `owner` that was NEVER tasked (`everSentText !== true`).
 *
 * @returns the reaped sessionIds — EMPTY ⇒ the turn tasked everything it created (the happy path;
 *   the caller then records a normal success). A non-empty result ⇒ the turn stranded ≥1 never-tasked
 *   drive → the caller records an honest failure. TOTAL: a dead (`alive:false`) drive is skipped, and
 *   a per-drive `kill` rejection is swallowed so one wedged handle cannot strand the reap of the rest.
 */
export async function reapNeverTaskedDrives(
  registry: ReapUntaskedRegistry,
  owner: SessionOwner,
): Promise<{ reaped: string[] }> {
  const reaped: string[] = [];
  for (const listing of registry.list(owner)) {
    if (!listing.alive) continue; // only a live drive can be a strand.
    const handle = registry.get(listing.sessionId, owner);
    // A handle that exists but was never tasked (`everSentText !== true`) is the flub. A missing
    // handle (gone/cross-owner) is skipped — nothing to reap.
    if (handle !== undefined && handle.everSentText !== true) {
      try {
        await registry.kill(listing.sessionId, owner);
        reaped.push(listing.sessionId);
      } catch {
        /* a per-drive kill failure must not strand the reap of the others (total) */
      }
    }
  }
  return { reaped };
}
