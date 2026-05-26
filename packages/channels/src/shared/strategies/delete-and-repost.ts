// SPDX-License-Identifier: Apache-2.0
/**
 * DeleteAndRepost — delete-previous + post-new on each transition (§7.2 / §7.3
 * row "DeleteAndRepost"). Used by Signal (no edit, has delete).
 *
 * State machine:
 *   - `apply(frame)`: delete the previous activity message (if any), then post a
 *     fresh one carrying the current frame text. The newest message id becomes
 *     `lastActivityId`.
 *   - `finalize`:
 *       • success (non-trivial): delete `lastActivityId` AFTER the answer lands
 *         (gated on `outcome.delivery.deliveredAtMs` when a clock is injected —
 *         T-70-07-01 sequencing). Nothing is kept.
 *       • success (trivial): delete the placeholder.
 *       • failure: delete the running activity, then post a final ❌ message and
 *         KEEP it (T-70-07-02 — the diagnostic trail).
 *       • silent: delete the placeholder (nothing happened).
 *       • aborted: keep the running activity (diagnostic).
 *
 * Timing goes through the injected `TimerPort` / `ClockPort` (never raw globals,
 * Pitfall 7); cancellation via `handle.cancel()`. Implements the core
 * `ChannelActivityRenderer` port.
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

export interface DeleteAndRepostDeps {
  actions: ActivityRenderActions;
  /** Optional — used only to schedule the deliveredAt-gated success delete. */
  timer?: TimerPort;
  /** Optional — gates the success delete on `deliveredAtMs`. */
  clock?: ClockPort;
}

export function createDeleteAndRepostRenderer(
  deps: DeleteAndRepostDeps,
): ChannelActivityRenderer {
  const { actions, timer, clock } = deps;

  let lastActivityId: string | undefined;
  let pendingDelete: TimerHandle | undefined;

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
      const sent = await actions.send(renderFrameText(frame.visibleEvents));
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
          return ok(undefined);
        }

        case "failure": {
          // Delete the running activity, then post the final ❌ and KEEP it.
          const deleted = await deleteLast();
          if (!deleted.ok) return deleted;
          const sent = await actions.send(failureLabel(outcome));
          if (!sent.ok) return sent;
          // Do NOT track the ❌ message as deletable — it is the kept trail.
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
