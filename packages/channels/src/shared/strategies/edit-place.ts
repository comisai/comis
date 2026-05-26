// SPDX-License-Identifier: Apache-2.0
/**
 * EditPlace — edit-in-place + delete-on-success rendering strategy
 * (§7.2 / §7.3 row "EditPlace"). Used by edit-capable channels: Telegram,
 * Discord, Slack, WhatsApp.
 *
 * State machine:
 *   - The FIRST `apply(frame)` posts a placeholder message (capturing its id).
 *   - Subsequent `apply(frame)` calls DEBOUNCE the edit: each schedules an edit
 *     800ms out and cancels the prior pending edit, so a burst of frames
 *     collapses to a single edit (≤1/800ms — §5.3 / Pitfall 7 throttle).
 *   - `finalize`:
 *       • success (non-trivial): edit to the final form, then WAIT for
 *         `outcome.delivery.deliveredAtMs` before deleting the placeholder. The
 *         delete is gated on the delivery receipt so scaffolding never vanishes
 *         before the assistant answer lands (T-70-07-01, §7.3 sequencing rule).
 *       • success (trivial): delete the placeholder, no edit history.
 *       • failure: edit to the ❌ form and KEEP the message (T-70-07-02 — a
 *         failed turn must leave a diagnostic trail; finalize NEVER deletes).
 *       • silent: nothing happened → delete the placeholder.
 *       • aborted: keep the trail (cancel/timeout/fatal are diagnostic).
 *
 * ALL timing goes through the injected `TimerPort` / `ClockPort` — never raw
 * `setTimeout` / `Date.now` (Pitfall 7; `globals.test.ts` fails the build).
 * Cancellation uses `handle.cancel()`, never `clearTimeout` (TimerHandle is
 * opaque). Implements the core `ChannelActivityRenderer` port.
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  TurnOutcome,
  TimerPort,
  TimerHandle,
  ClockPort,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { renderFrameText, failureLabel } from "./render.js";

/** Debounce window: at most one edit per 800ms (§5.3). */
const EDIT_DEBOUNCE_MS = 800;

export interface EditPlaceDeps {
  actions: ActivityRenderActions;
  timer: TimerPort;
  /**
   * Clock used to gate the delete on `deliveredAtMs`. When omitted, a successful
   * delete fires immediately (no wait) — but the coordinator always injects a
   * clock so the §7.3 sequencing holds.
   */
  clock?: ClockPort;
}

export function createEditPlaceRenderer(deps: EditPlaceDeps): ChannelActivityRenderer {
  const { actions, timer, clock } = deps;

  let messageId: string | undefined;
  /** Pending debounce edit; cancelled + rescheduled on each apply. */
  let pendingEdit: TimerHandle | undefined;
  /** Latest frame text awaiting an edit flush. */
  let latestText = "";
  /** Pending delete timer (deliveredAt wait); cancelled on shutdown paths. */
  let pendingDelete: TimerHandle | undefined;

  function clearPendingEdit(): void {
    if (pendingEdit && !pendingEdit.cancelled) pendingEdit.cancel();
    pendingEdit = undefined;
  }

  async function ensurePlaceholder(text: string): Promise<Result<void, ActivityRenderError>> {
    if (messageId !== undefined) return ok(undefined);
    const sent = await actions.send(text);
    if (!sent.ok) return sent;
    messageId = sent.value;
    return ok(undefined);
  }

  async function flushEdit(): Promise<void> {
    pendingEdit = undefined;
    if (messageId === undefined) return;
    // Best-effort: a transient edit failure during streaming is non-fatal; the
    // coordinator owns retry/error translation on the final apply/finalize.
    await actions.edit(messageId, latestText);
  }

  async function deletePlaceholder(): Promise<Result<void, ActivityRenderError>> {
    if (messageId === undefined) return ok(undefined);
    return actions.delete(messageId);
  }

  return {
    strategy: "EditPlace",
    canEdit: true,
    canDelete: true,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      latestText = renderFrameText(frame.visibleEvents);

      // First frame posts the placeholder; later frames only debounce an edit.
      if (messageId === undefined) {
        const placed = await ensurePlaceholder(latestText);
        if (!placed.ok) return placed;
        return ok(undefined);
      }

      // Debounce: cancel the prior pending edit, schedule a fresh one. A burst
      // of frames collapses to a single edit carrying the latest text.
      clearPendingEdit();
      pendingEdit = timer.setTimeout(() => {
        void flushEdit();
      }, EDIT_DEBOUNCE_MS);
      // unref so a pending debounce edit never keeps the event loop alive at
      // shutdown (the TimerHandle cancel-safety contract also exposes unref) —
      // WR-02.
      pendingEdit.unref();
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      // Any pending streaming edit is superseded by the finalize form.
      clearPendingEdit();
      // Cancel a prior pending delete (cancel-safe on a repeated finalize).
      if (pendingDelete && !pendingDelete.cancelled) pendingDelete.cancel();
      pendingDelete = undefined;

      switch (outcome.kind) {
        case "success":
        case "success_with_recovered_failures": {
          if (outcome.kind === "success" && outcome.trivial) {
            // Trivial turn: drop the placeholder, no edit history.
            return deletePlaceholder();
          }
          // Edit to the final form, then delete AFTER deliveredAt.
          if (messageId !== undefined) {
            const edited = await actions.edit(messageId, "✓ done");
            if (!edited.ok) return edited;
          }
          const deliveredAtMs = outcome.delivery.deliveredAtMs;
          const now = clock?.now();
          if (now === undefined || now >= deliveredAtMs) {
            // Receipt already in the past (or no clock injected) → delete now.
            return deletePlaceholder();
          }
          // Wait until the assistant message has landed, then delete.
          pendingDelete = timer.setTimeout(() => {
            void deletePlaceholder();
          }, deliveredAtMs - now);
          // unref so the deliveredAt-gated delete never holds the event loop
          // open at shutdown (WR-02).
          pendingDelete.unref();
          return ok(undefined);
        }

        case "failure": {
          // KEEP the message: edit to the ❌ form, never delete (T-70-07-02).
          if (messageId !== undefined) {
            const edited = await actions.edit(messageId, failureLabel(outcome));
            if (!edited.ok) return edited;
          }
          return ok(undefined);
        }

        case "silent": {
          // Nothing happened — remove the transient scaffolding.
          return deletePlaceholder();
        }

        case "aborted": {
          // Cancel/timeout/fatal: keep the trail for diagnosis, no delete.
          return ok(undefined);
        }

        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
          return ok(undefined);
        }
      }
    },
  };
}
