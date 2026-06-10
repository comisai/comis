// SPDX-License-Identifier: Apache-2.0
/**
 * Assembly-outcome asserter — deterministic typed helpers for Phase-171 CTX harness (HARN-01).
 *
 * All functions are pure (no I/O). They throw descriptive errors on assertion failure —
 * same error-message style as cache-trace.ts and context-trace.ts.
 *
 * assemblyOutcomeScore and assertAssemblyOutcome are INLINED here (not imported
 * from @comis/agent). Reason: packages/agent/src/context-engine/ is NOT re-exported
 * at the barrel level for test consumption.
 * The implementations match design/lcd-v3-unified-substrate.md §15 exactly.
 *
 * CONTENT-FREE: this module never logs or stores model answers, reference answers,
 * or key-fact strings — only numeric scores and scenario IDs.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Assembly-outcome scorer (inlined — not imported from @comis/agent)
// ---------------------------------------------------------------------------

/**
 * Deterministic key-fact presence scorer for HARN-01 assembly-outcome evaluation.
 *
 * Measures "did the assembled working set enable the model to answer correctly"
 * by checking how many key facts are present in the model answer (case-insensitive).
 *
 * Returns `|keyFacts found in modelAnswer| / |keyFacts|`. An empty keyFacts list
 * yields 0 (no ground truth to score — never NaN).
 *
 * Inlined here — NOT imported from @comis/agent. The context-engine scorer is not
 * re-exported from the packages/agent barrel level (same constraint as memory-recall.ts).
 *
 * @param modelAnswer - The model's response to score.
 * @param referenceAnswer - Typed for future use; unused in Stage-A deterministic math.
 * @param keyFacts - List of key fact strings that must be present in modelAnswer.
 * @returns Score in [0, 1] where 1.0 = all key facts found, 0.0 = none found.
 */
export function assemblyOutcomeScore(
  modelAnswer: string,
  referenceAnswer: string,
  keyFacts: string[],
): number {
  if (keyFacts.length === 0) return 0;
  const answerLower = modelAnswer.toLowerCase();
  let hits = 0;
  for (const fact of keyFacts) {
    if (answerLower.includes(fact.toLowerCase())) hits++;
  }
  return hits / keyFacts.length;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Assert that the assembly-outcome score meets or exceeds a threshold.
 *
 * @throws Error when score < threshold — message includes scenarioId, score,
 *   threshold, and first 80 chars of the model answer (content-free minimum context).
 */
export function assertAssemblyOutcome(opts: {
  score: number;
  threshold: number;
  scenarioId: string;
  modelAnswer: string;
}): void {
  if (opts.score >= opts.threshold) return;
  throw new Error(
    `[assembly-outcome] scenarioId=${opts.scenarioId}: ` +
      `score=${opts.score.toFixed(3)} < threshold=${opts.threshold}. ` +
      `Answer (first 80 chars): "${opts.modelAnswer.slice(0, 80)}"`,
  );
}

// ---------------------------------------------------------------------------
// Secret-leak guard (mirror of memory-recall.ts assertNoSecretLeak pattern)
// ---------------------------------------------------------------------------

/**
 * Assert that a fixture content string contains no secret-like patterns.
 *
 * Applied to any fixture file content before use in Stage-B to prevent
 * accidental commitment or logging of credentials.
 *
 * T-171-06 mitigation: reference set uses synthetic scenario questions/answers
 * with no real user data; this guard is a defence-in-depth check.
 *
 * @param content - The string content to check.
 * @param context - Human-readable label for the check location (logged on error).
 * @throws Error with "Secret-like pattern detected" when any violation is found.
 */
export function assertNoSecretLeak(content: string, context: string): void {
  const secretPatterns = [/sk-[a-zA-Z0-9]{20,}/g, /Bearer [a-zA-Z0-9._-]{20,}/g];
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      throw new Error(
        `[assembly-outcome] Secret-like pattern detected in ${context}`,
      );
    }
  }
}
