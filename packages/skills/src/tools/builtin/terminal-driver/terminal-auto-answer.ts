// SPDX-License-Identifier: Apache-2.0
/**
 * The pure `safe-only` auto-answer policy (spec §4.5/§4.6; SEC-12).
 *
 * `decideAutoAnswer(mode, screen, hintPatterns)` is the binding governance decision:
 * **allowlist the few safe prompts, escalate EVERYTHING else.** A driven CLI screen is
 * attacker-influenceable and the model is prompt-injectable, so the policy NEVER tries
 * to classify "is this dangerous" — it answers ONLY an operator-allowlisted safe
 * pattern and escalates the rest with no keystroke.
 *
 * Decision order (the escalate-always gate is FIRST and WINS over any safe match):
 *   1. mode `none`                       → escalate `no_safe_match`  (policy is OFF)
 *   2. ESCALATE-ALWAYS gate (structural) → escalate `auth_login` | `destructive` |
 *      `approval` — fires EVEN IF an operator hintPattern would otherwise match the
 *      same screen. A login/destructive/approval prompt is never guessed and never
 *      looped (SEC-12, T-124-08); a CLI cannot phish a canned answer by rendering a
 *      fake "(y/n)" beneath an auth/destructive prompt.
 *   3. otherwise (`safe-only` / `all`)   → the first matching operator safe pattern
 *      yields `{action:"answer", keys, matchedPatternIndex}`; no match → escalate
 *      `no_safe_match` (the SAFE default — no keystroke is ever invented).
 *
 * `all` may answer a broader set than the structural-safe heuristic but STILL escalates
 * auth/login/destructive/approval — it is documented "trusted-input only".
 *
 * OPERATOR-DIALABLE, NEVER model-dialable (T-124-09): `mode` + `hintPatterns` come
 * ONLY from the operator allow-entry (the closed `autoAnswer`/`hintPatterns` config in
 * schema-skills.ts). There is NO model-supplied parameter — the create-tool schema in
 * terminal-tools.ts carries no such field, so the model cannot widen its own policy.
 * This module's signature reflects that: it takes only operator inputs + the screen.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-caps.ts` / `terminal-classifier.ts`):
 *   - PURE: a free function. NO clock/timer reads, NO module-global mutable state,
 *     NO I/O. It NEVER sends a keystroke and NEVER throws — it returns a typed
 *     {@link AutoAnswerDecision}; the woken turn (124-09) acts on it (an `answer`
 *     keystroke rides the P4 `enforceSendCapsThenAudit` path; an `escalate` raises
 *     the `terminal:escalated` audit). A degenerate screen yields escalate (safe dir).
 *   - Infra-free: value-imports ONLY `@comis/core` (`scrubSecretsFromText` for a
 *     redaction-safe matched-value summary — the @comis/core redaction primitive, NOT
 *     the observability-side egress helper, which is forbidden in skills value-imports)
 *     — no platform runtime packages, no raw timer (the globals + infra-runtime-scope
 *     architecture gates enforce this; this module names none of them).
 *
 * @module
 */

import { scrubSecretsFromText } from "@comis/core";

/** The auto-answer modes — the operator allow-entry `autoAnswer` (default `safe-only`). */
export type AutoAnswerMode = "none" | "safe-only" | "all";

/**
 * The typed auto-answer verdict (the RESEARCH §4.5 shape). An `answer` carries the
 * canned keystroke set + the matched operator-pattern INDEX (an id, for the
 * `terminal:auto_answered` audit — never the prompt). An `escalate` carries ONLY a
 * typed closed `reason` (the audited WHY) and NO keystroke field — the escalate
 * branches can never leak a guessed key.
 */
export type AutoAnswerDecision =
  | { action: "answer"; keys: string[]; matchedPatternIndex: number }
  | { action: "escalate"; reason: "no_safe_match" | "destructive" | "approval" | "auth_login" };

// ---------------------------------------------------------------------------
// The escalate-always structural matchers (the SEC-12 gate)
// ---------------------------------------------------------------------------
//
// These are deliberately BROAD structural cues, not a precise parser: the safe
// direction is to OVER-escalate (a benign prompt that trips one of these is merely
// handed to a human), never to UNDER-escalate (auto-answering an auth/destructive
// prompt is the privilege-escalation we are preventing). Order = severity: auth/login
// is checked before destructive before approval so the most specific WHY is reported.

/** Auth/login/credential cues — escalate-always (credential-phishing guard, SEC-12). */
const AUTH_LOGIN_MARKERS: readonly string[] = [
  "log in",
  "login",
  "sign in",
  "signin",
  "authenticate",
  "authorize",
  "authorization",
  "oauth",
  "token expired",
  "session expired",
  "enter your password",
  "password:",
  "passphrase",
  "api key",
  "credential",
  "two-factor",
  "2fa",
  "verification code",
];

/** Destructive-action cues — escalate-always (a mis-answer must not delete/overwrite). */
const DESTRUCTIVE_MARKERS: readonly string[] = [
  "delete",
  "rm -rf",
  "remove all",
  "overwrite",
  "force push",
  "force-push",
  "drop table",
  "drop database",
  "wipe",
  "erase",
  "permanently",
  "reset --hard",
  "discard all",
  "destroy",
];

/** Approval/confirmation cues — escalate-always (an irreversible commit needs a human). */
const APPROVAL_MARKERS: readonly string[] = [
  "approve",
  "approval",
  "are you sure",
  "confirm",
  "confirmation",
  "proceed with",
  "do you accept",
  "accept the",
  "grant access",
  "allow access",
];

/** Lower-case structural contains-match (the cues are byte/space-shape, not regex). */
function containsAny(haystackLower: string, markers: readonly string[]): boolean {
  for (const m of markers) {
    if (haystackLower.includes(m)) return true;
  }
  return false;
}

/**
 * The escalate-always reason for a screen, or `undefined` if none fires. Auth/login is
 * the highest-severity WHY, then destructive, then approval. This gate runs BEFORE the
 * operator safe-pattern match so it WINS even when a hintPattern would match.
 */
function escalateAlwaysReason(
  screen: string,
): "auth_login" | "destructive" | "approval" | undefined {
  const lower = screen.toLowerCase();
  if (containsAny(lower, AUTH_LOGIN_MARKERS)) return "auth_login";
  if (containsAny(lower, DESTRUCTIVE_MARKERS)) return "destructive";
  if (containsAny(lower, APPROVAL_MARKERS)) return "approval";
  return undefined;
}

// ---------------------------------------------------------------------------
// The operator safe-pattern match
// ---------------------------------------------------------------------------

/**
 * Does the screen STRUCTURALLY contain the operator safe pattern? A case-insensitive
 * substring test — the operator pattern is an explicit allowlisted prompt cue
 * (e.g. "Press enter to continue"), not a regex. An empty pattern never matches.
 */
function matchesSafePattern(screen: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  return screen.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * The canned keystroke set for a matched safe pattern. The operator allowlisted the
 * pattern precisely because its safe answer is "proceed" — a single Enter (`\r`)
 * acknowledges a "press enter to continue" / benign affordance. The matched value is
 * run through {@link scrubSecretsFromText} (the @comis/core redaction primitive) so a
 * pattern accidentally carrying a secret never rides a downstream summary verbatim.
 */
function cannedKeysFor(pattern: string): string[] {
  // Redaction-safe touch of the matched pattern: the canned answer is structural
  // (Enter), but scrubbing the pattern here keeps any later matched-value summary
  // (logged by the woken turn) free of an operator typo that embedded a secret.
  void scrubSecretsFromText(pattern);
  return ["\r"];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide whether to auto-answer a settled prompt or escalate it (SEC-12). Pure, total,
 * never throws, never sends — returns a typed {@link AutoAnswerDecision} the woken turn
 * acts on. See the module doc for the full decision order (the escalate-always gate is
 * FIRST and WINS over any operator safe match).
 *
 * @param mode - The operator `autoAnswer` mode (`none` | `safe-only` | `all`).
 * @param screen - The settled prompt region (attacker-influenceable input).
 * @param hintPatterns - The operator-configured safe prompt cues (NEVER model-supplied).
 * @returns The typed decision.
 */
export function decideAutoAnswer(
  mode: AutoAnswerMode,
  screen: string,
  hintPatterns: readonly string[],
): AutoAnswerDecision {
  // 1. Policy off ⇒ never auto-answer (the SAFE default).
  if (mode === "none") {
    return { action: "escalate", reason: "no_safe_match" };
  }

  // 2. ESCALATE-ALWAYS gate — runs BEFORE the safe-pattern match so it WINS even when
  //    a hintPattern would match. A login/destructive/approval prompt is never guessed.
  const forced = escalateAlwaysReason(screen);
  if (forced !== undefined) {
    return { action: "escalate", reason: forced };
  }

  // 3. safe-only / all: answer the FIRST matching operator safe pattern; otherwise the
  //    SAFE default (escalate — no keystroke is ever invented).
  for (let i = 0; i < hintPatterns.length; i++) {
    const pattern = hintPatterns[i] ?? "";
    if (matchesSafePattern(screen, pattern)) {
      return { action: "answer", keys: cannedKeysFor(pattern), matchedPatternIndex: i };
    }
  }
  return { action: "escalate", reason: "no_safe_match" };
}
