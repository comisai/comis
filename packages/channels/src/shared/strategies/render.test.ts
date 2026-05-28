// SPDX-License-Identifier: Apache-2.0
/**
 * Shared render-helper tests (§7.2 / §7.3 + APV-02/03 subagent render side).
 *
 * Covers the channel-agnostic text helpers:
 *   - `eventLabel` / `renderFrameText`: best-effort short label + one line per
 *     event, drawn from the already-redacted hints only (never raw params).
 *   - `failureLabel`: the closing `❌ {errorKind}` form.
 *   - subagent parent line: a `kind:"subagent"` event's `defaultLabel` carries
 *     the `🤖` marker (set by the projection); `renderFrameText` paints it
 *     verbatim, and `subagentLine(event, { depthPrefix })` reproduces the IRC
 *     `↳ ` form (the depth prefix is applied by the renderer, §18.3 IRC row).
 *
 * Plus a type-level assertion that the extended `ActivityRenderActions.send`
 * now accepts an optional approval-`buttons` argument so a renderer can paint
 * native choices (the port carries approval choices for 73-08/09).
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
 * Build a render frame with sensible defaults. WS-D `renderFrameText(frame,
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

/** The ascii theme's markers (75-01): bracketed pure-ASCII tags, zero emoji. */
const ASCII_MARKERS = { success: "[OK]", failure: "[ERR]", subagent: "[SUB]", running: "[..]" } as const;
/** The default theme's markers (75-01): today's hardcoded closing-line glyphs. */
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
  it("prefers defaultLabel, then toolName, then kind", () => {
    expect(eventLabel(event({ kind: "tool", defaultLabel: "searching", toolName: "search" }))).toBe(
      "searching",
    );
    expect(eventLabel(event({ kind: "tool", toolName: "search" }))).toBe("search");
    expect(eventLabel(event({ kind: "model" }))).toBe("model");
  });
});

describe("renderFrameText", () => {
  it("joins one label per event in display order", () => {
    const out = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", defaultLabel: "a" }),
          event({ kind: "tool", defaultLabel: "b" }),
        ],
      }),
    );
    expect(out).toBe("a\nb");
  });

  it("paints a subagent event's 🤖-marked defaultLabel verbatim", () => {
    // The projection sets `🤖`-prefixed defaultLabel (activity-stream T-73-07);
    // the text path renders it unchanged — Discord/Slack key the thread shell
    // off the 🤖 marker in the sent text.
    const out = renderFrameText(
      frame({
        visibleEvents: [event({ kind: "subagent", defaultLabel: "🤖 subagent: 3 steps" })],
      }),
    );
    expect(out).toBe("🤖 subagent: 3 steps");
  });

  // WS-D Phase 78 — SPEC §8.3 plan-state header + SPEC §8.5 (step N of M).
  //
  // The atomic signature migration (events array -> ActivityRenderFrame) is a
  // combined RED+GREEN per AGENTS.md §2.10 escape: pre-patch test code would
  // not compile against the new signature. The `frame()` factory above keeps
  // every call-site uniform; the plan-aware render adds three above-the-event
  // lines (`renderPlan` output + bounded counter + `───` separator).

  it("with no plan snapshot returns only the joined event list (no header lines)", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [
          event({ kind: "tool", defaultLabel: "first" }),
          event({ kind: "tool", defaultLabel: "second" }),
        ],
      }),
    );
    expect(out).toBe("first\nsecond");
    expect(out).not.toContain("[x]");
    expect(out).not.toContain("(step ");
    expect(out).not.toContain("───");
  });

  it("with a plan snapshot prefixes renderPlan output + (step 2 of 3) + ─── separator above the events", () => {
    // SPEC §8.3: checkbox header above events. SPEC §8.5 first half: a bounded
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
      "[x] step a\n[~] step b\n[ ] step c\n(step 2 of 3)\n───\nev1\nev2",
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
    // No markers arg → today's hardcoded glyph, byte-identical to pre-75-06.
    expect(failureLabel({ kind: "failure", errorKind: "timeout" })).toBe("❌ timeout");
  });

  it("is byte-identical to the cross glyph when the default theme markers are passed", () => {
    // Passing the default bundle's markers must reproduce the legacy output exactly.
    expect(failureLabel({ kind: "failure", errorKind: "timeout" }, DEFAULT_THEME_MARKERS)).toBe(
      "❌ timeout",
    );
  });

  it("failure label uses the ascii marker and drops the cross emoji", () => {
    // The ascii theme strips ALL emoji (UX-01): the closing failure line carries
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
    // The ascii theme strips ALL emoji (UX-01): the windowed-edit success line
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
    // additive overload 73-08/09 consume.
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
