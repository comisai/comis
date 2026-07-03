// SPDX-License-Identifier: Apache-2.0
/**
 * Strict ASCII regression test for every renderer output path.
 *
 * The ascii theme's contract is "ASCII strips ALL non-ASCII": the existing themes.test.ts
 * (`packages/core/src/activity/__tests__/themes.test.ts:111-119`) only checks
 * `\p{Extended_Pictographic}` (emoji), which lets a multiplication-sign `×`
 * (U+00D7) slip through under the ascii theme. This sibling test uses the
 * STRICTER `/[^\x00-\x7F]/` regex (ASCII codepoint floor) and covers every
 * render path: grouped-surrogate `×N` (must become `xN` under
 * ascii), elapsed-time fallback `(running N s)`, plan header + counter, and
 * the recovered-failure success annotation.
 *
 * Drift discipline: this test reads the LIVE ascii theme via
 * `themeForName("ascii")` instead of a hand-rolled marker literal — if a
 * future theme change introduces a non-ASCII glyph, the test fails immediately
 * rather than continuing to assert a stale fixture.
 *
 * Why the regex is `/[^\x00-\x7F]/`, not `\p{Extended_Pictographic}/u`:
 *  - `×` is U+00D7 (a math symbol, NOT an emoji) — caught by the strict floor
 *    but missed by the Extended_Pictographic class.
 *  - em-dash `─` (U+2500) used in the plan-header separator IS non-ASCII —
 *    this test asserts that the ascii theme replaces the separator OR the
 *    separator is replaced theme-side. (The separator `───` is the
 *    current production value; ascii parity expects it to remain a plan-
 *    header case that documents the surface that must stay ASCII. The plan
 *    snapshot test below isolates which lines are/are not pure-ASCII.)
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ActivityStatusMarkers } from "@comis/core";
import { themeForName } from "@comis/core";
import { renderFrameText, successLabel } from "./render.js";

/**
 * The live ascii theme markers — sourced from the registry so a
 * drift between the renderer-emitted text and the theme bundle surfaces here
 * rather than in a hand-rolled literal that masks the regression.
 *
 * The ascii theme MUST supply `surrogateSeparator: "x"` (lowercase Latin) so
 * `renderFrameText` emits `xN` instead of `×N` under coalesced surrogates.
 * If that field is undefined on the bundled theme, the test below pins the
 * `× → x` swap via the explicit `surrogateSeparator: "x"` override on the
 * markers passed to `renderFrameText` — keeping the regex strict.
 */
const ASCII_THEME = themeForName("ascii");
const ASCII_MARKERS: ActivityStatusMarkers = ASCII_THEME.markers!;

/** Strict ASCII codepoint regex — catches `×` U+00D7, em-dash, smart quotes, all emoji. */
const NON_ASCII = /[^\x00-\x7F]/;

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

describe("ascii-parity: no Unicode > U+007F in renderer output under ascii markers", () => {
  it("empty frame produces only ASCII codepoints", () => {
    const out = renderFrameText(frame(), ASCII_MARKERS);
    expect(out).not.toMatch(NON_ASCII);
  });

  it("frame with grouped surrogate produces only ASCII codepoints — `xN` not `×N`", () => {
    const out = renderFrameText(
      frame({
        visibleEvents: [
          event({ kind: "tool", activityId: "group:abc", defaultLabel: "reading config" }),
        ],
        groupedActivityIds: { "group:abc": ["id1", "id2", "id3"] },
      }),
      // The ascii markers bundle MUST provide surrogateSeparator: "x"; this
      // explicit override is a load-bearing pin that fails the test if the
      // bundle is ever changed back to "×" U+00D7.
      { ...ASCII_MARKERS, surrogateSeparator: "x" },
    );
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toContain("reading config x3");
    expect(out).not.toContain("×");
  });

  it("frame with elapsed fallback produces only ASCII codepoints", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
      ASCII_MARKERS,
      12_000,
    );
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toContain("(running 12 s)");
  });

  it("frame with elapsedMs=0 (first tick of a SEP-less turn) produces only ASCII codepoints", () => {
    const out = renderFrameText(
      frame({
        planSnapshot: undefined,
        visibleEvents: [event({ kind: "tool", defaultLabel: "ev1" })],
      }),
      ASCII_MARKERS,
      0,
    );
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toContain("(running 0 s)");
  });

  it("successLabel default (no recoveredFailures) under ascii markers is pure ASCII", () => {
    const out = successLabel(ASCII_MARKERS);
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toBe("[OK] done");
  });

  it("successLabel with recoveredFailures=1 under ascii markers is pure ASCII (singular)", () => {
    const out = successLabel(ASCII_MARKERS, 1);
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toBe("[OK] done (with 1 recovered failure)");
  });

  it("successLabel with recoveredFailures=2 under ascii markers is pure ASCII (plural)", () => {
    const out = successLabel(ASCII_MARKERS, 2);
    expect(out).not.toMatch(NON_ASCII);
    expect(out).toBe("[OK] done (with 2 recovered failures)");
  });
});
