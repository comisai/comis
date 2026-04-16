/**
 * Slash Command Integration Tests
 *
 * Composes real instances of parseSlashCommand and createCommandHandler together,
 * testing the full parse-then-handle flow with realistic mock dependencies.
 *
 * @module
 */

import type { SessionKey } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseSlashCommand } from "./command-parser.js";
import { createCommandHandler, type CommandHandler } from "./command-handler.js";
import type { CommandHandlerDeps } from "./types.js";

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
      { provider: "google", modelId: "gemini-pro", name: "Gemini Pro" },
    ]),
    destroySession: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests: parse -> handle flow
// ---------------------------------------------------------------------------

describe("Slash Command Integration", () => {
  let handler: CommandHandler;
  let deps: CommandHandlerDeps;
  const sessionKey = makeSessionKey();

  beforeEach(() => {
    deps = makeDeps();
    handler = createCommandHandler(deps);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Plain text message -- no command processing
  // -------------------------------------------------------------------------

  it("plain text message passes through unchanged, no handler call needed", () => {
    const text = "Hello, how are you?";
    const parsed = parseSlashCommand(text);

    expect(parsed.found).toBe(false);
    expect(parsed.cleanedText).toBe(text);
    expect(parsed.isDirective).toBe(false);

    // Handler returns handled=false for not-found commands
    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: /status end-to-end
  // -------------------------------------------------------------------------

  it("/status end-to-end: parse -> handle -> response with agent info", () => {
    const parsed = parseSlashCommand("/status");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("status");
    expect(parsed.isStandalone).toBe(true);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Agent: Comis");
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929");
    expect(result.response).toContain("Total: 42 messages");
    expect(result.response).toContain("**Token Usage**");
    expect(result.response).toContain("Input: 10,000");
    expect(result.response).toContain("Output: 5,000");
    expect(result.response).toContain("Total: 15,000 tokens");
    expect(deps.getSessionInfo).toHaveBeenCalledWith(sessionKey);
    expect(deps.getAgentConfig).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: /context end-to-end
  // -------------------------------------------------------------------------

  it("/context end-to-end: parse -> handle -> lists file sizes and tool overhead", () => {
    const parsed = parseSlashCommand("/context");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("context");

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Context Overview**");
    // Bootstrap files
    expect(result.response).toContain("SOUL.md: 2,450 chars");
    expect(result.response).toContain("USER.md: 1,200 chars");
    expect(result.response).toContain("Total bootstrap: 3,650 chars");
    // Tool schemas
    expect(result.response).toContain("web_search: 450 chars");
    expect(result.response).toContain("file_read: 320 chars");
    expect(result.response).toContain("Total tools: 770 chars");
    // Total overhead
    expect(result.response).toContain("Total overhead: 4,420 chars");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: /model switch end-to-end
  // -------------------------------------------------------------------------

  it("/model openai/gpt-4o end-to-end: parse -> handle -> returns modelSwitch directive (executor consumes)", () => {
    const parsed = parseSlashCommand("/model openai/gpt-4o");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("model");
    expect(parsed.args).toEqual(["openai/gpt-4o"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelSwitch).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(result.directives.modelOverride).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4b: /model cycle end-to-end
  // -------------------------------------------------------------------------

  it("/model cycle end-to-end: parse -> handle -> returns modelCycle directive", () => {
    const parsed = parseSlashCommand("/model cycle");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("model");
    expect(parsed.args).toEqual(["cycle"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.modelCycle).toEqual({ direction: "forward" });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: /model list end-to-end
  // -------------------------------------------------------------------------

  it("/model list end-to-end: parse -> handle -> lists available models", () => {
    const parsed = parseSlashCommand("/model list");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("model");
    expect(parsed.args).toEqual(["list"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("**Available Models**");
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929 (Claude Sonnet)");
    expect(result.response).toContain("openai/gpt-4o (GPT-4o)");
    expect(result.response).toContain("google/gemini-pro (Gemini Pro)");
  });

  // -------------------------------------------------------------------------
  // Scenario 6: /think directive with body text
  // -------------------------------------------------------------------------

  it("/think with body text: directive strips command, passes body to executor", () => {
    const parsed = parseSlashCommand("/think What is the meaning of life?");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("think");
    expect(parsed.isDirective).toBe(true);
    expect(parsed.isStandalone).toBe(false);
    expect(parsed.cleanedText).toBe("What is the meaning of life?");

    const result = handler.handle(parsed, sessionKey);

    // Directive: handled=false so executor still runs with cleanedText
    expect(result.handled).toBe(false);
    expect(result.directives.thinkingLevel).toBe("high");
    // cleanedText is "What is the meaning of life?" -- should be passed to executor, not original text
    expect(parsed.cleanedText).toBe("What is the meaning of life?");
  });

  // -------------------------------------------------------------------------
  // Scenario 7: /verbose on then /verbose off
  // -------------------------------------------------------------------------

  it("/verbose on then /verbose off: toggles verbose directive", () => {
    // First: /verbose on
    const parsed1 = parseSlashCommand("/verbose on");
    const result1 = handler.handle(parsed1, sessionKey);

    expect(result1.handled).toBe(false);
    expect(result1.directives.verbose).toBe(true);

    // Second: /verbose off
    const parsed2 = parseSlashCommand("/verbose off");
    const result2 = handler.handle(parsed2, sessionKey);

    expect(result2.handled).toBe(false);
    expect(result2.directives.verbose).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: /new with model selection
  // -------------------------------------------------------------------------

  it("/new openai/gpt-4o: destroys session, confirms new session, sets model override", () => {
    const parsed = parseSlashCommand("/new openai/gpt-4o");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("new");
    expect(parsed.args).toEqual(["openai/gpt-4o"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("New session created.");
    expect(result.directives.newSession).toBe(true);
    expect(result.directives.modelOverride).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
  });

  // -------------------------------------------------------------------------
  // Scenario 9: /reset then verify session destroyed
  // -------------------------------------------------------------------------

  it("/reset: destroys session with correct sessionKey", () => {
    const parsed = parseSlashCommand("/reset");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("reset");

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toBe("Session reset.");
    expect(result.directives.resetSession).toBe(true);
    expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
  });

  // -------------------------------------------------------------------------
  // Scenario 10: /compact end-to-end
  // -------------------------------------------------------------------------

  it("/compact end-to-end: parse -> handle -> compact directive (handled=false for executor)", () => {
    const parsed = parseSlashCommand("/compact");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("compact");

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.directives.compact).toEqual({ verbose: false, instructions: undefined });
  });

  it("/compact verbose focus on user prefs end-to-end", () => {
    const parsed = parseSlashCommand("/compact verbose focus on user prefs");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("compact");
    expect(parsed.args).toEqual(["verbose", "focus", "on", "user", "prefs"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.response).toBe("Starting compaction (verbose mode)...");
    expect(result.directives.compact).toEqual({
      verbose: true,
      instructions: "focus on user prefs",
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 10b: /export end-to-end
  // -------------------------------------------------------------------------

  it("/export end-to-end: parse -> handle -> exportSession directive (handled=false for executor)", () => {
    const parsed = parseSlashCommand("/export");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("export");
    expect(parsed.isStandalone).toBe(true);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.exportSession).toEqual({ outputPath: undefined });
  });

  it("/export /tmp/out.html end-to-end: parse -> handle -> exportSession directive with custom path", () => {
    const parsed = parseSlashCommand("/export /tmp/out.html");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("export");
    expect(parsed.args).toEqual(["/tmp/out.html"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.exportSession).toEqual({ outputPath: "/tmp/out.html" });
  });

  // -------------------------------------------------------------------------
  // Scenario 10c: /fork end-to-end
  // -------------------------------------------------------------------------

  it("/fork end-to-end: parse -> handle -> forkSession directive (handled=false for executor)", () => {
    const parsed = parseSlashCommand("/fork");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("fork");
    expect(parsed.isStandalone).toBe(true);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.forkSession).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 10d: /branch <id> end-to-end
  // -------------------------------------------------------------------------

  it("/branch entry-42 end-to-end: parse -> handle -> branchAction directive with targetId", () => {
    const parsed = parseSlashCommand("/branch entry-42");

    expect(parsed.found).toBe(true);
    expect(parsed.command).toBe("branch");
    expect(parsed.args).toEqual(["entry-42"]);

    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(false);
    expect(result.directives.branchAction).toEqual({ targetId: "entry-42" });
  });

  // -------------------------------------------------------------------------
  // Scenario 11: Unknown command passes through
  // -------------------------------------------------------------------------

  it("unknown command /foobar passes through as-is to executor", () => {
    const parsed = parseSlashCommand("/foobar hello");

    expect(parsed.found).toBe(false);
    // The original text is preserved
    expect(parsed.cleanedText).toBe("/foobar hello");
    expect(parsed.isDirective).toBe(false);

    const result = handler.handle(parsed, sessionKey);
    expect(result.handled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 12: Multiple sequential commands on separate messages
  // -------------------------------------------------------------------------

  it("multiple sequential commands: model switch, thinking level, status reflects changes", () => {
    // Message 1: /model openai/gpt-4o -> model switch directive (executor consumes)
    const parsed1 = parseSlashCommand("/model openai/gpt-4o");
    const result1 = handler.handle(parsed1, sessionKey);

    expect(result1.handled).toBe(false);
    expect(result1.directives.modelSwitch).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(result1.directives.modelOverride).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });

    // Message 2: /think high -> thinking level
    const parsed2 = parseSlashCommand("/think high");
    const result2 = handler.handle(parsed2, sessionKey);

    expect(result2.handled).toBe(false);
    expect(result2.directives.thinkingLevel).toBe("high");

    // Message 3: /status -> status reflects the current state
    // Update mock to reflect model override
    (deps.getSessionInfo as any).mockReturnValue({
      messageCount: 44,
      createdAt: Date.now() - 3_600_000,
      modelOverride: "openai/gpt-4o",
      tokensUsed: { input: 11_000, output: 5_500, total: 16_500 },
    });

    const parsed3 = parseSlashCommand("/status");
    const result3 = handler.handle(parsed3, sessionKey);

    expect(result3.handled).toBe(true);
    // Status should show the overridden model
    expect(result3.response).toContain("Model: openai/gpt-4o");
    expect(result3.response).toContain("Total: 44 messages");

    // Each command was independently parsed and handled
    expect(deps.getSessionInfo).toHaveBeenCalledTimes(1); // Only /status calls getSessionInfo
    expect(deps.getAgentConfig).toHaveBeenCalledTimes(1); // Only /status calls getAgentConfig
  });
});
