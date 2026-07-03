// SPDX-License-Identifier: Apache-2.0
/**
 * DeleteAndRepost — delete-previous + post-new on each transition.
 * Used by Signal (no edit, has delete).
 *
 * State machine:
 *   - `apply(frame)`: delete the previous activity message (if any), then post a
 *     fresh one carrying the current frame text. The newest message id becomes
 *     `lastActivityId`.
 *   - `finalize`:
 *       • success (non-trivial): delete `lastActivityId` AFTER the answer lands
 *         (gated on `outcome.delivery.deliveredAtMs` when a clock is injected).
 *         Nothing is kept.
 *       • success (trivial): delete the placeholder.
 *       • failure: delete the running activity, then post a final ❌ message and
 *         KEEP it (the diagnostic trail).
 *       • silent: delete the placeholder (nothing happened).
 *       • aborted: keep the running activity (diagnostic).
 *
 * Timing goes through the injected `TimerPort` / `ClockPort` (never raw
 * setTimeout/Date globals, so tests stay deterministic); cancellation via
 * `handle.cancel()`. Implements the core `ChannelActivityRenderer` port.
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
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { renderFrameText, failureLabel, appendPrompt } from "./render.js";

export interface DeleteAndRepostDeps {
  actions: ActivityRenderActions;
  /** Optional — used only to schedule the deliveredAt-gated success delete. */
  timer?: TimerPort;
  /** Optional — gates the success delete on `deliveredAtMs`. */
  clock?: ClockPort;
  /**
   * Build the plain-text approval prompt for a frame's visible events.
   * Wired by a button-less channel (Signal) as a closure over
   * `buildApprovalPrompt`; the reposted message carries the prompt appended after
   * the frame text. Omitted by channels with a button surface. Returns `""` for a
   * non-approval frame (nothing appended).
   */
  buildPrompt?: (events: readonly ActivityEvent[]) => string;
  /** Resolved theme status markers. Omitted → default glyphs. */
  markers?: ActivityStatusMarkers;
}

export function createDeleteAndRepostRenderer(
  deps: DeleteAndRepostDeps,
): ChannelActivityRenderer {
  const { actions, timer, clock, buildPrompt, markers } = deps;

  let lastActivityId: string | undefined;
  let pendingDelete: TimerHandle | undefined;
  /** First-apply clock snapshot; feeds elapsedMs
   *  into renderFrameText on EVERY repost so each delete+repost carries the
   *  live "(running N s)" fallback. Undefined → no clock → graceful-degrade. */
  let startedAtMs: number | undefined;

  async function deleteLast(): Promise<Result<void, ActivityRenderError>> {
    if (lastActivityId === undefined) return ok(undefined);
    const id = lastActivityId;
    lastActivityId = undefined;
    return actions.delete(id);
  }

  return {
    strategy: "DeleteAndRepost",
    canDelete: true,
    canEdit: false,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      // Delete the previous activity message before reposting the transition.
      const deleted = await deleteLast();
      if (!deleted.ok) return deleted;
      // Capture startedAtMs once + compute elapsedMs at every apply()
      // so each repost carries the live "(running N s)" fallback (when no plan
      // is active). No clock injected → graceful-degrade (fallback skipped).
      if (startedAtMs === undefined && clock !== undefined) startedAtMs = clock.now();
      const elapsedMs =
        clock !== undefined && startedAtMs !== undefined ? clock.now() - startedAtMs : undefined;
      const text = appendPrompt(
        renderFrameText(frame, markers, elapsedMs),
        buildPrompt?.(frame.visibleEvents),
      );
      const sent = await actions.send(text);
      if (!sent.ok) return sent;
      lastActivityId = sent.value;
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      if (pendingDelete && !pendingDelete.cancelled) pendingDelete.cancel();
      pendingDelete = undefined;

      switch (outcome.kind) {
        case "success":
        case "success_with_recovered_failures": {
          if (outcome.kind === "success" && outcome.trivial) {
            return deleteLast();
          }
          const deliveredAtMs = outcome.delivery.deliveredAtMs;
          const now = clock?.now();
          if (now === undefined || timer === undefined || now >= deliveredAtMs) {
            return deleteLast();
          }
          pendingDelete = timer.setTimeout(() => {
            void deleteLast();
          }, deliveredAtMs - now);
          // unref so the deliveredAt-gated delete never holds the event loop
          // open at shutdown.
          pendingDelete.unref();
          return ok(undefined);
        }

        case "failure": {
          // Delete the running activity, then post the final themed failure line
          // and KEEP it. The marker follows the resolved theme; omitting
          // markers yields the byte-identical "❌ {errorKind}".
          const deleted = await deleteLast();
          if (!deleted.ok) return deleted;
          const sent = await actions.send(failureLabel(outcome, markers));
          if (!sent.ok) return sent;
          // Do NOT track the failure message as deletable — it is the kept trail.
          return ok(undefined);
        }

        case "silent": {
          return deleteLast();
        }

        case "aborted": {
          // Keep the running activity for diagnosis.
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
