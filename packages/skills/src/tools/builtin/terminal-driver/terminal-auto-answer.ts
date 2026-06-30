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
 * Decision order (the escalate-always gate is a VETO on an about-to-answer safe match):
 *   1. mode `none`                       → escalate `no_safe_match`  (policy is OFF)
 *   2. match the FIRST operator safe pattern — the "we are about to auto-answer" signal.
 *   3. ESCALATE-ALWAYS VETO (structural, SEC-12) → when a safe pattern matched, if that SAME
 *      screen ALSO carries an `auth_login` | `destructive` | `approval` cue the canned answer is
 *      VETOED + escalated. A CLI cannot phish a canned answer by rendering a fake "(y/n)" beneath
 *      an auth/destructive prompt — the phish BY DEFINITION matches a safe pattern, so the veto
 *      always covers it (the anti-phishing guard is fully intact). The gate is scoped to an actual
 *      safe match so it NEVER fires on a driven CLI's NARRATION: a screen with no safe match is
 *      never auto-answered anyway (step 4 → no_safe_match), so matching the broad markers there is
 *      pure downside — they trip on prose ("delete a todo", "gh auth login") and wedge the drive
 *      (real-VPS 2026-06-16).
 *   4. a safe match with NO veto → `{action:"answer", keys, matchedPatternIndex}`; no safe match
 *      → escalate `no_safe_match` (the SAFE default — no keystroke is ever invented).
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
 *   - Infra-free: value-imports NOTHING outside node builtins — no `@comis/infra`, no
 *     observability egress, no platform runtime packages, no raw timer (the globals +
 *     infra-runtime-scope architecture gates enforce this; this module names none of
 *     them). The decision is a pure function of operator inputs + the screen; the
 *     redaction of any audited value happens in the woken turn (terminal-wake-turn.ts),
 *     not here (the canned answer is structural Enter and the audit carries the matched
 *     pattern INDEX, never the pattern text).
 *
 * @module
 */

import type { PlatformDialog } from "./platforms/index.js";

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
  | { action: "answer"; keys: string[]; matchedPatternIndex: number; source: "hint" | "dialog" }
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

/**
 * The HARD-floor veto for a PROFILE-declared, non-destructive dialog (the {@link decideAutoAnswer}
 * dialog path) — AUTH (credential-phishing, the SEC-12 core) and DESTRUCTIVE (data-loss) cues ONLY,
 * NOT the generic APPROVAL tier. A profile dialog is operator-vetted: selected by the operator
 * `allowId` (never content-sniffed), matched by its specific `detect` regex, and explicitly
 * classified `destructive:false` with a known `safeAnswer`. The APPROVAL markers ("confirm",
 * "proceed with", …) false-positive on the near-universal benign keystroke-hint footer that such a
 * dialog carries ("Enter to confirm · Esc to cancel"), which would VETO every confirmation dialog —
 * defeating the whole point of a profile-declared safe dialog. So the approval tier does NOT veto a
 * vetted dialog; the two real-threat floors (auth/destructive) STILL do.
 *
 * (webhook-claude-cli-tdd-20260630, live VPS: claude 2.1.x reworded its trust gate to add an "Enter
 * to confirm" footer; the bare APPROVAL veto then escalated the documented auto-answer, stalling a
 * driven claude session at the gate. The hintPattern path below keeps the FULL veto — those cues are
 * generic operator strings, not a vetted-and-classified dialog.)
 */
function dialogVetoReason(screen: string): "auth_login" | "destructive" | undefined {
  const lower = screen.toLowerCase();
  if (containsAny(lower, AUTH_LOGIN_MARKERS)) return "auth_login";
  if (containsAny(lower, DESTRUCTIVE_MARKERS)) return "destructive";
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
 * acknowledges a "press enter to continue" / benign affordance. The answer is purely
 * structural (always Enter); the pattern TEXT is never echoed downstream (the audit
 * carries the matched pattern INDEX, never the text — terminal-wake-turn.ts), so there
 * is nothing to redact here.
 */
function cannedKeysFor(): string[] {
  return ["\r"];
}

/** The index of the FIRST operator safe pattern the screen matches, or `undefined` if none. */
function firstSafePatternIndex(screen: string, hintPatterns: readonly string[]): number | undefined {
  for (let i = 0; i < hintPatterns.length; i++) {
    const pattern = hintPatterns[i] ?? "";
    if (matchesSafePattern(screen, pattern)) return i;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Does ANY matching dialog carry `destructive:true`? Order-independent (review L2): a destructive
 *  match anywhere in `dialogs` escalates, even if a non-destructive dialog matches first. */
function anyMatchingDestructive(screen: string, dialogs: readonly PlatformDialog[]): boolean {
  return dialogs.some((d) => d.destructive === true && d.detect.test(screen));
}

/** The index of the FIRST non-destructive matching dialog that carries a non-empty safeAnswer, or -1. */
function firstAnswerableDialogIndex(screen: string, dialogs: readonly PlatformDialog[]): number {
  return dialogs.findIndex(
    (d) =>
      d.destructive !== true &&
      d.safeAnswer !== undefined &&
      d.safeAnswer.length > 0 &&
      d.detect.test(screen),
  );
}

/**
 * Decide whether to auto-answer a settled prompt or escalate it (SEC-12). Pure, total,
 * never throws, never sends — returns a typed {@link AutoAnswerDecision} the woken turn
 * acts on. See the module doc for the full decision order (the escalate-always gate is
 * FIRST and WINS over any operator safe match OR profile-dialog safeAnswer).
 *
 * @param mode - The operator `autoAnswer` mode (`none` | `safe-only` | `all`).
 * @param screen - The settled prompt region (attacker-influenceable input).
 * @param hintPatterns - The operator-configured safe prompt cues (NEVER model-supplied).
 * @param dialogs - The SELECTED platform profile's dialogs (v2.26 DIALOG-01; by operator allowId,
 *   never content-sniffed). A profile PROPOSES a safe answer; this policy DISPOSES — a `destructive`
 *   dialog is never auto-answered (escalates, even under `all`), and the escalate-always veto still
 *   WINS over any dialog safeAnswer. Empty ⇒ exactly today's hintPattern-only behavior (INV-1).
 * @returns The typed decision.
 */
export function decideAutoAnswer(
  mode: AutoAnswerMode,
  screen: string,
  hintPatterns: readonly string[],
  dialogs: readonly PlatformDialog[] = [],
): AutoAnswerDecision {
  // 1. Policy off ⇒ never auto-answer (the SAFE default).
  if (mode === "none") {
    return { action: "escalate", reason: "no_safe_match" };
  }

  // 2. A matched profile dialog flagged `destructive` ALWAYS escalates — never auto-answered, even
  //    under mode `all`, even if it declares a safeAnswer (DIALOG-01: the safety floor). Order-
  //    INDEPENDENT (review L2): ANY matching destructive dialog escalates, so a destructive entry can
  //    never be shadowed by an earlier non-destructive match. Checked BEFORE the safe-answer paths.
  if (anyMatchingDestructive(screen, dialogs)) {
    return { action: "escalate", reason: "destructive" };
  }

  // 3. The candidates we WOULD answer: the first answerable (non-destructive, has-safeAnswer) profile
  //    dialog, and the first operator safe-pattern. Both are "about to auto-answer" signals.
  const dialogIdx = firstAnswerableDialogIndex(screen, dialogs);
  const dialogAnswer = dialogIdx >= 0 ? dialogs[dialogIdx] : undefined;
  const matchedIndex = firstSafePatternIndex(screen, hintPatterns);

  // 4. The ESCALATE-ALWAYS gate (SEC-12) is a VETO that fires ONLY when we WOULD otherwise send a
  //    canned answer (a profile dialog safeAnswer OR an operator safe pattern matched): if that SAME
  //    screen also carries an auth/login, destructive, or approval cue the answer is VETOED +
  //    escalated (a CLI cannot phish a safe affordance beneath an auth/destructive prompt — SEC-12,
  //    T-124-08; the phish BY DEFINITION renders a safe affordance, so it ALWAYS matches here, leaving
  //    the anti-phishing guard fully intact). A screen with NO safe match is never auto-answered
  //    regardless, so running the BROAD markers against it is pure downside (narration false-positives
  //    that wedge the drive — real-VPS 2026-06-16); gating the veto on an actual safe match removes
  //    those while keeping the phishing guard. A profile dialog safeAnswer takes precedence over the
  //    canned-Enter hintPattern (it carries the dialog's explicit keys). `source`+index are a
  //    content-free audit id (the woken turn namespaces the resume-dedup + audit by `source`).
  if (dialogAnswer !== undefined) {
    // A vetted profile dialog is vetoed ONLY by the AUTH/DESTRUCTIVE hard floors — NOT the generic
    // APPROVAL tier (which false-positives on the benign "Enter to confirm" footer). See dialogVetoReason.
    const forced = dialogVetoReason(screen);
    if (forced !== undefined) return { action: "escalate", reason: forced };
    return {
      action: "answer",
      source: "dialog",
      keys: [...(dialogAnswer.safeAnswer ?? [])],
      matchedPatternIndex: dialogIdx,
    };
  }
  if (matchedIndex !== undefined) {
    const forced = escalateAlwaysReason(screen);
    if (forced !== undefined) return { action: "escalate", reason: forced };
    return { action: "answer", source: "hint", keys: cannedKeysFor(), matchedPatternIndex: matchedIndex };
  }

  // 5. No dialog safeAnswer AND no operator safe pattern matched ⇒ the SAFE default (escalate; no keystroke invented).
  return { action: "escalate", reason: "no_safe_match" };
}
