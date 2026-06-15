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
