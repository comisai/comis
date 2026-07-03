// SPDX-License-Identifier: Apache-2.0
/**
 * EditPlace — edit-in-place + delete-on-success rendering strategy.
 * Used by edit-capable channels: Telegram, Discord, Slack, WhatsApp.
 *
 * State machine:
 *   - The FIRST `apply(frame)` posts a placeholder message (capturing its id).
 *   - Subsequent `apply(frame)` calls DEBOUNCE the edit: each schedules an edit
 *     800ms out and cancels the prior pending edit, so a burst of frames
 *     collapses to a single edit (≤1/800ms, keeping edits under platform rate limits).
 *   - `finalize`:
 *       • success (non-trivial): edit to the final form, then WAIT for
 *         `outcome.delivery.deliveredAtMs` before deleting the placeholder. The
 *         delete is gated on the delivery receipt so scaffolding never vanishes
 *         before the assistant answer lands.
 *       • success (trivial): delete the placeholder, no edit history.
 *       • failure: edit to the ❌ form and KEEP the message (a failed turn must
 *         leave a diagnostic trail; finalize NEVER deletes).
 *       • silent: nothing happened → delete the placeholder.
 *       • aborted: keep the trail (cancel/timeout/fatal are diagnostic).
 *
 * ALL timing goes through the injected `TimerPort` / `ClockPort` — never raw
 * `setTimeout` / `Date.now` (`globals.test.ts` fails the build otherwise).
 * Cancellation uses `handle.cancel()`, never `clearTimeout` (TimerHandle is
 * opaque). Implements the core `ChannelActivityRenderer` port.
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  ActivityEvent,
  TurnOutcome,
  TimerPort,
  TimerHandle,
  ClockPort,
  RichButton,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { renderFrameText, failureLabel, successLabel, appendPrompt } from "./render.js";

/** Debounce window: at most one edit per 800ms. */
const EDIT_DEBOUNCE_MS = 800;

export interface EditPlaceDeps {
  actions: ActivityRenderActions;
  timer: TimerPort;
  /**
   * Clock used to gate the delete on `deliveredAtMs`. When omitted, a successful
   * delete fires immediately (no wait) — but the coordinator always injects a
   * clock so the delete-after-delivery sequencing holds.
   */
  clock?: ClockPort;
  /**
   * Build the signed native-approval button rows for a frame's visible events.
   * Wired by a button-capable per-channel renderer
   * (Discord/Slack/Telegram) as a closure over `buildApprovalButtons` + the
   * injected `SignCallbackData`; the placeholder `send` carries the returned rows
   * to the adapter. Omitted by plain-text channels (IRC/WhatsApp) — they paint a
   * text-only prompt and pass no buttons. Returns `[]` for a non-approval frame.
   */
  buildButtons?: (events: readonly ActivityEvent[]) => RichButton[][];
  /**
   * Build the plain-text approval prompt for a frame's visible events.
   * Wired by a button-less edit-capable channel (WhatsApp) as a closure
   * over `buildApprovalPrompt`; the PLACEHOLDER carries the prompt appended after
   * the frame text. Omitted by button channels (Telegram/Discord/Slack), which
   * paint native buttons instead. Returns `""` for a non-approval frame.
   */
  buildPrompt?: (events: readonly ActivityEvent[]) => string;
  /** Resolved theme status markers. Omitted → default glyphs. */
  markers?: ActivityStatusMarkers;
}

export function createEditPlaceRenderer(deps: EditPlaceDeps): ChannelActivityRenderer {
  const { actions, timer, clock, buildButtons, buildPrompt, markers } = deps;

  let messageId: string | undefined;
  /** Pending debounce edit; cancelled + rescheduled on each apply. */
  let pendingEdit: TimerHandle | undefined;
  /** Latest frame text awaiting an edit flush. */
  let latestText = "";
  /** Pending delete timer (deliveredAt wait); cancelled on shutdown paths. */
  let pendingDelete: TimerHandle | undefined;
  /** First-apply clock snapshot; feeds `elapsedMs`
   *  into renderFrameText so the "(running N s)" fallback lights up when no
   *  SEP plan is active. Undefined → no clock → graceful-degrade (skipped). */
  let startedAtMs: number | undefined;

  function clearPendingEdit(): void {
    if (pendingEdit && !pendingEdit.cancelled) pendingEdit.cancel();
    pendingEdit = undefined;
  }

  async function ensurePlaceholder(
    text: string,
    buttons: RichButton[][],
  ): Promise<Result<void, ActivityRenderError>> {
    if (messageId !== undefined) return ok(undefined);
    // A non-approval frame yields no rows → omit `buttons` entirely so a
    // button-less send stays byte-identical to the plain placeholder send.
    const sent = await actions.send(text, buttons.length > 0 ? { buttons } : undefined);
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
      // Capture startedAtMs once per turn (per-instance) + compute
      // elapsedMs at every apply() so the live "(running N s)" fallback rides
      // into renderFrameText. No clock injected → graceful-degrade (skipped).
      if (startedAtMs === undefined && clock !== undefined) startedAtMs = clock.now();
      const elapsedMs =
        clock !== undefined && startedAtMs !== undefined ? clock.now() - startedAtMs : undefined;
      latestText = renderFrameText(frame, markers, elapsedMs);

      // First frame posts the placeholder; later frames only debounce an edit.
      if (messageId === undefined) {
        // Build the signed approval rows from the frame. A button-less
        // renderer (no `buildButtons`) or a non-approval frame yields `[]`.
        const buttons = buildButtons?.(frame.visibleEvents) ?? [];
        // A button-less channel (WhatsApp) appends the plain-text approval prompt
        // to the placeholder instead; a non-approval frame yields
        // `""`, leaving the placeholder text byte-identical.
        const placeholderText = appendPrompt(latestText, buildPrompt?.(frame.visibleEvents));
        const placed = await ensurePlaceholder(placeholderText, buttons);
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
      // shutdown (the TimerHandle cancel-safety contract also exposes unref).
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
          // Edit to the final form, then delete AFTER deliveredAt. The success
          // closing line follows the resolved theme markers; omitting
          // them yields the byte-identical default check-done line.
          if (messageId !== undefined) {
            const edited = await actions.edit(messageId, successLabel(markers));
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
          // open at shutdown.
          pendingDelete.unref();
          return ok(undefined);
        }

        case "failure": {
          // KEEP the message: edit to the themed failure form, never delete.
          // The marker follows the resolved theme; omitting markers yields the
          // byte-identical "❌ {errorKind}".
          if (messageId !== undefined) {
            const edited = await actions.edit(messageId, failureLabel(outcome, markers));
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
