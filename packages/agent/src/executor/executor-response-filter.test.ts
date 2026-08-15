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
import * as responseFilter from "./executor-response-filter.js";
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
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
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
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
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
        { role: "toolResult", toolCallId: "tc1", isError: false, content: [{ type: "text", text: "OK" }], timestamp: 3 },
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
        { role: "toolResult", toolCallId: "tc1", isError: false, content: [{ type: "text", text: "OK" }], timestamp: 3 },
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

type DelegationEvidenceGuard = (params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    backgrounded?: boolean;
    subagentWaitCompletedCount?: number;
  }>;
  runtimeCompletion?: boolean;
  honestResponse: string;
  verifiedSpawnResponse?: string;
}) => {
  response: string;
  corrected: boolean;
  reason?:
    | "missing_current_turn_spawn"
    | "successful_spawn_response_internal_identifier"
    | "successful_spawn_response_ungrounded";
};

function delegationEvidenceGuard(): DelegationEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceCurrentTurnDelegationEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as DelegationEvidenceGuard;
}

describe("current-turn delegation evidence guard", () => {
  const request =
    "can u get someone to check if this lasts 7 hrs and make them ask someone else too";
  const falseClaim =
    "Two independent checks reached the same conclusion: qualified yes.";
  const honestResponse =
    "I did not successfully start the requested sub-agent in this turn.";

  it("replaces the live historical-result false claim when no spawn succeeded", () => {
    const guarded = delegationEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [
        { toolName: "sessions_history", success: false },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_current_turn_spawn",
    });
  });

  it("replaces a future delegation claim for an explicit plural-agent request", () => {
    const guarded = delegationEvidenceGuard()({
      request: "get a few separate agents on the comparison",
      response:
        "Yes — I can split the comparison across a few separate agents. Send me the options.",
      toolExecResults: [
        { toolName: "agents_manage", success: true },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_current_turn_spawn",
    });
  });

  it("preserves a delegation claim backed by a successful current-turn spawn", () => {
    const guarded = delegationEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: falseClaim,
      corrected: false,
    });
  });

  it("replaces an unsolicited partial answer while its spawned result is pending", () => {
    const verifiedSpawnResponse =
      "I started a sub-agent for this request. Its result is still pending.";
    const guarded = delegationEvidenceGuard()({
      request:
        "Scan a liquid US-equity universe and rank five short-term candidates using current data.",
      response: [
        "The supporting research workflow is complete.",
        "The five-stock ranking itself is not yet evidenced, so I will not invent candidates.",
      ].join("\n"),
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
        { toolName: "web_search", success: true },
      ],
      honestResponse,
      verifiedSpawnResponse,
    });

    expect(guarded).toEqual({
      response: verifiedSpawnResponse,
      corrected: true,
      reason: "successful_spawn_response_ungrounded",
    });
  });

  it("replaces a launch acknowledgement that exposes the internal spawn identifier", () => {
    const verifiedSpawnResponse =
      "I started a sub-agent for this request. Its result is still pending.";
    const guarded = delegationEvidenceGuard()({
      request: "ask a background helper to review the full fleet",
      response: [
        "I started the full-fleet review.",
        "Run ID: 8dc57d7f-0071-45cb-bdaf-23d47ecead39",
        "I will share the result when it completes.",
      ].join("\n\n"),
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
      ],
      honestResponse,
      verifiedSpawnResponse,
    });

    expect(guarded).toEqual({
      response: verifiedSpawnResponse,
      corrected: true,
      reason: "successful_spawn_response_internal_identifier",
    });
  });

  // A spawn receipt proves only that delegation started. It cannot establish
  // whether an undisclosed model answer came from independent knowledge or a
  // fabricated delegated result, so retaining that answer would weaken the
  // receipt boundary.
  it("replaces an undisclosed final answer after a successful spawn", () => {
    const verifiedSpawnResponse =
      "I successfully started the requested sub-agent. Its result is still pending.";
    const response =
      "A heat pump moves heat instead of creating heat, and geothermal systems use the ground.";
    const guarded = delegationEvidenceGuard()({
      request:
        "start one background helper with sessions_spawn and have it start one nested child",
      response,
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
      ],
      honestResponse,
      verifiedSpawnResponse,
    });

    expect(guarded).toEqual({
      response: verifiedSpawnResponse,
      corrected: true,
      reason: "successful_spawn_response_ungrounded",
    });
  });

  it("does not infer that another part of an undisclosed answer is independently grounded", () => {
    const verifiedSpawnResponse =
      "I successfully started the requested sub-agent. Its result is still pending.";
    const guarded = delegationEvidenceGuard()({
      request:
        "delegate the research to a background helper, and also tell me today's date",
      response: "Today is 11 August 2026.",
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
      ],
      honestResponse,
      verifiedSpawnResponse,
    });

    expect(guarded).toEqual({
      response: verifiedSpawnResponse,
      corrected: true,
      reason: "successful_spawn_response_ungrounded",
    });
  });

  // A finished-work claim about the delegated task has no receipt behind it —
  // the spawn is a handoff, not a result — so that reply is still replaced.
  it("replaces an undisclosed reply that claims the delegated work is finished", () => {
    const verifiedSpawnResponse =
      "I successfully started the requested sub-agent. Its result is still pending.";
    const guarded = delegationEvidenceGuard()({
      request:
        "start one background helper with sessions_spawn and have it start one nested child",
      response:
        "Done — the comparison is complete and both options meet the 7-hour requirement.",
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
      ],
      honestResponse,
      verifiedSpawnResponse,
    });

    expect(guarded).toEqual({
      response: verifiedSpawnResponse,
      corrected: true,
      reason: "successful_spawn_response_ungrounded",
    });
  });

  // The spawn receipt already exists here, so the only question is whether the
  // reply DISCLOSES the delegation. A truthful answer that says so with an
  // ordinary synonym must survive instead of being discarded for a vocabulary
  // miss.
  it("keeps a truthful reply that discloses the spawn with a synonym", () => {
    for (const response of [
      "Done — the helper is now researching the topic and will report back with results.",
      "That is running in the background now; I will send the findings when they land.",
    ]) {
      const guarded = delegationEvidenceGuard()({
        request:
          "delegate this to a background helper and summarise the plan",
        response,
        toolExecResults: [
          { toolName: "sessions_spawn", success: true },
        ],
        honestResponse,
        verifiedSpawnResponse:
          "I successfully started the requested sub-agent. Its result is still pending.",
      });

      expect(guarded).toEqual({ response, corrected: false });
    }
  });

  it("does not count a failed or background-placeholder spawn as proof", () => {
    for (const toolExecResults of [
      [{ toolName: "sessions_spawn", success: false }],
      [{ toolName: "sessions_spawn", success: true, backgrounded: true }],
    ]) {
      const guarded = delegationEvidenceGuard()({
        request,
        response: falseClaim,
        toolExecResults,
        honestResponse,
      });

      expect(guarded.corrected).toBe(true);
      expect(guarded.response).toBe(honestResponse);
    }
  });

  it("preserves an explicit honest refusal when no spawn succeeded", () => {
    const refusal =
      "I couldn't start another agent in this turn, so this is only historical context.";
    const guarded = delegationEvidenceGuard()({
      request,
      response: refusal,
      toolExecResults: [],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: refusal,
      corrected: false,
    });
  });

  it("preserves an actionable rejection after sessions_spawn validation fails", () => {
    const rejection =
      "Spawn rejected. The minimum supported max_steps is 30; requested value was 1. "
      + "No child launched because no runId was returned.";
    const guarded = delegationEvidenceGuard()({
      request: "Call sessions_spawn exactly once with max_steps set to 1.",
      response: rejection,
      toolExecResults: [
        { toolName: "sessions_spawn", success: false },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: rejection,
      corrected: false,
    });
  });

  it("preserves a configured-agent creation result from a runtime completion envelope", () => {
    const created =
      "The Live Test Helper agent was created successfully and is ready.";
    const guarded = delegationEvidenceGuard()({
      request:
        "[Background Task: agents_manage]\nAgent created.\nTool guide: use another agent for delegation.",
      response: created,
      toolExecResults: [],
      runtimeCompletion: true,
      honestResponse,
    });

    expect(guarded).toEqual({
      response: created,
      corrected: false,
    });
  });

  it("still guards the same delegation prose when it is an ordinary request", () => {
    const guarded = delegationEvidenceGuard()({
      request: "use another agent for an independent check",
      response: falseClaim,
      toolExecResults: [],
      runtimeCompletion: false,
      honestResponse,
    });

    expect(guarded.corrected).toBe(true);
    expect(guarded.response).toBe(honestResponse);
  });

  it("leaves ordinary replies unchanged even when session history was queried", () => {
    const ordinaryRequest = "what did the earlier reviewer say";
    const ordinaryResponse = "The earlier review said the battery lasted eight hours.";
    const guarded = delegationEvidenceGuard()({
      request: ordinaryRequest,
      response: ordinaryResponse,
      toolExecResults: [
        { toolName: "sessions_history", success: true },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: ordinaryResponse,
      corrected: false,
    });
  });

  it("does not treat a negative delegation instruction as a delegation request", () => {
    const ordinaryResponse =
      "The test suite passed and the slow test took twenty seconds.";
    const guarded = delegationEvidenceGuard()({
      request:
        "dont delegate this run npm test yourself in queue-fixture and find the slow one",
      response: ordinaryResponse,
      toolExecResults: [{ toolName: "exec", success: true }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: ordinaryResponse,
      corrected: false,
    });
  });

  it("preserves a leaf result when delegation is only test context and explicitly forbidden", () => {
    const directResult = "1 NESTED_LEAF";
    const guarded = delegationEvidenceGuard()({
      request:
        "You are the leaf in a nested delegation test. Do NOT spawn any further sub-agents and do not delegate. Read the file and return its version.",
      response: directResult,
      toolExecResults: [{ toolName: "read", success: true }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: directResult,
      corrected: false,
    });
  });

  it("preserves a grounded spawn disclosure followed by punctuation", () => {
    const groundedResponse =
      "The leaf returned no usable value. Exactly one child was spawned; no retry was made.";
    const guarded = delegationEvidenceGuard()({
      request: "use sessions_spawn to spawn exactly one child for this nested check",
      response: groundedResponse,
      toolExecResults: [{ toolName: "sessions_spawn", success: true }],
      honestResponse,
      verifiedSpawnResponse:
        "I successfully started the requested sub-agent. Its result is still pending.",
    });

    expect(guarded).toEqual({
      response: groundedResponse,
      corrected: false,
    });
  });

  it("preserves a final child result backed by a completed subagent wait", () => {
    const completedResult = "version: 1\nNESTED_LEAF\nNESTED_COORD";
    const guarded = delegationEvidenceGuard()({
      request: "use sessions_spawn for one nested child and return its result",
      response: completedResult,
      toolExecResults: [
        { toolName: "sessions_spawn", success: true },
        {
          toolName: "subagents",
          action: "wait",
          success: true,
          subagentWaitCompletedCount: 1,
        },
      ],
      honestResponse,
      verifiedSpawnResponse:
        "I successfully started the requested sub-agent. Its result is still pending.",
    });

    expect(guarded).toEqual({
      response: completedResult,
      corrected: false,
    });
  });

  it("preserves a successful direct result when a coordinated instruction forbids further delegation", () => {
    const directResult =
      "CATALOG CARD framework: price_usd=949; source_id=fixture-catalog/framework-13";
    const guarded = delegationEvidenceGuard()({
      request:
        "Call the local fixture exactly once. Return the exact result only. Do not use web or delegate further.",
      response: directResult,
      toolExecResults: [
        { toolName: "mcp__fixture--laptop_card", success: true },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: directResult,
      corrected: false,
    });
  });
});

type TrustedRuntimeCompletionDetector = (message: {
  channelType: string;
  senderId: string;
}) => boolean;

function trustedRuntimeCompletionDetector(): TrustedRuntimeCompletionDetector {
  const candidate = (responseFilter as Record<string, unknown>)
    .isTrustedRuntimeCompletionEnvelope;
  expect(candidate).toBeTypeOf("function");
  return candidate as TrustedRuntimeCompletionDetector;
}

describe("trusted runtime completion envelope", () => {
  it("requires an authenticated internal completion channel and relay identity", () => {
    const detect = trustedRuntimeCompletionDetector();

    expect(detect({
      channelType: "background_task",
      senderId: "background-task-runner",
    })).toBe(true);
    expect(detect({
      channelType: "telegram",
      senderId: "background-task-runner",
    })).toBe(false);
    expect(detect({
      channelType: "background_task",
      senderId: "user_a",
    })).toBe(false);
    expect(detect({
      channelType: "cross-session",
      senderId: "cross-session-relay",
    })).toBe(true);
    expect(detect({
      channelType: "cross-session",
      senderId: "user_a",
    })).toBe(false);
  });
});

type PersistentActionEvidenceGuard = (params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "missing_current_turn_action_evidence";
};

function persistentActionEvidenceGuard(): PersistentActionEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforcePersistentActionEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as PersistentActionEvidenceGuard;
}

describe("persistent action evidence guard", () => {
  const request =
    "Keep checking the local operation one attempt at a time until it passes. Do not stop early.";
  const falseClaim =
    "The operation passed after 3 attempts.\n\nEvidence:\n```\nSTATUS: PASSED\n```";
  const honestResponse =
    "I did not perform or verify the requested repeated action in this turn.";

  it("replaces a fabricated terminal result when the turn executed no tool", () => {
    expect(persistentActionEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_current_turn_action_evidence",
    });
  });

  it("preserves the terminal result when a current-turn tool succeeded", () => {
    expect(persistentActionEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [{ toolName: "exec", success: true }],
      honestResponse,
    })).toEqual({
      response: falseClaim,
      corrected: false,
    });
  });

  it("does not count a background placeholder as terminal action evidence", () => {
    expect(persistentActionEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [{
        toolName: "sessions_spawn",
        success: true,
        backgrounded: true,
      }],
      honestResponse,
    }).corrected).toBe(true);
  });

  it("accepts a runtime completion receipt as current action evidence", () => {
    expect(persistentActionEvidenceGuard()({
      request,
      response: falseClaim,
      toolExecResults: [],
      currentActionEvidence: true,
      honestResponse,
    })).toEqual({
      response: falseClaim,
      corrected: false,
    });
  });

  it("preserves an honest limitation and an ordinary non-persistent answer", () => {
    expect(persistentActionEvidenceGuard()({
      request,
      response: "I could not run the checks in this turn.",
      toolExecResults: [],
      honestResponse,
    }).corrected).toBe(false);
    expect(persistentActionEvidenceGuard()({
      request: "Explain what a passing status means.",
      response: falseClaim,
      toolExecResults: [],
      honestResponse,
    }).corrected).toBe(false);
  });

  it("preserves a step-limit disclosure containing negated success words", () => {
    const announcementRequest = [
      "[System Message]",
      "A background task has halted (max steps reached).",
      "",
      "Task: Keep checking the local operation until it passes.",
      "Status: Failed — Halted (max steps reached)",
      "Abort: step_limit | Hint: Increase max_steps or simplify the task",
    ].join("\n");
    const truthfulFailure = [
      "The operation stopped at the max_steps limit before it passed, so it did not complete.",
      "Increase max_steps or simplify the task before retrying.",
    ].join(" ");

    expect(persistentActionEvidenceGuard()({
      request: announcementRequest,
      response: truthfulFailure,
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: truthfulFailure,
      corrected: false,
    });
  });

  it("still rejects success reported after earlier failed attempts", () => {
    const mixedOutcomeClaim =
      "The first two attempts failed; the next attempt passed successfully.";

    expect(persistentActionEvidenceGuard()({
      request,
      response: mixedOutcomeClaim,
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_current_turn_action_evidence",
    });
  });
});

type OutboundAudioEvidenceGuard = (params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  runtimeAudioDelivery?: boolean;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_audio_evidence";
};

function outboundAudioEvidenceGuard(): OutboundAudioEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceOutboundAudioEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as OutboundAudioEvidenceGuard;
}

describe("outbound audio evidence guard", () => {
  const honestResponse =
    "I did not deliver the requested audio in this turn because there is no successful synthesis receipt.";

  it("replaces a spoken-summary completion claim when the turn used no tool", () => {
    expect(outboundAudioEvidenceGuard()({
      request: "say the summary out loud",
      response: "Done — I said: “The total of the two items is £5.75.”",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_audio_evidence",
    });
  });

  it("preserves spoken completion backed by successful synthesis", () => {
    const response = "Done — I said the summary out loud.";

    expect(outboundAudioEvidenceGuard()({
      request: "please read the total aloud",
      response,
      toolExecResults: [{ toolName: "tts_synthesize", success: true }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("does not count a failed synthesis or background placeholder as delivery proof", () => {
    for (const toolExecResults of [
      [{ toolName: "tts_synthesize", success: false }],
      [{ toolName: "sessions_spawn", success: true, backgrounded: true }],
    ]) {
      expect(outboundAudioEvidenceGuard()({
        request: "could you send that as a voice message?",
        response: "The voice message is sent.",
        toolExecResults,
        honestResponse,
      }).corrected).toBe(true);
    }
  });

  it("accepts the runtime's own voice route as delivery proof for this turn", () => {
    // The configured voice route speaks the reply after execution returns, so
    // a truthful spoken answer can never carry a synthesis tool receipt.
    const response = "Done — here is the summary, read out loud.";

    expect(outboundAudioEvidenceGuard()({
      request: "can you please reply with a voice message?",
      response,
      toolExecResults: [],
      runtimeAudioDelivery: true,
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("still replaces an audio claim when no voice route speaks this turn", () => {
    expect(outboundAudioEvidenceGuard()({
      request: "can you please reply with a voice message?",
      response: "Done — the voice message is sent.",
      toolExecResults: [],
      runtimeAudioDelivery: false,
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_audio_evidence",
    });
  });

  it("accepts a trusted background completion receipt for delivered audio", () => {
    const response = "The requested voice reply was delivered.";

    expect(outboundAudioEvidenceGuard()({
      request: "say the summary out loud",
      response,
      toolExecResults: [],
      currentActionEvidence: true,
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("leaves honest limitations and unrelated explanatory questions unchanged", () => {
    const limitation = "I couldn't synthesize or send the audio in this turn.";
    expect(outboundAudioEvidenceGuard()({
      request: "say the summary out loud",
      response: limitation,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: limitation, corrected: false });

    const explanation = "It means to speak audibly rather than silently.";
    expect(outboundAudioEvidenceGuard()({
      request: "what does 'say it out loud' mean?",
      response: explanation,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: explanation, corrected: false });
  });

  // An admitted limitation is already honest about the missing receipt, so the
  // substitute it describes must survive: the delivered prose matches a claim
  // pattern ("I've read it out") without claiming audio was sent.
  it("keeps an admitted limitation that also describes the text substitute", () => {
    const response =
      "I couldn't send a voice note in this turn, so I have read it out as text below: "
      + "the total of the two items is £5.75.";

    expect(outboundAudioEvidenceGuard()({
      request: "please send that as a voice message",
      response,
      toolExecResults: [{ toolName: "tts_synthesize", success: false }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  // The substitute phrase must still be recognized where a sentence actually
  // ends it: before a full stop, a comma, or a closing parenthesis. Matching a
  // space-delimited phrase list against whitespace-only normalization dropped
  // every punctuated occurrence and replaced an honest, self-limiting reply.
  it("keeps an admitted limitation whose text substitute ends a clause", () => {
    for (const response of [
      "I couldn't send a voice note, so I have read it out in text.",
      "I couldn't synthesize the voice note, so I have read it out as the text version.",
      "I couldn't send the voice note, so I have read it out as text, below.",
      "I couldn't send it as a voice note (I have read it out in plain text).",
    ]) {
      expect(outboundAudioEvidenceGuard()({
        request: "please send that as a voice message",
        response,
        toolExecResults: [{ toolName: "tts_synthesize", success: false }],
        honestResponse,
      }), response).toEqual({ response, corrected: false });
    }
  });

  // "I sent" trips the success-claim trigger without naming the medium, which
  // an honest reply carries while refusing that medium. Requiring a named text
  // substitute on top of the admitted limitation discarded the whole reply,
  // including the work the turn did deliver.
  it("keeps an admitted limitation that delivers other requested work", () => {
    const response =
      "I can't record a voice note, so I sent the summary here in the chat: "
      + "the two items total £5.75.";

    expect(outboundAudioEvidenceGuard()({
      request: "please send that as a voice message",
      response,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("rejects a limitation followed by an unsupported audio success claim", () => {
    const response =
      "I couldn't send a voice note initially, but I have now sent the audio message.";

    expect(outboundAudioEvidenceGuard()({
      request: "please send that as a voice message",
      response,
      toolExecResults: [{ toolName: "tts_synthesize", success: false }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_audio_evidence",
    });
  });
});

type OutboundImageEvidenceGuard = (params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_image_evidence";
};

function outboundImageEvidenceGuard(): OutboundImageEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceOutboundImageEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as OutboundImageEvidenceGuard;
}

describe("outbound image evidence guard", () => {
  const honestResponse =
    "I could not verify creation or delivery of the requested image in this turn.";

  it("replaces a generated-image completion claim when the turn used no tool", () => {
    expect(outboundImageEvidenceGuard()({
      request: "make a simple blue calendar image",
      response: "Done — I created a simple, predominantly blue calendar image.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_image_evidence",
    });
  });

  it("preserves image completion backed by successful generation", () => {
    const response = "Done — I created and delivered the calendar image.";

    expect(outboundImageEvidenceGuard()({
      request: "please generate a blue calendar picture",
      response,
      toolExecResults: [{ toolName: "image_generate", success: true }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("does not count failed generation or a background placeholder as image proof", () => {
    for (const toolExecResults of [
      [{ toolName: "image_generate", success: false }],
      [{ toolName: "sessions_spawn", success: true, backgrounded: true }],
    ]) {
      expect(outboundImageEvidenceGuard()({
        request: "could you create a small calendar image?",
        response: "The requested image is ready.",
        toolExecResults,
        honestResponse,
      }).corrected).toBe(true);
    }
  });

  it("accepts a successful outbound attachment receipt for an image built without the generator", () => {
    // An image rendered by exec or an integration reaches the user through the
    // message tool's attach action; that delivery receipt is the proof.
    const response = "Done — I created the chart image and sent it to the group.";

    expect(outboundImageEvidenceGuard()({
      request: "please render a picture of the weekly totals and post it to the group",
      response,
      toolExecResults: [{ toolName: "message", action: "attach", success: true }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("does not accept a failed or non-attaching message call as image delivery proof", () => {
    for (const toolExecResults of [
      [{ toolName: "message", action: "attach", success: false }],
      [{ toolName: "message", action: "send", success: true }],
    ]) {
      expect(outboundImageEvidenceGuard()({
        request: "please render a picture of the weekly totals and post it to the group",
        response: "Done — I created the chart image and sent it to the group.",
        toolExecResults,
        honestResponse,
      }).corrected).toBe(true);
    }
  });

  it("accepts a trusted background completion receipt for a delivered image", () => {
    const response = "Done — the requested image was delivered.";

    expect(outboundImageEvidenceGuard()({
      request: "make a simple blue calendar image",
      response,
      toolExecResults: [],
      currentActionEvidence: true,
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("leaves image explanations and honest generation limitations unchanged", () => {
    const limitation = "I couldn't generate or deliver the requested image in this turn.";
    expect(outboundImageEvidenceGuard()({
      request: "make a simple blue calendar image",
      response: limitation,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: limitation, corrected: false });

    const explanation = "Use a blue palette and a seven-column grid.";
    expect(outboundImageEvidenceGuard()({
      request: "how do I make a simple blue calendar image?",
      response: explanation,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: explanation, corrected: false });
  });

  it("keeps an admitted limitation that also describes the written substitute", () => {
    const response =
      "I could not generate the picture in this turn, so I have created a text "
      + "layout description you can hand to a designer instead.";

    expect(outboundImageEvidenceGuard()({
      request: "make a simple blue calendar image",
      response,
      toolExecResults: [{ toolName: "image_generate", success: false }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  // "Ready for launch." trips the shared completion-claim gate while the reply
  // openly refuses the image. Replacing it lost the caption the user asked for
  // in the same turn.
  it("keeps an admitted limitation that delivers other requested work", () => {
    const response =
      "Here's the caption: 'Ready for launch.' I can't generate images.";

    expect(outboundImageEvidenceGuard()({
      request: "please create an image and a caption for our launch post",
      response,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("rejects a limitation followed by an unsupported image success claim", () => {
    const response =
      "I could not generate the picture initially, but I have now created the image.";

    expect(outboundImageEvidenceGuard()({
      request: "make a simple blue calendar image",
      response,
      toolExecResults: [{ toolName: "image_generate", success: false }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_image_evidence",
    });
  });
});

type OutboundDeliveryStatusEvidenceGuard = (params: {
  request: string;
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    backgrounded?: boolean;
  }>;
  currentActionEvidence?: boolean;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "missing_outbound_delivery_status_evidence";
};

function outboundDeliveryStatusEvidenceGuard(): OutboundDeliveryStatusEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceOutboundDeliveryStatusEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as OutboundDeliveryStatusEvidenceGuard;
}

describe("outbound delivery status evidence guard", () => {
  const honestResponse =
    "I could not verify whether the prior outbound item was delivered in this turn.";

  it("rejects an affirmative elliptical delivery answer with no current receipt", () => {
    expect(outboundDeliveryStatusEvidenceGuard()({
      request: "did it send?",
      response: "Yes — the audio was created and delivered to this conversation.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_outbound_delivery_status_evidence",
    });
  });

  it("preserves delivery status backed by current observability evidence", () => {
    const response = "Yes — the image was delivered successfully.";

    expect(outboundDeliveryStatusEvidenceGuard()({
      request: "did it send?",
      response,
      toolExecResults: [{ toolName: "obs_query", success: true }],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("accepts a current self-delivering media receipt or trusted completion", () => {
    const response = "It did — the file was delivered.";
    for (const params of [
      { toolExecResults: [{ toolName: "image_generate", success: true }] },
      { toolExecResults: [], currentActionEvidence: true },
    ]) {
      expect(outboundDeliveryStatusEvidenceGuard()({
        request: "did that go through?",
        response,
        honestResponse,
        ...params,
      })).toEqual({ response, corrected: false });
    }
  });

  it("does not treat failed lookups or background placeholders as status proof", () => {
    for (const toolExecResults of [
      [{ toolName: "obs_query", success: false }],
      [{ toolName: "sessions_spawn", success: true, backgrounded: true }],
    ]) {
      expect(outboundDeliveryStatusEvidenceGuard()({
        request: "was that delivered?",
        response: "Yes, it was delivered.",
        toolExecResults,
        honestResponse,
      }).corrected).toBe(true);
    }
  });

  it("leaves honest negative answers and unrelated questions unchanged", () => {
    const negative = "No — the image was not delivered.";
    expect(outboundDeliveryStatusEvidenceGuard()({
      request: "did it send?",
      response: negative,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: negative, corrected: false });

    const unrelated = "The send button is in the lower-right corner.";
    expect(outboundDeliveryStatusEvidenceGuard()({
      request: "where is the send button?",
      response: unrelated,
      toolExecResults: [],
      honestResponse,
    })).toEqual({ response: unrelated, corrected: false });
  });
});

type RuntimeActionEvidenceDetector = (message: {
  channelType: string;
  senderId: string;
  metadata: {
    runtimeActionEvidence?: { kind: "background_completion" };
  };
}) => boolean;

function runtimeActionEvidenceDetector(): RuntimeActionEvidenceDetector {
  const candidate = (responseFilter as Record<string, unknown>)
    .hasTrustedRuntimeActionEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as RuntimeActionEvidenceDetector;
}

describe("trusted runtime action evidence", () => {
  const receipt = {
    runtimeActionEvidence: { kind: "background_completion" as const },
  };

  it("requires the internal completion relay identity and typed receipt", () => {
    const detect = runtimeActionEvidenceDetector();

    expect(detect({
      channelType: "cross-session",
      senderId: "cross-session-relay",
      metadata: receipt,
    })).toBe(true);
    expect(detect({
      channelType: "telegram",
      senderId: "user_a",
      metadata: receipt,
    })).toBe(false);
    expect(detect({
      channelType: "cross-session",
      senderId: "cross-session-relay",
      metadata: {},
    })).toBe(false);
  });
});

type DestructiveEffectEvidenceGuard = (params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    errorText?: string;
  }>;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "destructive_action_no_effect";
};

function destructiveEffectEvidenceGuard(): DestructiveEffectEvidenceGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceDestructiveEffectEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as DestructiveEffectEvidenceGuard;
}

describe("destructive effect evidence guard", () => {
  const honestResponse =
    "I could not verify that anything was deleted. The command had no observable effect.";

  it("replaces a completion claim after an exec deletion reports no effect", () => {
    const guarded = destructiveEffectEvidenceGuard()({
      response: "Done. Everything inside ~/Downloads was deleted.",
      toolExecResults: [{
        toolName: "exec",
        success: false,
        errorText:
          "No filesystem entries were removed; the deletion command had no observable effect.",
      }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "destructive_action_no_effect",
    });
  });

  it("preserves a completion claim when the exec evidence has no no-effect failure", () => {
    const guarded = destructiveEffectEvidenceGuard()({
      response: "Done. The requested cleanup is complete.",
      toolExecResults: [{
        toolName: "exec",
        success: true,
      }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: "Done. The requested cleanup is complete.",
      corrected: false,
    });
  });

  it("preserves an honest failure disclosure after a no-effect deletion", () => {
    const response =
      "I couldn't delete anything because the target did not exist.";
    const guarded = destructiveEffectEvidenceGuard()({
      response,
      toolExecResults: [{
        toolName: "exec",
        success: false,
        errorText:
          "No filesystem entries were removed; the deletion command had no observable effect.",
      }],
      honestResponse,
    });

    expect(guarded).toEqual({ response, corrected: false });
  });
});

type ProviderModelFailureGroundingGuard = (params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    failureCode?: string;
  }>;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "provider_requires_model";
};

function providerModelFailureGroundingGuard(): ProviderModelFailureGroundingGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceProviderModelFailureGrounding;
  expect(candidate).toBeTypeOf("function");
  return candidate as ProviderModelFailureGroundingGuard;
}

describe("provider-model failure grounding guard", () => {
  const honestResponse =
    "I did not change the agent. The requested value names a provider, not an exact model.";

  it("replaces model prose after an unrecovered provider-as-model rejection", () => {
    const guarded = providerModelFailureGroundingGuard()({
      response:
        "That model is unavailable. I can switch to a different model from the current provider.",
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: false,
        failureCode: "provider_requires_model",
      }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "provider_requires_model",
    });
  });

  it("preserves the response after a later successful agent update", () => {
    const response = "The agent now uses the selected provider and exact model.";
    const guarded = providerModelFailureGroundingGuard()({
      response,
      toolExecResults: [
        {
          toolName: "agents_manage",
          action: "update",
          success: false,
          failureCode: "provider_requires_model",
        },
        {
          toolName: "agents_manage",
          action: "update",
          success: true,
        },
      ],
      honestResponse,
    });

    expect(guarded).toEqual({ response, corrected: false });
  });

  it("does not replace ordinary agent-management failures", () => {
    const response = "I could not update the agent because the request was rejected.";
    const guarded = providerModelFailureGroundingGuard()({
      response,
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: false,
        failureCode: "model_not_found",
      }],
      honestResponse,
    });

    expect(guarded).toEqual({ response, corrected: false });
  });
});

type AgentUpdateNoOpGroundingGuard = (params: {
  response: string;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    action?: string;
    success: boolean;
    changed?: boolean;
  }>;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "agent_update_noop_grounding";
};

function agentUpdateNoOpGroundingGuard(): AgentUpdateNoOpGroundingGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceAgentUpdateNoOpGrounding;
  expect(candidate).toBeTypeOf("function");
  return candidate as AgentUpdateNoOpGroundingGuard;
}

describe("agent-update no-op grounding guard", () => {
  const honestResponse =
    "No configuration change was needed. This agent already uses provider_a / model_a.";

  it("replaces model prose that contradicts the latest successful no-op update", () => {
    const guarded = agentUpdateNoOpGroundingGuard()({
      response:
        "I can change my active model, switch providers, and adjust certain settings.",
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: true,
        changed: false,
      }],
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "agent_update_noop_grounding",
    });
  });

  it("preserves the exact runtime-owned no-op disclosure", () => {
    expect(agentUpdateNoOpGroundingGuard()({
      response: honestResponse,
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: true,
        changed: false,
      }],
      honestResponse,
    })).toEqual({ response: honestResponse, corrected: false });
  });

  it("does not let an earlier no-op override a later applied update", () => {
    const response = "The agent now uses provider_b / model_b.";
    expect(agentUpdateNoOpGroundingGuard()({
      response,
      toolExecResults: [
        {
          toolName: "agents_manage",
          action: "update",
          success: true,
          changed: false,
        },
        {
          toolName: "agents_manage",
          action: "update",
          success: true,
          changed: true,
        },
      ],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("leaves a later failed update for the failure-grounding path", () => {
    const response = "The requested model was rejected.";
    expect(agentUpdateNoOpGroundingGuard()({
      response,
      toolExecResults: [
        {
          toolName: "agents_manage",
          action: "update",
          success: true,
          changed: false,
        },
        {
          toolName: "agents_manage",
          action: "update",
          success: false,
        },
      ],
      honestResponse,
    })).toEqual({ response, corrected: false });
  });
});

type SenderAuthorityGroundingGuard = (params: {
  request: string;
  response: string;
  senderTrust: string;
  honestResponse: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "sender_authority_overclaim";
};

function senderAuthorityGroundingGuard(): SenderAuthorityGroundingGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceSenderAuthorityGrounding;
  expect(candidate).toBeTypeOf("function");
  return candidate as SenderAuthorityGroundingGuard;
}

describe("sender self-authority grounding guard", () => {
  const honestResponse =
    "Your current trust does not authorize admin-only changes. An authorized administrator is required.";

  it("replaces a user-trust claim that the sender can grant system access", () => {
    const guarded = senderAuthorityGroundingGuard()({
      request: "and what would u need me for",
      response:
        "You would need to provide the necessary system-level permissions or approvals "
        + "for me to connect to external services. Without your direct authorization, I cannot proceed.",
      senderTrust: "user",
      honestResponse,
    });

    expect(guarded).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "sender_authority_overclaim",
    });
  });

  it("replaces a user-trust claim covering skill and settings mutations", () => {
    const guarded = senderAuthorityGroundingGuard()({
      request: "and what would u need me for",
      response:
        "You mainly need to provide authorization or approval for installing skills, "
        + "connecting external services, or changing system settings.",
      senderTrust: "user",
      honestResponse,
    });

    expect(guarded.corrected).toBe(true);
    expect(guarded.response).toBe(honestResponse);
  });

  it("preserves an accurate below-admin limitation", () => {
    const response =
      "I cannot increase my own trust or permissions. Those changes require an authorized administrator.";
    expect(senderAuthorityGroundingGuard()({
      request: "could you give yourself more access if you wanted",
      response,
      senderTrust: "user",
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("preserves the same answer for an admin sender", () => {
    const response =
      "You would need to approve an agent configuration change before I apply it.";
    expect(senderAuthorityGroundingGuard()({
      request: "and what would u need me for",
      response,
      senderTrust: "admin",
      honestResponse,
    })).toEqual({ response, corrected: false });
  });

  it("does not reinterpret ordinary user approval as admin authority", () => {
    const response = "I need your approval before I send that message.";
    expect(senderAuthorityGroundingGuard()({
      request: "what do u need me for",
      response,
      senderTrust: "user",
      honestResponse,
    })).toEqual({ response, corrected: false });
  });
});

type ActiveModelSelfStatusGuard = (params: {
  request: string;
  response: string;
  provider: string;
  modelId: string;
}) => {
  response: string;
  corrected: boolean;
  reason?: "active_model_status_mismatch";
};

function activeModelSelfStatusGuard(): ActiveModelSelfStatusGuard {
  const candidate = (responseFilter as Record<string, unknown>)
    .enforceActiveModelSelfStatus;
  expect(candidate).toBeTypeOf("function");
  return candidate as ActiveModelSelfStatusGuard;
}

describe("active-model self-status grounding guard", () => {
  it("replaces an ungrounded live self-status answer with exact runtime identity", () => {
    const guarded = activeModelSelfStatusGuard()({
      request: "what model are u actually using now",
      response: "The provider is provider_a, but the exact model is unspecified.",
      provider: "provider_a",
      modelId: "model_a",
    });

    expect(guarded).toEqual({
      response: "provider_a / model_a",
      corrected: true,
      reason: "active_model_status_mismatch",
    });
  });

  it("preserves a self-status answer carrying both exact runtime fields", () => {
    const response = "I am running provider_a / model_a.";
    expect(activeModelSelfStatusGuard()({
      request: "what model are u actually using now",
      response,
      provider: "provider_a",
      modelId: "model_a",
    })).toEqual({ response, corrected: false });
  });

  it("does not reinterpret a recommendation request as current self-status", () => {
    const response = "model_b would fit that workload.";
    expect(activeModelSelfStatusGuard()({
      request: "what model should i use now",
      response,
      provider: "provider_a",
      modelId: "model_a",
    })).toEqual({ response, corrected: false });
  });

  it("does not alter unrelated model-catalog discussion", () => {
    const response = "The catalog has several pricing tiers.";
    expect(activeModelSelfStatusGuard()({
      request: "tell me about model pricing",
      response,
      provider: "provider_a",
      modelId: "model_a",
    })).toEqual({ response, corrected: false });
  });

  it("does not combine scattered current-model words across a research request", () => {
    const request = [
      "Research three AI-agent security branches: model-provider guidance,",
      "application-security standards, and real incident lessons.",
      "Each branch must use current web evidence and state which branches completed.",
    ].join(" ");
    const response = "All three research branches completed with current citations.";

    expect(activeModelSelfStatusGuard()({
      request,
      response,
      provider: "provider_a",
      modelId: "model_a",
    })).toEqual({ response, corrected: false });
  });
});

describe("empty-turn recovery does not narrate an already-delivered reply", () => {
  // LIVE: an onboarding turn sent its question via message({action:"send"}), so the
  // final assistant text was empty. Recovery then posted a SECOND bubble on top of
  // the real answer: "[comis: tool-call summary recovered …] • message({action:
  // "send"}) … Please ask what you did" plus a raw `User actions: <id>`. The user
  // read internal scaffolding. Recovery exists to stop a SILENT turn.
  function recover(args: Record<string, unknown>, toolName = "message"): string {
    return recoverEmptyFinalResponse({
      extractedResponse: "",
      // textEmitted:true is the live shape — text streamed during the turn but the
      // FINAL extracted response was empty (the reply went out via the tool).
      textEmitted: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: toolName, arguments: args }],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          isError: false,
          content: [{ type: "text", text: "OK" }],
          timestamp: 3,
        },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 4 },
      ] as never,
      logger: mockLogger(),
      userMessageIndex: 0,
    });
  }

  it("suppresses the synthesis when the batch already sent text to the channel", () => {
    const out = recover({ action: "send", channel_type: "telegram", channel_id: "1", text: "the real reply" });
    expect(out).toBe("");
    expect(out).not.toContain("tool-call summary recovered");
  });

  it("suppresses on a reply action too", () => {
    expect(recover({ action: "reply", channel_type: "telegram", channel_id: "1", text: "answer", message_id: "9" })).toBe("");
  });

  it("still recovers when the message delivery tool failed", () => {
    const out = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "send it" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-failed", name: "message", arguments: { action: "send", text: "answer" } }],
        },
        { role: "toolResult", toolCallId: "tc-failed", isError: true, content: [{ type: "text", text: "delivery failed" }] },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(out).toContain("tool-call summary recovered");
  });

  it("STILL synthesizes when the batch delivered NO words (a react is not a reply)", () => {
    expect(recover({ action: "react", channel_type: "telegram", channel_id: "1", emoji: "\u{1F44D}" }))
      .toContain("tool-call summary recovered");
  });

  it("STILL synthesizes for a non-message tool batch (the silent-turn case it exists for)", () => {
    expect(recover({ path: "a.txt" }, "write")).toContain("tool-call summary recovered");
  });

  it("STILL synthesizes when a send carries no text (attach-only delivers no words)", () => {
    expect(recover({ action: "send", channel_type: "telegram", channel_id: "1", text: "   " }))
      .toContain("tool-call summary recovered");
  });
});
