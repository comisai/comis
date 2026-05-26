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
  /**
   * Optional trailer appended to the `[FAILED]` digest body (APV-10 / SEC-06).
   * Email cannot show buttons, so it injects this to append a single-use,
   * time-bounded, signed approval LINK when the buffered trail carries a
   * `kind:"approval"` event. Receives the full buffered trail; returns the
   * trailer text (already newline-prefixed by this strategy) or `undefined`
   * when there is nothing to append (no approval event / no link minter). The
   * trailer must carry an OPAQUE link only — never a raw HMAC/secret (T-73-31).
   */
  appendToFailureDigest?: (trail: readonly ActivityEvent[]) => string | undefined;
}

export function createDigestOnlyRenderer(deps: DigestOnlyDeps): ChannelActivityRenderer {
  const { actions, appendToFailureDigest } = deps;

  // Buffer the latest visible trail; the projection accumulates surviving events
  // so the final frame's visibleEvents is the full trail to digest.
  let trail: readonly ActivityEvent[] = [];

  function renderFailureDigest(
    outcome: Extract<TurnOutcome, { kind: "failure" }>,
  ): string {
    const header = `[FAILED] ${outcome.errorKind}`;
    const body = trail.map((e) => `  • ${eventLabel(e)}`).join("\n");
    const digest = body.length > 0 ? `${header}\n${body}` : header;
    // Optional approval-link trailer (Email). Absent → byte-stable Phase-72 body.
    const trailer = appendToFailureDigest?.(trail);
    return trailer !== undefined && trailer.length > 0
      ? `${digest}\n${trailer}`
      : digest;
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
