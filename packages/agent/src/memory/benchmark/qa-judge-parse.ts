// SPDX-License-Identifier: Apache-2.0
/**
 * TOTAL judge-output parser (BENCH-03) -- turns the LLM judge's free text into a
 * `{ correct, reasoning }` verdict, or `undefined` when no verdict can be
 * extracted (the INVALID signal, which `qa-accuracy.ts` EXCLUDES from the
 * accuracy denominator -- never counts as a wrong answer).
 *
 * SUPERSET OF `parseExtractionResult` (memory-extraction.ts:90-100): that analog
 * is fence-strip -> JSON.parse(try/catch) -> `undefined`. This parser ADDS both a
 * leading-`{...}`-object extraction AND a regex fallback because the judge --
 * instructed to emit `{ "correct": bool, "reasoning" }` but free-text by nature --
 * also emits a JSON object followed by trailing commentary, `correct: yes`,
 * fenced JSON, or a `correct=no` token (Pitfall 1; PATTERNS Correction #2). The
 * order is:
 *   1. strip markdown code fences (same regex as the analog),
 *   2. JSON.parse the whole string inside try/catch; a boolean `correct` wins,
 *   3. else JSON.parse the FIRST balanced `{...}` substring (JSON + trailing prose),
 *   4. else a bounded `correct\s*[:=]\s*"?(true|yes|false|no)"?` regex,
 *   5. otherwise `undefined`.
 *
 * SECURITY -- TOTAL over an untrusted boundary (ASVS V5/V7, T-89-02-01): the judge
 * text is lightly-trusted, possibly-injected free text. This function NEVER
 * throws on arbitrary/adversarial input -- a parse failure is a deterministic
 * `undefined` (-> counted invalid, not wrong), so malformed or hostile judge
 * output cannot crash the harness or be scored as a real verdict. The regex is
 * anchored/bounded with non-nested quantifiers (the loaders' ReDoS-safe
 * convention -- longmemeval-loader.ts:101, locomo-loader.ts:137).
 *
 * ADVISORY-ONLY caveat (T-89-02-02, accept): an injected `correct=true` CAN steer
 * a verdict, but the judge is measurement only and grants no capability. The
 * parser does NOT treat prose as a rubric -- it extracts ONLY the `correct`
 * verdict token the judge was asked to emit; free prose mentioning "correct
 * answer" (no `:`/`=` separator) yields no token -> `undefined`.
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module -- the agent
 * package may not import the memory package; this file has no external import at
 * all. Mirrors the cut-clean, no-Result, no-throw discipline of recall-eval.ts.
 *
 * @module
 */

/** A parsed judge verdict: the boolean grade + the judge's short reasoning. */
export interface JudgeVerdict {
  /** `true` if the judge graded the model answer correct. */
  correct: boolean;
  /** The judge's short reasoning (defaults to `""` when absent). */
  reasoning: string;
}

/**
 * Parse raw judge text into a {@link JudgeVerdict}, or `undefined` when no
 * verdict token is present.
 *
 * TOTAL -- never throws. JSON / fenced JSON with a boolean `correct` parses
 * directly; otherwise a bounded `correct: yes|no|true|false` regex is the
 * fallback; otherwise `undefined` (the invalid signal). `undefined` is the
 * caller's cue to mark the question INVALID (excluded from the accuracy
 * denominator in `qa-accuracy.ts`), NOT to score it wrong.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | undefined {
  const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  // 1. whole-string JSON, then the first balanced {...} object (JSON + trailing prose).
  for (const candidate of [cleaned, firstJsonObject(cleaned)]) {
    if (candidate === undefined) continue;
    const verdict = verdictFromJson(candidate);
    if (verdict !== undefined) return verdict;
  }
  // 2. bounded regex fallback over `correct: yes|no|true|false`.
  const m = /correct\s*[:=]\s*"?(true|yes|false|no)"?/i.exec(cleaned);
  if (m) {
    return { correct: /true|yes/i.test(m[1] ?? ""), reasoning: cleaned.slice(0, 200) };
  }
  return undefined; // -> counted as `invalid` (qa-accuracy.ts denominator), NEVER as wrong
}

/** Parse a JSON string and return a verdict iff it carries a boolean `correct`. */
function verdictFromJson(s: string): JudgeVerdict | undefined {
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    if (typeof j.correct === "boolean") {
      return { correct: j.correct, reasoning: String(j.reasoning ?? "") };
    }
  } catch {
    /* not JSON -- caller falls through */
  }
  return undefined;
}

/**
 * Extract the first balanced top-level `{...}` substring (handles a JSON object
 * the judge emitted followed by trailing commentary). Brace-depth scan with
 * string/escape awareness; a single linear pass (ReDoS-free -- no regex). Returns
 * `undefined` when no balanced object is present.
 */
function firstJsonObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined; // unterminated object
}
