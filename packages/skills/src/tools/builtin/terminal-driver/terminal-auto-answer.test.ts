// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure safe-only auto-answer policy
 * (terminal-auto-answer.ts) — SEC-12, spec §4.5/§4.6.
 *
 * `decideAutoAnswer(mode, screen, hintPatterns)` is a PURE typed decision: it never
 * sends a keystroke and never throws. The woken turn (124-09) acts on the verdict —
 * an `answer` keystroke goes through the P4 `enforceSendCapsThenAudit` send path; an
 * `escalate` raises a `terminal:escalated` audit. These tests pin the FULL policy:
 *
 *   - safe-only ALLOWLISTS the safe: a screen matching an operator `hintPatterns`
 *     safe-pattern (with a canned keystroke) → `{action:"answer", keys, matchedPatternIndex}`.
 *   - the SAFE default: a screen matching NO hintPattern → escalate `no_safe_match`
 *     (NO keystroke is ever guessed).
 *   - the ESCALATE-ALWAYS gate WINS over a hintPattern match: an auth/login,
 *     destructive, or approval prompt escalates even when a hintPattern would
 *     otherwise match it (a CLI cannot phish a canned answer by rendering a fake
 *     "(y/n)" under an auth/destructive prompt — SEC-12, T-124-08).
 *   - mode `none` → always escalate (the policy is OFF).
 *   - OPERATOR-ONLY signature: the decision reads only (mode, screen, hintPatterns) —
 *     there is NO caller/model-supplied input path (operator-dialable, never
 *     model-dialable — T-124-09).
 *
 * The decision is deterministic (no clock, no I/O) so it pins exactly under a fixture.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  decideAutoAnswer,
  type AutoAnswerDecision,
} from "./terminal-auto-answer.js";
import type { PlatformDialog } from "./platforms/index.js";

describe("decideAutoAnswer — SEC-12 safe-only allowlist (Test 1: safe match → answer)", () => {
  it("answers an operator safe-pattern prompt with a canned keystroke + the matched index", () => {
    // A benign "continue?" style prompt the operator explicitly allowlisted.
    const screen = ["Build complete.", "Press enter to continue ❯ "].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, ["Press enter to continue"]);

    expect(decision.action).toBe("answer");
    if (decision.action === "answer") {
      // A non-empty canned keystroke set + the index of the matched operator pattern.
      expect(decision.keys.length).toBeGreaterThan(0);
      expect(decision.matchedPatternIndex).toBe(0);
    }
  });
});

describe("decideAutoAnswer — the SAFE default (Test 2: no match → escalate, no keystroke)", () => {
  it("escalates no_safe_match when the screen matches no operator hintPattern", () => {
    const screen = "Some unrecognized prompt that nobody allowlisted: respond?";
    const decision = decideAutoAnswer("safe-only", screen, ["Press enter to continue"]);

    expect(decision).toEqual<AutoAnswerDecision>({
      action: "escalate",
      reason: "no_safe_match",
    });
  });
});

describe("decideAutoAnswer — ESCALATE-ALWAYS wins over a hintPattern (Test 3: auth/login)", () => {
  it("escalates auth_login for a login prompt EVEN when a hintPattern matches it", () => {
    // The CLI renders a login prompt that ALSO contains the operator's safe pattern —
    // the escalate-always gate must win (a fake "(y/n)" must never auto-answer a login).
    const screen = ["Please log in to continue", "(y/n) ❯ "].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, ["(y/n)"]);

    expect(decision).toEqual<AutoAnswerDecision>({
      action: "escalate",
      reason: "auth_login",
    });
  });

  it("escalates auth_login for an OAuth / token-expired prompt", () => {
    const oauth = decideAutoAnswer("safe-only", "Authorize via OAuth to proceed (y/n)", ["(y/n)"]);
    expect(oauth).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });

    const expired = decideAutoAnswer("safe-only", "Your token expired. Sign in again? (y/n)", ["(y/n)"]);
    expect(expired).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });
  });
});

describe("decideAutoAnswer — ESCALATE-ALWAYS wins over a hintPattern (Test 4: destructive/approval)", () => {
  it("escalates destructive for a destructive prompt even when a hintPattern matches", () => {
    const screen = ["This will DELETE all files. Continue?", "(y/n) ❯ "].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, ["(y/n)"]);

    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("escalates approval for an approval/confirmation prompt even when a hintPattern matches", () => {
    const screen = ["Do you approve this change? Are you sure?", "(y/n) ❯ "].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, ["(y/n)"]);

    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "approval" });
  });

  it("never returns a keystroke on any escalate-always branch (no `keys` field)", () => {
    const destructive = decideAutoAnswer("safe-only", "rm -rf the workspace? (y/n)", ["(y/n)"]);
    expect(destructive.action).toBe("escalate");
    // A typed escalate decision carries no keystroke — the woken turn sends nothing.
    expect(destructive).not.toHaveProperty("keys");
  });
});

describe("decideAutoAnswer — a VETTED profile dialog: APPROVAL tier does NOT veto, AUTH/DESTRUCTIVE floors STILL do (webhook-claude-cli-tdd-20260630)", () => {
  // Live VPS: claude 2.1.x reworded its trust gate to add an "Enter to confirm · Esc to cancel"
  // footer. The bare APPROVAL veto ("confirm") then escalated the documented trust-gate auto-answer,
  // stalling a driven claude session at the gate. A profile dialog is operator-vetted (selected by
  // allowId, classified destructive:false), so the generic APPROVAL tier must not veto it — but the
  // two real-threat floors (AUTH credential-phishing, DESTRUCTIVE data-loss) STILL must.
  const trustGate: PlatformDialog = {
    name: "trust-gate",
    detect: /trust this folder/iu,
    safeAnswer: ["\r"],
    destructive: false,
  };

  it("auto-answers a vetted dialog whose footer carries an APPROVAL cue ('Enter to confirm')", () => {
    const screen = ["Is this a project you trust?", "❯ 1. Yes, I trust this folder", "Enter to confirm · Esc to cancel"].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, [], [trustGate]);
    expect(decision.action).toBe("answer");
    if (decision.action === "answer") expect(decision.keys).toEqual(["\r"]);
  });

  it("STILL escalates the SAME vetted dialog when an AUTH cue rides the screen (phishing floor intact)", () => {
    const screen = ["Yes, I trust this folder", "Enter to confirm", "Please sign in to continue"].join("\n");
    expect(decideAutoAnswer("safe-only", screen, [], [trustGate])).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });
  });

  it("STILL escalates the SAME vetted dialog when a DESTRUCTIVE cue rides the screen (data-loss floor intact)", () => {
    const screen = ["Yes, I trust this folder", "Enter to confirm", "This will delete all files"].join("\n");
    expect(decideAutoAnswer("safe-only", screen, [], [trustGate])).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("the HINT path is UNCHANGED — a hintPattern match + an APPROVAL cue STILL escalates (unvetted generic match)", () => {
    // No profile dialog here: a generic operator hintPattern matched alongside an approval cue. The
    // full veto (incl. APPROVAL) still applies to the unvetted hint path.
    const decision = decideAutoAnswer("safe-only", "Confirm? (y/n)", ["(y/n)"], []);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "approval" });
  });
});

describe("decideAutoAnswer — narration is NOT a prompt: a marker with no safe-pattern match must not force destructive (real-VPS 2026-06-16)", () => {
  // Live Telegram drive: gpt-5.5 launched claude to build a Python app. claude NARRATED a TODO
  // app ("add a todo, list, mark done, delete a todo by id, clear all completed") and queued
  // `! python -m unittest` to run its tests. No operator safe pattern matched, but the
  // destructive WORDS in claude's narration tripped the escalate-always gate → a FALSE
  // `destructive` escalation that wedged the drive (the app was built but never delivered).
  // The escalate-always gate is a VETO on an about-to-answer safe match (the anti-phishing case);
  // with NO safe match there is nothing to auto-answer, so it must NOT fire on narration.
  it("a driven CLI's narration with destructive WORDS + no operator safe-pattern match → no_safe_match, NOT destructive", () => {
    const screen = [
      "I built a small TODO app:",
      "  add a todo, list todos, mark done, delete a todo by id, clear all completed.",
      "Now running the tests:",
      "❯ ! cd /home/comis/.comis/workspace/projects/todo-app && python -m unittest discover -s tests -v",
    ].join("\n");
    // The claude allow-entry configures NO hintPatterns → nothing here is auto-answerable.
    const decision = decideAutoAnswer("safe-only", screen, []);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "no_safe_match" });
  });

  it("STILL escalates destructive when the destructive cue rides a screen that DOES match a safe pattern (phishing veto intact)", () => {
    const screen = ["This will delete everything. Continue?", "(y/n) ❯ "].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, ["(y/n)"]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("auth_login narration with no safe-pattern match → no_safe_match (not auth_login) — same veto semantics", () => {
    const decision = decideAutoAnswer("safe-only", "Tip: run `gh auth login` to authenticate with GitHub.", []);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "no_safe_match" });
  });
});

describe("decideAutoAnswer — mode none (Test 5: always escalate)", () => {
  it("escalates regardless of a matching hintPattern when the policy is off", () => {
    const screen = "Press enter to continue ❯ ";
    const decision = decideAutoAnswer("none", screen, ["Press enter to continue"]);

    expect(decision).toEqual<AutoAnswerDecision>({
      action: "escalate",
      reason: "no_safe_match",
    });
  });
});

describe("decideAutoAnswer — operator-only signature (Test 6)", () => {
  it("takes only (mode, screen, hintPatterns) — there is NO model-supplied input path", () => {
    // Type-level/signature assertion: the function arity is exactly three, and the
    // third argument is the operator-configured pattern list (a readonly string[]).
    expect(decideAutoAnswer.length).toBe(3);

    // Exercising it with ONLY operator inputs is the whole contract — there is no
    // fourth param a caller could pass to widen the policy.
    const patterns: readonly string[] = ["Press enter to continue"];
    const decision = decideAutoAnswer("safe-only", "Press enter to continue ❯ ", patterns);
    expect(decision.action).toBe("answer");
  });
});

describe("decideAutoAnswer — CLASS-01 I4 no-bypass: a dialog_detected frame still escalates (SEC-12 wins)", () => {
  // CLASS-01 makes a full-screen dialog classify `awaiting-input`/`dialog_detected`
  // instead of `stuck`. Classification and the answer-decision are ORTHOGONAL: the
  // classifier says "this is a prompt"; SEC-12 says "a human must answer THIS one".
  // These pin that the dialog-detection change cannot bypass escalate-always (I4) —
  // a dialog screen carrying an auth/destructive cue still escalates BEFORE any
  // hintPattern auto-answer. The dialog frame flows through this SAME decideAutoAnswer
  // the wake-turn already calls (terminal-wake-turn.ts) — no new wiring.

  it("a boxed permission DIALOG with an auth-login cue escalates auth_login even though it is dialog_detected", () => {
    // The exact dialog SHAPE the classifier now reads as dialog_detected: a box-drawing
    // permission prompt with a selector — but the prompt text is a login, so SEC-12
    // escalate-always wins over the operator's allowlisted (y/n) cue.
    const dialogScreen = [
      "╭──────────────────────────────────────────╮",
      "│ Your session expired — please log in.      │",
      "│ ❯ 1. Sign in   2. Cancel   (y/n)            │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    const decision = decideAutoAnswer("safe-only", dialogScreen, ["(y/n)", "❯"]);

    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });
  });

  it("a boxed DIALOG with a destructive cue escalates destructive even though it is dialog_detected", () => {
    const dialogScreen = [
      "╭──────────────────────────────────────────╮",
      "│ This will permanently delete build/.        │",
      "│ ❯ 1. Yes, proceed   2. No   (y/n)           │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    const decision = decideAutoAnswer("safe-only", dialogScreen, ["(y/n)", "❯"]);

    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("regression: a benign DIALOG matching ONLY an operator hintPattern still answers (the gate is not weakened)", () => {
    // A dialog-shaped screen (a box + a selector) with NO auth/destructive/approval cue,
    // matching only the operator's allowlisted safe pattern → answer (unchanged routing).
    // The dialog branch changes the CLASSIFIER reason, never the auto-answer decision.
    const dialogScreen = [
      "╭──────────────────────────────────────────╮",
      "│ Press enter to continue                     │",
      "│ ❯ continue                                  │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    const decision = decideAutoAnswer("safe-only", dialogScreen, ["Press enter to continue"]);

    expect(decision.action).toBe("answer");
    if (decision.action === "answer") {
      expect(decision.matchedPatternIndex).toBe(0);
    }
  });
});

describe("decideAutoAnswer — mode all still escalate-always (trusted-input only)", () => {
  it("escalates auth/destructive even in mode all (all is documented trusted-input only)", () => {
    const login = decideAutoAnswer("all", "Please sign in (y/n)", ["(y/n)"]);
    expect(login).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });

    const destructive = decideAutoAnswer("all", "Permanently delete? (y/n)", ["(y/n)"]);
    expect(destructive).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });
});

describe("decideAutoAnswer — consumes profile.dialogs (DIALOG-01/02, v2.26 Phase 169)", () => {
  const trustGate: PlatformDialog = {
    name: "trust-gate",
    detect: /Do you trust the files in this folder/i,
    safeAnswer: ["\r"],
    destructive: false,
  };
  const approval: PlatformDialog = {
    name: "approval-overlay",
    detect: /Allow command to run/i,
    safeAnswer: ["\r"], // present but moot — destructive wins
    destructive: true,
  };

  it("answers a non-destructive profile dialog with ITS safeAnswer keys (not just the canned Enter)", () => {
    const screen = ["Do you trust the files in this folder?", "1. Yes  2. No"].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, [], [trustGate]);
    expect(decision.action).toBe("answer");
    if (decision.action === "answer") expect(decision.keys).toEqual(["\r"]);
  });

  it("escalates a destructive profile dialog — NEVER auto-answered, even with a safeAnswer present", () => {
    const screen = "Allow command to run: rm -rf build ?";
    const decision = decideAutoAnswer("safe-only", screen, [], [approval]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("escalates a destructive profile dialog even under mode all", () => {
    const decision = decideAutoAnswer("all", "Allow command to run something", [], [approval]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });

  it("the escalate-always veto WINS over a non-destructive dialog safeAnswer (SEC-12 hard floor)", () => {
    // A trust-gate that ALSO carries an auth cue on the same screen → escalate, never auto-answer.
    const screen = ["Do you trust the files in this folder?", "Please sign in to continue"].join("\n");
    const decision = decideAutoAnswer("safe-only", screen, [], [trustGate]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "auth_login" });
  });

  it("mode none never auto-answers a profile dialog (policy off)", () => {
    const screen = "Do you trust the files in this folder?";
    const decision = decideAutoAnswer("none", screen, [], [trustGate]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "no_safe_match" });
  });

  it("no dialogs (default) ⇒ byte-identical to today — a non-matching screen escalates (INV-1)", () => {
    const decision = decideAutoAnswer("safe-only", "some unrecognized prompt", ["nope"]);
    expect(decision).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "no_safe_match" });
  });

  it("a profile dialog that does NOT match the screen falls through to the operator hintPattern path", () => {
    const screen = "Press enter to continue";
    const decision = decideAutoAnswer("safe-only", screen, ["Press enter to continue"], [trustGate]);
    expect(decision.action).toBe("answer"); // the hintPattern path still works (canned Enter)
  });

  it("tags a dialog answer source 'dialog' and a hint answer source 'hint' (audit provenance, M1/L1)", () => {
    const dialogDec = decideAutoAnswer("safe-only", "Do you trust the files in this folder?", [], [trustGate]);
    expect(dialogDec.action === "answer" && dialogDec.source).toBe("dialog");
    const hintDec = decideAutoAnswer("safe-only", "Press enter to continue", ["Press enter to continue"], []);
    expect(hintDec.action === "answer" && hintDec.source).toBe("hint");
  });

  it("a destructive dialog escalates even when a non-destructive dialog matches the screen FIRST (order-independent, L2)", () => {
    const benignFirst: PlatformDialog = { name: "benign", detect: /run command/i, safeAnswer: ["\r"], destructive: false };
    const destructiveLater: PlatformDialog = { name: "danger", detect: /run command/i, safeAnswer: ["\r"], destructive: true };
    // Both match; benign is listed FIRST — the destructive floor must still win (not order-dependent).
    const dec = decideAutoAnswer("safe-only", "run command: rm -rf build", [], [benignFirst, destructiveLater]);
    expect(dec).toEqual<AutoAnswerDecision>({ action: "escalate", reason: "destructive" });
  });
});
