// SPDX-License-Identifier: Apache-2.0
/**
 * Script-routed FTS5 trigram query construction.
 *
 * Routes a query to one of three lanes and, for the trigram lane, builds the
 * FTS5 MATCH string from untrusted user/model query text:
 *   - "word": NO non-Latin token → the caller uses the ORIGINAL string against
 *     the existing porter word lane (byte-identical SQL for all-Latin queries).
 *   - "tri":  at least one non-Latin token → a quoted, normalized, bounded
 *     MATCH expression over the trigram twins.
 *   - "scan": every non-operator token folds below the 3-codepoint trigram
 *     floor → the caller runs its bounded normalized scan floor over `scanTokens`.
 *
 * DECISION RECORD: OR-of-trigram decomposition ONLY for suffixing-morphology
 * scripts (cyrillic + greek); whole-quoted tokens for hebrew/arabic/cjk/
 * everything else. A quoted whole token is FTS5 substring semantics, which
 * fails inflected-suffix recall (`книга` is not a substring of stored
 * `книги`); an OR-of-trigrams group matches it. he/ar/CJK are prefix/substring
 * cases the whole-token shape already satisfies. Adding a suffixing script
 * later is a data edit to SUFFIXING_SCRIPTS.
 *
 * SECURITY: every non-operator term is double-quoted
 * AFTER normalization, operators come only from the exact-uppercase allowlist,
 * any residual ASCII `"` is stripped from a term before quoting, and the only
 * parens are builder-emitted (never sourced from user text). MAX_QUERY_TOKENS +
 * MAX_TRIGRAMS_PER_TOKEN bound the MATCH size; the dangling-operator sweep
 * eliminates the known FTS5 syntax-error shapes (a stranded leading/trailing
 * or doubled operator is a hard FTS5 parse error). Pure: no I/O.
 * @module
 */

import { classifyCodepoint } from "./script-classes.js";
import { normalizeForSearch } from "./normalize-search.js";

/** The lane a query is routed to. */
export type SearchLane = "word" | "tri" | "scan";

export interface TrigramRoute {
  lane: SearchLane;
  /** Defined iff lane === "tri" — the complete FTS5 MATCH string. */
  match?: string;
  /** Defined iff lane === "scan" — normalized non-operator tokens for the
   *  bounded floor (includes the <3-codepoint tokens that forced the scan). */
  scanTokens?: string[];
}

/**
 * DoS bound on the token count fed into the MATCH builder. The upstream FTS5
 * sanitizer does NOT cap token count, so the builder must — a pathological
 * query could otherwise inflate the MATCH string without limit. 16 is
 * generous for real queries.
 */
const MAX_QUERY_TOKENS = 16;

/**
 * DoS bound on the OR-of-trigrams group size for one suffixing-script token.
 * Covers a ≤14-codepoint word fully; recall is preserved beyond it because any
 * 3 matching trigrams already rank the document (BM25).
 */
const MAX_TRIGRAMS_PER_TOKEN = 12;

/**
 * Scripts whose morphology is SUFFIXING — a stem keeps its prefix but changes
 * its tail across inflections, so substring (quoted whole-token) matching fails
 * (`книга`/`книги`). These get OR-of-trigram decomposition.
 * Everything else (hebrew/arabic/cjk/...) is prefix/substring morphology and
 * stays whole-quoted. Adding a script here is a one-line data edit.
 */
const SUFFIXING_SCRIPTS: ReadonlySet<string> = new Set(["cyrillic", "greek"]);

/** The exact-uppercase FTS5 operator allowlist — the ONLY tokens passed
 *  through bare (a lowercase `and` is a literal search term, not an operator). */
const OPERATORS: ReadonlySet<string> = new Set(["AND", "OR", "NOT"]);

/** ASCII double-quote (built from a codepoint to avoid the string-terminator
 *  hazard and to keep the quoting site explicit). */
const DQUOTE = String.fromCodePoint(0x22);

/** Codepoint count (NOT .length — astral safety for the <3 trigram floor). */
function codepointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** True if the token contains any codepoint classified as a non-Latin script
 *  (neutral ASCII — digits/punct — classifies null and never forces routing). */
function hasNonLatin(token: string): boolean {
  for (const ch of token) {
    const cls = classifyCodepoint(ch.codePointAt(0) ?? 0);
    if (cls !== null && cls !== "latin") return true;
  }
  return false;
}

/** True if the token contains any codepoint in a suffixing-morphology script. */
function hasSuffixingScript(token: string): boolean {
  for (const ch of token) {
    const cls = classifyCodepoint(ch.codePointAt(0) ?? 0);
    if (cls !== null && SUFFIXING_SCRIPTS.has(cls)) return true;
  }
  return false;
}

/** Sliding window of 3 codepoints, each trigram double-quoted, capped at
 *  MAX_TRIGRAMS_PER_TOKEN. Astral-safe (operates on the codepoint array). */
function orOfTrigrams(normalized: string): string {
  const cps = [...normalized];
  const trigrams: string[] = [];
  for (let i = 0; i + 3 <= cps.length && trigrams.length < MAX_TRIGRAMS_PER_TOKEN; i += 1) {
    trigrams.push(quote(cps.slice(i, i + 3).join("")));
  }
  return `(${trigrams.join(" OR ")})`;
}

/** Double-quote a term for FTS5. The caller has already stripped any interior
 *  ASCII `"` (so the quotes can never be unbalanced). */
function quote(term: string): string {
  return DQUOTE + term + DQUOTE;
}

/** Strip any residual ASCII double-quote from a term (buildFtsQuery parity —
 *  hybrid-search.ts:82,90; FTS5 injection prevention). */
function stripQuotes(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch !== DQUOTE) out += ch;
  }
  return out;
}

/**
 * Re-apply the dangling-operator sweep AFTER token drops can leave an operator
 * stranded (`ספרים NOT גם` → drop `גם` → trailing `NOT`). The three regexes are
 * COPIED VERBATIM out of the upstream sanitizer source file
 * `packages/skills/.../tools/fts5-sanitizer.ts` (step 4, lines 53-59) — a
 * cross-package import between core and skills is forbidden in both directions,
 * so the source is duplicated with this citation rather than imported. These are
 * fixed alternations over a 3-word operator set: no nested quantifiers, no
 * backtracking surface (ReDoS-safe).
 */
function sweepDanglingOperators(match: string): string {
  let working = match;
  // Remove operators at the start.
  working = working.replace(/^\s*\b(AND|OR|NOT)\b\s*/i, "");
  // Remove operators at the end.
  working = working.replace(/\s*\b(AND|OR|NOT)\b\s*$/i, "");
  // Collapse adjacent operators (e.g. "query AND OR other" → "query other").
  working = working.replace(/\b(AND|OR|NOT)\s+(AND|OR|NOT)\b/gi, "");
  // Trim and collapse whitespace.
  return working.replace(/\s+/g, " ").trim();
}

/** A query token, tagged so a sanitizer-preserved balanced phrase is kept whole
 *  (never re-split) while a plain token is folded and quoted/decomposed. */
interface Token {
  kind: "plain" | "phrase";
  text: string;
}

/**
 * Tokenize: extract sanitizer-preserved balanced `"…"` phrases as single phrase
 * tokens (mirror fts5-sanitizer.ts step 1 mechanics, reimplemented locally),
 * then whitespace-split the remainder into plain tokens. Order is preserved.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  const text = query;
  while (cursor < text.length) {
    const open = text.indexOf(DQUOTE, cursor);
    if (open === -1) {
      pushPlain(text.slice(cursor), tokens);
      break;
    }
    const close = text.indexOf(DQUOTE, open + 1);
    if (close === -1) {
      // Unbalanced trailing quote — treat the remainder as plain (the upstream
      // sanitizer strips unbalanced quotes for the LCD lane; be defensive here).
      pushPlain(text.slice(cursor), tokens);
      break;
    }
    pushPlain(text.slice(cursor, open), tokens);
    const phrase = text.slice(open + 1, close);
    if (phrase.trim().length > 0) tokens.push({ kind: "phrase", text: phrase });
    cursor = close + 1;
  }
  return tokens;
}

function pushPlain(chunk: string, tokens: Token[]): void {
  for (const part of chunk.split(/\s+/)) {
    if (part.length > 0) tokens.push({ kind: "plain", text: part });
  }
}

/**
 * Route a query to the word / trigram / scan lane and, for the trigram lane,
 * build the FTS5 MATCH string.
 *
 * join: "and" = space-joined terms (LCD implicit-AND semantics);
 * join: "or"  = OR-joined terms (LTM buildFtsQuery parity).
 */
export function routeSearchQuery(query: string, opts: { join: "and" | "or" }): TrigramRoute {
  const raw = (query ?? "").trim();
  if (raw.length === 0) return { lane: "word" };

  // Step 1: tokenize (phrases kept whole). Step 2: cap at MAX_QUERY_TOKENS.
  const tokens = tokenize(raw).slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return { lane: "word" };

  // Step 3: all-Latin → word lane (caller uses the ORIGINAL string, so the
  // existing porter word lane emits byte-identical SQL).
  const anyNonLatin = tokens.some((t) => hasNonLatin(t.text));
  if (!anyNonLatin) return { lane: "word" };

  // Step 4: build the trigram MATCH term-wise. `prevWasNot` carries the
  // preceding-operator context as a local (no variable array indexing) so a
  // suffixing-script token directly governed by NOT stays whole-quoted.
  const terms: string[] = [];
  const scanTokens: string[] = [];
  let positiveTermCount = 0;
  let prevWasNot = false;

  for (const token of tokens) {
    // Operators (exact-uppercase) pass through bare.
    if (token.kind === "plain" && OPERATORS.has(token.text)) {
      terms.push(token.text);
      prevWasNot = token.text === "NOT";
      continue;
    }

    // Normalize the token (or phrase interior) and strip any residual ASCII `"`.
    const normalized = stripQuotes(normalizeForSearch(token.text));
    const governedByNot = prevWasNot;
    prevWasNot = false; // only the token immediately after NOT is governed

    // A balanced phrase stays ONE whole-quoted phrase (interior normalized,
    // never re-split even if it now contains spaces — the U+FDFA edge).
    if (token.kind === "phrase") {
      scanTokens.push(normalized);
      if (normalized.length > 0) {
        terms.push(quote(normalized));
        positiveTermCount += 1;
      }
      continue;
    }

    scanTokens.push(normalized);

    // Drop tokens below the 3-codepoint trigram floor — correctness-critical:
    // a <3-cp token can never match a trigram index, so in an AND context it
    // returns ZERO ROWS for the whole query.
    if (codepointLength(normalized) < 3) continue;

    // Suffixing-script token (≥4 cp) NOT directly governed by a
    // preceding NOT → OR-of-trigrams group; else whole-quoted.
    if (hasSuffixingScript(normalized) && codepointLength(normalized) >= 4 && !governedByNot) {
      terms.push(orOfTrigrams(normalized));
    } else {
      terms.push(quote(normalized));
    }
    positiveTermCount += 1;
  }

  // Step 5: join. Step 6: sweep dangling operators left by drops.
  const joiner = opts.join === "and" ? " " : " OR ";
  const match = sweepDanglingOperators(terms.join(joiner));

  // Step 7: zero positive terms survived → scan floor (ALL normalized
  // non-operator tokens, including the short ones that forced the floor).
  if (positiveTermCount === 0 || match.length === 0) {
    return { lane: "scan", scanTokens };
  }

  return { lane: "tri", match };
}
