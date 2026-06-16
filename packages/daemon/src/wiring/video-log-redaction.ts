// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-03 (Phase 192): redaction-safe shaping of a RAW provider/channel Error
 * before it rides a log line.
 *
 * The off-turn video poller logs failure causes — a FAL/Veo/Grok SDK error, a
 * channel-adapter send error, a SQLite store error — whose free-text `message`
 * (AND the message of every nested `err.cause`) can echo a key / bearer / the Veo
 * `&key=AIza…` download URL / a FAL `<uuid>:<hex>` key. The Pino redact set only
 * scrubs credential-NAMED structured keys; it never touches free-text inside
 * `err.message` or `err.cause`. So a raw cause logged as `err: cause` leaks any
 * secret in its (possibly nested) message.
 *
 * `redactErr` (CR-01) walks a BOUNDED `err.cause` chain, folds every level's
 * message into one carrier, runs it through `sanitizeLogString` (the SECOND line
 * of defense — Bearer/sk-/AIza/the FAL uuid:hex shape/etc. → `[REDACTED]`), and
 * exact-match-scrubs any BOUND resolved video secret (the v2.20 OutputGuard
 * `knownSecrets` precedent — catches ANY shape, incl. future ones, with zero
 * false-positive risk). It returns a spreadable `{ errName, errMessage }`
 * (bounded) for the log payload. The cause chain is preserved so the failure
 * CLASS (DNS vs refused vs TLS — undici puts it in `err.cause`) stays diagnosable
 * (§2.7 / the troubleshooting feedback loop), while any secret in it is redacted.
 *
 * The stack (which can also carry a URL) is intentionally dropped — AGENTS.md
 * §2.7 keeps stack traces at DEBUG only, and the threat model forbids a credential
 * at ANY level, so the redacted message is the safe carrier on WARN/ERROR.
 *
 * Use `makeRedactErr(videoSecrets)` at the wiring site (where the resolved
 * GOOGLE_API_KEY/XAI_API_KEY/FAL_KEY/Grok-bearer are already in hand) to bind the
 * exact-match scrub; the bare `redactErr` export is the pattern-only variant for
 * call sites with no bound secret in scope.
 *
 * @module
 */
import { sanitizeLogString } from "@comis/core";

/** Max logged message length (mirrors the pi-event-bridge sanitized-error bound). */
const MAX_ERR_MESSAGE_CHARS = 1500;

/** Bounded `err.cause` walk depth — folds the realistic undici
 *  `TypeError("fetch failed", { cause })` chain without looping on a cyclic cause. */
const MAX_CAUSE_DEPTH = 4;

/** Minimum length for a bound known-secret to be eligible for exact-match scrub —
 *  guards against a short/empty value redacting ordinary text (the OutputGuard
 *  `KNOWN_SECRET_MIN_LENGTH` precedent). */
const KNOWN_SECRET_MIN_LENGTH = 8;

/** The redacted `{ errName, errMessage }` carrier spread into a log payload. */
export interface RedactedErr {
  errName: string;
  errMessage: string;
}

/** Fold an Error + its bounded `cause` chain into one " <- "-joined message. A
 *  non-Error cause (string/undefined/cyclic past the depth bound) terminates the
 *  walk. Preserves each level's text so the failure class survives redaction. */
function foldCauseChain(cause: Error): string {
  const parts: string[] = [];
  let cur: unknown = cause;
  for (let d = 0; d < MAX_CAUSE_DEPTH && cur instanceof Error; d++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/**
 * Shape a raw Error for a log payload: the error name + its scrubbed,
 * length-bounded message folded across the `err.cause` chain. Pattern-only scrub
 * (`sanitizeLogString`) — use `makeRedactErr` to additionally exact-match-scrub
 * bound secrets. Spread into the structured payload in place of a raw `err: cause`.
 */
export function redactErr(cause: Error): RedactedErr {
  return makeRedactErr([])(cause);
}

/**
 * Build a `redactErr`-shaped scrubber bound to the resolved video secrets
 * (`knownSecrets`) so they are removed by EXACT MATCH from every log surface —
 * the robust, shape-independent guard (catches the FAL `uuid:hex` shape and any
 * future shape a regex would miss) with zero false-positive risk. Empty or
 * sub-`KNOWN_SECRET_MIN_LENGTH` values are ignored so a misconfigured short value
 * can never redact ordinary text, and the absent-key case (no secret bound) falls
 * back to the pattern scrub only (no crash). The bound list is never logged.
 *
 * @param knownSecrets - Resolved secret VALUES (the agent's GOOGLE_API_KEY /
 *   XAI_API_KEY / FAL_KEY / the Grok bearer) — never the env-ref names.
 */
/** The names of the video creds resolved for the SEC-03 exact-match log scrub —
 *  the SAME creds the adapters use (CRED-01, no video-specific secret). */
const VIDEO_SECRET_NAMES = ["GOOGLE_API_KEY", "XAI_API_KEY", "FAL_KEY"] as const;

/**
 * Resolve the video creds (their VALUES, never the env-ref names) from the secret
 * manager for the poller's exact-match log scrub. Absent keys drop out → the
 * poller falls back to the pattern scrub only (no crash). Lives here (the SEC-03
 * module) so the wiring site stays small (file-size discipline).
 *
 * @param secretManager - any object exposing `get(name): string | undefined`
 *   (the daemon `SecretManager`; typed structurally to avoid a core type dep here).
 */
export function resolveVideoSecretsForRedaction(secretManager: {
  get(name: string): string | undefined;
}): string[] {
  return VIDEO_SECRET_NAMES.map((name) => secretManager.get(name)).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

export function makeRedactErr(knownSecrets: readonly string[]): (cause: Error) => RedactedErr {
  // Bind + dedupe the eligible secrets ONCE (longest-first so a secret that is a
  // substring of another is removed deterministically). Mirrors createOutputGuard.
  const bound = Array.from(
    new Set((knownSecrets ?? []).filter((s) => typeof s === "string" && s.trim().length >= KNOWN_SECRET_MIN_LENGTH)),
  ).sort((a, b) => b.length - a.length);

  return (cause: Error): RedactedErr => {
    let merged = sanitizeLogString(foldCauseChain(cause));
    // Exact-match scrub the bound resolved secrets (after the pattern pass, so a
    // shape the regex missed is still removed). replaceAll → every occurrence. The
    // labeled placeholder mirrors the OutputGuard `[REDACTED:known_secret]` idiom
    // (NOT the bare `[REDACTED]` literal banned in production source).
    for (const secret of bound) {
      if (merged.includes(secret)) merged = merged.replaceAll(secret, "[REDACTED:video_secret]");
    }
    return { errName: cause.name, errMessage: merged.slice(0, MAX_ERR_MESSAGE_CHARS) };
  };
}
