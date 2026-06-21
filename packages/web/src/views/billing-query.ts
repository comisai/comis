// SPDX-License-Identifier: Apache-2.0
/**
 * Typed-query DSL for the Billing view (OpenClaw `/usage` parity).
 *
 * A pure, dependency-free parser that maps a query string like
 * `agent:foo provider:openai minTokens:100 maxCost:0.5 has:errors tool:bash`
 * into a typed {@link BillingFilter}, applied client-side as an
 * `Array.prototype.filter` predicate over already-fetched billing rows.
 *
 * Two cross-cutting invariants are guaranteed by construction:
 * - **Injection-safe (T-179-15):** the parser produces a plain typed object;
 *   it builds no database query and no query string. Values are captured as
 *   data and only ever compared (`===`, `>=`, `<=`) in {@link applyBillingFilter}.
 * - **Content-free (T-179-14):** the filter axes are a CLOSED set of
 *   ids/enums/numbers — there is no free-text/body axis, so a message body can
 *   never become a filter.
 *
 * Grammar: tokenize on whitespace; split each token on the FIRST `:`; validate
 * the key against the closed set; coerce numbers for `minTokens`/`maxCost`
 * (a non-numeric value is dropped, never NaN-propagated); `has:errors` maps to
 * `hasErrors:true`. Unknown keys are ignored — never thrown on, never executed.
 *
 * @module
 */

/** The typed filter a {@link parseBillingQuery} call produces. */
export interface BillingFilter {
  agent?: string;
  provider?: string;
  model?: string;
  tool?: string;
  minTokens?: number;
  maxCost?: number;
  hasErrors?: boolean;
}

/**
 * A billing row the filter can be applied to. All fields optional so the
 * predicate degrades gracefully on partial rows; only the closed-set axes are
 * ever read (content-free).
 */
export interface BillingFilterableRow {
  agent?: string;
  provider?: string;
  model?: string;
  tool?: string;
  tokens?: number;
  cost?: number;
  hasErrors?: boolean;
}

/** The closed set of string-valued keys (the injection-safe allowlist). */
const STRING_KEYS = new Set(["agent", "provider", "model", "tool"]);
/** The closed set of number-valued keys. */
const NUMBER_KEYS = new Set(["minTokens", "maxCost"]);

/**
 * Parse a typed-query DSL string into a {@link BillingFilter}.
 *
 * Pure + total: any input (including malformed/empty) yields a filter object;
 * it never throws. Unknown keys are silently ignored.
 */
export function parseBillingQuery(input: string): BillingFilter {
  const filter: BillingFilter = {};
  if (typeof input !== "string") return filter;

  for (const token of input.trim().split(/\s+/)) {
    if (token.length === 0) continue;

    // Split on the FIRST colon only — a value may itself contain colons
    // (e.g. an ollama-style model id `registry:qwen3:8b`).
    const sep = token.indexOf(":");
    if (sep <= 0) continue; // no colon, or a leading colon → not a key:value token

    const key = token.slice(0, sep);
    const value = token.slice(sep + 1);
    if (value.length === 0) continue; // dangling key with no value

    if (STRING_KEYS.has(key)) {
      // Assign via a typed switch (no dynamic bracket write → no
      // security/detect-object-injection surface).
      switch (key) {
        case "agent": filter.agent = value; break;
        case "provider": filter.provider = value; break;
        case "model": filter.model = value; break;
        case "tool": filter.tool = value; break;
      }
    } else if (NUMBER_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue; // non-numeric → dropped, never NaN
      if (key === "minTokens") filter.minTokens = n;
      else filter.maxCost = n;
    } else if (key === "has") {
      // Only `has:errors` is meaningful; any other `has:` value is ignored.
      if (value === "errors") filter.hasErrors = true;
    }
    // else: unknown key → ignored (never thrown, never executed)
  }

  return filter;
}

/**
 * Apply a {@link BillingFilter} to a list of rows, returning only the matching
 * rows. A pure `Array.prototype.filter` predicate over in-memory data. An empty
 * filter matches every row.
 */
export function applyBillingFilter<T extends BillingFilterableRow>(
  rows: ReadonlyArray<T>,
  filter: BillingFilter,
): T[] {
  return rows.filter((row) => {
    if (filter.agent !== undefined && row.agent !== filter.agent) return false;
    if (filter.provider !== undefined && row.provider !== filter.provider) return false;
    if (filter.model !== undefined && row.model !== filter.model) return false;
    if (filter.tool !== undefined && row.tool !== filter.tool) return false;
    if (filter.minTokens !== undefined && (row.tokens ?? 0) < filter.minTokens) return false;
    if (filter.maxCost !== undefined && (row.cost ?? 0) > filter.maxCost) return false;
    if (filter.hasErrors !== undefined && (row.hasErrors ?? false) !== filter.hasErrors) return false;
    return true;
  });
}

/** Whether a filter has at least one active constraint (the view shows a count when so). */
export function isBillingFilterActive(filter: BillingFilter): boolean {
  return Object.keys(filter).length > 0;
}

/** Every valid DSL key (the closed set), for honest unknown-key feedback. */
const KNOWN_KEYS = new Set([...STRING_KEYS, ...NUMBER_KEYS, "has"]);

/**
 * Return an honest hint naming any key in `input` outside the closed set — so
 * the view can surface "Unknown filter key(s) ignored: …" without throwing.
 * Empty string when the query is empty or every key is valid.
 */
export function describeUnknownKeys(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw.length === 0) return "";
  const unknown = raw
    .split(/\s+/)
    .map((t) => (t.includes(":") ? t.slice(0, t.indexOf(":")) : ""))
    .filter((k) => k.length > 0 && !KNOWN_KEYS.has(k));
  return unknown.length > 0
    ? `Unknown filter key(s) ignored: ${[...new Set(unknown)].join(", ")}`
    : "";
}
