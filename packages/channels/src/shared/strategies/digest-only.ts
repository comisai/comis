// SPDX-License-Identifier: Apache-2.0
/**
 * DigestOnly — end-of-turn email digest, silent on success.
 * Used by Email (largest cap; the assistant reply IS the activity
 * on success, so no separate activity message is sent).
 *
 * State machine:
 *   - `apply(frame)`: buffer the latest visible trail; send NOTHING mid-turn.
 *   - `finalize`:
 *       • success: nothing (the model's reply carries the outcome).
 *       • failure: exactly one failure digest (header "<failure> {errorKind}",
 *         glyph from the resolved theme `markers` — default `[FAILED]`) carrying
 *         the activity trail, so a failed turn still leaves a diagnostic record.
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
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { eventLabel } from "./render.js";

/**
 * Failure-digest header glyph when no theme markers are injected (default-theme
 * parity). DigestOnly does NOT route through the shared `failureLabel` helper:
 * Email's failure header is the bracketed ASCII tag `"[FAILED]"`, NOT the `❌`
 * the shared `DEFAULT_MARKERS` use. This literal is the established Email
 * default; a marker-less call MUST stay byte-identical to it (golden-fixture
 * parity for the 5 Email digest fixtures).
 */
const DEFAULT_FAILURE_MARKER = "[FAILED]";

export interface DigestOnlyDeps {
  actions: ActivityRenderActions;
  /**
   * Optional trailer appended to the `[FAILED]` digest body.
   * Email cannot show buttons, so it injects this to append a single-use,
   * time-bounded, signed approval LINK when the buffered trail carries a
   * `kind:"approval"` event. Receives the full buffered trail; returns the
   * trailer text (already newline-prefixed by this strategy) or `undefined`
   * when there is nothing to append (no approval event / no link minter). The
   * trailer must carry an OPAQUE link only — never a raw HMAC/secret.
   */
  appendToFailureDigest?: (trail: readonly ActivityEvent[]) => string | undefined;
  /**
   * Resolved theme status markers. The `failure` glyph on the digest
   * header follows this. Omitted → the Email default (`[FAILED]`), keeping a
   * marker-less call byte-identical to the fixture-pinned digest body. Only
   * `failure` is read (success sends nothing; subagent/running never appear on
   * the header).
   */
  markers?: ActivityStatusMarkers;
}

export function createDigestOnlyRenderer(deps: DigestOnlyDeps): ChannelActivityRenderer {
  const { actions, appendToFailureDigest, markers } = deps;

  // Buffer the latest visible trail; the projection accumulates surviving events
  // so the final frame's visibleEvents is the full trail to digest.
  let trail: readonly ActivityEvent[] = [];

  function renderFailureDigest(
    outcome: Extract<TurnOutcome, { kind: "failure" }>,
  ): string {
    const header = `${markers?.failure ?? DEFAULT_FAILURE_MARKER} ${outcome.errorKind}`;
    const body = trail.map((e) => `  • ${eventLabel(e)}`).join("\n");
    const digest = body.length > 0 ? `${header}\n${body}` : header;
    // Optional approval-link trailer (Email). Absent → byte-stable digest body.
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
