import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { repairOrphanedMessages } from "./orphaned-message-repair.js";
import { validateRoleAttribution } from "../context-engine/reasoning-tag-stripper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory SessionManager for testing. */
function createTestSession(): SessionManager {
  return SessionManager.inMemory("/tmp/test-cwd");
}

/** Append a user message to the session. */
function appendUser(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

/** Append a synthetic assistant message to the session. */
function appendAssistant(sm: SessionManager, text: string): void {
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages" as any,
    provider: "anthropic" as any,
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  } as any);
}

/** Append a tool result message to the session. */
function appendToolResult(sm: SessionManager, toolCallId: string, text: string): void {
  sm.appendMessage({
    role: "tool" as any,
    content: [{ type: "text", text }],
    toolCallId,
    timestamp: Date.now(),
  } as any);
}

/** Append an assistant message with toolUse stopReason. */
function appendAssistantToolUse(sm: SessionManager, toolCallId: string): void {
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check that." },
      { type: "tool_use", id: toolCallId, name: "test_tool", input: {} },
    ],
    api: "messages" as any,
    provider: "anthropic" as any,
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "toolUse" as any,
    timestamp: Date.now(),
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("repairOrphanedMessages", () => {
  it("returns { repaired: false } for empty session", () => {
    const sm = createTestSession();
    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("returns { repaired: false } when last message is assistant", () => {
    const sm = createTestSession();
    appendUser(sm, "hello");
    appendAssistant(sm, "hi there");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("repairs session ending with user message", () => {
    const sm = createTestSession();
    appendUser(sm, "hello");
    appendAssistant(sm, "hi there");
    appendUser(sm, "this message was orphaned");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(true);
    expect(result.reason).toBe("trailing user message without assistant reply");

    // Verify the synthetic reply was appended
    const context = sm.buildSessionContext();
    const messages = context.messages;
    expect(messages.length).toBe(4); // user, assistant, orphaned user, synthetic assistant
    const lastMsg = messages[messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
  });

  it("repairs session with only a single user message", () => {
    const sm = createTestSession();
    appendUser(sm, "first message ever, never got a reply");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(true);
    expect(result.reason).toContain("trailing user message");

    const context = sm.buildSessionContext();
    expect(context.messages.length).toBe(2); // orphaned user + synthetic assistant
    // AgentMessage always has .role -- direct access is type-safe
    expect(context.messages[1]!.role).toBe("assistant");
  });

  it("synthetic reply contains interruption notice", () => {
    const sm = createTestSession();
    appendUser(sm, "orphaned");

    repairOrphanedMessages(sm);

    const context = sm.buildSessionContext();
    const lastMsg = context.messages[context.messages.length - 1]!;
    // as any: AssistantMessage.content is a typed union (TextContent | ThinkingContent | ToolCall)[];
    // direct indexed access requires a cast since AgentMessage is a union type
    const content = (lastMsg as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("interrupted");
  });

  it("does not modify a well-formed conversation", () => {
    const sm = createTestSession();
    appendUser(sm, "q1");
    appendAssistant(sm, "a1");
    appendUser(sm, "q2");
    appendAssistant(sm, "a2");

    const beforeCount = sm.buildSessionContext().messages.length;
    const result = repairOrphanedMessages(sm);
    const afterCount = sm.buildSessionContext().messages.length;

    expect(result.repaired).toBe(false);
    expect(afterCount).toBe(beforeCount);
  });

  it("is idempotent (second repair is a no-op)", () => {
    const sm = createTestSession();
    appendUser(sm, "orphaned");

    const first = repairOrphanedMessages(sm);
    expect(first.repaired).toBe(true);

    const second = repairOrphanedMessages(sm);
    expect(second.repaired).toBe(false);

    // Only one synthetic message should exist
    const context = sm.buildSessionContext();
    expect(context.messages.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Tool-result tail tests
  // -------------------------------------------------------------------------

  it("repairs session ending with tool result (restart during tool execution)", () => {
    const sm = createTestSession();
    appendUser(sm, "run the test tool");
    appendAssistantToolUse(sm, "call_001");
    appendToolResult(sm, "call_001", "tool output here");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(true);
    expect(result.reason).toContain("tool result");

    // Verify synthetic assistant was appended
    const context = sm.buildSessionContext();
    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
  });

  it("repairs session ending with assistant toolUse (restart before tool results)", () => {
    const sm = createTestSession();
    appendUser(sm, "check something");
    appendAssistantToolUse(sm, "call_002");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(true);
    expect(result.reason).toContain("toolUse interrupted");

    // Verify synthetic assistant was appended
    const context = sm.buildSessionContext();
    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
  });

  it("synthetic reply for tool-result tail mentions restart", () => {
    const sm = createTestSession();
    appendUser(sm, "run tool");
    appendAssistantToolUse(sm, "call_003");
    appendToolResult(sm, "call_003", "output");

    repairOrphanedMessages(sm);

    const context = sm.buildSessionContext();
    const lastMsg = context.messages[context.messages.length - 1]!;
    const content = (lastMsg as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].text).toContain("restart");
  });

  it("tool-result tail repair is idempotent", () => {
    const sm = createTestSession();
    appendUser(sm, "run tool");
    appendAssistantToolUse(sm, "call_004");
    appendToolResult(sm, "call_004", "output");

    const first = repairOrphanedMessages(sm);
    expect(first.repaired).toBe(true);

    const second = repairOrphanedMessages(sm);
    expect(second.repaired).toBe(false);

    // Count messages: user + assistantToolUse + toolResult + syntheticAssistant = 4
    const context = sm.buildSessionContext();
    expect(context.messages.length).toBe(4);
  });

  it("does not repair session ending with normal assistant message", () => {
    const sm = createTestSession();
    appendUser(sm, "hello");
    appendAssistant(sm, "hi there");

    const result = repairOrphanedMessages(sm);
    expect(result.repaired).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Mid-session role alternation repair (Case 4) tests
  // -------------------------------------------------------------------------

  describe("mid-session role alternation repair (Case 4)", () => {
    /**
     * Helper: verify strict role alternation in a message list.
     * Only checks user/assistant roles -- skips tool/custom roles.
     */
    function assertStrictAlternation(messages: { role: string }[]): void {
      const uaMessages = messages.filter(
        (m) => m.role === "user" || m.role === "assistant",
      );
      for (let i = 1; i < uaMessages.length; i++) {
        expect(
          uaMessages[i]!.role,
          `consecutive same role at index ${i}: ${uaMessages[i - 1]!.role} followed by ${uaMessages[i]!.role}`,
        ).not.toBe(uaMessages[i - 1]!.role);
      }
    }

    it("repairs assistant-assistant at mid-session", () => {
      const sm = createTestSession();
      // user, assistant, assistant, user, assistant
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly: consecutive assistant
      appendUser(sm, "u2");
      appendAssistant(sm, "a3");

      const result = repairOrphanedMessages(sm);
      expect(result.repaired).toBe(true);
      expect(result.reason).toContain("mid-session");

      const ctx = sm.buildSessionContext();
      assertStrictAlternation(ctx.messages as { role: string }[]);
    });

    it("repairs user-user at mid-session", () => {
      const sm = createTestSession();
      // user, assistant, user, user, assistant
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendUser(sm, "u2");
      appendUser(sm, "u3"); // anomaly: consecutive user
      appendAssistant(sm, "a2");

      const result = repairOrphanedMessages(sm);
      expect(result.repaired).toBe(true);
      expect(result.reason).toContain("mid-session");

      const ctx = sm.buildSessionContext();
      assertStrictAlternation(ctx.messages as { role: string }[]);
    });

    it("repairs multiple mid-session anomalies in one pass", () => {
      const sm = createTestSession();
      // user, assistant, assistant, user, user, assistant
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly 1: assistant-assistant
      appendUser(sm, "u2");
      appendUser(sm, "u3"); // anomaly 2: user-user
      appendAssistant(sm, "a3");

      const result = repairOrphanedMessages(sm);
      expect(result.repaired).toBe(true);
      expect(result.reason).toContain("2");

      const ctx = sm.buildSessionContext();
      assertStrictAlternation(ctx.messages as { role: string }[]);
    });

    it("does not repair a clean mid-length session", () => {
      const sm = createTestSession();
      // Proper alternation, 6 messages
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendUser(sm, "u2");
      appendAssistant(sm, "a2");
      appendUser(sm, "u3");
      appendAssistant(sm, "a3");

      const result = repairOrphanedMessages(sm);
      expect(result.repaired).toBe(false);
    });

    it("repairs mid-session anomaly when tail is clean", () => {
      const sm = createTestSession();
      // anomaly in middle, tail is clean (ends with assistant)
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly
      appendUser(sm, "u2");
      appendAssistant(sm, "a3"); // clean tail

      const result = repairOrphanedMessages(sm);
      expect(result.repaired).toBe(true);
      expect(result.reason).toContain("mid-session");
    });

    it("is idempotent -- second repair is a no-op", () => {
      const sm = createTestSession();
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly
      appendUser(sm, "u2");
      appendAssistant(sm, "a3");

      const first = repairOrphanedMessages(sm);
      expect(first.repaired).toBe(true);

      const second = repairOrphanedMessages(sm);
      expect(second.repaired).toBe(false);

      // Verify alternation is still valid
      const ctx = sm.buildSessionContext();
      assertStrictAlternation(ctx.messages as { role: string }[]);
    });

    it("preserves original message content after repair", () => {
      const sm = createTestSession();
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly
      appendUser(sm, "u2");
      appendAssistant(sm, "a3");

      repairOrphanedMessages(sm);

      const ctx = sm.buildSessionContext();
      const texts = ctx.messages.map((m) => {
        if (typeof m.content === "string") return m.content;
        return (m.content as { type: string; text: string }[])[0]?.text ?? "";
      });
      // Original messages must all appear (order may include fillers)
      expect(texts).toContain("u1");
      expect(texts).toContain("a1");
      expect(texts).toContain("a2");
      expect(texts).toContain("u2");
      expect(texts).toContain("a3");
    });

    it("validateRoleAttribution finds zero anomalies after repair", () => {
      const sm = createTestSession();
      // Multiple anomalies
      appendUser(sm, "u1");
      appendAssistant(sm, "a1");
      appendAssistant(sm, "a2"); // anomaly 1
      appendUser(sm, "u2");
      appendUser(sm, "u3"); // anomaly 2
      appendAssistant(sm, "a3");

      repairOrphanedMessages(sm);

      const ctx = sm.buildSessionContext();
      const mockLogger = { warn: vi.fn() } as any;
      validateRoleAttribution(ctx.messages, mockLogger);

      // If warn was NOT called, no anomalies remain
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});
