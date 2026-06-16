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

  // 2. Find the FIRST matching operator safe pattern — the "we are about to auto-answer" signal.
  const matchedIndex = firstSafePatternIndex(screen, hintPatterns);

  // 3. ESCALATE-ALWAYS gate (SEC-12) — a VETO on the about-to-answer safe match. It fires ONLY
  //    when an operator safe pattern matched (we WOULD otherwise send a canned answer): if that
  //    SAME screen also carries an auth/login, destructive, or approval cue the canned answer is
  //    VETOED + escalated (a CLI cannot phish a safe match beneath an auth/destructive prompt —
  //    SEC-12, T-124-08; the phish BY DEFINITION renders a safe-pattern affordance, so it ALWAYS
  //    matches here, leaving the anti-phishing guard fully intact). A screen with NO safe-pattern
  //    match is never auto-answered regardless (step 4 → no_safe_match), so running the BROAD
  //    markers against it is pure downside: on a driven AI CLI they mis-fire on NARRATION
  //    ("delete a todo", "remove all completed", "gh auth login") — a non-prompt — forcing a
  //    false escalation that wedges the drive (real-VPS 2026-06-16: claude's TODO-app narration
  //    forced a false `destructive`). Gating the gate on an actual safe match removes the
  //    narration false-positives while never weakening the phishing veto.
  if (matchedIndex !== undefined) {
    const forced = escalateAlwaysReason(screen);
    if (forced !== undefined) {
      return { action: "escalate", reason: forced };
    }
    // A safe match with no auth/destructive/approval veto ⇒ answer (the canned Enter).
    return { action: "answer", keys: cannedKeysFor(), matchedPatternIndex: matchedIndex };
  }

  // 4. No operator safe pattern matched ⇒ the SAFE default (escalate; no keystroke is invented).
  return { action: "escalate", reason: "no_safe_match" };
}
