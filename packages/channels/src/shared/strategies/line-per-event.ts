// SPDX-License-Identifier: Apache-2.0
/**
 * LinePerEvent — one short line per event + a closing summary line (§7.2 / §7.3
 * row "LinePerEvent"). Used by IRC (no edit, no delete, 512-char line cap, §7.1).
 *
 * State machine:
 *   - `apply(frame)`: for each event newly visible in this frame
 *     (`frame.changeSet.added`), emit one line. A line longer than the 512-char
 *     IRC cap is truncated with "…" (T-70-07-05 — IRC rejects/splits overlong
 *     lines).
 *   - `finalize`:
 *       • success (non-trivial): one closing line "✓ done · N steps · Xs"
 *         (N = lines emitted; Xs = elapsed since the first line, when a clock is
 *         injected).
 *       • failure: one closing line "[ERR] {errorKind}".
 *       • trivial / silent / aborted: no closing line.
 *
 * Implements the core `ChannelActivityRenderer` port. The clock (optional) only
 * feeds the elapsed-time suffix — never raw `Date.now()` (Pitfall 7).
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  ActivityEvent,
  TurnOutcome,
  ClockPort,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { eventLabel } from "./render.js";

/** IRC's hard per-line cap (§7.1). Overlong lines truncate with the ellipsis. */
const MAX_LINE_CHARS = 512;
const ELLIPSIS = "…";

export interface LinePerEventDeps {
  actions: ActivityRenderActions;
  /** Optional — supplies the elapsed-time suffix on the success closing line. */
  clock?: ClockPort;
  /**
   * Per-event line builder (APV-02 / APV-10, §6.4.6 / §18.3). Default: `eventLabel`
   * (the redacted `defaultLabel`). A depth-aware plain-text channel (IRC) overrides
   * it to render a `kind:"approval"` event as the plain-text prompt
   * ("Reply approve or deny …", with shortIds when more than one is pending) and a
   * `kind:"subagent"` event with a `↳ ` depth prefix. Receives the frame's full
   * visible set so the override can derive the >1-pending disambiguation. Returns
   * the line BEFORE the 512-char cap (the strategy still truncates).
   */
  lineFor?: (event: ActivityEvent, visibleEvents: readonly ActivityEvent[]) => string;
}

/** Truncate a single line to the 512-char cap, marking the cut with an ellipsis. */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

export function createLinePerEventRenderer(deps: LinePerEventDeps): ChannelActivityRenderer {
  const { actions, clock } = deps;
  const lineFor = deps.lineFor ?? ((event) => eventLabel(event));

  let stepCount = 0;
  let startMs: number | undefined;

  return {
    strategy: "LinePerEvent",
    canEdit: false,
    canDelete: false,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      if (startMs === undefined && clock !== undefined) startMs = clock.now();

      const byId = new Map<string, ActivityEvent>();
      for (const e of frame.visibleEvents) byId.set(e.activityId, e);

      for (const addedId of frame.changeSet.added) {
        const ev = byId.get(addedId);
        if (ev === undefined) continue;
        const sent = await actions.send(capLine(lineFor(ev, frame.visibleEvents)));
        if (!sent.ok) return sent;
        stepCount += 1;
      }
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      switch (outcome.kind) {
        case "success":
        case "success_with_recovered_failures": {
          if (outcome.kind === "success" && outcome.trivial) return ok(undefined);
          let line = `✓ done · ${stepCount} steps`;
          if (clock !== undefined && startMs !== undefined) {
            const elapsedS = ((clock.now() - startMs) / 1000).toFixed(1);
            line += ` · ${elapsedS}s`;
          }
          const sent = await actions.send(capLine(line));
          if (!sent.ok) return sent;
          return ok(undefined);
        }

        case "failure": {
          const sent = await actions.send(capLine(`[ERR] ${outcome.errorKind}`));
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
