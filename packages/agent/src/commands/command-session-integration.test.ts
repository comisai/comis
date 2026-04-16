/**
 * Slash command integration tests during active session.
 *
 * Verifies that /status and /context produce correct output when wired
 * to dependencies reflecting an ACTIVE session with non-default values.
 *
 * Uses intentionally different values from command-integration.test.ts
 * to prove that tests validate dynamic session data, not static defaults:
 * - Agent "Atlas" (not "Comis"), model opus (not sonnet)
 * - 87 messages (not 42), 70k tokens (not 15k)
 * - 3 bootstrap files (not 2), 3 tools (not 2)
 * - $0.2150 cost, maxSteps 50 (not 25)
 *
 * @module
 */

import type { SessionKey } from "@comis/core";
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSlashCommand } from "./command-parser.js";
import { createCommandHandler, type CommandHandler } from "./command-handler.js";
import type { CommandHandlerDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create CommandHandlerDeps with values reflecting an ACTIVE session.
 * All values are intentionally distinct from command-integration.test.ts.
 */
function makeActiveSessionDeps(
  overrides?: Partial<CommandHandlerDeps>,
): CommandHandlerDeps {
  return {
    getSessionInfo: vi.fn().mockReturnValue({
      messageCount: 87,
      createdAt: Date.now() - 1_800_000, // 30 minutes ago
      modelOverride: undefined,
      tokensUsed: { input: 52_000, output: 18_000, total: 70_000 },
    }),
    getBootstrapInfo: vi.fn().mockReturnValue([
      { name: "SOUL.md", sizeChars: 4_800 },
      { name: "AGENTS.md", sizeChars: 2_100 },
      { name: "TOOLS.md", sizeChars: 950 },
    ]),
    getToolInfo: vi.fn().mockReturnValue([
      { name: "web_search", sizeChars: 680 },
      { name: "file_read", sizeChars: 420 },
      { name: "code_execute", sizeChars: 1_200 },
    ]),
    getAgentConfig: vi.fn().mockReturnValue({
      name: "Atlas",
      model: "claude-opus-4-20250514",
      provider: "anthropic",
      maxSteps: 50,
    }),
    getAvailableModels: vi.fn().mockReturnValue([
      {
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
        name: "Claude Opus",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet",
      },
    ]),
    getSessionCost: vi
      .fn()
      .mockReturnValue({ totalTokens: 70_000, totalCost: 0.215 }),
    destroySession: vi.fn(),
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "tenant-active",
    userId: "user-42",
    channelId: "chan-live",
  };
}

// ---------------------------------------------------------------------------
// -- Slash commands during active session
// ---------------------------------------------------------------------------

describe("-- Slash commands during active session", () => {
  const sessionKey = makeSessionKey();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("/status reflects active session with 87 messages and 70k tokens", () => {
    const deps = makeActiveSessionDeps();
    const handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);

    // Agent name (different from "Comis" in existing tests)
    expect(result.response).toContain("Agent: Atlas");

    // Model (different from sonnet in existing tests)
    expect(result.response).toContain("anthropic/claude-opus-4-20250514");

    // Message count (different from 42 in existing tests)
    expect(result.response).toContain("Total: 87 messages");

    // Token breakdown (grouped format)
    expect(result.response).toContain("Input: 52,000");
    expect(result.response).toContain("Output: 18,000");
    expect(result.response).toContain("Total: 70,000 tokens");

    // Max steps (different from 25 in existing tests)
    expect(result.response).toContain("Max steps: 50");

    // Session cost
    expect(result.response).toContain("$0.2150");

    // Session timing (30 minutes ago)
    expect(result.response).toContain("30m ago");

    // Verify deps were called correctly
    expect(deps.getSessionInfo).toHaveBeenCalledWith(sessionKey);
    expect(deps.getAgentConfig).toHaveBeenCalled();
  });

  it("/status with model override shows overridden model", () => {
    const deps = makeActiveSessionDeps({
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 87,
        createdAt: Date.now() - 1_800_000,
        modelOverride: "openai/gpt-4o",
        tokensUsed: { input: 52_000, output: 18_000, total: 70_000 },
      }),
    });
    const handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Model: openai/gpt-4o");
    expect(result.response).not.toContain("anthropic/claude-opus-4-20250514");
  });

  it("/context lists 3 bootstrap files and 3 tools with correct char counts", () => {
    const deps = makeActiveSessionDeps();
    const handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/context");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);

    // Header
    expect(result.response).toContain("**Context Overview**");

    // Bootstrap files
    expect(result.response).toContain("SOUL.md: 4,800 chars");
    expect(result.response).toContain("AGENTS.md: 2,100 chars");
    expect(result.response).toContain("TOOLS.md: 950 chars");
    expect(result.response).toContain("Total bootstrap: 7,850 chars");

    // Tool schemas
    expect(result.response).toContain("web_search: 680 chars");
    expect(result.response).toContain("file_read: 420 chars");
    expect(result.response).toContain("code_execute: 1,200 chars");
    expect(result.response).toContain("Total tools: 2,300 chars");

    // Total overhead (4800 + 2100 + 950 + 680 + 420 + 1200 = 10150)
    expect(result.response).toContain("Total overhead: 10,150 chars");
  });

  it("/status and /context in sequence on same session produce consistent agent name", () => {
    const deps = makeActiveSessionDeps();
    const handler = createCommandHandler(deps);

    // Run /status
    const statusParsed = parseSlashCommand("/status");
    const statusResult = handler.handle(statusParsed, sessionKey);

    // Run /context
    const contextParsed = parseSlashCommand("/context");
    const contextResult = handler.handle(contextParsed, sessionKey);

    // Status shows "Atlas"
    expect(statusResult.response).toContain("Agent: Atlas");

    // Context shows the same bootstrap files (consistency check)
    expect(contextResult.response).toContain("SOUL.md: 4,800 chars");

    // getSessionInfo called exactly once (only /status uses it)
    expect(deps.getSessionInfo).toHaveBeenCalledTimes(1);

    // getBootstrapInfo called exactly once (only /context uses it)
    expect(deps.getBootstrapInfo).toHaveBeenCalledTimes(1);
  });

  it("/context with no bootstrap files shows 'Not available'", () => {
    const deps = makeActiveSessionDeps({
      getBootstrapInfo: vi.fn().mockReturnValue([]),
      getToolInfo: vi.fn().mockReturnValue([]),
    });
    const handler = createCommandHandler(deps);

    const parsed = parseSlashCommand("/context");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Bootstrap files: Not available");
    expect(result.response).toContain("Tool schemas: Not available");

    // Total overhead is only shown when both are present
    expect(result.response).not.toContain("Total overhead");
  });
});
