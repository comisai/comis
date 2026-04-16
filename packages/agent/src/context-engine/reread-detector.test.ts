/**
 * Tests for the re-read detector module.
 *
 * Verifies exact-match duplicate tool call detection across session history
 * with deterministic sorted-key JSON comparison. Covers exact match, no match,
 * partial param negative, multiple rereads, empty session, parameter order
 * independence, empty currentMessages, and non-assistant last message.
 */

import { describe, it, expect } from "vitest";
import { detectRereads } from "./reread-detector.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create an assistant message with a single tool call.
 * Follows the pi-agent-core format used in dead-content-evictor.test.ts.
 */
function makeAssistantWithToolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId, toolName, arguments: args }],
  } as unknown as AgentMessage;
}

/**
 * Create an assistant message with multiple tool calls.
 */
function makeAssistantWithMultipleToolCalls(
  calls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
): AgentMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "toolCall",
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      arguments: c.args,
    })),
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

/**
 * Wrap a message in a session fileEntry structure.
 */
function toEntry(message: AgentMessage): { type: string; message: unknown } {
  return { type: "message", message };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectRereads", () => {
  it("a) exact match: same tool name + same params detected as reread", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read it again"),
      makeAssistantWithToolCall("tc-current", "file_read", { path: "/a.ts" }),
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(1);
    expect(result.rereadTools).toEqual(["file_read"]);
  });

  it("b) no match: different tool name not detected", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("run a command"),
      makeAssistantWithToolCall("tc-current", "bash", { command: "echo hello" }),
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });

  it("c) partial param negative: same tool name but different params not detected", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read different file"),
      makeAssistantWithToolCall("tc-current", "file_read", { path: "/b.ts" }),
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });

  it("d) multiple rereads: counts all matches, deduplicates tool names", () => {
    // Two file_read calls in current, both matching session history
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read both files again"),
      makeAssistantWithMultipleToolCalls([
        { toolCallId: "tc-1", toolName: "file_read", args: { path: "/a.ts" } },
        { toolCallId: "tc-2", toolName: "file_read", args: { path: "/b.ts" } },
      ]),
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior-a", "file_read", { path: "/a.ts" })),
      toEntry(makeAssistantWithToolCall("tc-prior-b", "file_read", { path: "/b.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(2);
    // Tool names should be deduplicated -- both are "file_read"
    expect(result.rereadTools).toEqual(["file_read"]);
  });

  it("e) empty session: returns zero count", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read a file"),
      makeAssistantWithToolCall("tc-current", "file_read", { path: "/a.ts" }),
    ];

    const fullSessionEntries: unknown[] = [];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });

  it("f) parameter order independence: different key ordering still matches", () => {
    // Current message has { path, encoding } order
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read with encoding"),
      makeAssistantWithToolCall("tc-current", "file_read", {
        path: "/a.ts",
        encoding: "utf-8",
      }),
    ];

    // Session has { encoding, path } order (reversed)
    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", {
        encoding: "utf-8",
        path: "/a.ts",
      })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(1);
    expect(result.rereadTools).toEqual(["file_read"]);
  });

  it("g) empty currentMessages: returns zero", () => {
    const currentMessages: AgentMessage[] = [];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });

  it("h) non-assistant last message: returns zero", () => {
    // Last message is a user message, not assistant
    const currentMessages: AgentMessage[] = [
      makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
      makeUserMessage("now what?"),
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    // Last message is user, so no tool calls to check
    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------

  it("i) handles tool_use format (alternative block type)", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("use tool_use format"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-current", name: "bash", input: { command: "ls" } }],
      } as unknown as AgentMessage,
    ];

    const fullSessionEntries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tc-prior", name: "bash", input: { command: "ls" } }],
        },
      },
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(1);
    expect(result.rereadTools).toEqual(["bash"]);
  });

  it("j) entries without message property are skipped", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("read it"),
      makeAssistantWithToolCall("tc-current", "file_read", { path: "/a.ts" }),
    ];

    const fullSessionEntries = [
      { type: "event", data: "something" }, // no message property
      { type: "message" }, // message is undefined
      null,
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(1);
    expect(result.rereadTools).toEqual(["file_read"]);
  });

  it("k) assistant message with text only (no tool calls): returns zero", () => {
    const currentMessages: AgentMessage[] = [
      makeUserMessage("hello"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      } as unknown as AgentMessage,
    ];

    const fullSessionEntries = [
      toEntry(makeAssistantWithToolCall("tc-prior", "file_read", { path: "/a.ts" })),
    ];

    const result = detectRereads(currentMessages, fullSessionEntries);

    expect(result.rereadCount).toBe(0);
    expect(result.rereadTools).toEqual([]);
  });
});
