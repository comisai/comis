// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-free query understanding — pure, deterministic helpers over the query
 * STRING. All exports are PURE (no `Result`, no throw, no I/O, no clock, no globals — the
 * rag/score.ts pure-ranking carve-out): a malformed input returns a safe value (the default
 * intent / a 1.0 multiplier / the unchanged string / `undefined`), NEVER an exception.
 *
 * NO LLM, NO network: intent is keyword/shape heuristics, synonym expansion is a bounded static
 * map, and the temporal grammar is a hand-rolled regex + epoch arithmetic (no date library —
 * `@comis/agent` has none, and adding one violates the CLAUDE.md exact-pin supply-chain invariant).
 *
 * @module
 */

/**
 * The CLOSED set of query intents. Default / unmatched = `"factual"` (a plain lookup). A new
 * member fails the build at the {@link intentMultiplier} switch's exhaustive default until it is
 * handled explicitly (the score.ts `trustWeight` closed-union precedent, AGENTS.md §2.8).
 */
export type Intent = "factual" | "temporal" | "preference" | "enumeration";

/** The CLOSED set of reweightable recall lanes (the intent-reweight surface). */
export type ReweightLane = "fts" | "vector" | "entity" | "temporal" | "causal" | "graphSpread";

/**
 * Lowercase + Unicode-aware tokenize (the buildFtsQuery shape, hybrid-search.ts:81-106:
 * strip double-quotes, split on non-letter/non-number). Replicated agent-side — this is
 * pure string work and MUST NOT import from `@comis/memory` (the agent↛memory cut).
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/"/g, "") // FTS5-injection-safe shape (no special chars carried)
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Single-token marker sets per family (matched against the tokenized query).
const TEMPORAL_TOKENS = new Set([
  "when",
  "yesterday",
  "today",
  "tonight",
  "since",
  "ago",
  "recently",
  "earlier",
  "before",
  "after",
]);
const PREFERENCE_TOKENS = new Set([
  "prefer",
  "prefers",
  "preferred",
  "preference",
  "like",
  "likes",
  "liked",
  "favorite",
  "favourite",
  "favorites",
  "favourites",
]);
const ENUMERATION_TOKENS = new Set(["list", "all", "every", "everything", "each", "count"]);

// Multi-word / pattern markers matched against the lowercased raw string.
const TEMPORAL_PHRASE_RE = /\b(last|this|next|past)\s+(week|month|year|day|night|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const TEMPORAL_LAST_N_RE = /\blast\s+\d+\s+(day|days|week|weeks|month|months|year|years)\b/;
const YEAR_TOKEN_RE = /\b(19|20)\d{2}\b/; // a 4-digit year token like 2023 → a temporal signal
const ENUMERATION_PHRASE_RE = /\bhow\s+many\b/;

/**
 * Classify a query into the closed {@link Intent} union by DETERMINISTIC keyword/shape
 * heuristics — NO LLM. Marker families are checked in a DOCUMENTED precedence so a query that
 * matches several is classified once, always the same:
 *
 *   temporal  >  enumeration  >  preference  >  factual (default)
 *
 * Temporal wins first (the NL range parse it enables is the most specific signal);
 * enumeration next (it widens recall + favors MMR diversity); preference next (entity up-weight);
 * a plain lookup with no marker falls through to `"factual"`. Pure + total — an empty/garbage
 * query simply matches nothing → `"factual"` (never throws).
 */
export function classifyIntent(query: string): Intent {
  const lower = query.toLowerCase();
  const tokens = tokenize(query);

  const hasTemporal =
    tokens.some((t) => TEMPORAL_TOKENS.has(t)) ||
    YEAR_TOKEN_RE.test(lower) ||
    TEMPORAL_PHRASE_RE.test(lower) ||
    TEMPORAL_LAST_N_RE.test(lower);
  if (hasTemporal) return "temporal";

  const hasEnumeration =
    tokens.some((t) => ENUMERATION_TOKENS.has(t)) || ENUMERATION_PHRASE_RE.test(lower);
  if (hasEnumeration) return "enumeration";

  const hasPreference = tokens.some((t) => PREFERENCE_TOKENS.has(t));
  if (hasPreference) return "preference";

  return "factual";
}

/**
 * The modest per-(intent, lane) up-weight. Kept small (1.5 ≤ 2.0) so the reweight COMPOSES with
 * the existing lane weights without overpowering trust-first ordering (a lane boost can lift a
 * lane's contribution but never overturn the trust ladder, which is a hard filter upstream).
 */
const TARGETED_BOOST = 1.5;

/**
 * Per-intent lane reweight multiplier. Returns exactly `1.0` (byte-identity) for the
 * `"factual"` intent on every lane AND for any (intent, lane) pair with no documented boost;
 * a documented `TARGETED_BOOST` (>1.0) on the targeted lane(s):
 *
 *   - `temporal`    → up-weights the `temporal` lane (recency/event-time evidence matters most).
 *   - `preference`  → up-weights the `entity` lane (preferences are entity-associative — the
 *                     person↔preference links the entity lane surfaces).
 *   - `enumeration` → NEUTRAL on every lane: enumeration's payoff is DIVERSITY, which is handled
 *                     by the MMR-λ knob, NOT a lane weight (a deliberate design fork).
 *   - `factual`     → NEUTRAL everywhere (the default-lookup byte-identity case).
 *
 * The switch over the closed {@link Intent} union carries an exhaustive `const _exhaustive: never`
 * default (score.ts `trustWeight` precedent, AGENTS.md §2.8) so a NEW intent fails the build here
 * until its reweight is decided explicitly — it can never silently fall through to 1.0.
 */
export function intentMultiplier(intent: Intent, lane: ReweightLane): number {
  switch (intent) {
    case "temporal":
      return lane === "temporal" ? TARGETED_BOOST : 1.0;
    case "preference":
      return lane === "entity" ? TARGETED_BOOST : 1.0;
    case "enumeration":
      return 1.0; // diversity via MMR-λ, not a lane weight
    case "factual":
      return 1.0; // default lookup → byte-identity on every lane
    default: {
      const _exhaustive: never = intent; // compile-time exhaustiveness: a NEW intent fails here
      void _exhaustive;
      return 1.0; // runtime-safe neutral (defense-in-depth; unreachable in pure TS)
    }
  }
}

// ---------------------------------------------------------------------------
// Synonym / acronym expansion (whole-query, bounded, FTS-safe)
// ---------------------------------------------------------------------------

/** Max synonym/acronym expansions appended PER term (the DoS / query-blow-up fan-out cap). */
const SYNONYM_FANOUT_CAP = 3;

/**
 * A SMALL, BOUNDED static synonym/acronym table (project/domain acronyms + a few common
 * synonyms) — deliberately a bounded static map, NOT a generated thesaurus. Keyed by a
 * lowercase token; the value is the expansion phrase(s) appended to the query. Expansions are
 * plain tokens (no FTS5 special chars) so the OR-join in buildFtsQuery stays injection-safe.
 */
const SYNONYM_MAP: Readonly<Record<string, readonly string[]>> = {
  vps: ["virtual private server"],
  config: ["configuration", "settings"],
  db: ["database", "datastore", "sqlite", "postgres"],
  auth: ["authentication", "login"],
  repo: ["repository"],
  docs: ["documentation"],
  k8s: ["kubernetes"],
  env: ["environment"],
  ci: ["continuous integration"],
};

/**
 * Expand a query STRING via the bounded {@link SYNONYM_MAP} (whole-query expansion, by
 * design). For each token, up to {@link SYNONYM_FANOUT_CAP} mapped expansion phrases are
 * appended (so buildFtsQuery's OR-join surfaces both the original term and its synonyms), then the
 * whole token list is de-duplicated and re-joined with single spaces.
 *
 * Guarantees (pure, never throws):
 *   - NO-MAP NO-OP: a query whose tokens are all unmapped returns the input STRING UNCHANGED
 *     (byte-identity — the precondition for the `synonyms:false` off-path proof).
 *   - BOUNDED FAN-OUT: at most `SYNONYM_FANOUT_CAP` expansions per term (a term with many
 *     synonyms cannot blow up the query — the DoS guard).
 *   - FTS-SAFE: double-quotes are stripped (the buildFtsQuery sanitisation shape) and the static
 *     map holds only plain tokens, so the output introduces no FTS5 special characters
 *     (the downstream buildFtsQuery re-sanitises).
 *   - DE-DUP: a synonym already present in the query is not appended twice.
 */
export function expandSynonyms(query: string): string {
  const sanitized = query.replace(/"/g, ""); // FTS5-injection-safe (the buildFtsQuery shape)
  const tokens = sanitized.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return query; // empty / whitespace-only → unchanged

  let expanded = false;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tok: string): void => {
    const key = tok.toLowerCase();
    if (seen.has(key)) return; // de-dup (case-insensitive)
    seen.add(key);
    out.push(tok);
  };

  for (const tok of tokens) {
    push(tok);
    const expansions = SYNONYM_MAP[tok.toLowerCase()];
    if (expansions !== undefined) {
      for (const phrase of expansions.slice(0, SYNONYM_FANOUT_CAP)) {
        for (const word of phrase.split(/\s+/).filter((w) => w.length > 0)) {
          const before = seen.size;
          push(word);
          if (seen.size > before) expanded = true; // a genuinely new token was added
        }
      }
    }
  }

  // NO-MAP NO-OP byte-identity: if nothing new was added, return the ORIGINAL string verbatim
  // (the sanitized/re-joined form could differ in whitespace from the input — preserve identity).
  return expanded ? out.join(" ") : query;
}

// ---------------------------------------------------------------------------
// NL temporal-range parse → [start,end] epoch range (nowMs param)
// ---------------------------------------------------------------------------

/** Milliseconds per day (UTC days are exactly 86_400_000 ms — no DST in UTC). */
const DAY_MS = 86_400_000;

/** UTC civil date (year, 0-based month, day, day-of-week 0=Sun) extracted from epoch ms. */
interface UtcParts {
  year: number;
  month0: number;
  day: number;
  dow: number;
}

/**
 * Howard Hinnant's `civil_from_days` — a PURE arithmetic epoch-days → (y, m, d) conversion.
 * Used instead of `new Date(nowMs).getUTC*()` because `new Date(...)` is a banned global
 * (globals.test.ts); `Date.UTC(...)` (the inverse, used for boundary math below) is a static
 * function and is NOT banned. Correct across leap years, century boundaries, and negative epochs
 * (verified against Node's Date over a sample spanning 1900–2024 incl. 2020-02-29 + pre-epoch).
 */
function utcPartsOf(epochMs: number): UtcParts {
  const days = Math.floor(epochMs / DAY_MS);
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  const year = m <= 2 ? y + 1 : y;
  let dow = (days % 7 + 4) % 7; // epoch day 0 (1970-01-01) was Thursday=4; normalize to [0,6]
  if (dow < 0) dow += 7;
  return { year, month0: m - 1, day, dow };
}

/** Start-of-UTC-day (00:00:00.000) for the calendar day containing `epochMs`. */
function startOfUtcDay(epochMs: number): number {
  const { year, month0, day } = utcPartsOf(epochMs);
  return Date.UTC(year, month0, day, 0, 0, 0, 0);
}

/** Inclusive end-of-month span [first ms of month, last ms of month] (handles year rollover). */
function monthSpan(year: number, month0: number): { start: number; end: number } {
  const start = Date.UTC(year, month0, 1, 0, 0, 0, 0);
  const end = Date.UTC(year, month0 + 1, 1, 0, 0, 0, 0) - 1; // Date.UTC normalizes Dec→next Jan
  return { start, end };
}

/** Full-year span [Jan 1 00:00, Dec 31 23:59:59.999]. */
function yearSpan(year: number): { start: number; end: number } {
  return { start: Date.UTC(year, 0, 1, 0, 0, 0, 0), end: Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1 };
}

/** Month name → 0-based index (full + 3-letter abbreviations). */
const MONTHS: Readonly<Record<string, number>> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

/** Day-of-week name → index (0=Sun), for "since <weekday>". */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Parse a natural-language time expression in `query` into a `[start, end]` epoch-ms range,
 * computed entirely from the `nowMs` PARAMETER. NEVER reads a global clock — the recall
 * path passes `deps.clock.now()`. NEVER throws — any unparseable / ambiguous query, or
 * any unexpected internal error, returns `undefined` (→ no `occurred_at` filter, recall unchanged).
 *
 * Supported expression families (the bounded grammar's contract):
 *   RELATIVE: "today", "yesterday", "last N days"/"last week" (rolling, ending now),
 *             "last month" (rolling 30-day, documented approximation), "this year",
 *             "since <weekday>" (from the most-recent past occurrence of that weekday to now).
 *   ABSOLUTE: "in YYYY" (full year), "in <Month>" (that month in nowMs's year),
 *             "in <Month> YYYY", "YYYY-MM" (that month).
 *
 * Deterministic: the same (query, nowMs) yields the same range every call. Boundary math uses the
 * static `Date.UTC(...)` (NOT the banned `new Date(...)`); UTC calendar parts of `nowMs` come from
 * the pure {@link utcPartsOf} arithmetic. The returned numbers flow to a BOUND `?` parameter in
 * the occurred_at WHERE clause (never string-concatenated into SQL).
 */
export function parseTemporalRange(
  query: string,
  nowMs: number,
): { start: number; end: number } | undefined {
  try {
    const lower = query.toLowerCase();

    // --- ABSOLUTE: YYYY-MM (e.g. "2023-01") ---
    const ymMatch = lower.match(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/);
    if (ymMatch) {
      return monthSpan(Number(ymMatch[1]), Number(ymMatch[2]) - 1);
    }

    // --- ABSOLUTE: "<Month> YYYY" or "<Month>" or "in YYYY" ---
    const monthNames = Object.keys(MONTHS).join("|");
    const monthYearRe = new RegExp(`\\b(${monthNames})\\s+((?:19|20)\\d{2})\\b`);
    const monthYear = lower.match(monthYearRe);
    if (monthYear) {
      return monthSpan(Number(monthYear[2]), MONTHS[monthYear[1]]);
    }
    const monthOnlyRe = new RegExp(`\\b(${monthNames})\\b`);
    const monthOnly = lower.match(monthOnlyRe);
    if (monthOnly) {
      // "in March" → that month in nowMs's year.
      const { year } = utcPartsOf(nowMs);
      return monthSpan(year, MONTHS[monthOnly[1]]);
    }
    const yearMatch = lower.match(/\b((?:19|20)\d{2})\b/);
    if (yearMatch) {
      return yearSpan(Number(yearMatch[1]));
    }

    // --- RELATIVE: today / yesterday ---
    if (/\btoday\b/.test(lower)) {
      const start = startOfUtcDay(nowMs);
      return { start, end: start + DAY_MS - 1 };
    }
    if (/\byesterday\b/.test(lower)) {
      const startToday = startOfUtcDay(nowMs);
      return { start: startToday - DAY_MS, end: startToday - 1 };
    }

    // --- RELATIVE: last N days (explicit N) ---
    const lastN = lower.match(/\blast\s+(\d+)\s+days?\b/);
    if (lastN) {
      const n = Number(lastN[1]);
      return { start: nowMs - n * DAY_MS, end: nowMs };
    }

    // --- RELATIVE: last week / last month (rolling windows ending now) ---
    if (/\blast\s+week\b/.test(lower)) {
      return { start: nowMs - 7 * DAY_MS, end: nowMs };
    }
    if (/\blast\s+month\b/.test(lower)) {
      return { start: nowMs - 30 * DAY_MS, end: nowMs }; // documented 30-day approximation
    }

    // --- RELATIVE: this year ---
    if (/\bthis\s+year\b/.test(lower)) {
      const { year } = utcPartsOf(nowMs);
      return yearSpan(year);
    }

    // --- RELATIVE: since <weekday> (most-recent past occurrence → now) ---
    const sinceDow = lower.match(/\bsince\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (sinceDow) {
      const target = WEEKDAYS[sinceDow[1]];
      const { dow } = utcPartsOf(nowMs);
      const back = (dow - target + 7) % 7; // days back to the target weekday (0 = today IS it)
      const startDay = startOfUtcDay(nowMs - back * DAY_MS);
      return { start: startDay, end: nowMs };
    }

    return undefined; // no recognized time expression → no filter (recall unchanged)
  } catch {
    return undefined; // pure-fn carve-out: any unexpected error → no filter, never throws
  }
}
