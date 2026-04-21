// SPDX-License-Identifier: Apache-2.0
/**
 * Slash Command Types: Type definitions for the command parser and handler.
 *
 * Provides:
 * - CommandType: Recognized command names
 * - ParsedCommand: Parser output with command info and cleaned text
 * - CommandDirectives: Execution state modifications from directives
 * - CommandResult: Handler output with response and directives
 * - CommandHandlerDeps: Dependencies for command handler
 *
 * @module
 */

import type { SessionKey } from "@comis/core";

// ---------------------------------------------------------------------------
// Command type enum
// ---------------------------------------------------------------------------

/** Recognized command types */
export type CommandType =
  | "think" | "verbose" | "reasoning"  // Directives (stripped, modify state)
  | "context" | "status" | "usage" | "config"     // Response commands (return info)
  | "model"                            // Sub-commands: list, switch, status
  | "new" | "reset"                    // Session commands
  | "compact"                          // Compaction command
  | "export"                           // Session export to HTML
  | "stop"                             // Execution cancellation
  | "fork" | "branch" // Conversation branching
  | "budget"; // User-specified per-turn token budget

// ---------------------------------------------------------------------------
// Parser types
// ---------------------------------------------------------------------------

/** Result of parsing a message for slash commands */
export interface ParsedCommand {
  /** Whether a command was found */
  found: boolean;
  /** The command type (undefined if not found) */
  command?: CommandType;
  /** Arguments after the command name */
  args: string[];
  /** Message text with command/directive stripped */
  cleanedText: string;
  /** Whether this is a directive (stripped from text, modifies state) */
  isDirective: boolean;
  /** Whether this is a standalone command (no remaining text for LLM) */
  isStandalone: boolean;
}

// ---------------------------------------------------------------------------
// Prompt skill directive types
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
// Directive types
// ---------------------------------------------------------------------------

/** Execution state modifications from directives */
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

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/** Result from handling a command */
export interface CommandResult {
  /** Response text to send to the user (for response commands) */
  response?: string;
  /** Whether the command was fully handled (skip executor) */
  handled: boolean;
  /** Directive state modifications */
  directives: CommandDirectives;
}

/** Dependencies for command handler */
export interface CommandHandlerDeps {
  /** Get session info (message count, creation time, model override) */
  getSessionInfo: (sessionKey: SessionKey) => {
    messageCount: number;
    createdAt?: number;
    modelOverride?: string;
    tokensUsed?: { input: number; output: number; total: number };
  };
  /** Get bootstrap file info (for /context) */
  getBootstrapInfo?: () => Array<{ name: string; sizeChars: number }>;
  /** Get tool schema overhead (for /context) */
  getToolInfo?: () => Array<{ name: string; sizeChars: number }>;
  /** Get current agent config values */
  getAgentConfig: () => {
    name: string;
    model: string;
    provider: string;
    maxSteps: number;
  };
  /** Get available models (for /model list) */
  getAvailableModels?: () => Array<{ provider: string; modelId: string; name: string }>;
  /** Destroy current session (for /new, /reset) */
  destroySession: (sessionKey: SessionKey) => void;
  /** Get per-provider usage breakdown (for /usage). Returns array from costTracker.getByProvider(). */
  getUsageBreakdown?: () => Array<{
    provider: string;
    model: string;
    totalTokens: number;
    totalCost: number;
    callCount: number;
  }>;
  /** Get session cost (for /status cost line). Returns from costTracker.getBySession(). */
  getSessionCost?: (sessionKey: SessionKey) => { totalTokens: number; totalCost: number };
  /** Get SDK session stats (from ComisSessionManager or AgentSession.getSessionStats()). */
  getSDKSessionStats?: (sessionKey: SessionKey) => {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
  } | undefined;
  /** Get context window usage info. */
  getContextUsage?: (sessionKey: SessionKey) => {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
  /** Get budget configuration for the agent. */
  getBudgetInfo?: () => {
    perExecution: number;
    perHour: number;
    perDay: number;
  } | undefined;
  /**
   * Get available thinking levels from SDK for the current model.
   * When undefined (e.g., at RPC gateway time before session creation),
   * command-handler falls back to hardcoded set ["off","minimal","low","medium","high","xhigh"].
   */
  getAvailableThinkingLevels?: () => string[];
}
