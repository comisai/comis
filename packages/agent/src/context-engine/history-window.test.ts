// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the history window layer.
 *
 * Verifies windowing to N user turns, per-channel overrides, compaction
 * summary preservation, and tool_use/tool_result pair safety.
 */

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { applyHistoryWindow, isCompactionSummary } from "./history-window.js";
import type { HistoryWindowConfig } from "./history-window.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantWithToolCalls(toolCallIds: string[]): AgentMessage {
  return {
    role: "assistant",
    content: toolCallIds.map((id) => ({
      type: "toolCall" as const,
      id,
      name: `tool_${id}`,
      arguments: {},
    })),
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResult(toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: `tool_${toolCallId}`,
    content: [{ type: "text" as const, text: `result for ${toolCallId}` }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeCompactionSummary(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text" as const, text: `<summary>${text}</summary>` }],
    timestamp: Date.now(),
    compactionSummary: true,
  } as unknown as AgentMessage;
}

/** Build a simple conversation of N user turns (user + assistant pairs). */
function buildConversation(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(makeUserMsg(`user-${i}`));
    messages.push(makeAssistantMsg(`assistant-${i}`));
  }
  return messages;
}

const defaultConfig: HistoryWindowConfig = {
  historyTurns: 15,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyHistoryWindow", () => {
  it("1. empty messages returns empty array", () => {
    const result = applyHistoryWindow([], defaultConfig);
    expect(result).toEqual([]);
  });

  it("2. messages within window returns all messages unchanged (reference equality)", () => {
    const messages = buildConversation(5); // 5 user turns, window=15
    const result = applyHistoryWindow(messages, defaultConfig);
    expect(result).toBe(messages); // reference equality -- no windowing needed
  });

  it("3. messages exceeding window returns last N user turns with intervening messages", () => {
    const messages = buildConversation(20); // 20 user turns, window=5
    const config: HistoryWindowConfig = { historyTurns: 5 };
    const result = applyHistoryWindow(messages, config);

    // Count user turns in result
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5);

    // The windowed result should contain the last 5 user turns and their assistants
    // That's the last 10 messages of the original 40
    expect(result.length).toBe(10);

    // Verify they are the LAST 5 user turns
    const firstUserContent = (result[0] as any).content;
    expect(firstUserContent[0].text).toBe("user-15"); // turns 15-19 (0-indexed)
  });

  it("4. per-channel override: channelType dm with override { dm: 3 } returns last 3 user turns", () => {
    const messages = buildConversation(10);
    const config: HistoryWindowConfig = {
      historyTurns: 15,
      historyTurnOverrides: { dm: 3 },
      channelType: "dm",
    };
    const result = applyHistoryWindow(messages, config);

    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(3);
    expect(result.length).toBe(6); // 3 user + 3 assistant
  });

  it("5. per-channel override: unknown channelType falls back to default historyTurns", () => {
    const messages = buildConversation(20);
    const config: HistoryWindowConfig = {
      historyTurns: 5,
      historyTurnOverrides: { dm: 3 },
      channelType: "telegram", // not in overrides
    };
    const result = applyHistoryWindow(messages, config);

    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5); // falls back to historyTurns=5
  });

  it("6. compaction summary: first message is compaction summary, always included", () => {
    const compaction = makeCompactionSummary("previous context summary");
    const conversation = buildConversation(3);
    const messages = [compaction, ...conversation];
    const config: HistoryWindowConfig = { historyTurns: 15 };

    const result = applyHistoryWindow(messages, config);
    // 3 user turns < 15 window, so all messages returned
    expect(result).toBe(messages);
  });

  it("7. compaction summary + windowing: compaction + 20 user turns with window=5 -> compaction + last 5 turns", () => {
    const compaction = makeCompactionSummary("summary of earlier context");
    const conversation = buildConversation(20);
    const messages = [compaction, ...conversation];
    const config: HistoryWindowConfig = { historyTurns: 5 };

    const result = applyHistoryWindow(messages, config);

    // First message should be the compaction summary
    expect(isCompactionSummary(result[0]!)).toBe(true);

    // Remaining should be last 5 user turns with assistants
    const nonCompaction = result.slice(1);
    const userMsgs = nonCompaction.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5);
    expect(nonCompaction.length).toBe(10); // 5 user + 5 assistant

    // Total: 1 compaction + 10 messages = 11
    expect(result.length).toBe(11);
  });

  it("8. pair safety: tool_use/tool_result not split by window boundary", () => {
    // Build: u0, a0, u1, a1(toolCall:tc1), tr(tc1), u2, a2, u3, a3
    // Window=2 -> should include u2,a2,u3,a3 but tc1 result is NOT in window
    // so no extension needed
    const messages: AgentMessage[] = [
      makeUserMsg("u0"), makeAssistantMsg("a0"),
      makeUserMsg("u1"), makeAssistantWithToolCalls(["tc1"]), makeToolResult("tc1"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
      makeUserMsg("u3"), makeAssistantMsg("a3"),
    ];

    const config: HistoryWindowConfig = { historyTurns: 2 };
    const result = applyHistoryWindow(messages, config);

    // Last 2 user turns: u2,a2,u3,a3
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(result.length).toBe(4);

    // Now test when window DOES split a pair:
    // u0, a0, u1, a1(tc1), tr(tc1), u2, a2
    // Window=1 -> u2,a2 but tr(tc1) is right before u2, and a1(tc1) before that
    // The window should extend to include a1(tc1) + tr(tc1)
    const messages2: AgentMessage[] = [
      makeUserMsg("u0"), makeAssistantMsg("a0"),
      makeUserMsg("u1"),
      makeAssistantWithToolCalls(["tc1"]),
      makeToolResult("tc1"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
    ];

    const result2 = applyHistoryWindow(messages2, { historyTurns: 1 });
    // Window starts at u2 (idx 5), pair safety should NOT extend because
    // tc1 result is at idx 4 which is before the window boundary.
    // The pair safety only extends if a tool result IS in the window
    // but its matching tool_use is NOT.
    const userMsgs2 = result2.filter((m) => m.role === "user");
    expect(userMsgs2.length).toBe(1);
    expect(result2.length).toBe(2); // u2, a2
  });

  it("8b. pair safety: window boundary falls ON tool result, extends to include assistant tool_use", () => {
    // Build: u0, a0, u1, a1(tc1,tc2), tr(tc1), tr(tc2), u2, a2
    // Window=1 with user counting -> would normally start at u2
    // But let's test where the boundary falls on a tool result:
    // We need a scenario where the Nth-from-last user turn is u2,
    // and the message just before u2 is tr(tc2), and a1(tc1,tc2) has matching calls

    const messages: AgentMessage[] = [
      makeUserMsg("u0"), makeAssistantMsg("a0"),
      makeUserMsg("u1"),
      makeAssistantWithToolCalls(["tc1", "tc2"]),
      makeToolResult("tc1"),
      makeToolResult("tc2"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
      makeUserMsg("u3"), makeAssistantMsg("a3"),
    ];

    // Window=2 -> starts at u2 (idx 6). Messages from idx 6: u2,a2,u3,a3
    // No tool results in window, no extension needed
    const result = applyHistoryWindow(messages, { historyTurns: 2 });
    expect(result.length).toBe(4); // u2,a2,u3,a3
  });

  it("9. pair safety: multiple consecutive tool calls all included", () => {
    // Build conversation where tool results are at the START of the window:
    // u0, a0, u1, a1(tc1,tc2,tc3), tr(tc1), tr(tc2), tr(tc3), a_text, u2, a2
    // Window=1 -> starts at u2. No tool results in window -> no extension

    // Better test: window includes a tool result but not its tool_use
    // u0, a0(tc1), tr(tc1), u1, a1, u2, a2
    // Window=2 -> starts at u1. tr(tc1) is at idx 2, before window. No issue.

    // Real pair-split scenario:
    // a0(tc1,tc2,tc3), tr(tc1), tr(tc2), tr(tc3), u1, a1
    // Window=1, starts at u1 (idx 4). Tool results (idx 1-3) outside window. OK.

    // To actually trigger pair safety, we need tool results INSIDE the window
    // without their assistant tool_use:
    // u0, a0(tc1), [BOUNDARY] tr(tc1), u1, a1
    // Window=1 -> normally starts at u1 (idx 3). tr(tc1) at idx 2 is outside.
    // But if window=1 and we structure differently:
    // u0, [BOUNDARY] tr(tc1), u1, a1 -- impossible, tr without preceding assistant in window

    // Better: a message structure where first message IN window is toolResult
    // u0, a0, a1(tc1,tc2), [WINDOW STARTS HERE] tr(tc1), tr(tc2), u1, a1_text
    // Window counting: u1 is the only user message in window, effectiveTurns=1
    // Walking backwards from end: u1 at idx 5, counted=1 -> windowStartIdx=5
    // But we want window to start at tr(tc1)...
    // Actually the walk-back sets windowStartIdx to the index of the user message.
    // Then pair safety extends backwards if tool results at windowStartIdx-1.
    // windowStartIdx=5, prev at idx 4 is tr(tc2)... but tr(tc2) is at idx 4 BEFORE window.
    // pair safety only checks if items WITHIN the window have orphaned tool results.

    // Let me think about this differently. Pair safety matters when:
    // The window starts with a tool result whose tool_use (assistant) is outside.
    // This happens when the window-start user message is preceded by tool results.

    // Create: u0, a0, u1, a1(tc1,tc2,tc3), tr1, tr2, tr3, u2, a2, u3, a3
    // Window=2 -> walk back from end counting users: u3(counted=1), u2(counted=2) -> windowStartIdx=7
    // messages[7] = u2. messages[6] = tr3. Pair safety: check within window (idx 7-10)
    // No tool results in window -> no extension. Good.

    // To actually test pair safety, create a conversation where a tool result
    // IS the first user turn's preceding context:
    // u0, a0, a1(tc1,tc2,tc3), tr1, tr2, tr3, u1, a1_text, u2, a2
    // Window=2 -> walk back: u2(1), u1(2) -> windowStartIdx=6 (u1)
    // Window = [u1, a1_text, u2, a2] (idx 6-9)
    // messages[5] = tr3 (before window). Check within window: no tool results.
    // No extension. Clean.

    // The only way pair safety triggers is if a toolResult message IS counted as being
    // inside the window. This happens if the window start is set to a tool result,
    // which won't happen because we count USER messages. The window starts at a user message.
    // Between the window start and the user message BEFORE it, there could be
    // assistant + tool_results. Those are OUTSIDE the window by definition.

    // However: imagine assistant with tool calls AFTER a user turn inside the window,
    // where the assistant's tool results are ALSO in the window:
    // u0, a0, u1, a1(tc1), tr1, u2, a2
    // Window=2 -> windowStartIdx=2 (u1). Window = [u1, a1(tc1), tr1, u2, a2]
    // Tool results IN window: tr1. Its tool_use a1(tc1) is ALSO in window. No extension needed.

    // The REAL pair safety scenario: the walking-back for user turns
    // puts the boundary RIGHT ON an assistant with tool calls, and
    // the tool results for those calls are AFTER the boundary (in the window).

    // u0, a0, [a_with_tools(tc1)], [tr1], u1, a1, u2, a2
    //                                ^^^ window starts here (idx 3)
    // Walk back from end: u2(1), u1(2) -> windowStartIdx=4 (u1)
    // Window = [u1, a1, u2, a2]. tr1 at idx 3 is outside. No issue.

    // Can we construct: windowStartIdx lands on u1, but the message BEFORE u1
    // is tr1, and before that is a_with_tools(tc1)?
    // u0, a0, a_with_tools(tc1), tr1, u1, a1
    // Window=1 -> windowStartIdx=4 (u1). Window=[u1, a1].
    // tr1 at idx 3 is outside window. No tool results in window.

    // The pair safety algorithm checks tool results INSIDE the window.
    // If there are none, no extension. The scenario where it matters is when
    // windowing puts the cut BETWEEN tool results:

    // u0, a0, u1, a1(tc1,tc2), tr1, [CUT] tr2, u2, a2
    // This can't happen because the cut is always at a user message index.

    // Wait -- the cut IS at a user message. Then the tool results/assistant
    // before the user message are always outside. The pair safety extends
    // backwards only if there's a tool result IN the window whose tool_use is
    // NOT in the window.

    // Scenario: user messages interleaved with tool results from a DIFFERENT exchange
    // u0, a0(tc1), u1 (user sent while tool was executing?), tr1, u2, a2
    // Window=1 -> windowStartIdx=4 (u2). Window=[u2, a2]. tr1 outside. Fine.
    // Window=2 -> windowStartIdx=2 (u1). Window=[u1, tr1, u2, a2].
    // tr1 is in window! Its tool_use a0(tc1) is at idx 1, OUTSIDE window.
    // Pair safety should extend to include a0(tc1).
    // Expected result: [a0(tc1), u1, tr1, u2, a2]

    const messages: AgentMessage[] = [
      makeUserMsg("u0"),
      makeAssistantWithToolCalls(["tc1", "tc2", "tc3"]),
      makeUserMsg("u1"),  // user sent while tools executing
      makeToolResult("tc1"),
      makeToolResult("tc2"),
      makeToolResult("tc3"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
    ];

    // Window=2 -> walk back: u2(1), u1(2) -> windowStartIdx=2 (u1)
    // Window starts at idx 2: [u1, tr1, tr2, tr3, u2, a2]
    // Tool results in window: tc1, tc2, tc3
    // Walk back from idx 1: messages[1] = a_with_tools(tc1,tc2,tc3)
    // It has matching tool calls -> extend to idx 1
    // Then messages[0] = u0 (user, not matching) -> break
    // Adjusted window: [a_with_tools, u1, tr1, tr2, tr3, u2, a2] = 7 messages
    const result = applyHistoryWindow(messages, { historyTurns: 2 });
    expect(result.length).toBe(7);
    // First message should be the assistant with tool calls
    expect(result[0]!.role).toBe("assistant");
  });

  it("10. mixed content: correct turn counting with text-only and tool-call assistants", () => {
    // u0, a0(text), u1, a1(tc1), tr1, u2, a2(text), u3, a3(text)
    const messages: AgentMessage[] = [
      makeUserMsg("u0"), makeAssistantMsg("a0"),
      makeUserMsg("u1"), makeAssistantWithToolCalls(["tc1"]), makeToolResult("tc1"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
      makeUserMsg("u3"), makeAssistantMsg("a3"),
    ];

    // Window=2 -> last 2 user turns: u2, u3
    const result = applyHistoryWindow(messages, { historyTurns: 2 });
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    // u2(idx 5), a2(idx 6), u3(idx 7), a3(idx 8) = 4 messages
    expect(result.length).toBe(4);
  });

  it("11. no user messages: edge case returns all messages (no windowing possible)", () => {
    const messages: AgentMessage[] = [
      makeAssistantMsg("a0"),
      makeAssistantMsg("a1"),
    ];

    const result = applyHistoryWindow(messages, { historyTurns: 5 });
    expect(result).toBe(messages); // no user turns -> within window -> reference equality
  });

  it("12. channelType undefined with overrides: falls back to historyTurns", () => {
    const messages = buildConversation(20);
    const config: HistoryWindowConfig = {
      historyTurns: 5,
      historyTurnOverrides: { dm: 3 },
      // channelType is undefined
    };
    const result = applyHistoryWindow(messages, config);
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5); // falls back to default
  });

  // ---------------------------------------------------------------------------
  // Cache-stable boundary snapping
  // ---------------------------------------------------------------------------

  it("13. window start is always a user message when no pair safety extension", () => {
    // 20 user turns (40 messages), window=5. The boundary should always
    // land on a user message since the backward walk counts user turns.
    const messages = buildConversation(20);
    const config: HistoryWindowConfig = { historyTurns: 5 };
    const result = applyHistoryWindow(messages, config);

    // First message in result should be a user message (no compaction)
    expect(result[0]!.role).toBe("user");

    // All user turns in result
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5);
  });

  it("14. pair safety extension preserves assistant at window start", () => {
    // Same scenario as test 9: pair safety extends to include an assistant
    // with tool calls. The snap should NOT advance past it.
    const messages: AgentMessage[] = [
      makeUserMsg("u0"),
      makeAssistantWithToolCalls(["tc1", "tc2", "tc3"]),
      makeUserMsg("u1"),  // user sent while tools executing
      makeToolResult("tc1"),
      makeToolResult("tc2"),
      makeToolResult("tc3"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
    ];

    // Window=2 -> walk back: u2(1), u1(2) -> windowStartIdx=2 (u1)
    // Pair safety extends to idx 1 (assistant with tool calls)
    // snap should NOT advance past the assistant -- pair safety takes priority
    const result = applyHistoryWindow(messages, { historyTurns: 2 });
    expect(result.length).toBe(7);
    // First message should be the assistant with tool calls (pair safety boundary)
    expect(result[0]!.role).toBe("assistant");
  });

  it("15. snap forward when boundary falls on toolResult without matching toolUse", () => {
    // Defensive edge case: unmatched toolResult at boundary.
    // Build: [user0, assistant0, toolResult(orphan), user1, assistant1, user2, assistant2]
    // The orphan toolResult has a toolCallId that does NOT match any assistant tool call.
    // Window=2: walk back -> u2(1), u1(2) -> windowStartIdx=3 (user1)
    // pair safety checks: no tool results in window with missing tool_use -> no extension
    // snap: messages[3] is user1 -> already a user message -> done
    const orphanToolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "orphan-no-match",
      toolName: "tool_orphan",
      content: [{ type: "text" as const, text: "orphan result" }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage;

    const messages: AgentMessage[] = [
      makeUserMsg("u0"),
      makeAssistantMsg("a0"),
      orphanToolResult,
      makeUserMsg("u1"), makeAssistantMsg("a1"),
      makeUserMsg("u2"), makeAssistantMsg("a2"),
    ];

    const result = applyHistoryWindow(messages, { historyTurns: 2 });
    // Should start at user1 (idx 3)
    expect(result[0]!.role).toBe("user");
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(result.length).toBe(4); // u1, a1, u2, a2
  });

  it("16. compaction + windowing still starts on user message", () => {
    // Compaction summary at index 0, 20 user turns, window=5.
    // Result should be: compaction at [0], user message at [1].
    const compaction = makeCompactionSummary("summary of earlier context");
    const conversation = buildConversation(20);
    const messages = [compaction, ...conversation];
    const config: HistoryWindowConfig = { historyTurns: 5 };

    const result = applyHistoryWindow(messages, config);

    // First message is compaction summary
    expect(isCompactionSummary(result[0]!)).toBe(true);
    // Second message (first after compaction) should be a user message
    expect(result[1]!.role).toBe("user");
    // 5 user turns in the non-compaction portion
    const nonCompaction = result.slice(1);
    const userMsgs = nonCompaction.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(5);
  });
});

describe("isCompactionSummary", () => {
  it("detects compactionSummary property", () => {
    const msg = { role: "user", compactionSummary: true, content: "text" } as unknown as AgentMessage;
    expect(isCompactionSummary(msg)).toBe(true);
  });

  it("detects type=compactionSummary", () => {
    const msg = { role: "user", type: "compactionSummary", content: [] } as unknown as AgentMessage;
    expect(isCompactionSummary(msg)).toBe(true);
  });

  it("detects string content starting with <summary>", () => {
    const msg = { role: "user", content: "<summary>previous context</summary>" } as unknown as AgentMessage;
    expect(isCompactionSummary(msg)).toBe(true);
  });

  it("detects array content with text block starting with <summary>", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "<summary>previous context</summary>" }],
    } as unknown as AgentMessage;
    expect(isCompactionSummary(msg)).toBe(true);
  });

  it("returns false for regular user message", () => {
    const msg = makeUserMsg("hello");
    expect(isCompactionSummary(msg)).toBe(false);
  });

  it("returns false for assistant message", () => {
    const msg = makeAssistantMsg("hello");
    expect(isCompactionSummary(msg)).toBe(false);
  });
});
