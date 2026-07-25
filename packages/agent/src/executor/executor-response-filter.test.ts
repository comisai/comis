// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for executor-response-filter.ts — focused on empty-response recovery.
 *
 * The private `extractVisibleText` logic is tested indirectly through the
 * exported `recoverEmptyFinalResponse` function.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { recoverEmptyFinalResponse, surfaceDiscardedPreToolUrl } from "./executor-response-filter.js";
import type { ComisLogger } from "@comis/core";

/** Minimal mock logger satisfying ComisLogger for recovery tests. */
function mockLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    audit: vi.fn(),
  } as unknown as ComisLogger;
}

describe("recoverEmptyFinalResponse", () => {
  it("returns original response when non-empty", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "Hello, world!",
      textEmitted: true,
      messages: [],
      logger: mockLogger(),
    });
    expect(result).toBe("Hello, world!");
  });

  it("returns empty string when textEmitted is false", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Some earlier text" }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("");
  });

  it("recovers visible text from earlier assistant turn", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is your answer." }],
        },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "pondering..." }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("Here is your answer.");
  });

  it("skips text blocks that are entirely <think> tags (root cause of false empty responses)", () => {
    const thinkOnlyText =
      "<think>The user asked about X. Let me reason through this carefully. " +
      "I need to consider A, B, and C factors before responding.</think>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Explain X" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The real visible answer about X." },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: thinkOnlyText },
          ],
        },
      ],
      logger: mockLogger(),
    });
    // Should skip the think-only message (index 2) and recover from index 1
    expect(result).toBe("The real visible answer about X.");
  });

  it("returns empty string when ALL text blocks are think-only", () => {
    const thinkOnly = "<think>Some internal reasoning</think>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: thinkOnly },
          ],
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    // No visible text found — returns original empty response
    expect(result).toBe("");
  });

  it("recovers text that has both <think> tags and visible content", () => {
    const mixedText =
      "<think>Internal reasoning here.</think>Here is the actual answer.";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: mixedText }],
        },
      ],
      logger: mockLogger(),
    });
    // Should strip the think tags and return the visible portion
    expect(result).toBe("Here is the actual answer.");
  });

  it("handles <thinking> variant tags the same as <think>", () => {
    const thinkingOnly = "<thinking>Deep reasoning about the topic.</thinking>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible response" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: thinkingOnly }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("Visible response");
  });

  it("silent tokens (NO_REPLY, HEARTBEAT_OK) pass through unchanged — recovery does not override explicit suppression signals", () => {
    const messages = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the real response." }],
      },
    ];
    expect(
      recoverEmptyFinalResponse({
        extractedResponse: "NO_REPLY",
        textEmitted: true,
        messages,
        logger: mockLogger(),
      }),
    ).toBe("NO_REPLY");
    expect(
      recoverEmptyFinalResponse({
        extractedResponse: "HEARTBEAT_OK",
        textEmitted: true,
        messages,
        logger: mockLogger(),
      }),
    ).toBe("HEARTBEAT_OK");
  });

  it("respects userMessageIndex boundary", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Previous execution text" }],
        },
        { role: "user", content: "New question" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }],
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 1,
    });
    // Should NOT recover text from index 0 (before userMessageIndex)
    expect(result).toBe("");
  });

  it("logs recovery info when text is recovered", () => {
    const logger = mockLogger();
    recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered text here" }],
        },
      ],
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("recovered text from earlier turn"),
        recoveredLength: expect.any(Number),
      }),
      expect.stringContaining("recovered visible text"),
    );
  });
});

describe("recoverEmptyFinalResponse — tool-call synthesis", () => {
  it("synthesizes summary after parallel agents_manage.create batch", () => {
    const logger = mockLogger();
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Build a trading system", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Big task — let me plan this out before building..." },
          ],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "agents_manage", arguments: { action: "create", agent_id: "ta-fundamentals" } },
            { type: "toolCall", id: "tc2", name: "agents_manage", arguments: { action: "create", agent_id: "ta-technicals" } },
            { type: "toolCall", id: "tc3", name: "agents_manage", arguments: { action: "create", agent_id: "ta-risk" } },
          ],
          stopReason: "toolUse",
          timestamp: 3,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], timestamp: 4 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "OK" }], timestamp: 5 },
        { role: "toolResult", toolCallId: "tc3", content: [{ type: "text", text: "OK" }], timestamp: 6 },
        {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 7,
        },
      ],
      logger,
      userMessageIndex: 0,
    });
    // Anchors
    expect(result).toContain("tool-call summary recovered");
    expect(result).toContain("Completed 3 tool calls");
    expect(result).toContain("agents_manage.create");
    expect(result).toContain("ta-fundamentals");
    expect(result).toContain("ta-technicals");
    expect(result).toContain("ta-risk");
    // CRITICAL: planning prose must NOT appear in the synthesized output
    expect(result).not.toContain("let me plan this out");
    expect(result).not.toContain("Big task");
  });

  it("includes each path when synthesizing from a write × 3 batch", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Customize roles", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "write", arguments: { path: "/agents/ta-fundamentals/ROLE.md", content: "..." } },
            { type: "toolCall", id: "tc2", name: "write", arguments: { path: "/agents/ta-technicals/ROLE.md", content: "..." } },
            { type: "toolCall", id: "tc3", name: "write", arguments: { path: "/agents/ta-risk/ROLE.md", content: "..." } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], timestamp: 3 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "OK" }], timestamp: 4 },
        { role: "toolResult", toolCallId: "tc3", content: [{ type: "text", text: "OK" }], timestamp: 5 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 6 },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toContain("Completed 3 tool calls");
    expect(result).toContain("/agents/ta-fundamentals/ROLE.md");
    expect(result).toContain("/agents/ta-technicals/ROLE.md");
    expect(result).toContain("/agents/ta-risk/ROLE.md");
  });

  it("includes all tool names when synthesizing from a mixed-tool batch", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Set up the agent", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "write", arguments: { path: "/role.md" } },
            { type: "toolCall", id: "tc2", name: "agents_manage", arguments: { action: "create", agent_id: "alpha" } },
            { type: "toolCall", id: "tc3", name: "gateway", arguments: { action: "patch", section: "agents" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], timestamp: 3 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "OK" }], timestamp: 4 },
        { role: "toolResult", toolCallId: "tc3", content: [{ type: "text", text: "OK" }], timestamp: 5 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 6 },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toContain("write");
    expect(result).toContain("agents_manage");
    expect(result).toContain("gateway");
    expect(result).toContain("Completed 3 tool calls");
  });

  it("falls back to standalone walk-backward when no prior tool calls exist (pure-conversational case)", () => {
    const logger = mockLogger();
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hi", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello! How can I help?" }],
          timestamp: 2,
        },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
      ],
      logger,
      userMessageIndex: 0,
    });
    expect(result).toBe("Hello! How can I help?");
    // Logger should record recoveryPass: "standalone" — NOT "tool-call-synthesis"
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryPass: "standalone" }),
      expect.any(String),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ recoveryPass: "tool-call-synthesis" }),
      expect.any(String),
    );
  });

  it("emits structured INFO with full canonical field shape on synthesis", () => {
    const logger = mockLogger();
    recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Do work", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "agents_manage", arguments: { action: "create", agent_id: "x" } },
            { type: "toolCall", id: "tc2", name: "agents_manage", arguments: { action: "create", agent_id: "y" } },
            { type: "toolCall", id: "tc3", name: "agents_manage", arguments: { action: "create", agent_id: "z" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], timestamp: 3 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "OK" }], timestamp: 4 },
        { role: "toolResult", toolCallId: "tc3", content: [{ type: "text", text: "OK" }], timestamp: 5 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 6 },
      ],
      logger,
      userMessageIndex: 0,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        submodule: "executor.empty-turn-recovery",
        recoveryPass: "tool-call-synthesis",
        toolCallCount: 3,
        toolNames: ["agents_manage"],
        synthesisLength: expect.any(Number),
        hint: expect.stringContaining("synthesized completion summary"),
      }),
      "Empty-turn recovery: synthesized from tool-call history",
    );
    // synthesisLength must be > 0
    const call = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      c => (c[0] as Record<string, unknown>)?.recoveryPass === "tool-call-synthesis",
    );
    expect(call).toBeDefined();
    expect((call![0] as { synthesisLength: number }).synthesisLength).toBeGreaterThan(0);
  });

  it("summarizeToolCall covers known tools, unknown tools, and malformed input (5+ cases via single-tool batches)", () => {
    // Each sub-case runs synthesis on a single-tool batch and asserts the bullet line.
    const runSingle = (block: unknown): string => recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "x", timestamp: 1 },
        { role: "assistant", content: [block], stopReason: "toolUse", timestamp: 2 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });

    // Case A: agents_manage.create with agent_id → full form
    expect(runSingle({ type: "toolCall", id: "tc", name: "agents_manage", arguments: { action: "create", agent_id: "alpha" } }))
      .toContain('agents_manage.create({agent_id: "alpha"})');

    // Case B: write with path → write({path: "..."})
    expect(runSingle({ type: "toolCall", id: "tc", name: "write", arguments: { path: "/x.md" } }))
      .toContain('write({path: "/x.md"})');

    // Case C: gateway with action+section → gateway({action: "...", section: "..."})
    expect(runSingle({ type: "toolCall", id: "tc", name: "gateway", arguments: { action: "patch", section: "agents" } }))
      .toContain('gateway({action: "patch", section: "agents"})');

    // Case C2: gateway with action+section+key → includes key for disambiguation
    expect(runSingle({ type: "toolCall", id: "tc", name: "gateway", arguments: { action: "patch", section: "agents", key: "default.model" } }))
      .toContain('gateway({action: "patch", section: "agents", key: "default.model"})');

    // Case D: edit with path → edit({path: "..."})
    expect(runSingle({ type: "toolCall", id: "tc", name: "edit", arguments: { path: "/y.md" } }))
      .toContain('edit({path: "/y.md"})');

    // Case E: unknown tool → bare name fallback
    const unknownOutput = runSingle({ type: "toolCall", id: "tc", name: "totally_unknown_tool", arguments: { whatever: 1 } });
    expect(unknownOutput).toContain("totally_unknown_tool");
    expect(unknownOutput).not.toContain("totally_unknown_tool({");

    // Case F: malformed (no name field) → unknown_tool fallback, no throw.
    // Note: non-string `name` blocks ARE summarized as "unknown_tool" but are
    // NOT added to toolNamesSet — so a hypothetical INFO-log assertion for
    // this batch would expect toolNames: [].
    expect(() => runSingle({ type: "toolCall", id: "tc", arguments: { x: 1 } })).not.toThrow();
    expect(runSingle({ type: "toolCall", id: "tc", arguments: { x: 1 } }))
      .toContain("unknown_tool");

    // Case G: tool_use shape (Anthropic native) with `input` → same output as `arguments`
    expect(runSingle({ type: "tool_use", id: "toolu_1", name: "write", input: { path: "/native.md" } }))
      .toContain('write({path: "/native.md"})');
  });

  it("disambiguates parallel gateway.patch calls with different keys in the same batch", () => {
    // Production repro from 2026-04-30 OpenRouter onboarding test: model fired
    // gateway.patch agents.default.model + gateway.patch agents.default.provider
    // in the same turn. Without the key field, both bullets render identically
    // as `gateway({action: "patch", section: "agents"})`; including the key
    // field disambiguates them.
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Switch to OpenRouter Qwen3 Coder", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "gateway", arguments: { action: "patch", section: "agents", key: "default.model", value: "qwen/qwen3-coder" } },
            { type: "toolCall", id: "tc2", name: "gateway", arguments: { action: "patch", section: "agents", key: "default.provider", value: "openrouter" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], timestamp: 3 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "OK" }], timestamp: 4 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 5 },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toContain('gateway({action: "patch", section: "agents", key: "default.model"})');
    expect(result).toContain('gateway({action: "patch", section: "agents", key: "default.provider"})');
    expect(result).toContain("Completed 2 tool calls");
  });

  it("source no longer contains the pre-tool-commentary recovery pass marker (regression)", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const sourcePath = url.fileURLToPath(new URL("./executor-response-filter.ts", import.meta.url));
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).not.toContain("pre-tool-commentary");
  });

  it("source no longer contains generateCompletenessNudge symbol (regression)", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const sourcePath = url.fileURLToPath(new URL("./executor-response-filter.ts", import.meta.url));
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).not.toContain("generateCompletenessNudge");
    // The formatChecklistForInjection import was only used by
    // generateCompletenessNudge; with the function deleted, the import is
    // also gone (no remaining consumer in this module).
    expect(source).not.toContain("formatChecklistForInjection");
  });
});

describe("recoverEmptyFinalResponse — silent-token pass-through (cron heartbeat regression)", () => {
  it("cron heartbeat case: HEARTBEAT_OK after observation tools (web_search + get_stock_price) passes through unchanged", () => {
    // Production trace from May 2026: iran-war-monitor Telegram cron agent
    // emitted HEARTBEAT_OK after observation-only tools. Previously, recovery
    // synthesized a fake "[comis: tool-call summary recovered ...]" message
    // and delivered it hourly via Telegram. Now the silent token
    // passes through to the channel-layer filter for suppression.
    const result = recoverEmptyFinalResponse({
      extractedResponse: "HEARTBEAT_OK",
      textEmitted: true,
      messages: [
        { role: "user", content: "heartbeat: check iran war state", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "web_search", arguments: { query: "iran war news" } },
            { type: "toolCall", id: "tc2", name: "mcp__yfinance-ts--get_stock_price", arguments: { symbol: "USO" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "no relevant news" }], timestamp: 3 },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "USO 78.50" }], timestamp: 4 },
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], stopReason: "stop", timestamp: 5 },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toBe("HEARTBEAT_OK");
    expect(result).not.toContain("tool-call summary recovered");
    expect(result).not.toContain("Completed");
  });
});

// ---------------------------------------------------------------------------
// surfaceDiscardedPreToolUrl — URL/short-code safety-net
// ---------------------------------------------------------------------------

describe("surfaceDiscardedPreToolUrl", () => {
  it("Case A — pre-tool text with OAuth URL absent from final response is prepended to result", () => {
    const messages = [
      { role: "user", content: "Please authorize." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visit https://oauth.example.com/auth?code=XYZ to authorize" },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Tool completed." }],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Tool completed.", messages, 0, mockLogger());
    expect(result).toMatch(/^https:\/\/oauth\.example\.com\/auth\?code=XYZ/);
    expect(result).toContain("Tool completed.");
  });

  it("Case B — pre-tool framing prose \"I'm going to...\" without URL is not surfaced (negative control)", () => {
    // Stock-scanner scenario: pre-tool prose that begins with "I'm going to..."
    // must not be surfaced as a user-visible auth hint.
    const messages = [
      { role: "user", content: "Create a stock scanner skill", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'm going to build it as a private skill, scaffold it, validate it, and leave it ready to use." },
          { type: "tool_use", id: "tc1", name: "read", input: {} },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Step 4/4: sanity-testing the trigger with a real prompt that ought to activate the skill." },
          { type: "tool_use", id: "tc5", name: "sessions_spawn", input: {} },
        ],
        stopReason: "toolUse",
        timestamp: 10,
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toBe("Done.");
    expect(result).not.toContain("I'm going to build");
    expect(result).not.toContain("Step 4/4");
  });

  it("Case C — pre-tool framing prose \"Let me handle that for you.\" is not surfaced (negative control)", () => {
    // Negative control: pre-tool prose that begins with "Let me ..." must not
    // be surfaced as a user-visible auth hint.
    const messages = [
      { role: "user", content: "Do something", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me handle that for you." },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toBe("Done.");
    expect(result).not.toContain("Let me handle that for you.");
  });

  it("Case D — URL already in final response is not re-prepended", () => {
    const messages = [
      { role: "user", content: "Please authorize." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visit https://oauth.example.com/auth to continue." },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
    ];
    const finalResponse = "Please visit https://oauth.example.com/auth to continue.";
    const result = surfaceDiscardedPreToolUrl(finalResponse, messages, 0, mockLogger());
    expect(result).toBe(finalResponse);
  });

  it("Case E — NO_REPLY sentinel response is not modified by URL safety-net", () => {
    const messages = [
      { role: "user", content: "Please authorize." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visit https://oauth.example.com/auth?code=XYZ to authorize" },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("NO_REPLY", messages, 0, mockLogger());
    expect(result).toBe("NO_REPLY");
  });

  it("Case E2 — HEARTBEAT_OK sentinel response is not modified by URL safety-net", () => {
    const messages = [
      { role: "user", content: "heartbeat" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visit https://oauth.example.com/auth?code=XYZ to authorize" },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("HEARTBEAT_OK", messages, 0, mockLogger());
    expect(result).toBe("HEARTBEAT_OK");
  });

  it("Case F — pre-tool framing prose containing URL is not surfaced (FRAMING_PROSE_RE wins over URL predicate)", () => {
    // FRAMING_PROSE_RE must fire BEFORE the URL predicate
    const messages = [
      { role: "user", content: "Fetch the docs." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'm going to fetch https://example.com/docs for you" },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toBe("Done.");
  });

  it("logs info when a pre-tool URL is surfaced", () => {
    const logger = mockLogger();
    const messages = [
      { role: "user", content: "Please authorize." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visit https://oauth.example.com/auth?code=XYZ to authorize" },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Tool completed." }],
      },
    ];
    surfaceDiscardedPreToolUrl("Tool completed.", messages, 0, logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        surfacedUrl: "https://oauth.example.com/auth?code=XYZ",
        submodule: "executor-response-filter.surfaceDiscardedPreToolUrl",
      }),
      expect.stringContaining("Surfaced discarded pre-tool URL"),
    );
  });

  // Regression tests — SHORT_CODE_RE must NOT match plain English words.
  it("Case G — benign non-framing pre-tool narration 'Checking the weather forecast now.' is NOT surfaced", () => {
    // Pre-tool text that doesn't start with FRAMING_PROSE_RE but contains only
    // dictionary words must not get the first word prepended.
    const messages = [
      { role: "user", content: "What's the weather like?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the weather forecast now." },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("It will be sunny.", messages, 0, mockLogger());
    expect(result).toBe("It will be sunny.");
    expect(result).not.toMatch(/^weather/);
    expect(result).not.toMatch(/^checking/i);
  });

  it("Case H — benign non-framing pre-tool narration 'Running the analysis pipeline.' is NOT surfaced", () => {
    // "analysis" must not be prepended as a code candidate.
    const messages = [
      { role: "user", content: "Run the analysis." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running the analysis pipeline." },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toBe("Done.");
    expect(result).not.toMatch(/^analysis/);
    expect(result).not.toMatch(/^running/i);
  });

  it("Case I — real one-time numeric code '493021' in pre-tool text IS surfaced when absent from response", () => {
    // Positive control: a 6-digit numeric code (digit-containing) must still be surfaced.
    const messages = [
      { role: "user", content: "What is my code?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Your verification code is 493021" },
          { type: "tool_use", id: "tc1", name: "sessions_spawn", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toMatch(/^493021/);
    expect(result).toContain("Done.");
  });

  it("Case J — alphanumeric device code 'A1B2C3' in pre-tool text IS surfaced when absent from response", () => {
    // Positive control: a mixed-case alphanumeric code (contains digit) must still be surfaced.
    const messages = [
      { role: "user", content: "What is the pairing code?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Use pairing code A1B2C3 to connect." },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
      },
    ];
    const result = surfaceDiscardedPreToolUrl("Done.", messages, 0, mockLogger());
    expect(result).toMatch(/^A1B2C3/);
    expect(result).toContain("Done.");
  });

  it("substring-dedupe suppresses re-surfacing a prefix URL already covered by a longer URL in the response", () => {
    // Pins the substring-dedupe semantics documented on
    // surfaceDiscardedPreToolUrl. A pre-tool block containing a shorter URL
    // (https://x.ai/device) must NOT be surfaced when the response already
    // carries a longer URL with the same prefix (https://x.ai/device?code=…).
    // This is the conservative direction — duplicate surfacing of a URL that
    // shares a prefix with a credential-bearing URL widens the exposure
    // surface. The substring check is load-bearing safety, not an oversight.
    const messages = [
      { role: "user", content: "Authorize" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Open https://x.ai/device to start." },
          { type: "tool_use", id: "tc1", name: "exec", input: {} },
        ],
      },
    ];
    // Final response already contains the longer, more-specific URL.
    const finalResponse = "Visit https://x.ai/device?code=ABC123 to complete.";
    const result = surfaceDiscardedPreToolUrl(finalResponse, messages, 0, mockLogger());
    // The shorter URL is a substring of the longer one — must NOT be re-surfaced.
    expect(result).toBe(finalResponse);
  });
});

// ---------------------------------------------------------------------------
// recoverEmptyFinalResponse — synthesis branch URL/code preservation
// ---------------------------------------------------------------------------

describe("recoverEmptyFinalResponse — synthesis branch URL/code preservation", () => {
  it("recoverEmptyFinalResponse preserves URL from pre-tool assistant text in synthesis branch", () => {
    // The synthesis branch must not discard pre-tool URLs: the URL is
    // preserved in the synthesized recovery string (the actionable-artifact
    // extraction appends it as a "User actions:" suffix).
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Authorize the MCP server", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Authorize at https://x.ai/device?code=ABCD-1234" },
            { type: "tool_use", id: "tc1", name: "mcp_login", input: { server_name: "higgsfield" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 3,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    // Synthesis branch fired (tool_use present) — URL must appear in result
    expect(result).toContain("https://x.ai/device?code=ABCD-1234");
  });

  it("recoverEmptyFinalResponse does NOT include framing prose URL in synthesis branch", () => {
    // Negative control: the framing-prose guard must fire before URL
    // extraction — FRAMING_PROSE_RE blocks the leak.
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Fetch some data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'm going to fetch https://api.example.com/data" },
            { type: "tool_use", id: "tc1", name: "exec", input: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 3,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    // Framing prose guard fires: URL must NOT appear in synthesis output
    expect(result).not.toContain("https://api.example.com/data");
  });
});
