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
import { decideAutoAnswer } from "../../terminal-auto-answer.js";
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

  it("classifies a RECENT `Working (Ns)` frame (unparked) → working via the workingLine path (the Codex fix)", () => {
    const c = classifyCodex(["Working (12s)", "reading the project files", "more output", "and more"], { x: 4, y: 0 }, 0);
    expect(c.state).toBe("working");
    expect(c.reason).toBe("working_line");
  });

  it("does NOT suppress stuck: a frozen `Working (Ns)` PAST the stuck window stays stuck (WR-02 hang hole)", () => {
    const c = classifyCodex(["Working (12s)", "reading the project files", "more output", "and more"], { x: 4, y: 0 }, 10_000);
    expect(c.state).toBe("stuck");
  });

  it("does NOT over-match a markdown `- thinking` bullet into a false working past the stuck window (WR-03/WR-02b)", () => {
    // The anchored ascii-spinner can still match a leading `- thinking` bullet, but the WR-02b
    // noProgressMs<=stuckMs gate means a frame frozen for the whole window is stuck regardless.
    const c = classifyCodex(["- thinking about the design", "still", "more", "and more"], { x: 4, y: 0 }, 10_000);
    expect(c.state).toBe("stuck");
  });

  it("classifies a text-only Codex approval menu → awaiting-input", () => {
    const c = classifyCodex(["Select approval mode", "auto", "manual", ""], { x: 0, y: 3 }, 10_000);
    expect(c.state).toBe("awaiting-input");
    expect(c.reason).toBe("dialog_detected");
  });
});

describe("codexProfile.dialogs — approval overlay is destructive → always escalates (DIALOG-01/02)", () => {
  const dialogs = codexProfile.dialogs!;

  it("the approval-overlay detect matches a run-command approval and is flagged destructive", () => {
    const overlay = dialogs.find((d) => d.name === "approval-overlay")!;
    expect(overlay.detect.test("Allow Codex to run command: npm test")).toBe(true);
    expect(overlay.destructive).toBe(true);
  });

  it("ESCALATES the approval overlay under safe-only — command execution is never auto-approved", () => {
    const screen = "Allow Codex to run command: rm -rf dist";
    expect(decideAutoAnswer("safe-only", screen, [], dialogs)).toEqual({ action: "escalate", reason: "destructive" });
  });

  it("ESCALATES the approval overlay even under mode all", () => {
    const screen = "Approve command execution: git push --force";
    expect(decideAutoAnswer("all", screen, [], dialogs)).toEqual({ action: "escalate", reason: "destructive" });
  });
});
