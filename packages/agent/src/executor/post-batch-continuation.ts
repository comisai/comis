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

import { fromPromise, ok, err, type Result } from "@comis/shared";
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
// Implementation
// ---------------------------------------------------------------------------

const MODULE = "agent.executor.post-batch-continuation";

/* eslint-disable @typescript-eslint/no-explicit-any */
function isToolCallBlock(block: any): boolean {
  return block?.type === "toolCall" || block?.type === "tool_use";
}

function isThinkingBlock(block: any): boolean {
  return block?.type === "thinking";
}

function hasVisibleTextBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

function hasThinkingBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isThinkingBlock);
}

function hasToolCallBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isToolCallBlock);
}

function findLastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i; // eslint-disable-line security/detect-object-injection
  }
  return 0;
}

function buildDirective(priorToolCallCount: number, priorToolNames: string[]): string {
  const toolList = priorToolNames.join(", ");
  return (
    `[comis: post-batch continuation — your last turn was empty after ${priorToolCallCount} successful tool calls]\n` +
    `You completed ${priorToolCallCount} tool calls (toolNames: [${toolList}]). Your previous turn produced no text, thinking, or new tool calls. The conversation is incomplete.\n\n` +
    `You MUST either:\n` +
    `  (a) Provide a brief summary of what you accomplished AND continue with the next step from your plan, OR\n` +
    `  (b) Explicitly state "task complete" with reasoning for stopping (e.g., "All N agents created and ROLE.md customized — the user can now use them").\n\n` +
    `Do NOT emit empty turns. If you have nothing else to do, say so explicitly.`
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Run the post-batch continuation handler. Returns a `Result` so callers can
 * distinguish a clean outcome (any `ContinuationOutcome.outcome` value) from
 * a true error (followUp rejected).
 *
 * Detection (pure inspection, no throw):
 *   1. Walk `messages` to find the most recent user-role index (lower bound).
 *   2. The last message must be assistant with NO visible text, NO thinking
 *      blocks, and NO tool_use/toolCall blocks.
 *   3. Within `[lowerBound, messages.length)`, count assistant turns whose
 *      content includes tool_use/toolCall blocks; collect tool names where
 *      `block.name` is a string.
 *   4. Fire when (2) AND (≥1 tool call from step 3); else `no_match`.
 *
 * `session.followUp` errors are caught and propagated as
 * `Result<_, ContinuationError>` per AGENTS.md §2.1 + the
 * `executor-prompt-runner.ts:931` precedent.
 */
export async function runPostBatchContinuation(
  deps: RunPostBatchContinuationDeps,
): Promise<Result<ContinuationOutcome, ContinuationError>> {
  const { session, messages, config, logger, agentId, getVisibleAssistantText } = deps;

  // Step 1: disable check.
  if (!config.enabled || config.maxRetries === 0) {
    logger.info(
      { module: MODULE, agentId, decision: "skip", reason: "disabled" },
      "Post-batch continuation skipped",
    );
    return ok({
      recovered: false,
      attempts: 0,
      outcome: "disabled",
      priorToolCallCount: 0,
      priorToolNames: [],
    });
  }

  // Step 2: detection — last message must be empty assistant turn.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const msgs = messages as any[];
  if (!Array.isArray(msgs) || msgs.length === 0) {
    logger.info(
      { module: MODULE, agentId, decision: "skip", reason: "non_empty_final" },
      "Post-batch continuation skipped",
    );
    return ok({
      recovered: false,
      attempts: 0,
      outcome: "no_match",
      priorToolCallCount: 0,
      priorToolNames: [],
    });
  }

  const last = msgs[msgs.length - 1];
  const lastIsAssistant = last?.role === "assistant";
  const lastIsEmpty =
    lastIsAssistant &&
    !hasVisibleTextBlock(last.content) &&
    !hasThinkingBlock(last.content) &&
    !hasToolCallBlock(last.content);

  if (!lastIsEmpty) {
    logger.info(
      { module: MODULE, agentId, decision: "skip", reason: "non_empty_final" },
      "Post-batch continuation skipped",
    );
    return ok({
      recovered: false,
      attempts: 0,
      outcome: "no_match",
      priorToolCallCount: 0,
      priorToolNames: [],
    });
  }

  // Step 3: collect tool calls within the current execution window.
  const lowerBound = findLastUserIndex(msgs);
  let priorToolCallCount = 0;
  const priorToolNamesSet = new Set<string>();
  for (let i = lowerBound; i < msgs.length; i++) {
    const m = msgs[i]; // eslint-disable-line security/detect-object-injection
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (isToolCallBlock(block)) {
        priorToolCallCount++;
        if (typeof block?.name === "string") priorToolNamesSet.add(block.name);
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const priorToolNames = [...priorToolNamesSet];

  if (priorToolCallCount === 0) {
    logger.info(
      { module: MODULE, agentId, decision: "skip", reason: "no_tool_calls" },
      "Post-batch continuation skipped",
    );
    return ok({
      recovered: false,
      attempts: 0,
      outcome: "no_match",
      priorToolCallCount: 0,
      priorToolNames: [],
    });
  }

  // Step 4: decision-log fire.
  logger.info(
    {
      module: MODULE,
      agentId,
      decision: "fire",
      reason: "empty_after_tool_batch",
      priorToolCallCount,
      priorToolNames,
      maxAttempts: config.maxRetries,
    },
    "Post-batch continuation firing",
  );

  // Step 5: directive multi-shot retry loop.
  const directive = buildDirective(priorToolCallCount, priorToolNames);
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const followUpResult = await fromPromise(session.followUp(directive));
    if (!followUpResult.ok) {
      return err({ kind: "followup_error", cause: followUpResult.error });
    }
    const text = getVisibleAssistantText(session);
    const outcomeForLog = text && text.length > 0 ? "recovered" : "still_empty";
    logger.info(
      {
        module: MODULE,
        agentId,
        attempt,
        maxAttempts: config.maxRetries,
        priorToolCallCount,
        priorToolNames,
        outcome: outcomeForLog,
      },
      "Post-batch continuation attempt",
    );
    if (text && text.length > 0) {
      return ok({
        recovered: true,
        response: text,
        attempts: attempt,
        outcome: "recovered",
        priorToolCallCount,
        priorToolNames,
      });
    }
  }

  // Step 6: max retries exhausted.
  return ok({
    recovered: false,
    attempts: config.maxRetries,
    outcome: "max_attempts_exhausted",
    priorToolCallCount,
    priorToolNames,
  });
}
