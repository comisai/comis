// SPDX-License-Identifier: Apache-2.0
/**
 * Generic tool-entry schema validator.
 *
 * Pre-flight, action-aware shape gate that runs BEFORE per-tool
 * `validateInput`. Catches malformed shapes such as
 * `mcp_manage({action:"connect", server_name:"yfinance"})` at the
 * tool-entry boundary and produces a self-correcting message:
 *
 *     "[invalid_value] unknown key 'server_name' -- did you mean 'name'?.
 *      missing for action='connect': transport.
 *      valid keys: action, name, transport, command, args, url, headers"
 *
 * Generic by construction: every per-tool branch lives in the metadata
 * registered via `registerToolMetadata({ validActions, validKeys,
 *   requiredByAction })`. This file contains zero tool-name conditionals.
 *
 * Reuses `levenshteinSimilarity` from
 * ../builtin/file/path-suggest.js -- DO NOT duplicate the helper.
 *
 * Returns a single error string on failure (matches the
 * `validateInput` contract used by `wrapWithMetadataEnforcement`),
 * `undefined` on success. Caller prepends `[invalid_value]`.
 *
 * @module
 */

import type { ComisToolMetadata } from "@comis/core";
import { levenshteinSimilarity } from "../../tools/builtin/file/path-suggest.js";

/**
 * Min similarity for did-you-mean suggestion. Below this we say "unknown"
 * with no suggestion to avoid misleading the LLM.
 *
 * We score with `tokenAwareSimilarity` (max of full-string similarity and
 * the best per-token similarity after splitting on `_`/`-`). This catches
 * payloads like `server_name -> name` (token "name" matches exactly,
 * score 1.0) without spurious matches against short unrelated keys (`x`,
 * `srver` -> max < 0.3 across all candidates in the 7-key mcp_manage
 * shape, well below threshold).
 *
 * 0.5 was chosen empirically: `conect -> connect` scores 0.857 (fires);
 * `srver -> headers` scores 0.286 (does not fire); the closest false
 * positive across the manage-tool corpus is below 0.5.
 */
const SUGGEST_THRESHOLD = 0.5;

/**
 * Validate tool-entry shape against registered metadata.
 *
 * @param params - Raw params object as the SDK would pass to `execute()`.
 * @param meta - Metadata returned from `getToolMetadata(toolName)`. May be
 *   undefined or missing the entry-shape fields -- in either case this
 *   function returns undefined (no-op) so existing tools without
 *   registered shape metadata pass through unchanged.
 * @returns A single error string when validation fails (caller prepends
 *   `[invalid_value]`), or `undefined` when validation passes / is skipped.
 */
export function validateToolEntry(
  params: unknown,
  meta: ComisToolMetadata | undefined,
): string | undefined {
  // Skip if no entry-shape metadata registered.
  if (
    meta === undefined
    || (meta.validActions === undefined
      && meta.validKeys === undefined
      && meta.requiredByAction === undefined)
  ) {
    return undefined;
  }

  // Shape gate: params MUST be a plain object. Reject null, primitives,
  // and arrays. (Arrays would otherwise pass typeof === "object".)
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return "params must be an object";
  }

  const p = params as Record<string, unknown>;
  const segments: string[] = [];

  // Action gate.
  let action: string | undefined;
  if (meta.validActions !== undefined) {
    const raw = p.action;
    if (raw === undefined) {
      segments.push(
        `Missing required parameter: action. valid actions: ${meta.validActions.join(", ")}`,
      );
    } else if (typeof raw !== "string") {
      segments.push("action must be a string");
    } else if (!meta.validActions.includes(raw)) {
      const suggestion = bestMatch(raw, meta.validActions);
      const didYouMean = suggestion !== undefined ? ` -- did you mean '${suggestion}'?` : "";
      segments.push(
        `invalid action '${raw}'${didYouMean}. valid actions: ${meta.validActions.join(", ")}`,
      );
    } else {
      action = raw;
    }
  } else if (typeof p.action === "string") {
    // No validActions registered but the tool still uses an action field
    // (rare). Use it for requiredByAction lookup.
    action = p.action;
  }

  // Unknown-key gate.
  if (meta.validKeys !== undefined) {
    const validSet = new Set(meta.validKeys);
    const unknowns: string[] = [];
    for (const key of Object.keys(p)) {
      if (!validSet.has(key)) unknowns.push(key);
    }
    if (unknowns.length > 0) {
      const parts = unknowns.map((k) => {
        const suggestion = bestMatch(k, meta.validKeys!);
        return suggestion !== undefined
          ? `unknown key '${k}' -- did you mean '${suggestion}'?`
          : `unknown key '${k}'`;
      });
      segments.push(parts.join("; "));
    }
  }

  // Required-fields gate (only when we have a known action).
  if (action !== undefined && meta.requiredByAction !== undefined) {
    const required = meta.requiredByAction[action];
    if (required !== undefined && required.length > 0) {
      const missing = required.filter((k) => !(k in p) || p[k] === undefined);
      if (missing.length > 0) {
        segments.push(`missing for action='${action}': ${missing.join(", ")}`);
      }
    }
  }

  if (segments.length === 0) return undefined;

  // Always append valid-keys list when registered -- closes the LLM's
  // self-correction loop in one turn.
  if (meta.validKeys !== undefined) {
    segments.push(`valid keys: ${meta.validKeys.join(", ")}`);
  }
  return segments.join(". ");
}

/** Pick the best-matching candidate above SUGGEST_THRESHOLD, or undefined. */
function bestMatch(input: string, candidates: readonly string[]): string | undefined {
  let best: { value: string; score: number } | undefined;
  const lowered = input.toLowerCase();
  for (const candidate of candidates) {
    const score = tokenAwareSimilarity(lowered, candidate.toLowerCase());
    if (score >= SUGGEST_THRESHOLD && (best === undefined || score > best.score)) {
      best = { value: candidate, score };
    }
  }
  return best?.value;
}

/**
 * Token-aware similarity: max of full-string similarity and the best
 * per-token similarity after splitting `input` on `_`/`-`.
 *
 * Plain Levenshtein on full strings misses snake_case key suggestions:
 * `server_name` vs `name` is similarity 0.36, well below any reasonable
 * threshold. Splitting on `_` exposes the `name` token (similarity 1.0
 * vs `name`), which is the LLM-self-correction signal we want to surface.
 *
 * Inputs are assumed lowercased by the caller.
 */
function tokenAwareSimilarity(input: string, candidate: string): number {
  let best = levenshteinSimilarity(input, candidate);
  // Split on '_' or '-' (skill, manage-tool, snake_case conventions). Empty
  // tokens are dropped so leading/trailing/double-separators do not produce
  // 0-length strings that would skew similarity to 1.0 against an empty
  // candidate (defensive -- candidate is non-empty in practice).
  const tokens = input.split(/[_-]+/);
  for (const t of tokens) {
    if (t.length === 0) continue;
    const score = levenshteinSimilarity(t, candidate);
    if (score > best) best = score;
  }
  return best;
}
