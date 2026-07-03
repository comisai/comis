// SPDX-License-Identifier: Apache-2.0
/**
 * LinePerEvent — one short line per event + a closing summary line.
 * Used by IRC (no edit, no delete, 512-char line cap).
 *
 * State machine:
 *   - `apply(frame)`: for each event newly visible in this frame
 *     (`frame.changeSet.added`), emit one line. A line longer than the 512-char
 *     IRC cap is truncated with "…" (IRC rejects/splits overlong lines).
 *   - `finalize`:
 *       • success (non-trivial): one closing line "<success> done · N steps · Xs"
 *         (N = lines emitted; Xs = elapsed since the first line, when a clock is
 *         injected). The success/failure glyph follows the resolved theme
 *         `markers`; omitting them yields the default `✓`/`[ERR]`.
 *       • failure: one closing line "<failure> {errorKind}".
 *       • trivial / silent / aborted: no closing line.
 *
 * Implements the core `ChannelActivityRenderer` port. The clock (optional) only
 * feeds the elapsed-time suffix — never raw `Date.now()` (injected time keeps
 * tests deterministic).
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  ActivityEvent,
  TurnOutcome,
  ClockPort,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "./actions.js";
import { eventLabel } from "./render.js";

/**
 * Closing-line glyphs when no theme markers are injected (default-theme parity).
 *
 * LinePerEvent does NOT route through the shared `successLabel`/`failureLabel`
 * helpers: IRC's defaults differ from the windowed-edit channels — the success
 * line is the composed `"✓ done · N steps · Xs"` (not `"✓ done"`) and the failure
 * line is `"[ERR] {errorKind}"` (a bracketed ASCII tag, NOT the `❌` the shared
 * `DEFAULT_MARKERS` use). These two literals are the established IRC defaults; a
 * marker-less call MUST stay byte-identical to them (golden-fixture parity).
 */
const DEFAULT_SUCCESS_MARKER = "✓";
const DEFAULT_FAILURE_MARKER = "[ERR]";

/** IRC's hard per-line cap. Overlong lines truncate with the ellipsis. */
const MAX_LINE_CHARS = 512;
const ELLIPSIS = "…";

export interface LinePerEventDeps {
  actions: ActivityRenderActions;
  /** Optional — supplies the elapsed-time suffix on the success closing line. */
  clock?: ClockPort;
  /**
   * Per-event line builder. Default: `eventLabel`
   * (the redacted `defaultLabel`). A depth-aware plain-text channel (IRC) overrides
   * it to render a `kind:"approval"` event as the plain-text prompt
   * ("Reply approve or deny …", with shortIds when more than one is pending) and a
   * `kind:"subagent"` event with a `↳ ` depth prefix. Receives the frame's full
   * visible set so the override can derive the >1-pending disambiguation. Returns
   * the line BEFORE the 512-char cap (the strategy still truncates).
   */
  lineFor?: (event: ActivityEvent, visibleEvents: readonly ActivityEvent[]) => string;
  /**
   * Resolved theme status markers. The success/failure glyphs on the
   * closing summary line follow these. Omitted → the IRC defaults
   * (`✓` success, `[ERR]` failure), keeping a marker-less call byte-identical to
   * the fixture-pinned output. Only `success`/`failure` are read (the closing line
   * paints neither `subagent` nor `running`).
   */
  markers?: ActivityStatusMarkers;
}

/** Truncate a single line to the 512-char cap, marking the cut with an ellipsis. */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

export function createLinePerEventRenderer(deps: LinePerEventDeps): ChannelActivityRenderer {
  const { actions, clock, markers } = deps;
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
          let line = `${markers?.success ?? DEFAULT_SUCCESS_MARKER} done · ${stepCount} steps`;
          if (clock !== undefined && startMs !== undefined) {
            const elapsedS = ((clock.now() - startMs) / 1000).toFixed(1);
            line += ` · ${elapsedS}s`;
          }
          const sent = await actions.send(capLine(line));
          if (!sent.ok) return sent;
          return ok(undefined);
        }

        case "failure": {
          const sent = await actions.send(
            capLine(`${markers?.failure ?? DEFAULT_FAILURE_MARKER} ${outcome.errorKind}`),
          );
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
