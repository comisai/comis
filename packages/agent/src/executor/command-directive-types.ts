// SPDX-License-Identifier: Apache-2.0
/**
 * Command directive boundary types — agent-local mirror.
 *
 * History: these types previously lived in `packages/agent/src/commands/types.ts`.
 * Phase 32 commit 6 (ORCH-EXT-08) moved the canonical definitions to
 * `@comis/orchestrator/src/commands/types.ts` (where slash-command parsing
 * lives — inbound dispatch, not executor logic).
 *
 * However, agent's executor consumes `CommandDirectives` at its public surface
 * (`AgentExecutor.execute(directives?: CommandDirectives, ...)`), and agent
 * CANNOT depend on `@comis/orchestrator` — that would be circular
 * (orchestrator already depends on agent). To break the cycle, this file
 * holds an agent-local mirror of the directive shape. Structural typing
 * (no nominal `tag`) lets orchestrator-typed values flow into agent-typed
 * parameters at the boundary without explicit casts.
 *
 * Maintenance contract: this file MUST stay in lock-step with
 * `@comis/orchestrator/src/commands/types.ts`. Any field added/removed in
 * the orchestrator's `CommandDirectives` must be mirrored here in the same
 * commit. Agent's tests do not exercise these fields (they're consumed by
 * orchestrator and forwarded into agent.execute), so test-side drift will
 * not be caught — keep the maintenance discipline tight.
 *
 * Long-term: a Phase-N follow-up (out of Phase-32 scope) may promote these
 * types to `@comis/core` (the canonical home for cross-package boundary
 * types — see Phase 28's ComisLogger/LogFields promotion). That would
 * eliminate the duplication; until then, the structural-typing seam is
 * the established workaround.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Prompt skill directive (nested inside CommandDirectives.promptSkill)
// ---------------------------------------------------------------------------

/** Metadata for a prompt skill invocation via /skill:name. */
export interface PromptSkillDirective {
  /** Canonical skill name (from registry). */
  name: string;
  /** Raw user arguments (everything after skill name, trimmed). Empty string if none. */
  args: string;
  /** Expanded skill content -- populated by executor wiring, not by matcher. */
  content?: string;
  /** Tool allowlist from skill manifest -- populated by executor wiring, not by matcher. */
  allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// CommandDirectives — execution state modifications from slash directives
// ---------------------------------------------------------------------------

/** Execution state modifications from directives. Mirror of orchestrator's `CommandDirectives`. */
export interface CommandDirectives {
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  verbose?: boolean;
  reasoning?: boolean;
  modelOverride?: { provider: string; modelId: string };
  newSession?: boolean;
  resetSession?: boolean;
  compact?: boolean | {
    verbose?: boolean;
    instructions?: string;
  };
  /** Prompt skill invocation metadata. */
  promptSkill?: PromptSkillDirective;
  /** Export session to HTML via SDK's exportToHtml(). Optional outputPath. */
  exportSession?: { outputPath?: string };
  /**
   * Model switch directive -- executor calls session.setModel() for
   * immediate API key validation. Distinct from modelOverride which is consumed
   * by the inbound pipeline for deferred model state.
   */
  modelSwitch?: { provider: string; modelId: string };
  /**
   * Model cycle directive -- executor calls session.cycleModel()
   * to rotate through configured models.
   */
  modelCycle?: { direction?: "forward" | "backward" };
  /** Fork conversation at latest user message via SDK fork(). */
  forkSession?: boolean;
  /** Branch action -- list branch points or navigate to one.
   * When targetId is undefined: list available branch points via getUserMessagesForForking().
   * When targetId is set: navigate to that branch via navigateTree(). */
  branchAction?: { targetId?: string };
  /** User-specified per-turn token budget in absolute tokens (e.g., 500000 for +500k). */
  userTokenBudget?: number;
}
