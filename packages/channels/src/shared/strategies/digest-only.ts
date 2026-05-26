// SPDX-License-Identifier: Apache-2.0
/**
 * DigestOnly — end-of-turn email digest, silent on success (§7.2 / §7.3 row
 * "DigestOnly"). Used by Email (largest cap; the assistant reply IS the activity
 * on success, so no separate activity message is sent).
 *
 * State machine:
 *   - `apply(frame)`: buffer the latest visible trail; send NOTHING mid-turn.
 *   - `finalize`:
 *       • success: nothing (the model's reply carries the outcome).
 *       • failure: exactly one "[FAILED]" digest carrying the activity trail +
 *         the errorKind, so a failed turn still leaves a diagnostic record
 *         (T-70-07-02).
 *       • trivial / silent / aborted: nothing.
 *
 * No timers — DigestOnly is purely end-of-turn. Implements the core
 * `ChannelActivityRenderer` port.
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  ActivityEvent,
  TurnOutcome,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { eventLabel } from "./render.js";

export interface DigestOnlyDeps {
  actions: ActivityRenderActions;
}

export function createDigestOnlyRenderer(deps: DigestOnlyDeps): ChannelActivityRenderer {
  const { actions } = deps;

  // Buffer the latest visible trail; the projection accumulates surviving events
  // so the final frame's visibleEvents is the full trail to digest.
  let trail: readonly ActivityEvent[] = [];

  function renderFailureDigest(
    outcome: Extract<TurnOutcome, { kind: "failure" }>,
  ): string {
    const header = `[FAILED] ${outcome.errorKind}`;
    const body = trail.map((e) => `  • ${eventLabel(e)}`).join("\n");
    return body.length > 0 ? `${header}\n${body}` : header;
  }

  return {
    strategy: "DigestOnly",
    canEdit: false,
    canDelete: false,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      trail = frame.visibleEvents;
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      switch (outcome.kind) {
        case "success":
        case "success_with_recovered_failures":
          // The assistant reply is the activity — send nothing.
          return ok(undefined);

        case "failure": {
          const sent = await actions.send(renderFailureDigest(outcome));
          if (!sent.ok) return sent;
          return ok(undefined);
        }

        case "silent":
        case "aborted":
          return ok(undefined);

        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
          return ok(undefined);
        }
      }
    },
  };
}
