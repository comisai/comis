// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the codex profile's perception patterns + their end-to-end classification
 * (CLASSIFY-01/02, v2.26 Phase 168) — the Codex `Working (Ns)` working-line is the named case.
 *
 * The classifier consumes `codexProfile.perception` (fed by the worker via the codex allowId),
 * layered on the generic structural detection — a settled working-line frame is `working`, a
 * Codex selection menu is `awaiting-input`. No-profile behaviour is unchanged (INV-1, covered in
 * terminal-classifier.test.ts).
 */

import { describe, it, expect } from "vitest";

import { classifyFrame, type ClassifierFrame } from "../../terminal-classifier.js";
import type { EmulatorSnapshot } from "../../terminal-render.js";
import { codexProfile } from "./profile.js";

const perc = codexProfile.perception!;
const matches = (patterns: readonly RegExp[] | undefined, s: string) =>
  (patterns ?? []).some((re) => re.test(s));

/** A settled classifier frame over `lines` with the codex profile's perception wired. */
function classifyCodex(
  lines: string[],
  cursor: { x: number; y: number },
  noProgressMs = 0,
): ReturnType<typeof classifyFrame> {
  const snapshot: EmulatorSnapshot = { screen: lines.join("\n"), cursor, cols: 80, rows: 24, alt: false };
  const frame: ClassifierFrame = {
    alive: true,
    settled: true,
    diffEmpty: true,
    snapshot,
    perception: codexProfile.perception,
  };
  return classifyFrame(frame, { noProgressMs, stuckMs: 5_000 });
}

describe("codexProfile — identity (PROFILE-02) + no render transform", () => {
  it("declares the codex allowId and version, and carries no render transform", () => {
    expect(codexProfile.id).toBe("codex");
    expect(codexProfile.allowIds).toContain("codex");
    expect(codexProfile.transformSnapshot).toBeUndefined(); // codex has no ghost-strip
  });
});

describe("codexProfile.perception — patterns + end-to-end classification (CLASSIFY-01/02)", () => {
  it("workingLine matches the canonical `Working (Ns)`, the banner, and the ascii spinner", () => {
    expect(matches(perc.workingLine, "Working (12s)")).toBe(true);
    expect(matches(perc.workingLine, "Working on your request...")).toBe(true);
    expect(matches(perc.workingLine, "  | thinking")).toBe(true);
    expect(matches(perc.workingLine, "I am working on the fix now")).toBe(false);
  });

  it("menuOrPicker matches a Codex selection menu", () => {
    expect(matches(perc.menuOrPicker, "Select approval mode")).toBe(true);
    expect(matches(perc.menuOrPicker, "Select sandbox")).toBe(true);
  });

  it("classifies a `Working (Ns)` frame (unparked, past stuck) → working, not stuck (the Codex fix)", () => {
    const c = classifyCodex(["Working (12s)", "reading the project files", "more output", "and more"], { x: 4, y: 0 }, 10_000);
    expect(c.state).toBe("working");
    expect(c.reason).toBe("working_line");
  });

  it("classifies a text-only Codex approval menu → awaiting-input", () => {
    const c = classifyCodex(["Select approval mode", "auto", "manual", ""], { x: 0, y: 3 }, 10_000);
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });
});
