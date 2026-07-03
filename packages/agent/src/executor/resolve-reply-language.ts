// SPDX-License-Identifier: Apache-2.0
/**
 * The single pure reply-language resolver for the deterministic
 * consumer (degraded replies). Returns a closed-set table key
 * (en|he|ar|ru) selected by a fixed 4-tier resolution order:
 *
 *   1. `configLanguage` — `agents.<id>.language` (operator-set, tier-1).
 *   2. `userMdLanguage` — USER.md "Preferred language" (already placeholder-
 *      filtered by the call site's `extractUserLanguage`, tier-2).
 *   3. inbound message script (tier-3) — `he`/`ar`/`ru` ONLY, and ONLY on a
 *      STRICT majority (> 0.5) of NON-NEUTRAL codepoints. `cjk` (and every
 *      other class) maps to nothing → falls through.
 *   4. `"en"` — the total floor.
 *
 * The resolver is PURE: no I/O, no logging, no clock, no events. It is
 * TOTAL — it never throws; "en" is the floor for any input. Returns a plain
 * string (the dominantScript/scriptTokenFactor text-primitive convention, NOT
 * Result<T,E>): a total pure value function needs no error channel.
 *
 * ⚠ Tier-3 uses `scriptShares` DIRECTLY with a strict `> 0.5` threshold — it
 * MUST NOT reuse `dominantScript`, whose 0.30 non-Latin floor
 * (script-classes.ts) is tuned for mixed code+text tolerance and would
 * return `hebrew` for a 40%-Hebrew message. This resolver requires a strict majority,
 * so a plurality-but-not-majority Hebrew message resolves to "en", not "he".
 * `scriptShares` already excludes neutral ASCII (digits/punct/space) from its
 * denominator, so its shares ARE "share of non-neutral codepoints" exactly.
 *
 * Model-facing consumers (the language-directive paths) do NOT use this tag —
 * they use content-anchored instructions so detection is sidestepped. Only the
 * deterministic degraded replies consume the resolved key.
 *
 * @module
 */

import { scriptShares, type ScriptClass } from "@comis/core";

/** The closed set of reply-language table keys the resolver emits. */
export type ReplyLanguage = "en" | "he" | "ar" | "ru";

/** Inputs for the reply-language resolution (all tiers; only inboundText required). */
export interface ResolveReplyLanguageInput {
  /** The untrusted inbound message text (tier-3 script default source). */
  readonly inboundText: string;
  /** `agents.<id>.language` config value (tier-1). BCP-47 or display name. */
  readonly configLanguage?: string;
  /** USER.md preferred language VALUE (tier-2), already placeholder-filtered. */
  readonly userMdLanguage?: string;
}

/**
 * Non-neutral script classes that map to a reply-language table key. `cjk`,
 * `latin`, and every other class deliberately have NO entry → they fall
 * through (latin → en is the floor; cjk → nothing by design).
 */
const SCRIPT_TO_LANGUAGE: Partial<Record<ScriptClass, ReplyLanguage>> = {
  hebrew: "he",
  arabic: "ar",
  cyrillic: "ru",
};

/**
 * Normalize a raw config/USER.md language hint to a closed table key, or
 * `undefined` when it is not one of the four supported languages.
 *
 * Lowercase + take the primary BCP-47 subtag ("he-IL" → "he"), and accept the
 * English display-name aliases (and the `iw` legacy code for Hebrew). Anything
 * else → `undefined` (the caller falls through; it never forces "en" here).
 */
function normalizeToTableKey(raw: string): ReplyLanguage | undefined {
  const primary = raw.trim().toLowerCase().split("-")[0] ?? "";
  switch (primary) {
    case "he":
    case "hebrew":
    case "iw": // legacy ISO 639-1 code for Hebrew
      return "he";
    case "ar":
    case "arabic":
      return "ar";
    case "ru":
    case "russian":
      return "ru";
    case "en":
    case "english":
      return "en";
    default:
      return undefined;
  }
}

/**
 * Tier-3: the inbound message script default. Returns a table key ONLY when a
 * single mapped script (he/ar/ru) holds a STRICT majority (> 0.5) of the
 * non-neutral codepoints; otherwise `undefined` (fall through). `cjk` and any
 * unmapped class never win even at a >0.5 share.
 */
function scriptDefault(inboundText: string): ReplyLanguage | undefined {
  const shares = scriptShares(inboundText);
  for (const [cls, share] of shares) {
    if (share > 0.5) {
      // At most one class can exceed 0.5; return its mapping (or undefined for cjk/latin/other).
      // eslint-disable-next-line security/detect-object-injection -- cls is a closed ScriptClass union key from scriptShares, never user-controlled
      return SCRIPT_TO_LANGUAGE[cls];
    }
  }
  return undefined;
}

/**
 * Resolve the deterministic reply language. Pure, total, never throws.
 * @returns one of "en" | "he" | "ar" | "ru".
 */
export function resolveReplyLanguage(input: ResolveReplyLanguageInput): ReplyLanguage {
  // Tier 1 — operator config. Unknown values fall through (do NOT short-circuit to en).
  if (input.configLanguage !== undefined) {
    const key = normalizeToTableKey(input.configLanguage);
    if (key !== undefined) return key;
  }

  // Tier 2 — USER.md preferred language (value already placeholder-filtered).
  if (input.userMdLanguage !== undefined) {
    const key = normalizeToTableKey(input.userMdLanguage);
    if (key !== undefined) return key;
  }

  // Tier 3 — inbound message script, strict >0.5 majority of non-neutral codepoints.
  const scriptKey = scriptDefault(input.inboundText);
  if (scriptKey !== undefined) return scriptKey;

  // Tier 4 — the total floor.
  return "en";
}
