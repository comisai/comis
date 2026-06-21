// SPDX-License-Identifier: Apache-2.0
/**
 * A pure RFC4180 CSV serializer (COST-03, Phase 179 WS6).
 *
 * Greenfield — the repo had no CSV module (the `join(",")` hits elsewhere are
 * list-formatting, not CSV). Zero-dependency by design: the only escaping rule is
 * RFC4180 §2.6/§2.7 — a field containing a comma, a double-quote, or a line break
 * (CR or LF) is enclosed in double-quotes, and each embedded double-quote is
 * doubled. Records are joined with CRLF (§2.1).
 *
 * CONTENT-FREE BY CONSTRUCTION: `toCsv` projects ONLY the explicit `columns`
 * allowlist — it NEVER reflects arbitrary object keys (`Object.keys(row)`). A
 * source row may carry a body/secret/query field, but unless that key is named in
 * `columns` it can never reach the CSV (the export threat T-179-07). The caller
 * passes the cost-bucket + pricing-coverage column set; nothing else is emitted.
 *
 * @module
 */

/**
 * Serialize a single cell value to its CSV text form (pre-escaping).
 * - `null` / `undefined` → an empty field (RFC4180 has no null; empty is the norm).
 * - numbers / booleans → their `String(...)` form (`3.14`, `true`).
 * - strings → as-is.
 * Objects/arrays are stringified defensively, but the column allowlist should keep
 * scalar values only — a structured value is a caller bug, not silently dropped.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Defensive: a non-scalar is JSON-encoded so it is still escaped below rather
  // than emitting "[object Object]". The allowlist is expected to be scalar-only.
  return JSON.stringify(value);
}

/**
 * RFC4180-escape one already-stringified field: wrap in double-quotes and double
 * any embedded double-quote IFF the field contains a comma, a double-quote, CR,
 * or LF. A plain field is emitted bare.
 */
function escapeField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Render `rows` as an RFC4180 CSV string, projecting ONLY `columns` (the
 * content-free allowlist). The header row is `columns` (escaped); each data row
 * is the `columns`-projected, escaped values. Records are CRLF-joined. An empty
 * `rows` yields a header-only document.
 *
 * @param rows    - the source records (extra keys are ignored — never emitted).
 * @param columns - the explicit, ordered column allowlist (also the header).
 * @returns the CSV text (no trailing newline).
 */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string {
  const header = columns.map((c) => escapeField(c)).join(",");
  const body = rows.map((row) =>
    // Project ONLY the allowlisted columns — never Object.keys(row). This is the
    // content-free guarantee: a non-listed (body/secret) key cannot leak.
    columns.map((col) => escapeField(cellToString(row[col]))).join(","),
  );
  return [header, ...body].join("\r\n");
}
