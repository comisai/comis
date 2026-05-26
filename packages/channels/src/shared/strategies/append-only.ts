// SPDX-License-Identifier: Apache-2.0
/**
 * AppendOnly — one opening status + a conditional closing follow-up (§7.2 / §7.3
 * row "AppendOnly"). Used by iMessage / LINE (no edit, no delete).
 *
 * State machine:
 *   - `apply(frame)`: post the opening status ONCE (the first non-trivial frame);
 *     later frames are no-ops (these channels cannot edit, so we don't spam).
 *   - `finalize`:
 *       • success: NO closing follow-up. (The §7.3 "✓ done" branch is the
 *         windowed-edit case, unavailable on append-only channels; posting a
 *         closing on every success would be noise.)
 *       • failure: exactly one "❌ {errorKind}" follow-up.
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
  TurnOutcome,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { renderFrameText, failureLabel } from "./render.js";

export interface AppendOnlyDeps {
  actions: ActivityRenderActions;
}

export function createAppendOnlyRenderer(deps: AppendOnlyDeps): ChannelActivityRenderer {
  const { actions } = deps;

  let opened = false;

  return {
    strategy: "AppendOnly",
    canEdit: false,
    canDelete: false,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      if (opened) return ok(undefined);
      const text = renderFrameText(frame.visibleEvents);
      if (text.length === 0) return ok(undefined);
      const sent = await actions.send(text);
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
          const sent = await actions.send(failureLabel(outcome));
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
