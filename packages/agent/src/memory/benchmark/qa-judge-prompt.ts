// SPDX-License-Identifier: Apache-2.0
/**
 * Pure per-category LLM-judge prompt builder — the category-specific,
 * LongMemEval-paper-derived grading rubric the gated harness feeds
 * to the judge model via `completeSimple`.
 *
 * Mirrors the discipline of `memory-extraction.ts` (the `STRUCTURED_PROMPT`
 * sibling): the verbose prompt constants live HERE, apart from the harness's
 * I/O, so this file stays a no-mock RED->GREEN unit and the harness stays under
 * the 800-line cap.
 *
 * PROVENANCE: the rubric strings are ported VERBATIM from the LongMemEval-paper
 * judge prompts as carried by the Hindsight harness (`benchmark_runner.py`
 * `judge_answer`, the category branches at :261-323 + the uniform tail at
 * :329-337), with TWO deliberate adaptations:
 *   1. Hindsight's source has a stray negative-verdict typo (it writes the
 *      verdict token with "no" instead of "false") in the single-session
 *      branch — ported here as the corrected `correct=false`.
 *   2. Hindsight uses OpenAI `response_format=JudgeResponse` structured output;
 *      pi-ai `completeSimple` has NO response_format arg, so the JSON verdict
 *      contract is instructed IN-PROMPT and parsed by the judge-verdict parser.
 *
 * SECURITY (prompt-injection ordering): the rubric and
 * instructions are placed FIRST; the UNTRUSTED dataset slots (`question`,
 * `goldAnswer`, `modelAnswer`) are appended AFTER, in clearly labeled fields, so
 * adversarial dataset content cannot masquerade as judge instructions. The judge
 * is advisory measurement only — it grants no capability. Pure string ops; the
 * agent->memory architecture cut forbids importing the memory package here.
 *
 * @module
 */

/**
 * The 6 LongMemEval `question_type` values that select a category-specific
 * rubric. VERIFIED against `longmemeval_benchmark.py:952` (help string) + `:578`
 * (filter). Any other category (LoCoMo numeric categories, the loader's
 * `"unknown"` fallback, or any unrecognized string) routes to the DEFAULT rubric.
 */
export const JUDGE_CATEGORIES = [
  "single-session-user",
  "single-session-assistant",
  "multi-session",
  "single-session-preference",
  "temporal-reasoning",
  "knowledge-update",
] as const;

export type JudgeCategory = (typeof JUDGE_CATEGORIES)[number];

/**
 * The shared rubric body for the three "factual recall" categories
 * (single-session-user, single-session-assistant, multi-session). Ported
 * verbatim; Hindsight's negative-verdict typo corrected to `correct=false`.
 */
const SHARED_FACTUAL_RUBRIC =
  "I will give you a question, a correct answer, and a response from a model. " +
  "Please set correct=true if the response contains the correct answer. Of course, " +
  "the response can contain other content as well, but the correct answer must be " +
  "present. If the response is equivalent to the correct answer or contains all the " +
  "intermediate steps to get the correct answer, you should also set correct=true. " +
  "If the response only contains a subset of the information required by the answer, " +
  "set correct=false.";

/**
 * temporal-reasoning: the shared factual body PLUS the off-by-one-days carve-out.
 * Ported verbatim (benchmark_runner.py temporal branch).
 */
const TEMPORAL_RUBRIC =
  SHARED_FACTUAL_RUBRIC +
  " In addition, do not penalize off-by-one errors for the number of days. If the " +
  "question asks for the number of days/weeks/months, etc., and the model makes off-" +
  "by-one errors (e.g., predicting 19 days when the answer is 18), the model's " +
  "response is still correct.";

/**
 * knowledge-update: accept a response that carries prior info alongside the
 * updated answer, as long as the updated answer is the required one. Verbatim.
 */
const KNOWLEDGE_UPDATE_RUBRIC =
  "I will give you a question, a correct answer, and a response from a model. " +
  "Please set correct=true if the response contains the correct answer. If the " +
  "response contains some previous information along with an updated answer, the " +
  "response should be considered as correct as long as the updated answer is the " +
  "required answer.";

/**
 * single-session-preference: grade against a desired personalized response.
 * Verbatim.
 */
const PREFERENCE_RUBRIC =
  "I will give you a question, a answer for desired personalized response, and a " +
  "response from a model. Please set correct=true if the response satisfies the " +
  "desired personalized response. The model does not need to reflect all the points " +
  "in the desired personalized response, as long as it recalls and utilizes the " +
  "user's personal information correctly, you can set correct=true.";

/**
 * DEFAULT (LoCoMo + any unknown category): the generous CORRECT/WRONG rubric.
 * Verbatim.
 */
const DEFAULT_RUBRIC =
  "Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will " +
  "be given the following data: (1) a question (posed by one user to another user), " +
  "(2) a 'gold' (ground truth) answer, (3) a generated answer which you will " +
  "judge to be either CORRECT or WRONG. Be generous: as long as the generated " +
  "answer touches on the same topic as the gold answer, label it CORRECT. For time " +
  "related questions, if the generated answer mentions the same date or time period " +
  "as the gold answer, label it CORRECT. Edge case: if the gold answer says the " +
  "information can't be found and the generated answer says it can't answer or " +
  "doesn't know, label it CORRECT.";

/**
 * Select the category-specific rubric. The three factual categories share one
 * body; temporal/knowledge-update/preference each have their own; everything
 * else (LoCoMo numeric categories + the loader's `"unknown"` fallback) gets the
 * generous DEFAULT.
 */
function selectRubric(category: string): string {
  switch (category) {
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return SHARED_FACTUAL_RUBRIC;
    case "temporal-reasoning":
      return TEMPORAL_RUBRIC;
    case "knowledge-update":
      return KNOWLEDGE_UPDATE_RUBRIC;
    case "single-session-preference":
      return PREFERENCE_RUBRIC;
    default:
      return DEFAULT_RUBRIC;
  }
}

/**
 * Build the full judge prompt for one graded answer.
 *
 * Layout (RUBRIC FIRST — the prompt-injection mitigation): the selected rubric,
 * then the uniform labeled tail carrying the UNTRUSTED `question` / `goldAnswer`
 * / `modelAnswer` slots, then the in-prompt JSON verdict contract (the pi-ai
 * adaptation — `completeSimple` has no `response_format`, so the judge is told
 * to emit `{ "correct": true|false, "reasoning": "..." }`, which the
 * judge-verdict parser then reads).
 *
 * Pure: no clock, no I/O, no memory-package import.
 */
export function buildJudgePrompt(
  category: string,
  question: string,
  goldAnswer: string,
  modelAnswer: string,
): string {
  const rubric = selectRubric(category);
  return (
    `${rubric}\n\n` +
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Generated answer: ${modelAnswer}\n` +
    "First, provide a short (one sentence) explanation of your reasoning. " +
    "Short reasoning is preferred.\n" +
    'Return ONLY JSON of the form { "correct": true|false, "reasoning": "..." }. ' +
    "If it's correct, set correct=true."
  );
}
