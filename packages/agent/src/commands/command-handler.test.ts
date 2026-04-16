import type { SessionKey } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCommandHandler, type CommandHandler } from "./command-handler.js";
import type { ParsedCommand, CommandHandlerDeps } from "./types.js";
import { parseSlashCommand } from "./command-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionKey(): SessionKey {
  return { tenantId: "default", userId: "user-1", channelId: "chan-1" };
}

function makeDeps(overrides?: Partial<CommandHandlerDeps>): CommandHandlerDeps {
  return {
    getSessionInfo: vi.fn().mockReturnValue({
      messageCount: 42,
      createdAt: Date.now() - 3_600_000, // 1 hour ago
      modelOverride: undefined,
      tokensUsed: { input: 10_000, output: 5_000, total: 15_000 },
    }),
    getBootstrapInfo: vi.fn().mockReturnValue([
      { name: "SOUL.md", sizeChars: 2_450 },
      { name: "USER.md", sizeChars: 1_200 },
    ]),
    getToolInfo: vi.fn().mockReturnValue([
      { name: "web_search", sizeChars: 450 },
      { name: "file_read", sizeChars: 320 },
    ]),
    getAgentConfig: vi.fn().mockReturnValue({
      name: "Comis",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      maxSteps: 25,
    }),
    getAvailableModels: vi.fn().mockReturnValue([
      { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929", name: "Claude Sonnet" },
      { provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
    ]),
    destroySession: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCommandHandler", () => {
  let handler: CommandHandler;
  let deps: CommandHandlerDeps;
  const sessionKey = makeSessionKey();

  beforeEach(() => {
    deps = makeDeps();
    handler = createCommandHandler(deps);
  });

  // -----------------------------------------------------------------------
  // /status
  // -----------------------------------------------------------------------

  it("/status returns formatted session info with grouped sections", () => {
    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Session Status**");
    expect(result.response).toContain("**Session Info**");
    expect(result.response).toContain("Agent: Comis");
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929");
    expect(result.response).toContain("**Messages**");
    expect(result.response).toContain("**Token Usage**");
    expect(result.response).toContain("**Context Window**");
    expect(result.response).toContain("**Budget**");
    expect(result.response).toContain("Max steps: 25");
    expect(deps.getSessionInfo).toHaveBeenCalledWith(sessionKey);
  });

  // -----------------------------------------------------------------------
  // /context
  // -----------------------------------------------------------------------

  it("/context returns formatted bootstrap file sizes and tool overhead", () => {
    const parsed = parseSlashCommand("/context");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Context Overview**");
    expect(result.response).toContain("SOUL.md: 2,450 chars");
    expect(result.response).toContain("USER.md: 1,200 chars");
    expect(result.response).toContain("Total bootstrap: 3,650 chars");
    expect(result.response).toContain("web_search: 450 chars");
    expect(result.response).toContain("file_read: 320 chars");
    expect(result.response).toContain("Total tools: 770 chars");
    expect(result.response).toContain("Total overhead: 4,420 chars");
  });

  it("/context without bootstrap/tool info shows Not available", () => {
    deps = makeDeps({ getBootstrapInfo: undefined, getToolInfo: undefined });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/context");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Bootstrap files: Not available");
    expect(result.response).toContain("Tool schemas: Not available");
  });

  // -----------------------------------------------------------------------
  // /model
  // -----------------------------------------------------------------------

  it("/model with no args returns current model", () => {
    const parsed = parseSlashCommand("/model");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Current model: anthropic/claude-sonnet-4-5-20250929");
  });

  it("/model list returns available models", () => {
    const parsed = parseSlashCommand("/model list");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Available Models**");
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929 (Claude Sonnet)");
    expect(result.response).toContain("openai/gpt-4o (GPT-4o)");
  });

  it("/model list without getAvailableModels shows not available", () => {
    deps = makeDeps({ getAvailableModels: undefined });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/model list");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("Model list not available.");
  });

  it("/model openai/gpt-4o returns handled=false with modelSwitch and modelOverride directives", () => {
    const parsed = parseSlashCommand("/model openai/gpt-4o");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelSwitch).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(result.directives.modelOverride).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("/model cycle returns handled=false with modelCycle forward directive", () => {
    const parsed = parseSlashCommand("/model cycle");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelCycle).toEqual({ direction: "forward" });
  });

  it("/model next returns handled=false with modelCycle forward directive", () => {
    const parsed = parseSlashCommand("/model next");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelCycle).toEqual({ direction: "forward" });
  });

  it("/model prev returns handled=false with modelCycle backward directive", () => {
    const parsed = parseSlashCommand("/model prev");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelCycle).toEqual({ direction: "backward" });
  });

  it("/model anthropic/claude-sonnet-4-20250514 returns handled=false with modelSwitch directive", () => {
    const parsed = parseSlashCommand("/model anthropic/claude-sonnet-4-20250514");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelSwitch).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
    expect(result.directives.modelOverride).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
  });

  // -----------------------------------------------------------------------
  // /think
  // -----------------------------------------------------------------------

  it("/think returns handled=false with thinkingLevel=high (default)", () => {
    const parsed = parseSlashCommand("/think");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("high");
  });

  it("/think high sets thinkingLevel to high", () => {
    const parsed = parseSlashCommand("/think high");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("high");
  });

  it("/think low sets thinkingLevel to low", () => {
    const parsed = parseSlashCommand("/think low");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("low");
  });

  it("/think off sets thinkingLevel to off", () => {
    const parsed = parseSlashCommand("/think off");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("off");
  });

  it("/think minimal sets thinkingLevel to minimal", () => {
    const parsed = parseSlashCommand("/think minimal");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("minimal");
  });

  it("/think xhigh sets thinkingLevel to xhigh", () => {
    const parsed = parseSlashCommand("/think xhigh");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("xhigh");
  });

  // -----------------------------------------------------------------------
  // /think with getAvailableThinkingLevels
  // -----------------------------------------------------------------------

  it("/think invalid-level with getAvailableThinkingLevels returns handled=true with error listing available levels", () => {
    deps = makeDeps({
      getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/think invalid-level");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Invalid thinking level 'invalid-level'");
    expect(result.response).toContain("Available: off, low, medium, high");
  });

  it("/think xhigh with getAvailableThinkingLevels excluding xhigh returns error", () => {
    deps = makeDeps({
      getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/think xhigh");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Invalid thinking level 'xhigh'");
    expect(result.response).toContain("Available: off, low, medium, high");
  });

  it("/think high with getAvailableThinkingLevels including high returns directive", () => {
    deps = makeDeps({
      getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/think high");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("high");
  });

  it("/think medium without getAvailableThinkingLevels dep falls back to hardcoded set and succeeds", () => {
    // Default deps do not provide getAvailableThinkingLevels
    const parsed = parseSlashCommand("/think medium");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("medium");
  });

  // -----------------------------------------------------------------------
  // /verbose
  // -----------------------------------------------------------------------

  it("/verbose on sets verbose to true", () => {
    const parsed = parseSlashCommand("/verbose on");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.verbose).toBe(true);
  });

  it("/verbose off sets verbose to false", () => {
    const parsed = parseSlashCommand("/verbose off");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.verbose).toBe(false);
  });

  it("/verbose with no arg defaults to true", () => {
    const parsed = parseSlashCommand("/verbose");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.verbose).toBe(true);
  });

  // -----------------------------------------------------------------------
  // /reasoning
  // -----------------------------------------------------------------------

  it("/reasoning returns reasoning: true directive", () => {
    const parsed = parseSlashCommand("/reasoning");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.reasoning).toBe(true);
  });

  // -----------------------------------------------------------------------
  // /new
  // -----------------------------------------------------------------------

  it("/new calls destroySession and sets newSession directive", () => {
    const parsed = parseSlashCommand("/new");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("New session created.");
    expect(result.directives.newSession).toBe(true);
    expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
  });

  it("/new openai/gpt-4o sets both newSession and modelOverride", () => {
    const parsed = parseSlashCommand("/new openai/gpt-4o");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.directives.newSession).toBe(true);
    expect(result.directives.modelOverride).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
  });

  // -----------------------------------------------------------------------
  // /reset
  // -----------------------------------------------------------------------

  it("/reset calls destroySession and sets resetSession directive", () => {
    const parsed = parseSlashCommand("/reset");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("Session reset.");
    expect(result.directives.resetSession).toBe(true);
    expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
  });

  // -----------------------------------------------------------------------
  // /compact
  // -----------------------------------------------------------------------

  it("/compact returns handled=false with compact directive (executor consumes)", () => {
    const parsed = parseSlashCommand("/compact");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.directives.compact).toEqual({ verbose: false, instructions: undefined });
  });

  it("/compact verbose returns verbose mode with response prefix", () => {
    const parsed = parseSlashCommand("/compact verbose");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBe("Starting compaction (verbose mode)...");
    expect(result.directives.compact).toEqual({ verbose: true, instructions: undefined });
  });

  it("/compact verbose focus on user preferences returns verbose + instructions", () => {
    const parsed = parseSlashCommand("/compact verbose focus on user preferences");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBe("Starting compaction (verbose mode)...");
    expect(result.directives.compact).toEqual({
      verbose: true,
      instructions: "focus on user preferences",
    });
  });

  it("/compact focus on key decisions returns instructions without verbose", () => {
    const parsed = parseSlashCommand("/compact focus on key decisions");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.directives.compact).toEqual({
      verbose: false,
      instructions: "focus on key decisions",
    });
  });

  // -----------------------------------------------------------------------
  // /export
  // -----------------------------------------------------------------------

  it("/export returns handled=false with exportSession directive (outputPath undefined)", () => {
    const parsed = parseSlashCommand("/export");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.exportSession).toEqual({ outputPath: undefined });
  });

  it("/export /tmp/out.html returns handled=false with exportSession directive (outputPath set)", () => {
    const parsed = parseSlashCommand("/export /tmp/out.html");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.exportSession).toEqual({ outputPath: "/tmp/out.html" });
  });

  // -----------------------------------------------------------------------
  // /usage
  // -----------------------------------------------------------------------

  it("/usage with no getUsageBreakdown dep returns empty message", () => {
    deps = makeDeps({ getUsageBreakdown: undefined });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("No usage data recorded yet.");
  });

  it("/usage with empty breakdown array returns empty message", () => {
    deps = makeDeps({ getUsageBreakdown: () => [] });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("No usage data recorded yet.");
  });

  it("/usage with data returns formatted per-provider breakdown", () => {
    deps = makeDeps({
      getUsageBreakdown: () => [
        { provider: "anthropic", model: "claude-sonnet-4-5-20250929", totalTokens: 15000, totalCost: 0.045, callCount: 3 },
        { provider: "openai", model: "gpt-4o", totalTokens: 8500, totalCost: 0.0255, callCount: 2 },
      ],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Usage Breakdown**");
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929: 15,000 tokens, $0.0450 (3 calls)");
    expect(result.response).toContain("openai/gpt-4o: 8,500 tokens, $0.0255 (2 calls)");
  });

  it("/usage grand total is correct sum", () => {
    deps = makeDeps({
      getUsageBreakdown: () => [
        { provider: "anthropic", model: "claude-sonnet-4-5-20250929", totalTokens: 15000, totalCost: 0.045, callCount: 3 },
        { provider: "openai", model: "gpt-4o", totalTokens: 8500, totalCost: 0.0255, callCount: 2 },
      ],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    expect(result.response).toContain("**Total:** 23,500 tokens, $0.0705");
  });

  it("/usage cost formatting uses .toFixed(4) -- no floating point noise", () => {
    deps = makeDeps({
      getUsageBreakdown: () => [
        { provider: "anthropic", model: "claude-sonnet-4-5-20250929", totalTokens: 1000, totalCost: 0.003, callCount: 1 },
      ],
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    // .toFixed(4) should give $0.0030, not $0.003000000000000000002
    expect(result.response).toContain("$0.0030");
    expect(result.response).not.toMatch(/\$0\.003\d{4,}/);
  });

  // -----------------------------------------------------------------------
  // /status with cost
  // -----------------------------------------------------------------------

  it("/status includes Est. cost when getSessionCost returns non-zero cost", () => {
    deps = makeDeps({
      getSessionCost: () => ({ totalTokens: 5000, totalCost: 0.015 }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Est. cost: $0.0150");
  });

  it("/status omits cost line when getSessionCost returns zero", () => {
    deps = makeDeps({
      getSessionCost: () => ({ totalTokens: 0, totalCost: 0 }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).not.toContain("Est. cost:");
  });

  it("/status omits cost line when getSessionCost is undefined", () => {
    deps = makeDeps({ getSessionCost: undefined });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).not.toContain("Est. cost:");
  });

  // -----------------------------------------------------------------------
  // /status with tokensUsed from pi-executor session stats
  // -----------------------------------------------------------------------

  it("/status shows token usage from session info when no SDK stats", () => {
    deps = makeDeps({
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 10,
        createdAt: Date.now() - 600_000,
        tokensUsed: { input: 25_000, output: 12_000, total: 37_000 },
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Token Usage**");
    expect(result.response).toContain("Input: 25,000 | Output: 12,000");
    expect(result.response).toContain("Total: 37,000 tokens");
  });

  it("/status shows 'No token data available' when tokensUsed is undefined", () => {
    deps = makeDeps({
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 5,
        createdAt: Date.now() - 300_000,
        tokensUsed: undefined,
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("No token data available");
  });

  // -----------------------------------------------------------------------
  // /status with SDK session stats
  // -----------------------------------------------------------------------

  it("/status shows SDK session stats when available", () => {
    deps = makeDeps({
      getSDKSessionStats: () => ({
        userMessages: 21,
        assistantMessages: 20,
        toolCalls: 15,
        toolResults: 15,
        totalMessages: 42,
        tokens: {
          input: 25_000,
          output: 12_000,
          cacheRead: 8_000,
          cacheWrite: 3_000,
          total: 48_000,
        },
        cost: 0.045,
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("User: 21");
    expect(result.response).toContain("Assistant: 20");
    expect(result.response).toContain("Tool calls: 15");
    expect(result.response).toContain("Cache read: 8,000");
    expect(result.response).toContain("Cache write: 3,000");
    expect(result.response).toContain("Total: 48,000 tokens");
    expect(result.response).toContain("Est. cost: $0.0450");
  });

  it("/status shows context window bar", () => {
    deps = makeDeps({
      getContextUsage: () => ({
        tokens: 84_000,
        contextWindow: 200_000,
        percent: 42,
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Context: 42%");
    expect(result.response).toContain("84k / 200k tokens");
    // Should contain filled and empty blocks
    expect(result.response).toMatch(/\u2588+/);
    expect(result.response).toMatch(/\u2591+/);
  });

  it("/status shows N/A for context when percent is null", () => {
    deps = makeDeps({
      getContextUsage: () => ({
        tokens: null,
        contextWindow: 200_000,
        percent: null,
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Context: N/A");
  });

  it("/status falls back to basic info when SDK stats unavailable", () => {
    deps = makeDeps({
      getSDKSessionStats: undefined,
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 10,
        createdAt: Date.now() - 600_000,
        tokensUsed: { input: 5_000, output: 3_000, total: 8_000 },
      }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    // Falls back to basic message count
    expect(result.response).toContain("Total: 10 messages");
    // Falls back to session-level token info
    expect(result.response).toContain("Input: 5,000 | Output: 3,000");
    expect(result.response).toContain("Total: 8,000 tokens");
  });

  it("/status shows budget info", () => {
    deps = makeDeps({
      getBudgetInfo: () => ({
        perExecution: 0.50,
        perHour: 2.00,
        perDay: 10.00,
      }),
      getSessionCost: () => ({ totalTokens: 5000, totalCost: 0.015 }),
    });
    handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Budget**");
    expect(result.response).toContain("Budget caps: $0.50/exec, $2.00/hr, $10.00/day");
    expect(result.response).toContain("Est. cost: $0.0150");
  });

  // -----------------------------------------------------------------------
  // /stop
  // -----------------------------------------------------------------------

  it("/stop returns handled=true with 'Stopping...' response", () => {
    const parsed = parseSlashCommand("/stop");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("Stopping...");
    expect(result.directives).toEqual({});
  });

  // -----------------------------------------------------------------------
  // /fork
  // -----------------------------------------------------------------------

  it("/fork returns handled=false with forkSession=true directive", () => {
    const parsed = parseSlashCommand("/fork");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.forkSession).toBe(true);
  });

  // -----------------------------------------------------------------------
  // /branch
  // -----------------------------------------------------------------------

  it("/branch (no args) returns handled=false with branchAction (no targetId)", () => {
    const parsed = parseSlashCommand("/branch");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.branchAction).toBeDefined();
    expect(result.directives.branchAction!.targetId).toBeUndefined();
  });

  it("/branch entry-123 returns handled=false with branchAction.targetId set", () => {
    const parsed = parseSlashCommand("/branch entry-123");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.branchAction).toEqual({ targetId: "entry-123" });
  });

  // -----------------------------------------------------------------------
  // /budget command
  // -----------------------------------------------------------------------

  it("/budget 500k sets userTokenBudget directive to 500000", () => {
    const parsed = parseSlashCommand("/budget 500k");
    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(false);
    expect(result.directives.userTokenBudget).toBe(500_000);
  });

  it("/budget 2m sets userTokenBudget directive to 2000000", () => {
    const parsed = parseSlashCommand("/budget 2m");
    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(false);
    expect(result.directives.userTokenBudget).toBe(2_000_000);
  });

  it("/budget 500k with body text sets budget and preserves cleanedText", () => {
    const parsed = parseSlashCommand("/budget 500k tell me about X");
    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(false);
    expect(result.directives.userTokenBudget).toBe(500_000);
    expect(parsed.cleanedText).toBe("tell me about X");
  });

  it("/budget alone returns usage instructions", () => {
    const parsed = parseSlashCommand("/budget");
    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("Usage:");
    expect(result.directives.userTokenBudget).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Not-found pass-through
  // -----------------------------------------------------------------------

  it("returns handled=false for parsed command with found=false", () => {
    const parsed = parseSlashCommand("Hello, world!");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
  });
});
