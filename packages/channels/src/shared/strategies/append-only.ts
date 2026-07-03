// SPDX-License-Identifier: Apache-2.0
/**
 * AppendOnly — one opening status + a conditional closing follow-up.
 * Used by iMessage / LINE (no edit, no delete).
 *
 * State machine:
 *   - `apply(frame)`: post the opening status ONCE (the first non-trivial frame);
 *     later frames are no-ops (these channels cannot edit, so we don't spam).
 *   - `finalize`:
 *       • success: NO closing follow-up. (The closing success marker is a
 *         windowed-edit affordance, unavailable on append-only channels; posting a
 *         closing on every success would be noise.)
 *       • failure: exactly one themed failure follow-up ("{marker} {errorKind}").
 *       • trivial / silent / aborted: nothing emitted.
 *
 * No timers needed — append-only has no delete to sequence. Implements the core
 * `ChannelActivityRenderer` port.
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  ActivityEvent,
  TurnOutcome,
  RichButton,
  ActivityStatusMarkers,
  ClockPort,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { renderFrameText, failureLabel, appendPrompt } from "./render.js";

export interface AppendOnlyDeps {
  actions: ActivityRenderActions;
  /** Optional clock for the "(running N s)" elapsed-time fallback.
   *  Read-only display arithmetic (no scheduling, no I/O); omitted →
   *  graceful-degrade. Distinct from the TimerPort used for delete sequencing. */
  clock?: ClockPort;
  /**
   * Build the plain-text approval prompt for a frame's visible events.
   * Wired by a button-less channel (iMessage) as a closure over
   * `buildApprovalPrompt`; the opening status carries the prompt appended after
   * the frame text. Omitted by channels with a button surface. Returns `""` for a
   * non-approval frame (nothing appended).
   */
  buildPrompt?: (events: readonly ActivityEvent[]) => string;
  /**
   * Build the signed native-approval button rows for a frame's visible events.
   * Wired by a button-capable send-only channel (LINE) as a
   * closure over `buildApprovalButtons` + the injected `SignCallbackData`; the
   * opening status `send` carries the returned rows as LINE Quick-Reply chips.
   * Omitted by text-only channels (iMessage). Returns `[]` for a non-approval
   * frame, so a button-less send stays byte-identical.
   */
  buildButtons?: (events: readonly ActivityEvent[]) => RichButton[][];
  /** Resolved theme status markers. Omitted → default glyphs. */
  markers?: ActivityStatusMarkers;
}

export function createAppendOnlyRenderer(deps: AppendOnlyDeps): ChannelActivityRenderer {
  const { actions, clock, buildPrompt, buildButtons, markers } = deps;

  let opened = false;
  /** First-apply clock snapshot. AppendOnly posts ONCE so the elapsed-time
   *  fallback fires only on the FIRST frame — exactly the pre-SEP window. */
  let startedAtMs: number | undefined;

  return {
    strategy: "AppendOnly",
    canEdit: false,
    canDelete: false,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      if (opened) return ok(undefined);
      if (startedAtMs === undefined && clock !== undefined) startedAtMs = clock.now();
      const elapsedMs =
        clock !== undefined && startedAtMs !== undefined ? clock.now() - startedAtMs : undefined;
      const text = appendPrompt(
        renderFrameText(frame, markers, elapsedMs),
        buildPrompt?.(frame.visibleEvents),
      );
      if (text.length === 0) return ok(undefined);
      // A button-capable channel (LINE) carries the signed Quick-Reply chips; a
      // non-approval frame yields `[]` → omit `buttons` so the send stays
      // byte-identical to the original opening status.
      const buttons = buildButtons?.(frame.visibleEvents) ?? [];
      const sent = await actions.send(text, buttons.length > 0 ? { buttons } : undefined);
      if (!sent.ok) return sent;
      opened = true;
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      switch (outcome.kind) {
        case "success":
        case "success_with_recovered_failures":
          // No closing follow-up on success.
          return ok(undefined);

        case "failure": {
          // The marker follows the resolved theme; omitting markers
          // yields the byte-identical "❌ {errorKind}".
          const sent = await actions.send(failureLabel(outcome, markers));
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
