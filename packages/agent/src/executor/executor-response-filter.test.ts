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
import { recoverEmptyFinalResponse } from "./executor-response-filter.js";
import type { ComisLogger } from "@comis/infra";

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

describe("recoverEmptyFinalResponse — tool-call synthesis (L3)", () => {
  it("synthesizes summary after parallel agents_manage.create batch", () => {
    const logger = mockLogger();
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Build a trading fleet", timestamp: 1 },
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
    // Note (per Step B item 1 implementation contract): non-string `name` blocks ARE
    // summarized as "unknown_tool" but are NOT added to toolNamesSet — so a hypothetical
    // INFO-log assertion for this batch would expect toolNames: [].
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
    // in the same turn. Pre-fix, both bullets rendered identically as
    // `gateway({action: "patch", section: "agents"})`. Post-fix, key field
    // disambiguates them.
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
    // emitted HEARTBEAT_OK after observation-only tools. Pre-fix, recovery
    // synthesized a fake "[comis: tool-call summary recovered ...]" message
    // and delivered it hourly via Telegram. Post-fix, the silent token
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
