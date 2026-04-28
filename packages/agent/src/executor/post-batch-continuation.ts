// SPDX-License-Identifier: Apache-2.0
/**
 * Post-batch continuation handler (L4 silent-termination recovery).
 *
 * When the LLM emits an empty final assistant turn (zero text + zero thinking +
 * zero tool calls) following a successful tool batch within the same execution
 * window, this handler fires a directive `session.followUp()` with multi-shot
 * retry. Replaces the legacy SEP one-shot `generateCompletenessNudge` (whose
 * enforcement role is now superseded; SEP plan extraction + step counting
 * remain intact for observability).
 *
 * @module
 */

import { ok, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the post-batch continuation handler. */
export interface ContinuationConfig {
  /** Master toggle. When false, handler returns
   *  `{recovered: false, outcome: "disabled"}` without calling followUp. */
  enabled: boolean;
  /** Maximum directive followUp attempts before falling through to L3
   *  synthesis. Range 0..5; 0 is treated as disabled. */
  maxRetries: number;
}

/** Outcome returned by the handler. */
export interface ContinuationOutcome {
  recovered: boolean;
  /** Recovered visible text from the followed-up assistant turn (only set
   *  when `recovered === true`). */
  response?: string;
  /** Number of followUp attempts actually made (0 when handler did not fire). */
  attempts: number;
  /** Terminal outcome:
   *  - `recovered`           — followUp produced visible text on some attempt
   *  - `still_empty`         — followUp ran but produced no visible text
   *                           (single-attempt diagnostic; not a terminal flag)
   *  - `max_attempts_exhausted` — all `maxRetries` attempts produced empty
   *  - `disabled`            — config.enabled = false OR maxRetries = 0
   *  - `no_match`            — empty-after-tool-batch pattern not detected */
  outcome: "recovered" | "still_empty" | "max_attempts_exhausted" | "disabled" | "no_match";
  priorToolCallCount: number;
  priorToolNames: string[];
}

/** Error variant — only ever returned when `session.followUp` rejects. */
export type ContinuationError = { kind: "followup_error"; cause: unknown };

/** Dependencies passed in by the executor wire-in site. */
export interface RunPostBatchContinuationDeps {
  /** Live session — invoked via `followUp(text)` to issue the directive. */
  session: { followUp(text: string): Promise<unknown>; messages?: unknown[] };
  /** Session messages — passed explicitly per the canonical
   *  `(session as any).messages ?? []` pattern at executor-prompt-runner.ts:797. */
  messages: unknown[];
  config: ContinuationConfig;
  logger: ComisLogger;
  agentId?: string;
  /** Read visible text from the latest assistant turn (post-followUp). */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  getVisibleAssistantText: (session: any) => string;
}

// ---------------------------------------------------------------------------
// Stub implementation (Task 1 RED — replaced in Task 2 GREEN)
// ---------------------------------------------------------------------------

/**
 * Stub returning `no_match` unconditionally so the 8 RED tests in
 * post-batch-continuation.test.ts fail with assertion errors (NOT compile
 * errors). Replaced by a full implementation in Task 2.
 */
export async function runPostBatchContinuation(
  _deps: RunPostBatchContinuationDeps,
): Promise<Result<ContinuationOutcome, ContinuationError>> {
  return ok({
    recovered: false,
    attempts: 0,
    outcome: "no_match",
    priorToolCallCount: 0,
    priorToolNames: [],
  });
}
