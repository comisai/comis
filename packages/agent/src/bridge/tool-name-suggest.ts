// SPDX-License-Identifier: Apache-2.0
/**
 * Recover a hallucinated tool name to the closest REAL tool (F-13, live 2026-06-12).
 *
 * Small models routinely guess a wrong tool name — most often by mimicking the MCP
 * naming convention (`mcp__<server>--<verb>`) for a BUILTIN tool, e.g. emitting
 * `mcp__memory_manage--delete` for the real `memory_manage`. The SDK returns
 * "Tool <name> not found"; without a hint the model re-guesses and loops. This maps
 * the guess back to the closest configured tool so the not-found error can say
 * `Did you mean "memory_manage"?` and the model self-corrects.
 *
 * Conservative: returns undefined unless a confident match exists (no false steer).
 *
 * @module
 */

/** Normalize a name into a token set: drop a leading `mcp__`, split on `_`/`-`. */
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .replace(/^mcp__/, "")
      .replace(/[-]+/g, "_")
      .split("_")
      .filter(Boolean),
  );
}

/**
 * @param missing - the (non-existent) tool name the model called
 * @param real - the names of the tools actually available this turn
 * @returns the closest real tool name, or undefined if none is confident
 */
export function suggestClosestTool(missing: string, real: readonly string[]): string | undefined {
  if (real.length === 0) return undefined;
  const realSet = new Set(real);

  // 1. Strip an `mcp__` prefix + a trailing `--<verb>` (the MCP shape applied to a
  //    builtin): mcp__memory_manage--delete → memory_manage.
  const stripped = missing.replace(/^mcp__/, "").replace(/--[a-z0-9_]+$/i, "");
  if (realSet.has(stripped)) return stripped;
  // also collapse ALL `--segments`: a--b--c → a
  const core = stripped.replace(/--.*$/, "");
  if (core !== stripped && realSet.has(core)) return core;

  // 2. A real tool name embedded in the guess (call_memory_search_tool → memory_search).
  //    Longest containment wins.
  const contained = real.filter((r) => missing.includes(r)).sort((a, b) => b.length - a.length);
  if (contained.length > 0) return contained[0];

  // 3. Token-overlap fallback for typos (memory_serch → memory_search). Require a
  //    strong majority overlap so we never steer to an unrelated tool.
  const mTokens = tokenize(missing);
  if (mTokens.size === 0) return undefined;
  let best: { name: string; score: number } | undefined;
  for (const r of real) {
    const rTokens = tokenize(r);
    let overlap = 0;
    for (const t of rTokens) if (mTokens.has(t)) overlap++;
    // also count near-equal tokens (one edit apart) to catch single-char typos
    if (overlap < rTokens.size) {
      for (const rt of rTokens) {
        if (mTokens.has(rt)) continue;
        for (const mt of mTokens) {
          if (Math.abs(rt.length - mt.length) <= 1 && oneEditApart(rt, mt)) {
            overlap++;
            break;
          }
        }
      }
    }
    const score = overlap / Math.max(rTokens.size, 1);
    if (overlap > 0 && (!best || score > best.score)) best = { name: r, score };
  }
  return best && best.score >= 0.5 ? best.name : undefined;
}

/** True when `a` and `b` differ by at most one insert/delete/substitution. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  if (s.length === l.length) {
    let diff = 0;
    for (let i = 0; i < s.length; i++) if (s[i] !== l[i]) diff++;
    return diff <= 1;
  }
  // length differs by 1 — check for a single deletion
  for (let i = 0; i < l.length; i++) {
    if (s === l.slice(0, i) + l.slice(i + 1)) return true;
  }
  return false;
}
