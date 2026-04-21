// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Module Slash Command Integration Tests
 *
 * Composes real parseSlashCommand + createCommandHandler + matchPromptSkillCommand +
 * detectSkillCollisions imported from @comis/agent dist exports (not relative paths).
 *
 * Validates the full three-layer command system:
 * 1. Parser: parseSlashCommand extracts command, args, cleaned text
 * 2. Handler: createCommandHandler produces directives/responses
 * 3. Skill Matcher: matchPromptSkillCommand handles /skill:name syntax
 * 4. Collision Detector: detectSkillCollisions warns on reserved name shadows
 *
 * All 10 system commands covered: think, verbose, reasoning, status, context, usage,
 * model, new, reset, compact. Plus skill matching, priority rules, and edge cases.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseSlashCommand,
  createCommandHandler,
  matchPromptSkillCommand,
  detectSkillCollisions,
  RESERVED_COMMAND_NAMES,
} from "@comis/agent";
import type { CommandHandlerDeps } from "@comis/agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionKey() {
  return { tenantId: "integration", userId: "slash-user", channelId: "slash-chan" } as const;
}

/**
 * Create CommandHandlerDeps with distinctive integration test values.
 * All values are unique from unit test fixtures to prove cross-module composition.
 */
function makeDeps(overrides?: Partial<CommandHandlerDeps>): CommandHandlerDeps {
  return {
    getSessionInfo: vi.fn().mockReturnValue({
      messageCount: 55,
      createdAt: Date.now() - 2_700_000, // 45 minutes ago
      modelOverride: undefined,
      tokensUsed: { input: 22_000, output: 13_000, total: 35_000 },
    }),
    getBootstrapInfo: vi.fn().mockReturnValue([
      { name: "SOUL.md", sizeChars: 3_200 },
      { name: "RULES.md", sizeChars: 1_800 },
    ]),
    getToolInfo: vi.fn().mockReturnValue([
      { name: "web_search", sizeChars: 550 },
      { name: "read", sizeChars: 380 },
    ]),
    getAgentConfig: vi.fn().mockReturnValue({
      name: "SlashBot",
      model: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      maxSteps: 30,
    }),
    getAvailableModels: vi.fn().mockReturnValue([
      { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929", name: "Claude Sonnet" },
      { provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
      { provider: "google", modelId: "gemini-pro", name: "Gemini Pro" },
    ]),
    destroySession: vi.fn(),
    getUsageBreakdown: vi.fn().mockReturnValue([
      { provider: "anthropic", model: "claude-sonnet-4-5-20250929", totalTokens: 35_000, totalCost: 0.105, callCount: 7 },
    ]),
    getSessionCost: vi.fn().mockReturnValue({ totalTokens: 35_000, totalCost: 0.105 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: Directive Commands (handled:false)
// ---------------------------------------------------------------------------

describe("Cross-Module Slash Commands Integration", () => {
  let deps: CommandHandlerDeps;
  const sessionKey = makeSessionKey();

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("Section 1: Directive Commands (handled:false)", () => {
    it("CMD-DIR-01: /think standalone -> thinkingLevel=high (default), handled:false", () => {
      const parsed = parseSlashCommand("/think");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("think");
      expect(parsed.isDirective).toBe(true);
      expect(parsed.isStandalone).toBe(true);
      expect(result.handled).toBe(false);
      expect(result.directives.thinkingLevel).toBe("high");
    });

    it("CMD-DIR-02: /think low -> thinkingLevel=low, handled:false, isStandalone:true", () => {
      const parsed = parseSlashCommand("/think low");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("think");
      expect(parsed.isDirective).toBe(true);
      expect(parsed.isStandalone).toBe(true);
      expect(parsed.args).toEqual(["low"]);
      expect(result.handled).toBe(false);
      expect(result.directives.thinkingLevel).toBe("low");
    });

    it("CMD-DIR-03: /think What about X? -> thinkingLevel=high, cleanedText body, isStandalone:false", () => {
      const parsed = parseSlashCommand("/think What about X?");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("think");
      expect(parsed.isDirective).toBe(true);
      expect(parsed.isStandalone).toBe(false);
      expect(parsed.cleanedText).toBe("What about X?");
      expect(result.handled).toBe(false);
      expect(result.directives.thinkingLevel).toBe("high");
    });

    it("CMD-DIR-04: /verbose on -> verbose=true, handled:false", () => {
      const parsed = parseSlashCommand("/verbose on");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("verbose");
      expect(parsed.isDirective).toBe(true);
      expect(result.handled).toBe(false);
      expect(result.directives.verbose).toBe(true);
    });

    it("CMD-DIR-05: /verbose off -> verbose=false, handled:false", () => {
      const parsed = parseSlashCommand("/verbose off");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("verbose");
      expect(result.handled).toBe(false);
      expect(result.directives.verbose).toBe(false);
    });

    it("CMD-DIR-06: /verbose Tell me more -> verbose=true, cleanedText body", () => {
      const parsed = parseSlashCommand("/verbose Tell me more");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("verbose");
      expect(parsed.isDirective).toBe(true);
      expect(parsed.isStandalone).toBe(false);
      expect(parsed.cleanedText).toBe("Tell me more");
      expect(result.handled).toBe(false);
      expect(result.directives.verbose).toBe(true);
    });

    it("CMD-DIR-07: /reasoning -> reasoning=true, handled:false", () => {
      const parsed = parseSlashCommand("/reasoning");
      const handler = createCommandHandler(deps);
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("reasoning");
      expect(parsed.isDirective).toBe(true);
      expect(result.handled).toBe(false);
      expect(result.directives.reasoning).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 2: Response Commands (handled:true)
  // ---------------------------------------------------------------------------

  describe("Section 2: Response Commands (handled:true)", () => {
    it("CMD-RSP-01: /status -> response contains session info fields", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/status");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Session Status");
      expect(result.response).toContain("Agent: SlashBot");
      expect(result.response).toContain("Model: anthropic/claude-sonnet-4-5-20250929");
      expect(result.response).toContain("Total: 55 messages");
      expect(result.response).toContain("Input: 22,000");
      expect(result.response).toContain("Output: 13,000");
      expect(result.response).toContain("Total: 35,000 tokens");
      expect(result.response).toContain("Max steps: 30");
      expect(result.response).toContain("Session started:");
      expect(result.response).toContain("$0.1050");
    });

    it("CMD-RSP-02: /status with model override shows overridden model", () => {
      const overrideDeps = makeDeps({
        getSessionInfo: vi.fn().mockReturnValue({
          messageCount: 55,
          createdAt: Date.now() - 2_700_000,
          modelOverride: "openai/gpt-4o",
          tokensUsed: { input: 22_000, output: 13_000, total: 35_000 },
        }),
      });
      const handler = createCommandHandler(overrideDeps);
      const parsed = parseSlashCommand("/status");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Model: openai/gpt-4o");
      // Should NOT contain the default model from config
      expect(result.response).not.toContain("anthropic/claude-sonnet-4-5-20250929");
    });

    it("CMD-RSP-03: /context -> response contains bootstrap files, tools, total overhead", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/context");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Context Overview");
      // Bootstrap files
      expect(result.response).toContain("SOUL.md: 3,200 chars");
      expect(result.response).toContain("RULES.md: 1,800 chars");
      // Tools
      expect(result.response).toContain("web_search: 550 chars");
      expect(result.response).toContain("read: 380 chars");
      // Total overhead (3200 + 1800 + 550 + 380 = 5930)
      expect(result.response).toContain("Total overhead: 5,930 chars");
    });

    it("CMD-RSP-04: /context with empty bootstrap/tools -> Not available for both sections", () => {
      const emptyDeps = makeDeps({
        getBootstrapInfo: vi.fn().mockReturnValue([]),
        getToolInfo: vi.fn().mockReturnValue([]),
      });
      const handler = createCommandHandler(emptyDeps);
      const parsed = parseSlashCommand("/context");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Bootstrap files: Not available");
      expect(result.response).toContain("Tool schemas: Not available");
      expect(result.response).not.toContain("Total overhead");
    });

    it("CMD-RSP-05: /usage -> response contains breakdown with provider, tokens, cost, calls", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/usage");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Usage Breakdown");
      expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929");
      expect(result.response).toContain("35,000 tokens");
      expect(result.response).toContain("$0.1050");
      expect(result.response).toContain("7 calls");
    });

    it("CMD-RSP-06: /usage with no breakdown data -> No usage data message", () => {
      const noUsageDeps = makeDeps({
        getUsageBreakdown: vi.fn().mockReturnValue([]),
      });
      const handler = createCommandHandler(noUsageDeps);
      const parsed = parseSlashCommand("/usage");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toBe("No usage data recorded yet.");
    });
  });

  // ---------------------------------------------------------------------------
  // Section 3: Model Commands (handled:true)
  // ---------------------------------------------------------------------------

  describe("Section 3: Model Commands (handled:true)", () => {
    it("CMD-MDL-01: /model (no arg) -> shows current model as provider/modelId", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/model");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toBe("Current model: anthropic/claude-sonnet-4-5-20250929");
    });

    it("CMD-MDL-01b: /model status -> same as /model (no arg)", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/model status");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toBe("Current model: anthropic/claude-sonnet-4-5-20250929");
    });

    it("CMD-MDL-02: /model list -> Available Models with 3 entries", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/model list");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Available Models");
      expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929 (Claude Sonnet)");
      expect(result.response).toContain("openai/gpt-4o (GPT-4o)");
      expect(result.response).toContain("google/gemini-pro (Gemini Pro)");
    });

    it("CMD-MDL-03: /model openai/gpt-4o -> modelOverride with provider/modelId (handled:false, deferred to executor)", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/model openai/gpt-4o");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(false);
      expect(result.directives.modelOverride).toEqual({
        provider: "openai",
        modelId: "gpt-4o",
      });
    });

    it("CMD-MDL-04: /model gpt-4o (bare modelId) -> provider defaults to 'default' (handled:false, deferred to executor)", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/model gpt-4o");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(false);
      expect(result.directives.modelOverride).toEqual({
        provider: "default",
        modelId: "gpt-4o",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Section 4: Session Commands (handled:true)
  // ---------------------------------------------------------------------------

  describe("Section 4: Session Commands (handled:true)", () => {
    it("CMD-SES-01: /new -> newSession=true, destroySession called, response confirmed", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/new");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toBe("New session created.");
      expect(result.directives.newSession).toBe(true);
      expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
    });

    it("CMD-SES-02: /new openai/gpt-4o -> newSession + modelOverride", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/new openai/gpt-4o");
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

    it("CMD-SES-03: /reset -> resetSession=true, destroySession called", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/reset");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(true);
      expect(result.response).toBe("Session reset.");
      expect(result.directives.resetSession).toBe(true);
      expect(deps.destroySession).toHaveBeenCalledWith(sessionKey);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 5: Compaction Command (handled:false)
  // ---------------------------------------------------------------------------

  describe("Section 5: Compaction Command (handled:false)", () => {
    it("CMD-CMP-01: /compact -> compact directive with verbose:false, no instructions", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/compact");
      const result = handler.handle(parsed, sessionKey);

      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("compact");
      expect(result.handled).toBe(false);
      expect(result.directives.compact).toEqual({ verbose: false, instructions: undefined });
    });

    it("CMD-CMP-02: /compact verbose focus on code -> verbose:true with instructions", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/compact verbose focus on code");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(false);
      expect(result.directives.compact).toEqual({
        verbose: true,
        instructions: "focus on code",
      });
    });

    it("CMD-CMP-03: /compact -v keep tool outputs -> verbose:true via -v flag with instructions", () => {
      const handler = createCommandHandler(deps);
      const parsed = parseSlashCommand("/compact -v keep tool outputs");
      const result = handler.handle(parsed, sessionKey);

      expect(result.handled).toBe(false);
      expect(result.directives.compact).toEqual({
        verbose: true,
        instructions: "keep tool outputs",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Section 6: Priority & Skill Matching
  // ---------------------------------------------------------------------------

  describe("Section 6: Priority & Skill Matching", () => {
    it("CMD-PRI-01: system /status takes priority -- parseSlashCommand returns found:true before skill matching", () => {
      // Even if "status" were a skill name, parseSlashCommand returns found:true
      const parsed = parseSlashCommand("/status");
      expect(parsed.found).toBe(true);
      expect(parsed.command).toBe("status");

      // Skill matcher should only be called when parseSlashCommand returns found:false
      // Demonstrate the priority chain: parse first, skill match second
      const skillNames = new Set(["status", "deploy"]);
      // matchPromptSkillCommand uses /skill:name syntax, NOT /name syntax
      // So /status is always a system command, never matched as a skill
      const skillMatch = matchPromptSkillCommand("/status", skillNames);
      expect(skillMatch).toBeNull(); // /status doesn't match /skill:name pattern
    });

    it("CMD-PRI-02: /skill:deploy build api -> matches known skill with args", () => {
      const skillNames = new Set(["deploy", "test-runner", "lint"]);
      const match = matchPromptSkillCommand("/skill:deploy build api", skillNames);

      expect(match).not.toBeNull();
      expect(match!.name).toBe("deploy");
      expect(match!.args).toBe("build api");
    });

    it("CMD-PRI-03: /skill:DEPLOY (case-insensitive) -> matches canonical 'deploy' name", () => {
      const skillNames = new Set(["deploy"]);
      const match = matchPromptSkillCommand("/skill:DEPLOY", skillNames);

      expect(match).not.toBeNull();
      expect(match!.name).toBe("deploy");
      expect(match!.args).toBe("");
    });

    it("CMD-PRI-04: /skill:unknown-skill with unknown name -> returns null", () => {
      const skillNames = new Set(["deploy", "test-runner"]);
      const match = matchPromptSkillCommand("/skill:unknown-skill", skillNames);

      expect(match).toBeNull();
    });

    it("CMD-PRI-05: detectSkillCollisions warns when skill named 'status' shadows reserved command", () => {
      const skillNames = new Set(["status", "deploy", "model"]);
      const warnings = detectSkillCollisions(skillNames);

      // "status" and "model" are reserved command names
      expect(warnings.length).toBe(2);

      const statusWarning = warnings.find((w) => w.skillName === "status");
      expect(statusWarning).toBeDefined();
      expect(statusWarning!.collidesWithCommand).toBe("status");
      expect(statusWarning!.message).toContain("shadows reserved command");
      expect(statusWarning!.message).toContain("/skill:status");

      const modelWarning = warnings.find((w) => w.skillName === "model");
      expect(modelWarning).toBeDefined();
      expect(modelWarning!.collidesWithCommand).toBe("model");

      // "deploy" does not collide
      const deployWarning = warnings.find((w) => w.skillName === "deploy");
      expect(deployWarning).toBeUndefined();
    });

    it("RESERVED_COMMAND_NAMES includes all 10 system commands plus anticipated future ones", () => {
      // All 10 system commands
      const systemCommands = ["think", "verbose", "reasoning", "context", "status", "usage", "model", "new", "reset", "compact"];
      for (const cmd of systemCommands) {
        expect(RESERVED_COMMAND_NAMES.has(cmd)).toBe(true);
      }

      // Anticipated future commands
      expect(RESERVED_COMMAND_NAMES.has("help")).toBe(true);
      expect(RESERVED_COMMAND_NAMES.has("skill")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Section 7: Edge Cases
  // ---------------------------------------------------------------------------

  describe("Section 7: Edge Cases", () => {
    it("CMD-EDGE-01: plain text 'Hello world' -> found:false, cleanedText preserved", () => {
      const parsed = parseSlashCommand("Hello world");

      expect(parsed.found).toBe(false);
      expect(parsed.cleanedText).toBe("Hello world");
      expect(parsed.isDirective).toBe(false);
      expect(parsed.isStandalone).toBe(false);
    });

    it("CMD-EDGE-02: mid-message slash 'Please /status my account' -> found:false (not at start)", () => {
      const parsed = parseSlashCommand("Please /status my account");

      expect(parsed.found).toBe(false);
      expect(parsed.cleanedText).toBe("Please /status my account");
    });

    it("CMD-EDGE-03: unknown command '/foobar hello' -> found:false", () => {
      const parsed = parseSlashCommand("/foobar hello");

      expect(parsed.found).toBe(false);
      expect(parsed.cleanedText).toBe("/foobar hello");
    });

    it("CMD-EDGE-04: sequential commands on same handler instance produce independent results", () => {
      const handler = createCommandHandler(deps);

      // First: /think (directive)
      const r1 = handler.handle(parseSlashCommand("/think"), sessionKey);
      expect(r1.handled).toBe(false);
      expect(r1.directives.thinkingLevel).toBe("high");
      expect(r1.directives.verbose).toBeUndefined();

      // Second: /verbose on (directive)
      const r2 = handler.handle(parseSlashCommand("/verbose on"), sessionKey);
      expect(r2.handled).toBe(false);
      expect(r2.directives.verbose).toBe(true);
      expect(r2.directives.thinkingLevel).toBeUndefined();

      // Third: /status (response)
      const r3 = handler.handle(parseSlashCommand("/status"), sessionKey);
      expect(r3.handled).toBe(true);
      expect(r3.directives.thinkingLevel).toBeUndefined();
      expect(r3.directives.verbose).toBeUndefined();

      // Each result is independent -- no cross-contamination of directives
    });
  });
});
