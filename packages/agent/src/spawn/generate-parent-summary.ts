/**
 * Wrapper around SDK `generateSummary()` for parent context summarization.
 *
 * This wrapper exists so the daemon can call parent summary generation via
 * `@comis/agent` without adding `@mariozechner/pi-coding-agent` as a direct
 * daemon dependency. The daemon must not import the SDK directly (see
 * `packages/daemon/src/wiring/setup-agents.ts` lines 43-44).
 *
 * @module
 */

import { generateSummary } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for parent summary generation. */
export interface GenerateParentSummaryDeps {
  /** Parent session messages to summarize.
   *  Typed as unknown[] so callers (e.g., daemon) don't need to import AgentMessage. */
  messages: unknown[];
  /** Model object (from ModelRegistry). */
  model: unknown;
  /** Maximum tokens for the summary output. */
  maxTokens: number;
  /** API key for the provider. */
  apiKey: string;
  /** Optional custom instructions for the summarizer. */
  customInstructions?: string;
}

// ---------------------------------------------------------------------------
// Function
// ---------------------------------------------------------------------------

/**
 * Generate a condensed summary of the parent session for sub-agent context.
 *
 * Delegates to the SDK's `generateSummary()`. Does NOT catch errors -- the
 * caller (executeSubAgent) has its own try/catch with graceful degradation.
 *
 * @param deps - Parent session messages, model, and API key
 * @returns Condensed parent context summary string
 */
export async function generateParentSummary(deps: GenerateParentSummaryDeps): Promise<string> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return generateSummary(
    deps.messages as any[],
    deps.model as any,
    deps.maxTokens,
    deps.apiKey,
    undefined,
    undefined,
    deps.customInstructions ?? "Summarize this conversation for a sub-agent. Focus on: decisions made, context established, current task state, and any constraints. Keep it concise.",
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
