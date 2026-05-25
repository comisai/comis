// SPDX-License-Identifier: Apache-2.0
/**
 * Strict response parser for `comis config tooling-fill` agent output.
 *
 * The agent is instructed (by prompt-template.ts) to emit ONLY two lines:
 *
 *   DESCRIPTION: <one-line text>
 *   REPLACES_PACKAGES: <json array>
 *
 * Defense-in-depth: any other lines — `CLUSTER: …`, `INSTALL_DETOURS: …`,
 * prose, code fences, shell-injection — are silently ignored. The parser
 * scans line-by-line for the FIRST match of each pattern; everything that
 * doesn't match either pattern is dropped.
 *
 * Package-name validation lives in validators.ts; this parser only enforces
 * grammar. Shell-shaped strings INSIDE the JSON array pass through here and
 * are filtered downstream by validatePackageNames.
 *
 * No I/O, no logger. Returns Result<ParsedFill, ParseError>; errorKind is the
 * closed union "validation" with a discriminated `reason` for each failure.
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";

/** Closed union of failure modes — exhaustive switch in callers is checked. */
export type ParseFailureReason =
  | "empty-response"
  | "missing-both-fields"
  | "missing-description"
  | "missing-replaces"
  | "invalid-replaces-array";

export interface ParseError {
  readonly kind: "validation";
  readonly reason: ParseFailureReason;
  readonly detail?: string;
}

export interface ParsedFill {
  readonly description: string;
  readonly replacesPackages: string[];
}

/**
 * First line whose tail (after `DESCRIPTION:` and any whitespace) is non-empty
 * "wins". Multi-line wrapping is intentionally NOT supported — the prompt
 * forbids it; the parser enforces it.
 */
const DESCRIPTION_RE = /^DESCRIPTION:\s*(.+)$/;

/**
 * REPLACES_PACKAGES tail must be a JSON array literal `[...]` on a single
 * line. Non-array shapes (`{...}`, bare values) never match — treated as if
 * the line is absent (→ missing-replaces). This is the first defense layer;
 * JSON.parse is the second.
 */
const REPLACES_RE = /^REPLACES_PACKAGES:\s*(\[.*\])\s*$/;

/**
 * Parse the agent's response, extracting ONLY the two contracted fields.
 *
 * Strategy: line-scan for the FIRST match of each pattern. Anything else is
 * dropped (strict scope). The agent cannot inject extra fields, change
 * `cluster`, alter sibling keys, or escape the contract — even if the
 * prompt forbid is bypassed (e.g. via prompt-injection attack carried
 * inside an MCP description), the parser is the structural gate.
 */
export function parseFillResponse(
  raw: string,
): Result<ParsedFill, ParseError> {
  if (raw.trim().length === 0) {
    return err({ kind: "validation", reason: "empty-response" });
  }
  const lines = raw.split(/\r?\n/);
  let description: string | undefined;
  let replacesRaw: string | undefined;
  for (const line of lines) {
    if (description === undefined) {
      const m = DESCRIPTION_RE.exec(line);
      if (m !== null) {
        // Take FIRST line content only — never multi-line a one-line field.
        description = m[1]!.trim();
        continue;
      }
    }
    if (replacesRaw === undefined) {
      const m = REPLACES_RE.exec(line);
      if (m !== null) {
        replacesRaw = m[1]!.trim();
      }
    }
  }
  // Reason ordering: both-missing first (most-specific signal), then per-field.
  if (description === undefined && replacesRaw === undefined) {
    return err({ kind: "validation", reason: "missing-both-fields" });
  }
  if (description === undefined || description.length === 0) {
    return err({ kind: "validation", reason: "missing-description" });
  }
  if (replacesRaw === undefined) {
    return err({ kind: "validation", reason: "missing-replaces" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(replacesRaw);
  } catch (e) {
    return err({
      kind: "validation",
      reason: "invalid-replaces-array",
      detail: `JSON parse: ${(e as Error).message}`,
    });
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((x): x is string => typeof x === "string")
  ) {
    return err({
      kind: "validation",
      reason: "invalid-replaces-array",
      detail: "REPLACES_PACKAGES must be a JSON array of strings",
    });
  }
  return ok({ description, replacesPackages: parsed });
}
