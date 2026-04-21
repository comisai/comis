// SPDX-License-Identifier: Apache-2.0
/**
 * Command Handler: Executes parsed slash commands using injected dependencies.
 *
 * Directives modify execution state without handling the message.
 * Response commands return formatted information to the user.
 * Session commands handle session lifecycle operations.
 *
 * @module
 */

import type { SessionKey } from "@comis/core";
import type {
  ParsedCommand,
  CommandResult,
  CommandDirectives,
  CommandHandlerDeps,
} from "./types.js";
import { MIN_USER_BUDGET, MAX_USER_BUDGET } from "./budget-command.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Command handler interface */
export interface CommandHandler {
  /** Handle a parsed command, returning a result with optional response and directives */
  handle(parsed: ParsedCommand, sessionKey: SessionKey): CommandResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyDirectives(): CommandDirectives {
  return {};
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a token count with compact suffix for context bar display.
 * Returns "84k" for 84000, "1.2M" for 1200000, or "500" for 500.
 */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Build a visual context window bar using Unicode block characters.
 * Returns a string of filled (\u2588) and empty (\u2591) blocks.
 *
 * @param percent - Percentage of context window used (0-100)
 * @param width - Total bar width in characters (default 20)
 */
function buildContextBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a command handler with injected dependencies.
 *
 * @param deps - Dependencies providing session, config, and model information
 * @returns CommandHandler that can process any parsed command
 */
export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  return {
    handle(parsed: ParsedCommand, sessionKey: SessionKey): CommandResult {
      if (!parsed.found || !parsed.command) {
        return { handled: false, directives: emptyDirectives() };
      }

      switch (parsed.command) {
        // Directives (modify state, handled=false so executor still runs)
        case "think":
          return handleThink(deps, parsed);
        case "verbose":
          return handleVerbose(parsed);
        case "reasoning":
          return handleReasoning();

        // Response commands (handled=true with response text)
        case "context":
          return handleContext(deps);
        case "status":
          return handleStatus(deps, sessionKey);
        case "usage":
          return handleUsage(deps);
        case "model":
          return handleModel(deps, parsed, sessionKey);

        // Execution cancellation (actual abort handled by inbound pipeline)
        case "stop":
          return { handled: true, response: "Stopping...", directives: emptyDirectives() };

        // Session commands (handled=true, modify state)
        case "new":
          return handleNew(deps, parsed, sessionKey);
        case "reset":
          return handleReset(deps, sessionKey);
        case "compact":
          return handleCompact(parsed);
        case "export":
          return handleExport(parsed);

        // Session branching commands
        case "fork":
          return handleFork();
        case "branch":
          return handleBranch(parsed);

        // Budget directive
        case "budget":
          return handleBudget(parsed);

        default:
          return { handled: false, directives: emptyDirectives() };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Directive handlers
// ---------------------------------------------------------------------------

/** Hardcoded fallback levels used when SDK getAvailableThinkingLevels is not available. */
const HARDCODED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function handleThink(deps: CommandHandlerDeps, parsed: ParsedCommand): CommandResult {
  // Level can come from args (parser recognized it as a known THINK_LEVEL) or from
  // cleanedText (parser treated it as body text because the word is not in THINK_LEVELS).
  // When cleanedText is a single word with no spaces, the user intended a level arg.
  const level = parsed.args[0]
    ?? (parsed.cleanedText && !parsed.cleanedText.includes(" ") ? parsed.cleanedText : undefined);

  // No explicit level arg -- default to "high"
  if (!level) {
    return {
      handled: false,
      directives: { thinkingLevel: "high" },
    };
  }

  // Validate against SDK levels if available, otherwise hardcoded fallback
  const availableLevels = deps.getAvailableThinkingLevels?.() ?? HARDCODED_THINKING_LEVELS;
  if (!availableLevels.includes(level)) {
    return {
      handled: true,
      response: `Invalid thinking level '${level}'. Available: ${availableLevels.join(", ")}`,
      directives: {},
    };
  }

  return {
    handled: false,
    directives: { thinkingLevel: level as CommandDirectives["thinkingLevel"] },
  };
}

function handleVerbose(parsed: ParsedCommand): CommandResult {
  const arg = parsed.args[0];
  let verbose: boolean;
  if (arg === "on") {
    verbose = true;
  } else if (arg === "off") {
    verbose = false;
  } else {
    // Toggle: default to true
    verbose = true;
  }
  return {
    handled: false,
    directives: { verbose },
  };
}

function handleReasoning(): CommandResult {
  return {
    handled: false,
    directives: { reasoning: true },
  };
}

// ---------------------------------------------------------------------------
// Response command handlers
// ---------------------------------------------------------------------------

function handleContext(deps: CommandHandlerDeps): CommandResult {
  const lines: string[] = ["**Context Overview**", ""];

  // Bootstrap files
  const bootstrapInfo = deps.getBootstrapInfo?.();
  if (bootstrapInfo && bootstrapInfo.length > 0) {
    lines.push("Bootstrap files:");
    let totalBootstrap = 0;
    for (const file of bootstrapInfo) {
      lines.push(`- ${file.name}: ${formatNumber(file.sizeChars)} chars`);
      totalBootstrap += file.sizeChars;
    }
    lines.push(`Total bootstrap: ${formatNumber(totalBootstrap)} chars`);
  } else {
    lines.push("Bootstrap files: Not available");
  }

  lines.push("");

  // Tool schemas
  const toolInfo = deps.getToolInfo?.();
  if (toolInfo && toolInfo.length > 0) {
    lines.push("Tool schemas:");
    let totalTools = 0;
    for (const tool of toolInfo) {
      lines.push(`- ${tool.name}: ${formatNumber(tool.sizeChars)} chars`);
      totalTools += tool.sizeChars;
    }
    lines.push(`Total tools: ${formatNumber(totalTools)} chars`);
  } else {
    lines.push("Tool schemas: Not available");
  }

  // Total overhead (only if both are available)
  if (bootstrapInfo && bootstrapInfo.length > 0 && toolInfo && toolInfo.length > 0) {
    const totalBootstrap = bootstrapInfo.reduce((sum, f) => sum + f.sizeChars, 0);
    const totalTools = toolInfo.reduce((sum, t) => sum + t.sizeChars, 0);
    lines.push("");
    lines.push(`Total overhead: ${formatNumber(totalBootstrap + totalTools)} chars`);
  }

  return {
    handled: true,
    response: lines.join("\n"),
    directives: emptyDirectives(),
  };
}

function handleStatus(deps: CommandHandlerDeps, sessionKey: SessionKey): CommandResult {
  const session = deps.getSessionInfo(sessionKey);
  const config = deps.getAgentConfig();
  const sdkStats = deps.getSDKSessionStats?.(sessionKey);

  const lines: string[] = ["**Session Status**", ""];

  // -- Session Info section --
  lines.push("**Session Info**");
  lines.push(`Agent: ${config.name}`);
  const effectiveModel = session.modelOverride ?? `${config.provider}/${config.model}`;
  lines.push(`Model: ${effectiveModel}`);
  if (session.createdAt) {
    const elapsed = Date.now() - session.createdAt;
    lines.push(`Session started: ${formatRelativeTime(elapsed)}`);
  }

  // -- Messages section --
  lines.push("");
  lines.push("**Messages**");
  if (sdkStats) {
    lines.push(
      `User: ${sdkStats.userMessages} | Assistant: ${sdkStats.assistantMessages} | Tool calls: ${sdkStats.toolCalls}`,
    );
    lines.push(`Total: ${sdkStats.totalMessages} messages`);
  } else {
    lines.push(`Total: ${session.messageCount} messages`);
  }

  // -- Token Usage section --
  lines.push("");
  lines.push("**Token Usage**");
  if (sdkStats) {
    lines.push(
      `Input: ${formatNumber(sdkStats.tokens.input)} | Output: ${formatNumber(sdkStats.tokens.output)}`,
    );
    lines.push(
      `Cache read: ${formatNumber(sdkStats.tokens.cacheRead)} | Cache write: ${formatNumber(sdkStats.tokens.cacheWrite)}`,
    );
    lines.push(`Total: ${formatNumber(sdkStats.tokens.total)} tokens`);
  } else if (session.tokensUsed) {
    lines.push(
      `Input: ${formatNumber(session.tokensUsed.input)} | Output: ${formatNumber(session.tokensUsed.output)}`,
    );
    lines.push(`Total: ${formatNumber(session.tokensUsed.total)} tokens`);
  } else {
    lines.push("No token data available");
  }

  // -- Context Window section --
  lines.push("");
  lines.push("**Context Window**");
  const contextUsage = deps.getContextUsage?.(sessionKey);
  if (contextUsage && contextUsage.percent !== null) {
    const bar = buildContextBar(contextUsage.percent);
    const usedStr = formatTokenCount(contextUsage.tokens ?? 0);
    const totalStr = formatTokenCount(contextUsage.contextWindow);
    lines.push(`Context: ${contextUsage.percent}% (${usedStr} / ${totalStr} tokens) ${bar}`);
  } else {
    lines.push("Context: N/A");
  }

  // -- Budget section --
  lines.push("");
  lines.push("**Budget**");
  const sessionCost = deps.getSessionCost?.(sessionKey);
  if ((sdkStats && sdkStats.cost > 0) || (sessionCost && sessionCost.totalCost > 0)) {
    const cost = sdkStats?.cost ?? sessionCost?.totalCost ?? 0;
    lines.push(`Est. cost: $${cost.toFixed(4)}`);
  }
  lines.push(`Max steps: ${config.maxSteps}`);
  const budgetInfo = deps.getBudgetInfo?.();
  if (budgetInfo) {
    lines.push(`Budget caps: $${budgetInfo.perExecution.toFixed(2)}/exec, $${budgetInfo.perHour.toFixed(2)}/hr, $${budgetInfo.perDay.toFixed(2)}/day`);
  }

  return {
    handled: true,
    response: lines.join("\n"),
    directives: emptyDirectives(),
  };
}

function handleUsage(deps: CommandHandlerDeps): CommandResult {
  const breakdown = deps.getUsageBreakdown?.();
  if (!breakdown || breakdown.length === 0) {
    return {
      handled: true,
      response: "No usage data recorded yet.",
      directives: emptyDirectives(),
    };
  }

  const lines: string[] = ["**Usage Breakdown**", ""];

  let grandTotalTokens = 0;
  let grandTotalCost = 0;

  for (const entry of breakdown) {
    grandTotalTokens += entry.totalTokens;
    grandTotalCost += entry.totalCost;
    lines.push(
      `${entry.provider}/${entry.model}: ${formatNumber(entry.totalTokens)} tokens, $${entry.totalCost.toFixed(4)} (${entry.callCount} calls)`,
    );
  }

  lines.push("");
  lines.push(
    `**Total:** ${formatNumber(grandTotalTokens)} tokens, $${grandTotalCost.toFixed(4)}`,
  );

  return {
    handled: true,
    response: lines.join("\n"),
    directives: emptyDirectives(),
  };
}

function handleModel(
  deps: CommandHandlerDeps,
  parsed: ParsedCommand,
  sessionKey: SessionKey,
): CommandResult {
  const arg = parsed.args[0];

  // No arg or "status": show current model
  if (!arg || arg === "status") {
    const config = deps.getAgentConfig();
    const session = deps.getSessionInfo(sessionKey);
    const current = session.modelOverride ?? `${config.provider}/${config.model}`;
    return {
      handled: true,
      response: `Current model: ${current}`,
      directives: emptyDirectives(),
    };
  }

  // "list": show available models
  if (arg === "list") {
    const models = deps.getAvailableModels?.();
    if (!models || models.length === 0) {
      return {
        handled: true,
        response: "Model list not available.",
        directives: emptyDirectives(),
      };
    }

    const lines = ["**Available Models**", ""];
    for (const model of models) {
      lines.push(`- ${model.provider}/${model.modelId} (${model.name})`);
    }
    return {
      handled: true,
      response: lines.join("\n"),
      directives: emptyDirectives(),
    };
  }

  // "cycle" or "next": cycle model forward
  if (arg === "cycle" || arg === "next") {
    return {
      handled: false,
      directives: { modelCycle: { direction: "forward" } },
    };
  }

  // "prev" or "previous": cycle model backward
  if (arg === "prev" || arg === "previous") {
    return {
      handled: false,
      directives: { modelCycle: { direction: "backward" } },
    };
  }

  // Any other arg: switch model via SDK (executor calls session.setModel())
  const { provider, modelId } = parseModelArg(arg);
  return {
    handled: false, // Executor consumes -- needs live session for SDK validation
    directives: { modelSwitch: { provider, modelId }, modelOverride: { provider, modelId } },
  };
}

// ---------------------------------------------------------------------------
// Session command handlers
// ---------------------------------------------------------------------------

function handleNew(
  deps: CommandHandlerDeps,
  parsed: ParsedCommand,
  sessionKey: SessionKey,
): CommandResult {
  const directives: CommandDirectives = { newSession: true };

  // Optional model arg for new session
  if (parsed.args[0]) {
    const { provider, modelId } = parseModelArg(parsed.args[0]);
    directives.modelOverride = { provider, modelId };
  }

  deps.destroySession(sessionKey);

  return {
    handled: true,
    response: "New session created.",
    directives,
  };
}

function handleReset(
  deps: CommandHandlerDeps,
  sessionKey: SessionKey,
): CommandResult {
  deps.destroySession(sessionKey);

  return {
    handled: true,
    response: "Session reset.",
    directives: { resetSession: true },
  };
}

function handleCompact(parsed: ParsedCommand): CommandResult {
  const verbose = parsed.args.includes("verbose") || parsed.args.includes("-v");
  // Instructions are all args that are NOT verbose flags
  const instructionArgs = parsed.args.filter(a => a !== "verbose" && a !== "-v");
  const instructions = instructionArgs.length > 0 ? instructionArgs.join(" ") : undefined;

  return {
    handled: false, // NOT handled -- executor consumes the compact directive
    response: verbose ? "Starting compaction (verbose mode)..." : undefined,
    directives: {
      compact: { verbose, instructions },
    },
  };
}

function handleExport(parsed: ParsedCommand): CommandResult {
  // First arg (if any) is the output path
  const outputPath = parsed.args[0] ?? undefined;
  return {
    handled: false, // Executor consumes the directive (needs live session)
    directives: {
      exportSession: { outputPath },
    },
  };
}

function handleFork(): CommandResult {
  return {
    handled: false, // Executor needs live session for SDK fork()
    directives: { forkSession: true },
  };
}

function handleBranch(parsed: ParsedCommand): CommandResult {
  const targetId = parsed.args[0];
  if (targetId) {
    // Navigate to specific branch
    return {
      handled: false, // Executor needs live session for navigateTree()
      directives: { branchAction: { targetId } },
    };
  }
  // List available branch points
  return {
    handled: false, // Executor needs live session for getUserMessagesForForking()
    directives: { branchAction: {} },
  };
}

// ---------------------------------------------------------------------------
// Budget handler
// ---------------------------------------------------------------------------

/**
 * Handle /budget command: parse the budget arg and set userTokenBudget directive.
 *
 * Syntax: `/budget 500k` or `/budget 2m`
 * - k = multiply by 1000, m = multiply by 1000000
 * - Must be within [MIN_USER_BUDGET, MAX_USER_BUDGET] range
 * - If invalid, returns error response and handled=true (skip executor)
 * - If valid, returns handled=false with directive (message continues to executor)
 */
function handleBudget(parsed: ParsedCommand): CommandResult {
  const arg = parsed.args[0];
  if (!arg) {
    return {
      handled: true,
      response: `Usage: /budget <amount>\nExamples: /budget 500k, /budget 2m\nRange: ${formatTokenCount(MIN_USER_BUDGET)} - ${formatTokenCount(MAX_USER_BUDGET)} tokens`,
      directives: emptyDirectives(),
    };
  }

  // Parse Nk / Nm suffix
  const match = /^(\d+)(k|m)$/i.exec(arg);
  if (!match) {
    return {
      handled: true,
      response: `Invalid budget format '${arg}'. Use a number with k or m suffix (e.g., 500k, 2m).`,
      directives: emptyDirectives(),
    };
  }

  const num = parseInt(match[1]!, 10);
  const suffix = match[2]!.toLowerCase();
  const tokens = num * (suffix === "m" ? 1_000_000 : 1_000);

  if (tokens < MIN_USER_BUDGET || tokens > MAX_USER_BUDGET) {
    return {
      handled: true,
      response: `Budget ${arg} is out of range. Must be between ${formatTokenCount(MIN_USER_BUDGET)} and ${formatTokenCount(MAX_USER_BUDGET)} tokens.`,
      directives: emptyDirectives(),
    };
  }

  return {
    handled: false,
    directives: { userTokenBudget: tokens },
  };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Parse a model argument string into provider and modelId.
 *
 * Accepts formats:
 * - "provider/modelId" (e.g., "openai/gpt-4o")
 * - "modelId" alone (provider defaults to "default")
 */
function parseModelArg(arg: string): { provider: string; modelId: string } {
  const slashIndex = arg.indexOf("/");
  if (slashIndex === -1) {
    return { provider: "default", modelId: arg };
  }
  return {
    provider: arg.slice(0, slashIndex),
    modelId: arg.slice(slashIndex + 1),
  };
}

/**
 * Format a duration in milliseconds into a human-readable relative time string.
 */
function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
