// SPDX-License-Identifier: Apache-2.0
/**
 * Judge wrapper — thin abstraction over the bench-memory QA judge for MEM Stage-C.
 *
 * Reads COMIS_LIVE_JUDGE_PROVIDER, COMIS_LIVE_JUDGE_MODEL, COMIS_LIVE_JUDGE_API_KEY
 * from env (mirroring bench-memory.sh require_answer_judge_env guard).
 * Returns {verdict:"skip"} when env is absent — never throws on missing env.
 * Cross-judge ≥2 required for any published readiness claim.
 *
 * sweepSecrets: replicates bench-memory.sh sweep_dir in TypeScript.
 * Scans all files under dirPath for credential shapes:
 *   sk-[A-Za-z0-9_-]{16,} | Bearer [A-Za-z0-9._-]+ | apiKey<sep><quoted-value>
 * Throws on any match (belt-and-suspenders over in-test omission gates).
 *
 * Sweep throws with path only — matched content is NEVER included
 * in the error message (Information Disclosure mitigation).
 * COMIS_LIVE_JUDGE_API_KEY is read once and never returned or logged.
 *
 * @module
 */
import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { computePassRate } from "./stats.js";
import type { PassRateTier } from "./stats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verdict returned by judgeAnswer. */
export interface JudgeResult {
  verdict: "pass" | "fail" | "skip";
  /** Human-readable explanation (never includes secret values). */
  reason: string;
  /** Identifier for the judge model/config used, or "none" on skip. */
  judgeId: string;
}

/** Input to the judge. */
export interface JudgeInput {
  question: string;
  context: string;
  answer: string;
  rubric: string;
}

/**
 * Minimal shape of a completion fn the judge call needs — a function that takes
 * the built prompt and resolves to an object carrying text content blocks.
 * The default (real) impl lazily wraps pi-ai's `completeSimple`; the unit test
 * injects a deterministic stub (mirror `__fixtures__/qa-judge-stub.ts`).
 */
export type JudgeCompleteFn = (
  prompt: string,
) => Promise<{ content?: unknown[]; usage?: { totalTokens?: number } }>;

/** DI seam for judgeAnswer — lets the unit test inject a stub completion fn. */
export interface JudgeDeps {
  /** Stub completion fn (test). When absent, the real pi-ai judge is used. */
  complete?: JudgeCompleteFn;
}

// ---------------------------------------------------------------------------
// Secret pattern (mirrors bench-memory.sh sweep_dir line 123)
// A bare \bapiKey\b matches variable names (false positive), so this uses
// a value-requiring pattern: apiKey["':= ]+"<value>". This matches YAML/JSON
// credential assignments (apiKey: "sk-...", "apiKey": "realvalue") but NOT
// bare identifiers or declarations like `const apiKey = ...`.
// Mirrors the same fix applied in cost.ts for this hazard.
// ---------------------------------------------------------------------------
const SECRET_PATTERN =
  /sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|(?:"apiKey"|apiKey)\s*[=:]\s*["'][^"']{4,}/;

// ---------------------------------------------------------------------------
// judgeAnswer
// ---------------------------------------------------------------------------

/**
 * Evaluate an answer against a rubric using the configured judge model.
 *
 * Gate: returns {verdict:"skip", reason:"no-creds", judgeId:"none"} when
 * COMIS_LIVE_JUDGE_PROVIDER or COMIS_LIVE_JUDGE_API_KEY is absent from env.
 * Never throws on missing credentials — skip ≠ fail.
 *
 * When the judge env IS present, this invokes the REAL qa-judge: build the
 * category-rubric-first prompt
 * (mirrors bench-memory `buildJudgePrompt`), call the judge model at
 * temperature 0 via pi-ai `completeSimple` (lazy-imported; a DI `deps.complete`
 * stub bypasses it in tests), extract the text, and parse the verdict (the
 * bench `parseJudgeVerdict`, inlined — a PURE total parser). A parseable
 * `correct:true` → "pass", `correct:false` → "fail"; an UNPARSEABLE judge
 * output → "skip" (INVALID — excluded, never scored as a wrong answer, the
 * bench accuracy-denominator discipline).
 *
 * CROSS-JUDGE: this wires the SINGLE-judge invocation; cross-judge ≥2 (a second
 * judge model + agreement) for any PUBLISHED readiness claim is the operator
 * step. The unit test exercises the non-skip path with a STUB.
 *
 * The API key is read for presence + forwarded to the pi-ai option
 * field only; it is NEVER included in the returned JudgeResult, the judgeId, the
 * reason, or any log. The judge prompt/output are never logged (the
 * residency rule — the prompt may carry the answer).
 */
export async function judgeAnswer(
  input: JudgeInput,
  deps?: JudgeDeps,
): Promise<JudgeResult> {
  const provider = process.env["COMIS_LIVE_JUDGE_PROVIDER"];
  const apiKey = process.env["COMIS_LIVE_JUDGE_API_KEY"];

  if (!provider || !apiKey) {
    return {
      verdict: "skip",
      reason: "no-creds: COMIS_LIVE_JUDGE_PROVIDER or COMIS_LIVE_JUDGE_API_KEY unset",
      judgeId: "none",
    };
  }

  const model = process.env["COMIS_LIVE_JUDGE_MODEL"] ?? "claude-3-5-haiku-20241022";
  const judgeId = `${provider}:${model}`;

  // Build the judge prompt — rubric FIRST (prompt-injection ordering), then the
  // question / gold-or-context / generated answer; ask for ONLY the verdict JSON.
  const prompt = buildJudgePromptLocal(input);

  // Resolve the completion fn: the injected stub (test) or the lazy real pi-ai
  // judge call. The real path reads the key from env inside the closure and
  // never returns/logs it (presence-only at the seam boundary).
  const complete: JudgeCompleteFn =
    deps?.complete ?? (await makeRealJudgeComplete(provider, model, apiKey));

  let text: string;
  try {
    const resp = await complete(prompt);
    text = extractJudgeText(resp);
  } catch (err) {
    // A judge-call failure is NOT a verdict — surface as skip (invalid), never a
    // wrong answer. The message is sanitized (no key/prompt) — only the kind.
    const kind = err instanceof Error ? err.name : "error";
    return { verdict: "skip", reason: `judge call failed (${kind}) — invalid, not scored`, judgeId };
  }

  const verdict = parseJudgeVerdict(text);
  if (verdict === undefined) {
    // Unparseable judge output ⇒ INVALID (excluded from the denominator), NOT
    // wrong. skip ≠ fail.
    return { verdict: "skip", reason: "judge output unparseable (invalid — not scored)", judgeId };
  }

  return {
    verdict: verdict.correct ? "pass" : "fail",
    reason: verdict.reasoning.slice(0, 200),
    judgeId,
  };
}

// ---------------------------------------------------------------------------
// Judge helpers (inlined from packages/agent/src/memory/benchmark/* — those
// modules are NOT exported from @comis/agent's public index, so they cannot be
// imported here; the bench modules carry their own coverage).
// ---------------------------------------------------------------------------

/**
 * Build the judge prompt. Mirrors bench-memory `qa-judge-prompt.ts buildJudgePrompt`:
 * the rubric is placed FIRST (prompt-injection ordering — lightly-trusted answer
 * text follows the trusted rubric), then Question / Context / Generated answer,
 * then the ONLY-JSON instruction.
 */
function buildJudgePromptLocal(input: JudgeInput): string {
  return (
    `${input.rubric}\n\n` +
    `Question: ${input.question}\n` +
    `Reference / context: ${input.context}\n` +
    `Generated answer: ${input.answer}\n` +
    "First, provide a short (one sentence) explanation of your reasoning. " +
    "Short reasoning is preferred.\n" +
    'Return ONLY JSON of the form { "correct": true|false, "reasoning": "..." }. ' +
    "If the generated answer satisfies the rubric, set correct=true."
  );
}

/**
 * Walk a pi-ai `AssistantMessage`-shaped `{content:[{type:"text",text}]}` and
 * concatenate the text blocks. Mirrors the private `extractResponseText` helper
 * duplicated across the memory seams (memory-review-job.ts:240 et al).
 */
function extractJudgeText(resp: { content?: unknown[] }): string {
  if (!Array.isArray(resp.content)) return "";
  let out = "";
  for (const block of resp.content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

/** A parsed judge verdict (mirrors qa-judge-parse.ts JudgeVerdict). */
interface JudgeVerdict {
  correct: boolean;
  reasoning: string;
}

/**
 * Parse raw judge text into a verdict, or undefined when no verdict token is
 * present. Inlined VERBATIM from the PURE `qa-judge-parse.ts parseJudgeVerdict`
 * (a no-import TOTAL module — never throws; an unparseable verdict is undefined,
 * the INVALID signal, NOT a wrong answer).
 */
function parseJudgeVerdict(text: string): JudgeVerdict | undefined {
  const cleaned = stripCodeFences(text);
  for (const candidate of [cleaned, firstJsonObject(cleaned)]) {
    if (candidate === undefined) continue;
    const verdict = verdictFromJson(candidate);
    if (verdict !== undefined) return verdict;
  }
  const m = /correct\s*[:=]\s*"?(true|yes|false|no)"?/i.exec(cleaned);
  if (m) {
    return { correct: /true|yes/i.test(m[1] ?? ""), reasoning: cleaned.slice(0, 200) };
  }
  return undefined;
}

function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
}

function verdictFromJson(s: string): JudgeVerdict | undefined {
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    if (typeof j.correct === "boolean") {
      return { correct: j.correct, reasoning: String(j.reasoning ?? "") };
    }
  } catch {
    /* not JSON — caller falls through */
  }
  return undefined;
}

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
  return undefined;
}

/**
 * Lazily build the REAL judge completion fn over pi-ai `completeSimple`. The
 * dynamic import keeps `@earendil-works/pi-ai` off this module's import graph
 * (the DI stub never reaches it). Mirrors the bench harness idiom
 * (qa-judge-harness.bench.test.ts:569-581): temperature 0, the key forwarded to
 * the pi-ai option field, never stored/logged.
 */
async function makeRealJudgeComplete(
  provider: string,
  model: string,
  apiKey: string,
): Promise<JudgeCompleteFn> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic provider/modelId strings into pi-ai's typed getModel
  const piai: any = await import("@earendil-works/pi-ai");
  const judgeModel = piai.getModel(provider, model);
  return async (prompt: string) => {
    const resp = await piai.completeSimple(
      judgeModel,
      { messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] },
      { apiKey, temperature: 0, maxTokens: 1024 },
    );
    return resp as { content?: unknown[]; usage?: { totalTokens?: number } };
  };
}

// ---------------------------------------------------------------------------
// sweepSecrets
// ---------------------------------------------------------------------------

/**
 * Scan all files under dirPath for credential shapes.
 *
 * Credential patterns (mirrors bench-memory.sh sweep_dir):
 *   sk-[A-Za-z0-9_-]{16,}             — Anthropic/OpenAI-style API keys
 *   Bearer [A-Za-z0-9._-]+            — HTTP Bearer tokens
 *   apiKey["':= ]+"<value>{4,}"       — YAML/JSON apiKey key-value assignments
 *                                        (matches apiKey: "realvalue" but NOT
 *                                        bare `const apiKey = ...` identifiers)
 *
 * Throws with the FILE PATH only — matched content is never
 * included in the error message (Information Disclosure mitigation).
 *
 * No-op when dirPath does not exist (mirrors bench-memory.sh guard).
 *
 * @param dirPath - Directory to scan recursively.
 * @throws Error with "SECRET LEAK" in the message when any credential shape found.
 */
export function sweepSecrets(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  _sweepDir(dirPath);
}

function _sweepDir(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Use lstatSync (does NOT follow symlinks) to avoid infinite
    // recursion on symlinks-to-parents. Then filter by isFile() before reading
    // to skip sockets, FIFOs, device nodes, and symlinks — readFileSync on a
    // socket or FIFO hangs indefinitely, blocking the entire test process.
    const st = lstatSync(full);
    if (st.isDirectory()) {
      _sweepDir(full);
      continue;
    }
    if (!st.isFile()) continue; // skip sockets, FIFOs, device nodes, symlinks
    const text = readFileSync(full, "utf-8");
    if (SECRET_PATTERN.test(text)) {
      // Include path only — never the matched content.
      throw new Error(`SECRET LEAK detected in ${full} — failing the run.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports from stats.ts (convenience for callers importing from judge.ts)
// ---------------------------------------------------------------------------
export { computePassRate };
export type { PassRateTier };
