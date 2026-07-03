// SPDX-License-Identifier: Apache-2.0
/**
 * Shared render-helper tests (event labels, frame text, closing lines + the
 * subagent render side).
 *
 * Covers the channel-agnostic text helpers:
 *   - `eventLabel` / `renderFrameText`: best-effort short label + one line per
 *     event, drawn from the already-redacted hints only (never raw params).
 *   - `failureLabel`: the closing `❌ {errorKind}` form.
 *   - subagent parent line: a `kind:"subagent"` event's `defaultLabel` carries
 *     the `🤖` marker (set by the projection); `renderFrameText` paints it
 *     verbatim, and `subagentLine(event, { depthPrefix })` reproduces the IRC
 *     `↳ ` form (the depth prefix is applied by the IRC renderer).
 *
 * Plus a type-level assertion that the extended `ActivityRenderActions.send`
 * now accepts an optional approval-`buttons` argument so a renderer can paint
 * native choices (the port carries approval choices).
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { Result } from "@comis/shared";
import type {
  ActivityEvent,
  ActivityRenderError,
  ActivityRenderFrame,
  RichButton,
} from "@comis/core";
import { eventLabel, renderFrameText, failureLabel, successLabel, subagentLine } from "./render.js";
import type { ActivityRenderActions } from "./actions.js";

/**
 * Build a render frame with sensible defaults. `renderFrameText(frame,
 * markers?)` consumes the whole frame; tests construct one via this factory
 * instead of passing a bare events array.
 */
function frame(partial: Partial<ActivityRenderFrame> = {}): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: [],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
    ...partial,
  };
}

/** The ascii theme's markers: bracketed pure-ASCII tags, zero emoji. */
const ASCII_MARKERS = { success: "[OK]", failure: "[ERR]", subagent: "[SUB]", running: "[..]" } as const;
/** The default theme's markers: today's hardcoded closing-line glyphs. */
const DEFAULT_THEME_MARKERS = { success: "✓", failure: "❌", subagent: "🤖", running: "🔧" } as const;

function event(partial: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "sess",
    agentId: "agent",
    traceId: "trace",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    semanticPhase: "tool",
    ...partial,
  } as ActivityEvent;
}

describe("eventLabel", () => {
  it("prefers defaultLabel, then toolName, then kind (with running 🔧 marker on non-failed events)", () => {
    // eventLabel prepends the
    // themed running marker on non-failed non-subagent events; the precedence
    // contract (defaultLabel → toolName → kind) rides UNCHANGED inside the
    // marker prefix.
    expect(eventLabel(event({ kind: "tool", defaultLabel: "searching", toolName: "search" }))).toBe(
      "🔧 searching",
    );
    expect(eventLabel(event({ kind: "tool", toolName: "search" }))).toBe("🔧 search");
    expect(eventLabel(event({ kind: "model" }))).toBe("🔧 model");
  });
});

describe("renderFrameText", () => {
  it("joins one label per event in display order", () => {
    // Each non-failed non-subagent event
    // line carries the running 🔧 marker (eventLabel re-derives it for
    // events that arrive bare); the ordering contract is what this pins.
    const out = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", defaultLabel: "a" }),
          event({ kind: "tool", defaultLabel: "b" }),
        ],
      }),
    );
    expect(out).toBe("🔧 a\n🔧 b");
  });

  it("paints a subagent event's 🤖-marked defaultLabel verbatim", () => {
    // The projection sets `🤖`-prefixed defaultLabel (activity-stream);
    // the text path renders it unchanged — Discord/Slack key the thread shell
    // off the 🤖 marker in the sent text.
    const out = renderFrameText(
      frame({
        visibleEvents: [event({ kind: "subagent", defaultLabel: "🤖 subagent: 3 steps" })],
      }),
    );
    expect(out).toBe("🤖 subagent: 3 steps");
  });

  // Plan-state header + (step N of M) counter.
  //
  // The `frame()` factory above keeps
  // every call-site uniform; the plan-aware render adds three above-the-event
  // lines (`renderPlan` output + bounded counter + `───` separator).

  it("with no plan snapshot returns only the joined event list (no header lines)", () => {
    // No SEP header → event lines only.
    // Each non-failed event line carries the running 🔧 (per-step marker
    // re-derived by eventLabel); the no-header contract is the invariant.
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [
          event({ kind: "tool", defaultLabel: "first" }),
          event({ kind: "tool", defaultLabel: "second" }),
        ],
      }),
    );
    expect(out).toBe("🔧 first\n🔧 second");
    expect(out).not.toContain("[x]");
    expect(out).not.toContain("(step ");
    expect(out).not.toContain("───");
  });

  it("with a plan snapshot prefixes renderPlan output + (step 2 of 3) + ─── separator above the events", () => {
    // Checkbox header above events, plus a bounded
    // `(step N of M)` line where N is the in_progress entry's 1-based index.
    const out = renderFrameText(
      frame({
        planSnapshot: {
          entries: [
            { id: "0", label: "step a", status: "done" },
            { id: "1", label: "step b", status: "in_progress" },
            { id: "2", label: "step c", status: "pending" },
          ],
        },
        visibleEvents: [
          event({ kind: "tool", defaultLabel: "ev1" }),
          event({ kind: "tool", defaultLabel: "ev2" }),
        ],
      }),
    );
    expect(out).toBe(
      // Per-event lines carry the running
      // 🔧 marker; the SEP header + (step N of M) + ─── separator render
      // above them.
      "[x] step a\n[~] step b\n[ ] step c\n(step 2 of 3)\n───\n🔧 ev1\n🔧 ev2",
    );
  });

  it("computes the (step N of M) counter from the in_progress entry's 1-based index", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: {
          entries: [
            { id: "0", label: "a", status: "done" },
            { id: "1", label: "b", status: "done" },
            { id: "2", label: "c", status: "done" },
            { id: "3", label: "d", status: "in_progress" },
            { id: "4", label: "e", status: "pending" },
          ],
        },
      }),
    );
    expect(out).toContain("(step 4 of 5)");
  });

  it("omits the (step N of M) line when no entry is in_progress (all done or all pending)", () => {
    const allPending = renderFrameText(
      frame({
        planSnapshot: {
          entries: [
            { id: "0", label: "a", status: "pending" },
            { id: "1", label: "b", status: "pending" },
          ],
        },
      }),
    );
    expect(allPending).not.toContain("(step ");
    expect(allPending).toContain("───");

    const allDone = renderFrameText(
      frame({
        planSnapshot: {
          entries: [
            { id: "0", label: "a", status: "done" },
            { id: "1", label: "b", status: "done" },
          ],
        },
      }),
    );
    expect(allDone).not.toContain("(step ");
    expect(allDone).toContain("───");
  });

  // --- ×N / xN surrogate count ------------------------------
  //
  // When a visible event represents a coalesced surrogate
  // (`frame.groupedActivityIds[event.activityId].length > 1`), the rendered
  // line is `${eventLabel(event)} ×${count}` under default markers and
  // `${eventLabel(event)} x${count}` under ascii markers (the ascii theme
  // strips ALL non-ASCII via `surrogateSeparator: "x"`).

  it("appends ×N for surrogate event with constituent count > 1 (default theme)", () => {
    const out = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", activityId: "group:abc", defaultLabel: "reading config" }),
        ],
        groupedActivityIds: { "group:abc": ["id1", "id2", "id3"] },
      }),
    );
    expect(out).toContain("reading config ×3");
  });

  it("does NOT append ×N for non-surrogate event (subagent collapse uses parentActivityId, not groupedActivityIds)", () => {
    // The per-event running 🔧 is prepended on
    // the bare base label; the no-×N contract is the load-bearing
    // invariant of this test — the `not.toContain("×")`
    // assertions pin it.
    // length === 0 (key absent) — single non-coalesced event.
    const outNoEntry = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", activityId: "tool:xyz", defaultLabel: "reading config" }),
        ],
        groupedActivityIds: {},
      }),
    );
    expect(outNoEntry).toBe("🔧 reading config");
    expect(outNoEntry).not.toContain("×");

    // length === 1 — a single-element grouped entry is NOT a coalesced surrogate.
    const outSingleton = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", activityId: "group:single", defaultLabel: "reading config" }),
        ],
        groupedActivityIds: { "group:single": ["id1"] },
      }),
    );
    expect(outSingleton).toBe("🔧 reading config");
    expect(outSingleton).not.toContain("×");
  });

  it("uses ascii separator x under ascii markers (ASCII-strict theme)", () => {
    const out = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", activityId: "group:abc", defaultLabel: "reading config" }),
        ],
        groupedActivityIds: { "group:abc": ["id1", "id2", "id3"] },
      }),
      // surrogateSeparator: "x" (lowercase) — ascii-strict; default theme uses "×" (U+00D7).
      { ...ASCII_MARKERS, surrogateSeparator: "x" },
    );
    expect(out).toContain("reading config x3");
    expect(out).not.toContain("×");
  });

  // --- Failure marker on kept failed end events ----------------------------
  //
  // A failed tool call's kept
  // end event arrives with `status:"failed"` + a bare `defaultLabel` (the
  // running 🔧 is baked into START events only at the activity-stream emit
  // site, by design — the marker conveys in-flight status).
  // Rendering the bare label would paint the failure
  // as "using yfinance · get stock price" with NO marker — the user
  // couldn't tell the call failed. So when `event.status === "failed"`,
  // the themed failure marker is prefixed (default: ❌, ascii: [ERR]).

  it("prefixes ❌ on a kept failed end event (failure marker on terminal failure state)", () => {
    const failedFrame = frame({
      visibleEvents: [
        event({
          kind: "tool",
          phase: "end",
          status: "failed",
          defaultLabel: "using yfinance · get stock price",
          errorKind: "dependency",
        }),
      ],
    });
    // Default-theme fallback (no markers arg) — must inject ❌ via the
    // DEFAULT_MARKERS fallback in eventLabel (mirrors failureLabel's pattern).
    expect(renderFrameText(failedFrame)).toBe("❌ using yfinance · get stock price");
    // Explicitly-supplied default markers — same output, byte-identical.
    expect(renderFrameText(failedFrame, DEFAULT_THEME_MARKERS)).toBe(
      "❌ using yfinance · get stock price",
    );
    // Ascii theme — failure glyph becomes the bracketed [ERR] tag, no emoji.
    expect(renderFrameText(failedFrame, ASCII_MARKERS)).toBe(
      "[ERR] using yfinance · get stock price",
    );
  });

  // Contract-pin: a kept COMPLETED end event does NOT carry the per-step ✓.
  // The closing line carries the single ✓ done; per-step ✓ would
  // clutter the running flow.
  //
  // The kept end event
  // carries the per-step running marker (🔧 / [..]) — keeping
  // symmetry between fast and slow tool calls. The
  // load-bearing invariant of this test is ✓-absence on completed end
  // events (so the running flow stays calm and the closing ✓ done is the only
  // success marker); the running-marker presence is the companion contract.
  // The ✓-absence assertion is preserved below.
  it("does NOT prefix the success ✓ on a kept completed end event (no per-step ✓ during running phase)", () => {
    const completedFrame = frame({
      visibleEvents: [
        event({
          kind: "tool",
          phase: "end",
          status: "completed",
          defaultLabel: "doing the thing",
          durationMs: 2300,
        }),
      ],
    });
    expect(renderFrameText(completedFrame)).toBe("🔧 doing the thing");
    expect(renderFrameText(completedFrame, DEFAULT_THEME_MARKERS)).toBe("🔧 doing the thing");
    expect(renderFrameText(completedFrame, ASCII_MARKERS)).toBe("[..] doing the thing");
    // The no-per-step-✓ invariant (the original load-bearing point) holds:
    // neither the default ✓ nor the ascii [OK] appears on a kept end event.
    expect(renderFrameText(completedFrame)).not.toContain("✓");
    expect(renderFrameText(completedFrame, DEFAULT_THEME_MARKERS)).not.toContain("✓");
    expect(renderFrameText(completedFrame, ASCII_MARKERS)).not.toContain("[OK]");
  });

  // --- Running marker symmetry on kept end events ---------------------------
  //
  // Via coalesce.ts Step 1.5's prefer-end dedup,
  // slow-completed events (>=1500ms, exempt from isDroppableFastSuccess)
  // survive Step 1 with BOTH start and end events kept; Step 1.5 then keeps
  // the END (whose defaultLabel has no 🔧 baked in — the running marker is
  // baked on START events only). Without re-derivation a slow fetch
  // (e.g. 1676ms) renders as "fetching <host>/<path>" with NO running glyph —
  // asymmetric with sub-1500ms calls whose marked START survives Step 1 and
  // shows 🔧. The contract: every in-flight tool step shows the running
  // glyph regardless of duration.
  //
  // So eventLabel re-derives the running marker for non-failed events whose
  // defaultLabel arrives bare (idempotent on already-marked start events;
  // failed events still take the ❌ branch;
  // kind:"subagent" events keep their projection-baked 🤖 marker verbatim).

  it("prefixes 🔧 on a kept slow-completed end event with bare defaultLabel (running-marker symmetry)", () => {
    const slowCompletedFrame = frame({
      visibleEvents: [
        event({
          kind: "tool",
          phase: "end",
          status: "completed",
          defaultLabel: "fetching finance.yahoo.com/IBM",
          durationMs: 1676,
        }),
      ],
    });
    // Default-theme fallback (no markers arg) — the running glyph must be
    // re-derived via the DEFAULT_RUNNING_MARKER fallback.
    expect(renderFrameText(slowCompletedFrame)).toBe("🔧 fetching finance.yahoo.com/IBM");
    // Explicitly-supplied default markers — byte-identical output.
    expect(renderFrameText(slowCompletedFrame, DEFAULT_THEME_MARKERS)).toBe(
      "🔧 fetching finance.yahoo.com/IBM",
    );
    // Ascii theme — running glyph becomes the bracketed [..] tag, no emoji.
    expect(renderFrameText(slowCompletedFrame, ASCII_MARKERS)).toBe(
      "[..] fetching finance.yahoo.com/IBM",
    );
  });

  it("does NOT double-prepend the running marker on a start event whose defaultLabel already carries 🔧 (idempotency)", () => {
    const startFrame = frame({
      visibleEvents: [
        event({
          kind: "tool",
          phase: "start",
          status: "running",
          defaultLabel: "🔧 searching the web for IBM stock price",
        }),
      ],
    });
    // Default-theme fallback — already-marked start event passes through
    // unchanged (no leading "🔧 🔧 ").
    expect(renderFrameText(startFrame)).toBe("🔧 searching the web for IBM stock price");
    expect(renderFrameText(startFrame, DEFAULT_THEME_MARKERS)).toBe(
      "🔧 searching the web for IBM stock price",
    );
    // Ascii theme: the baked-in 🔧 is NOT the ascii running marker ([..]),
    // so the prefix check (`startsWith("[..] ")`) is false and [..] is
    // prepended. Pinning this prevents an over-eager "strip baked emoji"
    // fix — the baked emoji is data; the theme marker is presentation.
    expect(renderFrameText(startFrame, ASCII_MARKERS)).toBe(
      "[..] 🔧 searching the web for IBM stock price",
    );
  });

  // --- elapsed-time fallback when no plan is active --------
  //
  // When `frame.planSnapshot` is undefined AND the strategy supplies an
  // elapsedMs value, the rendered text appends a `(running N s)` line where
  // N is the elapsedMs floored to whole seconds.

  it("emits elapsed-time fallback (running 12 s) when planSnapshot is undefined", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
      undefined,
      12_345,
    );
    expect(out).toContain("(running 12 s)");
  });

  it("does NOT emit elapsed fallback when planSnapshot is present (no double-display)", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: {
          entries: [{ id: "0", label: "a", status: "in_progress" }],
        },
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
      undefined,
      12_345,
    );
    expect(out).not.toContain("(running");
  });

  it("does NOT emit elapsed fallback when elapsedMs is undefined", () => {
    // The event line carries the running
    // 🔧 marker; the no-elapsed-fallback contract (no `(running …)`
    // suffix) is the load-bearing invariant.
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
    );
    expect(out).toBe("🔧 ev1");
    expect(out).not.toContain("(running");
  });

  it("emits (running 0 s) when elapsedMs is 0 (first tick of a SEP-less turn)", () => {
    // A freshly-captured `startedAtMs === clock.now()` produces elapsedMs=0
    // on the first apply(); the renderer must treat 0 as a legitimate
    // first-tick value, NOT as "no value". The strategies that capture
    // `startedAtMs` on first apply() depend on this branch.
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
      undefined,
      0,
    );
    expect(out).toContain("(running 0 s)");
  });
});

// --- successLabel(markers?, recoveredFailures?) ---------------
//
// When a turn completes with `recoveredFailures > 0`, the closing
// success line carries `(with N recovered failure[s])` after the base label.

describe("successLabel recoveredFailures annotation", () => {
  it("without recoveredFailures arg returns the base check-done label", () => {
    expect(successLabel(DEFAULT_THEME_MARKERS)).toBe("✓ done");
  });

  it("with recoveredFailures=1 appends (with 1 recovered failure) — singular", () => {
    expect(successLabel(DEFAULT_THEME_MARKERS, 1)).toBe("✓ done (with 1 recovered failure)");
  });

  it("with recoveredFailures=2 uses plural failures", () => {
    expect(successLabel(DEFAULT_THEME_MARKERS, 2)).toBe("✓ done (with 2 recovered failures)");
  });

  it("with recoveredFailures=0 returns the base label (no annotation)", () => {
    expect(successLabel(DEFAULT_THEME_MARKERS, 0)).toBe("✓ done");
  });
});

describe("subagentLine", () => {
  it("prefixes the event label with the supplied depth prefix (IRC ↳ form)", () => {
    const ev = event({ kind: "subagent", defaultLabel: "subagent: search" });
    expect(subagentLine(ev, { depthPrefix: "↳ " })).toBe("↳ subagent: search");
  });

  it("defaults to no prefix (the bare label) when depthPrefix is omitted", () => {
    const ev = event({ kind: "subagent", defaultLabel: "🤖 subagent done" });
    expect(subagentLine(ev)).toBe("🤖 subagent done");
  });
});

describe("failureLabel", () => {
  it("formats the closing ❌ {errorKind} by default (marker-less byte parity)", () => {
    // No markers arg → the hardcoded glyph, byte-identical to the default theme's output.
    expect(failureLabel({ kind: "failure", errorKind: "timeout" })).toBe("❌ timeout");
  });

  it("is byte-identical to the cross glyph when the default theme markers are passed", () => {
    // Passing the default bundle's markers must reproduce the marker-less output exactly.
    expect(failureLabel({ kind: "failure", errorKind: "timeout" }, DEFAULT_THEME_MARKERS)).toBe(
      "❌ timeout",
    );
  });

  it("failure label uses the ascii marker and drops the cross emoji", () => {
    // The ascii theme strips ALL emoji: the closing failure line carries
    // the bracketed `[ERR]` tag and NO `❌`.
    const out = failureLabel({ kind: "failure", errorKind: "timeout" }, ASCII_MARKERS);
    expect(out).toBe("[ERR] timeout");
    expect(out).not.toContain("❌");
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("interpolates only the closed-union errorKind after the themed marker", () => {
    // The marker carries the errorKind only — never raw outcome internals.
    expect(failureLabel({ kind: "failure", errorKind: "dependency" }, ASCII_MARKERS)).toBe(
      "[ERR] dependency",
    );
  });

  it("appends the one-line reason for a resource abort so the label reads truthfully (never platform)", () => {
    // A max_steps / loop abort carries a fixed one-line reason; the label must
    // read "❌ resource — <reason>", never the bare "❌ platform" mislabel.
    const out = failureLabel({
      kind: "failure",
      errorKind: "resource",
      failedEvents: [],
      reason: "stopped — hit step limit",
    });
    expect(out).toBe("❌ resource — stopped — hit step limit");
    expect(out).not.toContain("platform");
  });

  it("omits the reason separator when no reason is present (byte parity preserved)", () => {
    // A failure with no reason must be byte-identical to the historical output.
    expect(failureLabel({ kind: "failure", errorKind: "timeout", failedEvents: [] })).toBe(
      "❌ timeout",
    );
  });
});

describe("successLabel", () => {
  it("success label is the bare check-done form by default", () => {
    // No markers arg → today's hardcoded edit-place success literal, byte-identical.
    expect(successLabel()).toBe("✓ done");
  });

  it("is byte-identical to the check-done glyph when the default theme markers are passed", () => {
    expect(successLabel(DEFAULT_THEME_MARKERS)).toBe("✓ done");
  });

  it("success label uses the ascii marker and drops the check emoji", () => {
    // The ascii theme strips ALL emoji: the windowed-edit success line
    // carries the bracketed `[OK]` tag and NO `✓`.
    const out = successLabel(ASCII_MARKERS);
    expect(out).toBe("[OK] done");
    expect(out).not.toContain("✓");
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("ActivityRenderActions.send (extended port)", () => {
  it("accepts an optional approval-buttons argument (type-level)", () => {
    // The extended port lets a renderer paint native approval choices. The
    // existing `send(text)` shape stays valid; `send(text, { buttons })` is the
    // additive overload the approval renderers consume.
    expectTypeOf<ActivityRenderActions["send"]>().parameters.toMatchTypeOf<
      [string, { buttons?: RichButton[][] }?]
    >();
  });

  it("a recorder implementing the extended port still satisfies the type with text-only send", () => {
    // Backward-compatible: an impl that ignores buttons still satisfies the port.
    const sent: Array<{ text: string; buttons?: RichButton[][] }> = [];
    const actions: ActivityRenderActions = {
      async send(text, opts): Promise<Result<string, ActivityRenderError>> {
        sent.push({ text, buttons: opts?.buttons });
        return { ok: true, value: "msg-0" };
      },
      async edit(): Promise<Result<void, ActivityRenderError>> {
        return { ok: true, value: undefined };
      },
      async delete(): Promise<Result<void, ActivityRenderError>> {
        return { ok: true, value: undefined };
      },
    };
    expectTypeOf(actions.send).toBeFunction();
    expect(sent).toEqual([]);
  });
});
