// SPDX-License-Identifier: Apache-2.0
/**
 * DAG repair loop — bounded retry wrapper around the existing DAG validation API.
 *
 * Feeds GraphValidationError messages back to the model via
 * repromptFn and re-validates. Fail-closed: after maxAttempts exhausted
 * without a valid graph, returns the last error message.
 *
 * FIX-HINT SOURCE: GraphValidationError.message + .kind + .nodes only.
 * The daemon-side graph-helpers are NOT imported — agent cannot import from
 * daemon (would create a forbidden cross-package dependency that breaks
 * cycles:refs). The error message is sufficient for the model to self-correct
 * common structural problems (cycles, missing deps, duplicates).
 *
 * Does NOT widen tool scope in re-prompts — fix-hints are validator output only.
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";
import {
  parseExecutionGraph,
  validateAndSortGraph,
  type ValidatedGraph,
} from "@comis/core";

/**
 * Attempt to repair a raw (possibly malformed) graph via bounded re-prompt.
 *
 * Validates the graph; if invalid, collects fix-hints from GraphValidationError
 * and calls repromptFn with those hints. Repeats up to maxAttempts times.
 * Returns ok(ValidatedGraph) on success, err(lastErrorMessage) after exhaustion.
 *
 * @param rawGraph - The raw graph object emitted by the model (unknown shape).
 * @param repromptFn - Injected async function that calls the model with hints
 *   and returns the model's revised graph attempt.
 * @param maxAttempts - Maximum number of reprompt attempts (default: 2).
 */
export async function repairDagWithBoundedRetries(
  rawGraph: unknown,
  repromptFn: (hints: string[]) => Promise<unknown>,
  maxAttempts = 2,
): Promise<Result<ValidatedGraph, string>> {
  let attempt = rawGraph;
  let lastErrorMsg = "exhausted";

  for (let i = 0; i <= maxAttempts; i++) {
    // Step 1: Zod structural parse
    const parsed = parseExecutionGraph(attempt);
    if (!parsed.ok) {
      // Parse failure is not retryable via DAG hints — fail immediately
      const issues = parsed.error.issues.map((e) => e.message).join("; ");
      return err(`parse-failed: ${issues}`);
    }

    // Step 2: DAG validation (cycle / missing-dep / dup / self-dep / topo-sort)
    const validated = validateAndSortGraph(parsed.value);
    if (validated.ok) {
      return ok(validated.value);
    }

    // Track the last error for fail-closed return
    lastErrorMsg = validated.error.message;

    // If we have exhausted all attempts, do not reprompt
    if (i >= maxAttempts) {
      break;
    }

    // Step 3: Collect fix-hints from GraphValidationError fields ONLY
    // (no daemon import — the agent package cannot import from packages/daemon)
    const hints: string[] = [
      `Graph validation error (${validated.error.kind}): ${validated.error.message}`,
    ];
    if (validated.error.nodes.length > 0) {
      hints.push(`Involved nodes: ${validated.error.nodes.join(", ")}`);
    }

    // Step 4: Re-prompt the model with the fix-hints
    attempt = await repromptFn(hints);
  }

  // Fail-closed: return the last validation error message (not a partial graph)
  return err(lastErrorMsg);
}
