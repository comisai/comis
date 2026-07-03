// SPDX-License-Identifier: Apache-2.0
/**
 * The pure heartbeat line for a promoted drive.
 *
 * `heartbeatLine(j)` builds the user-facing periodic progress one-liner for a PROMOTED
 * (long) drive — `"still working — elapsed Xh, last activity <digest>, N interactions,
 * ~$Y"` — assembled PURELY from the {@link DriveJournal}'s content-free fields
 * (`elapsedMs`, `lastScreenDigest`, `interactions`, `costUsd`). This is the
 * spam-free "the 40h drive is still alive" signal, distinct from the INTERNAL
 * liveness tick (which is never a user message).
 *
 * CONTENT-FREE BY CONSTRUCTION: the ONLY screen-derived text in the output is
 * `lastScreenDigest`, which the woken-turn driver ALREADY ran through `scrubSecretsFromText`
 * + bounded to `DIGEST_EXCERPT_MAX` before it landed on the journal (terminal-wake-turn.ts).
 * This function FORMATS, it does NOT redact and NEVER re-expands or re-reads the screen —
 * the same FORMAT-not-redact layer split `screenDigestLine` documents (terminal-read-digest.ts).
 * Everything else in the line is structural (counts/durations/labels).
 *
 * Architecture invariants (binding — AGENTS.md; mirrors
 * `terminal-read-digest.ts` `screenDigestLine` / `terminal-spend-ceiling.ts`):
 *   - PURE: a free function, NOT a factory. NO clock/timer reads (`elapsedMs` is the
 *     content-free number the CALLER derived from its own injected clock), NO module-global
 *     mutable state, NO I/O.
 *   - TOTAL / NEVER throws: a degenerate journal (NaN/negative/Infinity elapsedMs/
 *     interactions/costUsd, or an empty digest) yields a SAFE string — never a "NaNh" or a
 *     throw. The SAFE direction for an unreadable field is `0` / `"(no activity yet)"`.
 *   - Infra-free: value-imports NOTHING at runtime + a type-only `DriveJournal` — no
 *     platform runtime packages, no observability egress (the globals + infra-runtime-scope
 *     gates; this file names none, and worker ↛ infra/observability).
 *
 * @module
 */

import type { DriveJournal } from "./terminal-drive-journal.js";

/** A non-finite/negative number coerced to the SAFE `0` (a degenerate journal never yields "NaNh"). */
function safeNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The content-free heartbeat one-liner for a promoted drive.
 *
 * Pure + total: a degenerate journal yields a safe string (`0` hours/interactions/cost, an
 * empty digest → `"(no activity yet)"`); never throws. The line is content-free BY
 * CONSTRUCTION — counts/durations + the (already-redacted) `lastScreenDigest`, never raw TUI
 * bytes (the digest is FORMATTED here, not redacted — that happened upstream).
 *
 * @param j - The content-free journal fields the line reads (a {@link DriveJournal} subset).
 * @returns A single-line, content-free heartbeat string.
 */
export function heartbeatLine(
  j: Pick<DriveJournal, "elapsedMs" | "lastScreenDigest" | "interactions" | "costUsd">,
): string {
  const hours = (safeNonNegative(j.elapsedMs) / 3_600_000).toFixed(1);
  // interactions is a count: a non-finite/negative value is degenerate → 0 (floor any fraction).
  const interactions = Math.floor(safeNonNegative(j.interactions));
  // costUsd is money: a non-finite/negative value is degenerate → 0; two-decimal money format.
  const cost = safeNonNegative(j.costUsd).toFixed(2);
  // The (already-redacted, already-bounded) digest, VERBATIM — never re-expanded (the format-not-redact layer split).
  const activity =
    typeof j.lastScreenDigest === "string" && j.lastScreenDigest.length > 0
      ? j.lastScreenDigest
      : "(no activity yet)";
  return `Terminal drive still working — elapsed ${hours}h, last activity ${activity}, ${interactions} interactions, ~$${cost}.`;
}
